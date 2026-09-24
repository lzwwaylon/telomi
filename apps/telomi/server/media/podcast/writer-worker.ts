import { isThinkingLevel } from "../../agent-runtime/model-config/resolve.js";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { listJsonl } from "../../lib/fs.js";

import { renderAgentPrompt } from "../../agent-runtime/prompt-registry.js";
import {
	assertPrimeModelAnswered,
	createPrimeModelRegistry,
	createPrimeSettingsManager,
	createPrimeTraceEventFilter,
	projectPrimeChildLifecycleEvent,
} from "../../agent-runtime/prime-agent-paths.js";
import {
	materializePodcastOutput,
	podcastWorkspaceReady,
	validatePodcastWorkspace,
	type PodcastWorkspacePhase,
} from "./writer-contract.js";
import { toErrorMessage } from "../../lib/values.js";

const thinkingLevel = required("PRIME_PODCAST_THINKING_LEVEL");
if (!isThinkingLevel(thinkingLevel)) throw new Error("Invalid configured thinking level");
const cwd = required("PRIME_PODCAST_CWD");
const runtimeRoot = required("PRIME_PODCAST_RUNTIME");
const agentDir = required("PRIME_AGENT_CODING_AGENT_DIR");
const skillPath = required("PRIME_PODCAST_SKILL");
const expectedSkill = required("PRIME_PODCAST_EXPECTED_SKILL");
const rootSelector = required("PRIME_PODCAST_ROOT_MODEL");
const childSelector = required("PRIME_PODCAST_CHILD_MODEL");
const prime = await import(required("PRIME_AGENT_MODULE_PATH"));
const eventLog = join(runtimeRoot, "root-events.jsonl");
/** 每个阶段最多两轮修复，与 Prime Report Writer 一致。 */
const MAX_REPAIRS = 2;
const rlmSessionDir = join(runtimeRoot, "session-artifacts");
const rootSessionDir = join(runtimeRoot, "session");
mkdirSync(rlmSessionDir, { recursive: true });
mkdirSync(rootSessionDir, { recursive: true });

const { authStorage, modelRegistry } = createPrimeModelRegistry(prime, agentDir);
const rootModel = findModel(rootSelector);
const childModel = findModel(childSelector);
const settingsManager = createPrimeSettingsManager(prime.SettingsManager, cwd, agentDir);
const loader = new prime.DefaultResourceLoader({
	cwd,
	agentDir,
	settingsManager,
	additionalSkillPaths: [skillPath],
	noExtensions: true,
	noSkills: true,
	noPromptTemplates: true,
	noThemes: true,
	noContextFiles: true,
	appendSystemPrompt: [renderAgentPrompt("main", "podcast-writer", "system-append").content],
});
await loader.reload();
if (!loader.getSkills().skills.some((skill: { name: string }) => skill.name === expectedSkill)) {
	throw new Error(`${expectedSkill} Skill did not load`);
}

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
	scopedModels: [
		{ model: rootModel, thinkingLevel },
		{ model: childModel, thinkingLevel },
	],
	tools: ["ipython"],
	rlmSessionDir,
	rlmMaxDepth: 1,
	prewarmIpythonKernel: true,
	executionMode: "print",
	telemetryDisabled: true,
});

const shouldRecordTraceEvent = createPrimeTraceEventFilter();
session.subscribe((event: unknown) => {
	const value = event as {
		type?: string;
		toolName?: string;
		child?: { id?: string; name?: string; sessionName?: string; status?: string; model?: unknown };
		message?: { role?: string; provider?: string; model?: string; usage?: unknown; stopReason?: string; errorMessage?: string };
	};
	if (shouldRecordTraceEvent(value)) {
		appendFileSync(eventLog, `${JSON.stringify(projectPrimeChildLifecycleEvent(value))}\n`);
	}
});

try {
	if (!podcastWorkspaceReady(cwd, "segments")) {
		console.log("[prime-podcast] planning and segment delegation");
		await session.prompt(renderAgentPrompt("main", "podcast-writer", "user", {
			child_model: childSelector,
		}, "plan").content);
		await waitForChildren();
	}
	checkProvider();
	const plan = await validateWithRepair("segments", "segment-repair");
	console.log(`[prime-podcast] ${plan.segments.length} segment drafts complete`);

	if (!podcastWorkspaceReady(cwd, "initial-review")) {
		console.log("[prime-podcast] root merge and isolated initial reviews");
		await session.prompt(renderAgentPrompt("main", "podcast-writer", "user", {
			child_model: childSelector,
		}, "initial-review").content, { streamingBehavior: "followUp" });
		await waitForChildren();
	}
	checkProvider();
	await validateWithRepair("initial-review", "initial-review");

	if (!podcastWorkspaceReady(cwd, "final-audit")) {
		console.log("[prime-podcast] root final edit and final source audit");
		await session.prompt(renderAgentPrompt("main", "podcast-writer", "user", {
			child_model: childSelector,
		}, "final-edit").content, { streamingBehavior: "followUp" });
		await waitForChildren();
	}
	checkProvider();
	await validateWithRepair("final-audit", "final-audit-repair");

	if (!existsSync(join(cwd, "writer-output", "review.json"))) {
		await session.prompt(renderAgentPrompt("main", "podcast-writer", "user", {}, "review").content,
			{ streamingBehavior: "followUp" });
	}
	checkProvider();
	try {
		materializePodcastOutput(cwd);
	} catch (error) {
		await session.prompt(renderAgentPrompt("main", "podcast-writer", "user", {
			validation_error: toErrorMessage(error),
		}, "output-repair").content, { streamingBehavior: "followUp" });
		checkProvider();
		materializePodcastOutput(cwd);
	}
	console.log("[prime-podcast] writer output complete");
} finally {
	await session.abort().catch(() => undefined);
	session.dispose();
}

writeFileSync(join(runtimeRoot, "result.json"), `${JSON.stringify({
	schema_version: 1,
	root_model: rootSelector,
	thinking_level: thinkingLevel,
	child_model: childSelector,
	usage: collectUsage([rootSessionDir, rlmSessionDir]),
}, null, 2)}\n`);

async function waitForChildren(): Promise<void> {
	await session.waitForRlmQuiescence();
}

async function validateWithRepair(
	phase: PodcastWorkspacePhase,
	repairVariant: "segment-repair" | "initial-review" | "final-audit-repair",
) {
	for (let repair = 0; ; repair += 1) {
		try {
			return validatePodcastWorkspace(cwd, phase);
		} catch (error) {
			if (repair === MAX_REPAIRS) throw error;
			await session.prompt(renderAgentPrompt("main", "podcast-writer", "user", {
				child_model: childSelector,
				validation_error: toErrorMessage(error),
			}, repairVariant).content, { streamingBehavior: "followUp" });
			await waitForChildren();
			checkProvider();
		}
	}
}

function findModel(selector: string) {
	const slash = selector.indexOf("/");
	const model = slash > 0 ? modelRegistry.find(selector.slice(0, slash), selector.slice(slash + 1)) : undefined;
	if (!model) throw new Error(`Prime model '${selector}' is not configured`);
	return model;
}

/** A model call that failed after Prime's own retries ends the writer; one a retry recovered does not. */
function checkProvider(): void {
	assertPrimeModelAnswered(session);
}

interface Usage {
	input_tokens: number;
	output_tokens: number;
	cost_usd: number;
	model_calls: number;
}

function collectUsage(roots: string[]): Usage {
	const usage: Usage = { input_tokens: 0, output_tokens: 0, cost_usd: 0, model_calls: 0 };
	for (const path of roots.flatMap((root) => listJsonl(root, { regularFilesOnly: true }))) {
		for (const line of readFileSync(path, "utf-8").split("\n").filter(Boolean)) {
			try {
				const event = JSON.parse(line) as { type?: string; message?: { role?: string; usage?: { input?: number; output?: number; cost?: { total?: number } } } };
				if (!["message", "message_end"].includes(event.type ?? "") || event.message?.role !== "assistant" || !event.message.usage) continue;
				usage.input_tokens += event.message.usage.input ?? 0;
				usage.output_tokens += event.message.usage.output ?? 0;
				usage.cost_usd += event.message.usage.cost?.total ?? 0;
				usage.model_calls += 1;
			} catch {
				// Ignore an incomplete terminal JSONL line.
			}
		}
	}
	return usage;
}

function required(name: string): string {
	const value = process.env[name]?.trim();
	if (!value) throw new Error(`${name} is required`);
	return value;
}
