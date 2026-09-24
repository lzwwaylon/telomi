import { isThinkingLevel } from "../agent-runtime/model-config/resolve.js";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, delimiter, join } from "node:path";

import { listJsonl } from "../lib/fs.js";

import { renderAgentPrompt } from "../agent-runtime/prompt-registry.js";
import { createRlmChildLogicalWorkspaceSnapshotter, snapshotLogicalWorkspace } from "../agent-runtime/logical-workspace-snapshot.js";
import {
	assertPrimeModelAnswered,
	createPrimeModelRegistry,
	createPrimeSettingsManager,
	createPrimeTraceEventFilter,
	projectPrimeChildLifecycleEvent,
} from "../agent-runtime/prime-agent-paths.js";

import { materializeCuratorEdition, validateCuratorWorksets } from "./wiki-shard-merge.js";
import {
	commitCuratorWorkspace,
	createCuratorWorksetTools,
	curatorRelationsMissing,
	missingCuratorWorkspaceResults,
	prepareCuratorRelationWorkspace,
	prepareCuratorWorkspace,
	stageCuratorRelations,
	stageCuratorWorkspaceResults,
} from "./wiki-curator-workspace.js";
import { toErrorMessage } from "../lib/values.js";

const cwd = required("PRIME_WIKI_MERGE_ROOT");
const runtimeRoot = required("PRIME_WIKI_MERGE_RUNTIME");
const sessionRoot = required("PRIME_WIKI_MERGE_SESSION_ROOT");
const agentDir = required("PRIME_AGENT_CODING_AGENT_DIR");
const skillPaths = required("PRIME_WIKI_MERGE_SKILLS").split(delimiter).filter(Boolean);
const expectedSkill = required("PRIME_WIKI_MERGE_EXPECTED_SKILL");
const rootSelector = required("PRIME_WIKI_MERGE_ROOT_MODEL");
const childSelector = required("PRIME_WIKI_MERGE_CHILD_MODEL");
const thinkingLevel = required("PRIME_WIKI_MERGE_THINKING");
if (!isThinkingLevel(thinkingLevel)) throw new Error("Invalid configured thinking level");
const logicalWorkspaceCaptureRoot = process.env.PRIME_WIKI_LOGICAL_WORKSPACE_ROOT?.trim();
const prime = await import(required("PRIME_AGENT_MODULE_PATH"));
const systemPrompt = readFileSync(join(runtimeRoot, "system-prompt.md"), "utf-8");
const eventLog = join(runtimeRoot, "sdk-events.jsonl");
const rlmSessionDir = join(runtimeRoot, "session-artifacts");
const sessionDirectory = join(sessionRoot, "sessions");
const bundledSkillPath = skillPaths.find((path) => basename(path) === expectedSkill);
if (!bundledSkillPath) throw new Error(`${expectedSkill} bundled Skill path is missing`);
const childContract = readFileSync(join(bundledSkillPath, "references", "child-workset.md"), "utf-8");
const relationContract = readFileSync(join(bundledSkillPath, "references", "relation-contract.md"), "utf-8");
mkdirSync(join(cwd, "work"), { recursive: true });
writeFileSync(join(cwd, "work", "child-contract.md"), childContract);
mkdirSync(sessionDirectory, { recursive: true });
mkdirSync(rlmSessionDir, { recursive: true });

const { authStorage, modelRegistry } = createPrimeModelRegistry(prime, agentDir);
const rootModel = findModel(modelRegistry, rootSelector);
const childModel = findModel(modelRegistry, childSelector);
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
	appendSystemPrompt: [systemPrompt],
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
	sessionManager: prime.SessionManager.create(cwd, sessionDirectory),
	model: rootModel,
	thinkingLevel,
	scopedModels: [
		{ model: rootModel, thinkingLevel },
		{ model: childModel, thinkingLevel },
	],
	tools: ["ipython", "submit_workset"],
	customTools: createCuratorWorksetTools(cwd),
	rlmSessionDir,
	rlmMaxDepth: 1,
	prewarmIpythonKernel: true,
	executionMode: "print",
	telemetryDisabled: true,
});
const logicalWorkspace = {
	guestCwd: "/workspace",
	mounts: [{ hostPath: cwd, guestPath: "/workspace", access: "read-write" as const }],
};
if (logicalWorkspaceCaptureRoot) {
	snapshotLogicalWorkspace(logicalWorkspace, join(logicalWorkspaceCaptureRoot, "root"));
}
const snapshotChildWorkspace = logicalWorkspaceCaptureRoot
	? createRlmChildLogicalWorkspaceSnapshotter(logicalWorkspace, logicalWorkspaceCaptureRoot, "child")
	: undefined;
const shouldRecordTraceEvent = createPrimeTraceEventFilter();
session.subscribe((event: unknown) => {
	snapshotChildWorkspace?.(event);
	if (shouldRecordTraceEvent(event)) {
		appendFileSync(eventLog, `${JSON.stringify(projectPrimeChildLifecycleEvent(event))}\n`);
	}
});

try {
	if (!existsSync(join(cwd, "work", "assignments"))) await preparePlan();
	await completeWorksets();
	await validateWorksets();
	await completeRelations();
	await validateRelationsAndCommit();
} finally {
	await session.abort().catch(() => undefined);
	session.dispose();
}

writeFileSync(join(runtimeRoot, "result.json"), `${JSON.stringify({
	schema_version: 1,
	root_model: rootSelector,
	child_model: childSelector,
	usage: collectUsage([eventLog, rlmSessionDir]),
}, null, 2)}\n`);

async function prompt(text: string, options?: { streamingBehavior: "followUp" }): Promise<void> {
	await session.prompt(text, options);
	assertPrimeModelAnswered(session);
}

async function preparePlan(): Promise<void> {
	let error: unknown;
	for (let attempt = 0; attempt < 3; attempt += 1) {
		await prompt(renderAgentPrompt("wiki", "wiki-curator", "user", attempt === 0 ? {} : {
			validation_error: toErrorMessage(error),
		}, attempt === 0 ? "plan" : "plan-repair").content,
		attempt === 0 ? undefined : { streamingBehavior: "followUp" });
		try {
			prepareCuratorWorkspace(cwd, childContract);
			return;
		} catch (cause) {
			error = cause;
		}
	}
	throw error;
}

async function completeWorksets(): Promise<void> {
	for (let attempt = 0; attempt < 3; attempt += 1) {
		const missing = missingCuratorWorkspaceResults(cwd);
		if (missing.length === 0) return;
		await prompt(renderAgentPrompt("wiki", "wiki-curator", "user", {
			child_model: childSelector,
			assignment_paths: missing.map((id) => `work/assignments/${id}.json`).join(", "),
		}, "delegate").content, { streamingBehavior: "followUp" });
		await session.waitForRlmQuiescence();
		assertPrimeModelAnswered(session);
	}
	const missing = missingCuratorWorkspaceResults(cwd);
	if (missing.length) throw new Error(`Wiki Curator children did not submit Worksets: ${missing.join(", ")}`);
}

async function validateWorksets(): Promise<void> {
	let error: unknown;
	for (let attempt = 0; attempt < 3; attempt += 1) {
		try {
			stageCuratorWorkspaceResults(cwd);
			validateCuratorWorksets(cwd);
			return;
		} catch (cause) {
			error = cause;
			if (attempt === 2) break;
			await prompt(renderAgentPrompt("wiki", "wiki-curator", "user", {
				validation_error: toErrorMessage(cause),
				child_model: childSelector,
			}, "workset-repair").content, { streamingBehavior: "followUp" });
			await session.waitForRlmQuiescence();
			assertPrimeModelAnswered(session);
		}
	}
	throw error;
}

async function completeRelations(): Promise<void> {
	prepareCuratorRelationWorkspace(cwd, relationContract);
	for (let attempt = 0; attempt < 3 && curatorRelationsMissing(cwd); attempt += 1) {
		await prompt(renderAgentPrompt("wiki", "wiki-curator", "user", {
			child_model: childSelector,
		}, "relation").content, { streamingBehavior: "followUp" });
		await session.waitForRlmQuiescence();
		assertPrimeModelAnswered(session);
	}
	if (curatorRelationsMissing(cwd)) throw new Error("Wiki Curator relation child did not write work/relations/result.json");
}

async function validateRelationsAndCommit(): Promise<void> {
	let error: unknown;
	for (let attempt = 0; attempt < 3; attempt += 1) {
		try {
			stageCuratorRelations(cwd);
			const validationRoot = join(cwd, "validation-knowledge");
			rmSync(validationRoot, { recursive: true, force: true });
			materializeCuratorEdition(cwd, validationRoot);
			commitCuratorWorkspace(cwd);
			return;
		} catch (cause) {
			error = cause;
			if (attempt === 2) break;
			await prompt(renderAgentPrompt("wiki", "wiki-curator", "user", {
				validation_error: toErrorMessage(cause),
				child_model: childSelector,
			}, "relation-repair").content, { streamingBehavior: "followUp" });
			await session.waitForRlmQuiescence();
			assertPrimeModelAnswered(session);
		}
	}
	throw error;
}

function findModel(registry: { find(provider: string, model: string): unknown }, selector: string): unknown {
	const slash = selector.indexOf("/");
	if (slash <= 0 || slash === selector.length - 1) throw new Error(`Invalid Prime model '${selector}'`);
	const model = registry.find(selector.slice(0, slash), selector.slice(slash + 1));
	if (!model) throw new Error(`Prime model '${selector}' is not configured`);
	return model;
}

function collectUsage(roots: string[]): { input_tokens: number; output_tokens: number; cost_usd: number; model_calls: number } {
	const usage = { input_tokens: 0, output_tokens: 0, cost_usd: 0, model_calls: 0 };
	for (const path of roots.flatMap((root) => listJsonl(root))) {
		for (const line of readFileSync(path, "utf-8").split("\n").filter(Boolean)) {
			try {
				const value = JSON.parse(line) as { type?: string; message?: { role?: string; usage?: { input?: number; output?: number; cost?: { total?: number } } } };
				if (!new Set(["message", "message_end"]).has(value.type ?? "") || value.message?.role !== "assistant" || !value.message.usage) continue;
				usage.input_tokens += value.message.usage.input ?? 0;
				usage.output_tokens += value.message.usage.output ?? 0;
				usage.cost_usd += value.message.usage.cost?.total ?? 0;
				usage.model_calls += 1;
			} catch {
				// Ignore an incomplete final JSONL line.
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
