import { isThinkingLevel } from "../../agent-runtime/model-config/resolve.js";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { renderAgentPrompt } from "../../agent-runtime/prompt-registry.js";
import {
	assertPrimeModelAnswered,
	createPrimeModelRegistry,
	createPrimeSettingsManager,
	createPrimeTraceEventFilter,
	projectPrimeChildLifecycleEvent,
} from "../../agent-runtime/prime-agent-paths.js";
import { listJsonl } from "../../lib/fs.js";
import { isRecord, toErrorMessage } from "../../lib/values.js";

const thinkingLevel = required("PRIME_SCHEDULE_REVIEW_THINKING_LEVEL");
if (!isThinkingLevel(thinkingLevel)) throw new Error("Invalid configured thinking level");
const cwd = required("PRIME_SCHEDULE_REVIEW_CWD");
const runtimeRoot = required("PRIME_SCHEDULE_REVIEW_RUNTIME");
const agentDir = required("PRIME_AGENT_CODING_AGENT_DIR");
const skillPaths = stringArray("PRIME_SCHEDULE_REVIEW_SKILLS");
const expectedSkills = stringArray("PRIME_SCHEDULE_REVIEW_EXPECTED_SKILLS");
const rootSelector = required("PRIME_SCHEDULE_REVIEW_ROOT_MODEL");
const prime = await import(required("PRIME_AGENT_MODULE_PATH"));

const decisionPath = join(cwd, "review-output", "decision.json");
const eventLog = join(runtimeRoot, "root-events.jsonl");
const rootSessionDir = join(runtimeRoot, "session");
mkdirSync(join(cwd, "review-output"), { recursive: true });
mkdirSync(rootSessionDir, { recursive: true });

const { authStorage, modelRegistry } = createPrimeModelRegistry(prime, agentDir);
const slash = rootSelector.indexOf("/");
const rootModel = slash > 0
	? modelRegistry.find(rootSelector.slice(0, slash), rootSelector.slice(slash + 1))
	: undefined;
if (!rootModel) throw new Error(`Prime model '${rootSelector}' is not configured`);
const settingsManager = createPrimeSettingsManager(prime.SettingsManager, cwd, agentDir);
const loader = new prime.DefaultResourceLoader({
	cwd,
	agentDir,
	settingsManager,
	additionalSkillPaths: skillPaths,
	noExtensions: true,
	noSkills: true,
	noPromptTemplates: true,
	noThemes: true,
	noContextFiles: true,
	appendSystemPrompt: [renderAgentPrompt("research", "schedule-reviewer", "system-append").content],
});
await loader.reload();
const loadedSkills = new Set(loader.getSkills().skills.map((skill: { name: string }) => skill.name));
for (const skill of expectedSkills) {
	if (!loadedSkills.has(skill)) throw new Error(`${skill} Skill did not load`);
}

// Reviewer 只做一件语义判断，不委派 RLM child，因此没有子会话目录，也不等待 quiescence。
const { session } = await prime.createAgentSession({
	cwd,
	agentDir,
	authStorage,
	modelRegistry,
	settingsManager,
	resourceLoader: loader,
	sessionManager: prime.SessionManager.create(cwd, rootSessionDir),
	model: rootModel,
	thinkingLevel,
	scopedModels: [{ model: rootModel, thinkingLevel }],
	tools: ["ipython"],
	prewarmIpythonKernel: true,
	executionMode: "print",
	telemetryDisabled: true,
});

const shouldRecordTraceEvent = createPrimeTraceEventFilter();
session.subscribe((event: unknown) => {
	const value = event as { type?: string };
	if (shouldRecordTraceEvent(value)) {
		appendFileSync(eventLog, `${JSON.stringify(projectPrimeChildLifecycleEvent(value))}\n`);
	}
});

try {
	await session.prompt(renderAgentPrompt("research", "schedule-reviewer", "user").content);
	checkProvider();
	// Worker 只检查"有没有一份可读的 JSON 决定"，语义契约由 Runtime 在进程外校验并 fail closed。
	const readable = readableDecision();
	if (readable) {
		await session.prompt(renderAgentPrompt("research", "schedule-reviewer", "user", {
			validation_error: readable,
		}, "repair").content, { streamingBehavior: "followUp" });
		checkProvider();
		const stillUnreadable = readableDecision();
		if (stillUnreadable) throw new Error(stillUnreadable);
	}
} catch (error) {
	await reportWorkerFailure(toErrorMessage(error));
	throw error;
} finally {
	await session.abort().catch(() => undefined);
	session.dispose();
}

writeFileSync(join(runtimeRoot, "result.json"), `${JSON.stringify({
	schema_version: 1,
	root_model: rootSelector,
	thinking_level: thinkingLevel,
	usage: collectUsage(rootSessionDir),
	session_path: session.sessionFile ?? eventLog,
}, null, 2)}\n`);

/** Returns the reason the decision file cannot be read, or undefined when it parses. */
function readableDecision(): string | undefined {
	if (!existsSync(decisionPath)) return "review-output/decision.json is missing";
	try {
		JSON.parse(readFileSync(decisionPath, "utf-8"));
		return undefined;
	} catch (error) {
		return `review-output/decision.json is not valid JSON: ${toErrorMessage(error)}`;
	}
}

/** A model call that failed after Prime's own retries ends the review; one a retry recovered does not. */
function checkProvider(): void {
	assertPrimeModelAnswered(session);
}

async function reportWorkerFailure(error: string): Promise<void> {
	if (!process.send) return;
	await new Promise<void>((resolvePromise) => {
		try {
			process.send!({ type: "stage_worker_failure", failure_class: "provider", error }, () => resolvePromise());
		} catch {
			resolvePromise();
		}
	});
}

function collectUsage(root: string): {
	input_tokens: number;
	output_tokens: number;
	cost_usd: number;
	model_calls: number;
} {
	const usage = { input_tokens: 0, output_tokens: 0, cost_usd: 0, model_calls: 0 };
	for (const path of listJsonl(root, { regularFilesOnly: true })) {
		for (const line of readFileSync(path, "utf-8").split("\n").filter(Boolean)) {
			try {
				const event = JSON.parse(line) as unknown;
				if (!isRecord(event) || !["message", "message_end"].includes(String(event.type))) continue;
				const message = isRecord(event.message) ? event.message : undefined;
				if (message?.role !== "assistant" || !isRecord(message.usage)) continue;
				usage.input_tokens += finite(message.usage.input);
				usage.output_tokens += finite(message.usage.output);
				usage.cost_usd += isRecord(message.usage.cost) ? finite(message.usage.cost.total) : 0;
				usage.model_calls += 1;
			} catch {
				// Ignore an incomplete terminal JSONL line.
			}
		}
	}
	return usage;
}

function finite(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function required(name: string): string {
	const value = process.env[name]?.trim();
	if (!value) throw new Error(`${name} is required`);
	return value;
}

function stringArray(name: string): string[] {
	const value = JSON.parse(process.env[name] || "[]") as unknown;
	if (!Array.isArray(value) || value.length === 0
		|| !value.every((item) => typeof item === "string" && item.trim())) {
		throw new Error(`${name} must be a non-empty JSON string array`);
	}
	return value as string[];
}
