import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const cwd = required("PRIME_AGENT_EVIDENCE_CWD");
const runtimeRoot = required("PRIME_AGENT_EVIDENCE_RUNTIME");
const agentDir = required("PRIME_AGENT_CODING_AGENT_DIR");
const provider = required("PRIME_AGENT_EVIDENCE_PROVIDER");
const modelId = required("PRIME_AGENT_EVIDENCE_MODEL");
const skillPaths = JSON.parse(process.env.PRIME_AGENT_EVIDENCE_SKILLS || "[]");
if (!Array.isArray(skillPaths) || !skillPaths.every((value) => typeof value === "string")) {
	throw new Error("PRIME_AGENT_EVIDENCE_SKILLS must be a JSON string array");
}
const prime = await import(required("PRIME_AGENT_MODULE_PATH"));
const { assertPrimeModelAnswered, createPrimeModelRegistry } = await import(required("PRIME_AGENT_PATHS_MODULE_PATH"));
const systemPrompt = readFileSync(join(runtimeRoot, "system-prompt.md"), "utf-8");
const userPrompt = readFileSync(join(runtimeRoot, "user-prompt.md"), "utf-8");
const repairPrompt = readFileSync(join(runtimeRoot, "repair-prompt.md"), "utf-8");
const eventLog = join(runtimeRoot, "session.jsonl");
const sessionRoot = join(runtimeRoot, "sessions");
mkdirSync(sessionRoot, { recursive: true });

const { authStorage, modelRegistry } = createPrimeModelRegistry(prime, agentDir);
const model = modelRegistry.find(provider, modelId);
if (!model) throw new Error(`Prime model '${provider}/${modelId}' is not configured`);
const settingsManager = prime.SettingsManager.create(cwd, agentDir);
if (settingsManager.getAutoRefineSettings().enabled !== false) {
	throw new Error("Prime Cornell Note requires auto refine to be disabled");
}
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
	appendSystemPrompt: [systemPrompt],
});
await loader.reload();
const { session } = await prime.createAgentSession({
	cwd,
	agentDir,
	authStorage,
	modelRegistry,
	settingsManager,
	resourceLoader: loader,
	sessionManager: prime.SessionManager.create(cwd, sessionRoot),
	model,
	thinkingLevel: required("PRIME_AGENT_EVIDENCE_THINKING"),
	tools: ["ipython"],
	prewarmIpythonKernel: true,
	executionMode: "print",
	telemetryDisabled: true,
});
const usage = { input_tokens: 0, output_tokens: 0, cost_usd: 0, model_calls: 0 };
let toolCalls = 0;
let terminalValidationError;
session.subscribe((event) => {
	try {
		if (event?.type === "tool_execution_start") toolCalls += 1;
		if (event?.type !== "message_end") return;
		appendFileSync(eventLog, `${JSON.stringify({ type: "message", timestamp: Date.now(), message: event.message })}\n`);
		if (event.message?.role !== "assistant") return;
		usage.input_tokens += finite(event.message.usage?.input);
		usage.output_tokens += finite(event.message.usage?.output);
		usage.cost_usd += finite(event.message.usage?.cost?.total);
		usage.model_calls += 1;
	} catch {}
});

try {
	await session.prompt(userPrompt);
	for (let submission = 1; submission <= 3; submission += 1) {
		const validation = await requestRuntimeValidation(submission);
		if (validation.accepted) break;
		// Only a model call Prime's own retries could not recover ends the note; a recovered one still gets its repair.
		assertPrimeModelAnswered(session);
		const validationError = validation.error || "Runtime rejected cornell-note.json without an error description";
		if (submission === 3) {
			terminalValidationError = validationError;
			throw new Error(validationError);
		}
		await session.prompt(`${repairPrompt}\n${validationError}`);
	}
} catch (error) {
	await reportWorkerFailure(
		terminalValidationError ? "validation" : "provider",
		terminalValidationError || (error instanceof Error ? error.message : String(error)),
	);
	throw error;
} finally {
	await session.abort().catch(() => undefined);
	session.dispose();
}

writeFileSync(join(runtimeRoot, "result.json"), `${JSON.stringify({
	schema_version: 1,
	model: `${provider}/${modelId}`,
	usage,
	tool_calls: toolCalls,
	turns: usage.model_calls,
}, null, 2)}\n`);

function requestRuntimeValidation(submission) {
	if (!process.send) throw new Error("Prime Cornell Note requires a Runtime validation channel");
	return new Promise((resolvePromise) => {
		const onMessage = (message) => {
			if (!message || message.type !== "stage_output_validation" || message.submission !== submission) return;
			process.off("message", onMessage);
			resolvePromise(message);
		};
		process.on("message", onMessage);
		process.send({ type: "stage_output_candidate", submission });
	});
}

async function reportWorkerFailure(failureClass, error) {
	if (!process.send) return;
	await new Promise((resolvePromise) => {
		try {
			process.send({ type: "stage_worker_failure", failure_class: failureClass, error }, () => resolvePromise());
		} catch {
			resolvePromise();
		}
	});
}

function finite(value) {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function required(name) {
	const value = process.env[name]?.trim();
	if (!value) throw new Error(`${name} is required`);
	return value;
}
