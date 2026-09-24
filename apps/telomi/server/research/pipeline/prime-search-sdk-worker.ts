import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { createRlmChildLogicalWorkspaceSnapshotter } from "../../agent-runtime/logical-workspace-snapshot.js";
import {
	createPrimeModelRegistry,
	createPrimeSettingsManager,
	createPrimeTraceEventFilter,
	projectPrimeChildLifecycleEvent,
} from "../../agent-runtime/prime-agent-paths.js";
import { createPrimeOrganizerContractTools, createPrimeSearchContractTools } from "./prime-search-contract.js";
import { providerChildLogicalWorkspace, workspaceRelativeSkill } from "./provider-execution-workspace.js";

interface Input {
	cwd: string;
	sessionDir: string;
	provider: string;
	model: string;
	thinking: string;
	prompt: string;
	skills: string[];
	tools?: string[];
	contractTools?: boolean;
	organizerTools?: boolean;
	scopedModels: string[];
	rlmMaxDepth: number;
	logicalWorkspaceCaptureRoot?: string;
	childReplayId?: string;
	serviceTier?: "default" | "priority" | "flex";
}

const input = JSON.parse(readFileSync(required("PRIME_SEARCH_SDK_INPUT"), "utf-8")) as Input;
const agentDir = required("PRIME_AGENT_CODING_AGENT_DIR");
const prime = await import(required("PRIME_AGENT_MODULE_PATH"));
const { authStorage, modelRegistry } = createPrimeModelRegistry(prime, agentDir);
const rootModel = findModel(input.provider, input.model);
const settingsManager = createPrimeSettingsManager(prime.SettingsManager, input.cwd, agentDir);
const loader = new prime.DefaultResourceLoader({
	cwd: input.cwd,
	agentDir,
	settingsManager,
	additionalSkillPaths: input.skills,
	skillsOverride: (current: { skills: Array<{ filePath: string; baseDir: string }> }) => ({
		...current,
		skills: current.skills.map((skill) => workspaceRelativeSkill(input.cwd, skill)),
	}),
	noExtensions: true,
	noSkills: true,
	noPromptTemplates: true,
	noThemes: true,
	noContextFiles: true,
});
await loader.reload();
// Browser, general web search and Skill reads reach the Runtime through the Python SDK
// (`research_runtime`) over the per-run bridge; the only native Tools are the contract submissions.
const customTools = [
	...(input.contractTools ? createPrimeSearchContractTools(input.cwd) : []),
	...(input.organizerTools ? createPrimeOrganizerContractTools(input.cwd) : []),
];

const scopedModels = [
	{ model: rootModel, thinkingLevel: input.thinking },
	...input.scopedModels.map((selector) => {
		const [provider, model] = parseModel(selector);
		return { model: findModel(provider, model), thinkingLevel: input.thinking };
	}),
];
const rlmSessionDir = join(dirname(input.sessionDir), "session-artifacts");
const eventLog = join(dirname(input.sessionDir), "sdk-events.jsonl");
const sessionManager = prime.SessionManager.create(input.cwd, input.sessionDir);
if (input.childReplayId) sessionManager.newSession({ rlmDepth: 1 });
const { session } = await prime.createAgentSession({
	cwd: input.cwd,
	agentDir,
	authStorage,
	modelRegistry,
	settingsManager,
	resourceLoader: loader,
	sessionManager,
	model: rootModel,
	thinkingLevel: input.thinking,
	scopedModels,
	...(input.tools ? { tools: input.tools } : {}),
	...(customTools.length > 0 ? { customTools } : {}),
	rlmSessionDir: input.childReplayId ? input.sessionDir : rlmSessionDir,
	...(input.childReplayId ? { rlmDepth: 1, rlmParentNodeId: input.childReplayId, serviceTier: input.serviceTier } : {}),
	rlmMaxDepth: input.rlmMaxDepth,
	prewarmIpythonKernel: true,
	executionMode: "print",
	telemetryDisabled: true,
	autonomous: { enabled: false },
});

const shouldRecordTraceEvent = createPrimeTraceEventFilter();
const snapshotChildWorkspace = input.logicalWorkspaceCaptureRoot
	? createRlmChildLogicalWorkspaceSnapshotter(input.contractTools
		? (childId) => providerChildLogicalWorkspace(input.cwd, childId)
		: {
			guestCwd: "/workspace",
			mounts: [{ hostPath: input.cwd, guestPath: "/workspace", access: "read-write" }],
		}, input.logicalWorkspaceCaptureRoot)
	: undefined;
session.subscribe((event: unknown) => {
	const value = event as { type?: string; child?: { id?: string; status?: string; sessionDir?: string } };
	snapshotChildWorkspace?.(event);
	if (shouldRecordTraceEvent(event)) {
		appendFileSync(eventLog, `${JSON.stringify(projectPrimeChildLifecycleEvent(event))}\n`);
	}
	if (["message_update", "message_end", "tool_execution_start", "tool_execution_end", "rlm_child_update"].includes(value.type ?? "")) {
		process.stdout.write(`${JSON.stringify(event)}\n`);
	}
});

try {
	if (input.childReplayId) {
		// Match Prime's native first child turn; a parent model/session is deliberately absent.
		const content = `[task from parent]\n\n${input.prompt}`;
		await session.promptAndWait(content, {
			expandPromptTemplates: false,
			source: "extension",
			customMessage: {
				role: "custom", customType: "agent_message", content, display: true,
				details: { id: `spawn:${input.childReplayId}`, message: input.prompt, fromRelationship: "parent" },
				timestamp: Date.now(),
			},
		});
	} else {
		await session.prompt(input.prompt);
	}
	await session.waitForRlmQuiescence();
} finally {
	// The prime SDK composes the effective system prompt internally; capture it here (the only place it exists) into the
	// work dir so the Case snapshot carries it. The Agent is done, so this dotfile never enters its reasoning.
	try {
		const systemPrompt = (session as { systemPrompt?: string }).systemPrompt;
		if (typeof systemPrompt === "string" && systemPrompt) writeFileSync(join(input.cwd, ".system-prompt.md"), systemPrompt, "utf-8");
	} catch { /* the snapshot simply lacks the system prompt */ }
	await session.abort().catch(() => undefined);
	session.dispose();
}

function findModel(provider: string, model: string): unknown {
	const found = modelRegistry.find(provider, model);
	if (!found) throw new Error(`Prime model '${provider}/${model}' is not configured`);
	return found;
}

function parseModel(selector: string): [string, string] {
	const slash = selector.indexOf("/");
	if (slash <= 0 || slash === selector.length - 1) throw new Error(`Invalid Prime model '${selector}'`);
	return [selector.slice(0, slash), selector.slice(slash + 1)];
}

function required(name: string): string {
	const value = process.env[name]?.trim();
	if (!value) throw new Error(`${name} is required`);
	return value;
}
