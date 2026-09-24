import type { ResolvedOutputLanguage } from "../../shared/languages.js";
import {
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, sep } from "node:path";

import { resolveLLMConfig, resolveStageThinkingLevel, type ThinkingLevel } from "../agent-runtime/model-config/resolve.js";
import { TASK_MODEL_ROLE_INFO } from "../config/settings.js";
import { pinTaskModelSelection, resolvePrimeModel } from "../agent-runtime/model-policy.js";
import { bundledAgentSkillPath } from "../agent-runtime/skill-registry.js";
import { sha256 } from "../lib/hash.js";
import type { CornellNotesSnapshot } from "../cornell/contracts.js";
import { RunArtifactStore, type PublishedArtifactDirectoryRef, type PublishedArtifactRef } from "../agent-runtime/artifact-store.js";
import {
	beginNodeEvaluationCase,
	finishNodeEvaluationCase,
	type NodeEvaluationCaseDraft,
	type NodeReplayRecipe,
} from "../agent-runtime/node-evaluation.js";
import type { AgentStageRequest, ValidatedStageArtifact } from "../agent-runtime/agent-stage-runtime.js";
import { recordCaseCaptureFailure } from "../observability/case-capture.js";
import { emptyWorkspaceSnapshot, snapshotWorkspaceTree } from "../agent-runtime/workspace-snapshot.js";
import type { ResearchModelUsage } from "../agent-runtime/model-usage.js";
import {
	runPrimeNoteWikiMaintainer,
} from "../wiki/note-wiki-maintainer.js";
import { requireWikiGoalContext, type GoalTopicPlan, type WikiGoalContext } from "../wiki/contracts.js";
import {
	curateWikiEdition,
	type WikiCuratorOperation,
	type WikiCuratorResult,
} from "../wiki/wiki-shard-merge.js";
import { hashWikiDirectory } from "../wiki/files.js";
import { toErrorMessage } from "../lib/values.js";
import { listFilesRecursive, readJson } from "../lib/fs.js";

type WikiAgentId = "wiki-shard-builder" | "wiki-curator";
const RECIPE_VERSION = 1;

type WikiShardInput = Parameters<typeof runPrimeNoteWikiMaintainer>[0];
type WikiShardResult = Awaited<ReturnType<typeof runPrimeNoteWikiMaintainer>>;
type WikiCuratorInput = Parameters<typeof curateWikiEdition>[0];

export interface WikiReplayExecutionInput {
	caseInputDirectory: string;
	harnessWorkspaceDirectory: string;
	recordDirectory: string;
	workDirectory: string;
	artifactStore: RunArtifactStore;
	logicalWorkspaceCaptureRoot: string;
	candidateCase?: { sourceRunId: string; capabilitySnapshotId: string };
	signal: AbortSignal;
}

export interface WikiReplayExecutionResult {
	artifact: PublishedArtifactDirectoryRef | PublishedArtifactRef;
	usage: ResearchModelUsage;
	turns: number;
	toolCalls: number;
}

export async function runWikiShardNodeEvaluation(
	input: WikiShardInput,
	options: {
		recordDirectory: string;
		runId: string;
		execute?: (input: WikiShardInput) => Promise<WikiShardResult>;
		env?: NodeJS.ProcessEnv;
	},
): Promise<WikiShardResult> {
	const env = pinTaskModelSelection(["wikiMaintainer", "primeChild"], options.env ?? input.env ?? process.env);
	const maintain = options.execute ?? runPrimeNoteWikiMaintainer;
	let models: FrozenWikiModels;
	let logicalWorkspaces: string;
	let inputDirectory: string;
	try {
		models = wikiModels(env);
		logicalWorkspaces = resetDirectory(join(options.recordDirectory, "node-evaluation", `wiki-shard-builder-logical-workspaces-${safe(options.runId)}`));
		inputDirectory = resetDirectory(join(options.recordDirectory, "node-evaluation", `wiki-shard-builder-input-${safe(options.runId)}`));
		writeFileSync(join(inputDirectory, "request.json"), `${JSON.stringify({
			schema_version: 1,
			agent_id: "wiki-shard-builder",
			goal: input.goal,
			...(input.goalContext ? { goal_context: requireWikiGoalContext(input.goalContext) } : {}),
			batch: input.batch,
			models,
		}, null, 2)}\n`);
		writeFileSync(join(inputDirectory, "evidence.json"), `${JSON.stringify(input.evidence, null, 2)}\n`);
		writeFileSync(join(inputDirectory, "topic-plan.json"), `${JSON.stringify(input.topicPlan, null, 2)}\n`);
	} catch (error) {
		// fail-open：Capture 无法准备时照常执行产品 Wiki Shard Builder。
		recordCaseCaptureFailure("wiki-shard-builder", error);
		return maintain({ ...input, env });
	}
	return captureWikiExecution({
		agentId: "wiki-shard-builder",
		recordDirectory: options.recordDirectory,
		runId: options.runId,
		inputDirectory,
		goal: input.goalContext ? [input.goalContext.title, input.goalContext.description].filter(Boolean).join("\n\n") : input.goal,
		models,
		workDirectory: input.workRoot,
		logicalWorkspaces,
		signal: input.signal,
		execute: async () => maintain({ ...input, env, logicalWorkspaceCaptureRoot: logicalWorkspaces }),
	});
}

export async function runWikiCuratorNodeEvaluation(
	input: WikiCuratorInput,
	options: {
		recordDirectory: string;
		runId: string;
		execute?: (input: WikiCuratorInput) => Promise<WikiCuratorResult>;
		env?: NodeJS.ProcessEnv;
	},
): Promise<WikiCuratorResult> {
	const env = pinTaskModelSelection(["wikiMaintainer", "primeChild"], options.env ?? input.env ?? process.env);
	const curate = options.execute ?? curateWikiEdition;
	let models: FrozenWikiModels;
	let logicalWorkspaces: string;
	let inputDirectory: string;
	try {
		models = wikiModels(env);
		logicalWorkspaces = resetDirectory(join(options.recordDirectory, "node-evaluation", `wiki-curator-logical-workspaces-${safe(options.runId)}`));
		inputDirectory = resetDirectory(join(options.recordDirectory, "node-evaluation", `wiki-curator-input-${safe(options.runId)}`));
		writeFileSync(join(inputDirectory, "request.json"), `${JSON.stringify({
			schema_version: 1,
			agent_id: "wiki-curator",
			operation: input.operation,
			goal: input.goal,
			...(input.language ? { language: input.language } : {}),
			topic_plan: input.topicPlan,
			models,
			has_previous_edition: Boolean(input.previousEditionRoot),
			draft_count: input.draftRoots.length,
		}, null, 2)}\n`);
		if (input.previousEditionRoot) cpSync(input.previousEditionRoot, join(inputDirectory, "previous-edition"), { recursive: true });
		for (const [index, draft] of input.draftRoots.entries()) {
			cpSync(draft, join(inputDirectory, "drafts", String(index + 1)), { recursive: true });
		}
	} catch (error) {
		// fail-open：Capture 无法准备时照常执行产品 Wiki Curator。
		recordCaseCaptureFailure("wiki-curator", error);
		return curate({ ...input, env });
	}
	return captureWikiExecution({
		agentId: "wiki-curator",
		recordDirectory: options.recordDirectory,
		runId: options.runId,
		inputDirectory,
		goal: input.goal,
		models,
		workDirectory: input.workRoot,
		logicalWorkspaces,
		signal: input.signal,
		execute: async () => curate({ ...input, env, logicalWorkspaceCaptureRoot: logicalWorkspaces }),
	});
}

export function createWikiShardReplayRecipe(options: {
	execute?: (input: WikiReplayExecutionInput) => Promise<WikiReplayExecutionResult>;
} = {}): NodeReplayRecipe {
	return wikiRecipe("wiki-shard-builder", options.execute ?? executeProductionWikiShardReplay);
}

export function createWikiCuratorReplayRecipe(options: {
	execute?: (input: WikiReplayExecutionInput) => Promise<WikiReplayExecutionResult>;
} = {}): NodeReplayRecipe {
	return wikiRecipe("wiki-curator", options.execute ?? executeProductionWikiCuratorReplay);
}

export const wikiShardReplayRecipe = createWikiShardReplayRecipe();
export const wikiCuratorReplayRecipe = createWikiCuratorReplayRecipe();

function wikiRecipe(
	agentId: WikiAgentId,
	execute: (input: WikiReplayExecutionInput) => Promise<WikiReplayExecutionResult>,
): NodeReplayRecipe {
	return {
		identity: { id: agentId, version: RECIPE_VERSION },
		async replay(input) {
			if (input.value.agentId !== agentId) throw new Error(`Node Case belongs to Agent '${input.value.agentId}'`);
			const sourceInputDirectory = join(dirname(input.casePath), "input");
			const caseInputDirectory = input.candidateCase
				? resetDirectory(join(input.recordDirectory, "node-evaluation", `${agentId}-replay-input`))
				: sourceInputDirectory;
			if (input.candidateCase) cpSync(sourceInputDirectory, caseInputDirectory, { recursive: true });
			if (agentId === "wiki-shard-builder" && input.candidateCase) validateWikiShardReplayGoalContext(caseInputDirectory);
			const logicalWorkspaceCaptureRoot = resetDirectory(join(input.recordDirectory, "node-evaluation", `${agentId}-logical-workspaces`));
			const executionInput: WikiReplayExecutionInput = {
				caseInputDirectory,
				harnessWorkspaceDirectory: input.harnessWorkspaceDirectory,
				recordDirectory: input.recordDirectory,
				workDirectory: input.workDirectory,
				artifactStore: input.artifactStore,
				logicalWorkspaceCaptureRoot,
				...(input.candidateCase ? { candidateCase: input.candidateCase } : {}),
				signal: input.signal,
			};
			const result = input.candidateCase
				? await captureWikiReplayExecution(agentId, executionInput, execute)
				: await execute(executionInput);
			return { caseId: input.value.caseId, agentId, ...result };
		},
	};
}

/** Validate the captured Goal context without supplementing or rewriting Case inputs. */
export function validateWikiShardReplayGoalContext(directory: string): void {
	const request = readJson<Record<string, unknown>>(join(directory, "request.json"));
	requireWikiGoalContext(request.goal_context);
}

async function executeProductionWikiShardReplay(input: WikiReplayExecutionInput): Promise<WikiReplayExecutionResult> {
	const request = readJson<{ goal: string; goal_context?: WikiGoalContext; batch: WikiShardInput["batch"]; models: FrozenWikiModels }>(
		join(input.caseInputDirectory, "request.json"),
	);
	const env = frozenWikiEnv(request.models);
	const result = await runPrimeNoteWikiMaintainer({
		goal: request.goal,
		goalContext: requireWikiGoalContext(request.goal_context),
		evidence: readJson<CornellNotesSnapshot>(join(input.caseInputDirectory, "evidence.json")),
		topicPlan: readJson<GoalTopicPlan>(join(input.caseInputDirectory, "topic-plan.json")),
		workRoot: input.workDirectory,
		sessionRoot: join(input.recordDirectory, "sessions"),
		batch: request.batch,
		signal: input.signal,
		env,
		skillWorkspaceDirectory: input.harnessWorkspaceDirectory,
		logicalWorkspaceCaptureRoot: input.logicalWorkspaceCaptureRoot,
	});
	return replayResult(result, input, "result", "wiki-shard-builder");
}

async function executeProductionWikiCuratorReplay(input: WikiReplayExecutionInput): Promise<WikiReplayExecutionResult> {
	const request = readJson<{
		operation: WikiCuratorOperation;
		goal: string;
		language?: ResolvedOutputLanguage;
		topic_plan: GoalTopicPlan;
		models: FrozenWikiModels;
		has_previous_edition: boolean;
		draft_count: number;
	}>(join(input.caseInputDirectory, "request.json"));
	const result = await curateWikiEdition({
		operation: request.operation,
		goal: request.goal,
		...(request.language ? { language: request.language } : {}),
		topicPlan: request.topic_plan,
		...(request.has_previous_edition ? { previousEditionRoot: join(input.caseInputDirectory, "previous-edition") } : {}),
		draftRoots: Array.from({ length: request.draft_count }, (_, index) =>
			join(input.caseInputDirectory, "drafts", String(index + 1))),
		workRoot: input.workDirectory,
		sessionRoot: join(input.recordDirectory, "sessions"),
		signal: input.signal,
		env: frozenWikiEnv(request.models),
		skillWorkspaceDirectory: input.harnessWorkspaceDirectory,
		logicalWorkspaceCaptureRoot: input.logicalWorkspaceCaptureRoot,
	});
	return replayResult(result, input, "result", "wiki-curator");
}

interface WikiCaptureInput {
	agentId: WikiAgentId;
	recordDirectory: string;
	runId: string;
	inputDirectory: string;
	goal: string;
	models: FrozenWikiModels;
	workDirectory: string;
	logicalWorkspaces?: string;
	signal: AbortSignal;
	capabilitySnapshotId?: string;
}

/**
 * 正式 Wiki 节点的 Capture。fail-open：Capture 准备或落盘失败只记录结构化警告，
 * 产品 Wiki 结果照常返回。Candidate Replay 的 fail-closed 路径是
 * `captureWikiReplayExecution`，不走这里。
 */
async function captureWikiExecution<T extends WikiShardResult | WikiCuratorResult>(input: WikiCaptureInput & {
	execute: () => Promise<T>;
}): Promise<T> {
	const workspace = emptyWorkspaceSnapshot();
	let draft: NodeEvaluationCaseDraft | undefined;
	let artifactStore: RunArtifactStore | undefined;
	try {
		mkdirSync(input.workDirectory, { recursive: true });
		await snapshotWorkspaceTree(workspace, "input", input.workDirectory);
		artifactStore = new RunArtifactStore(input.recordDirectory);
		const stage = captureRequest(input, artifactStore);
		draft = beginNodeEvaluationCase({
			request: stage,
			recordDirectory: input.recordDirectory,
			promptConfig: stage.promptConfig!,
			sessionContextFile: join(input.recordDirectory, `.missing-${input.agentId}-session`),
			composedSystemPrompt: "",
			actualModel: input.models.root,
			...(input.capabilitySnapshotId ? { capabilitySnapshotId: input.capabilitySnapshotId } : {}),
		});
	} catch (error) {
		recordCaseCaptureFailure(input.agentId, error);
	}
	if (!draft || !artifactStore) {
		mkdirSync(input.workDirectory, { recursive: true });
		return input.execute();
	}
	const startedAt = Date.now();
	let result: T;
	try {
		result = await input.execute();
	} catch (error) {
		try {
			await snapshotWorkspaceTree(workspace, "output", input.workDirectory);
			finishNodeEvaluationCase(draft, {
				status: input.signal.aborted ? "cancelled" : "failed",
				workDirectory: input.workDirectory,
				validationErrors: [],
				logicalWorkspaces: input.logicalWorkspaces,
				error: toErrorMessage(error),
				durationMs: Date.now() - startedAt,
				workspace,
			});
		} catch (captureError) {
			recordCaseCaptureFailure(input.agentId, captureError);
		}
		throw error;
	}
	try {
		await snapshotWorkspaceTree(workspace, "output", input.workDirectory);
		const artifact = publishWikiEvaluationOutput(result.knowledgeRoot, result, artifactStore,
			`artifacts/node-evaluation/${input.agentId}-${safe(input.runId)}`, input.agentId);
		const capture = finishNodeEvaluationCase(draft, {
			status: "succeeded",
			workDirectory: input.workDirectory,
			result: validatedResult(result, artifact, input.recordDirectory),
			validationErrors: [],
			traceDirectories: wikiTraceDirectories(input.workDirectory, input.agentId, result.sessionPaths),
			logicalWorkspaces: input.logicalWorkspaces,
			durationMs: Date.now() - startedAt,
			workspace,
		});
		if (capture.status !== "captured") recordCaseCaptureFailure(input.agentId, capture.reason);
	} catch (captureError) {
		recordCaseCaptureFailure(input.agentId, captureError);
	}
	return result;
}

function captureRequest(
	input: WikiCaptureInput,
	artifactStore: RunArtifactStore,
): AgentStageRequest<unknown> {
	return {
		runId: input.runId,
		stageId: input.agentId,
		attemptId: "1",
		attempt: 1,
		role: input.agentId.replaceAll("-", "_"),
		promptConfig: { domain: "wiki", id: input.agentId, sandboxRole: `wiki.${input.agentId}` as never },
		recordKind: "evaluation",
		evaluation: {
			agentId: input.agentId,
			recipe: { id: input.agentId, version: RECIPE_VERSION },
			recipeInput: {},
			inputRelativePath: relative(input.recordDirectory, input.inputDirectory).split(sep).join("/"),
			harnessMounts: [],
			liveExternalState: false,
		},
		session: { key: input.agentId, policy: "fresh" },
		modelPolicy: { preferred: [input.models.root], fallback: [], reasoning: input.models.thinking },
		systemPrompt: "",
		userPrompt: input.goal,
		workDirectory: input.workDirectory,
		readonlyMounts: [],
		controlDirectory: input.recordDirectory,
		recordDirectory: input.recordDirectory,
		artifactStore,
		output: { kind: "chapter", publishRelativePath: `artifacts/node-evaluation/${input.agentId}`, validate: () => ({}) },
		signal: input.signal,
	};
}

async function captureWikiReplayExecution(
	agentId: WikiAgentId,
	input: WikiReplayExecutionInput,
	execute: (input: WikiReplayExecutionInput) => Promise<WikiReplayExecutionResult>,
): Promise<WikiReplayExecutionResult> {
	if (!input.candidateCase) throw new Error(`${agentId} Candidate Replay Case metadata is required`);
	const request = readJson<{ goal: string; goal_context?: WikiGoalContext; models: FrozenWikiModels }>(join(input.caseInputDirectory, "request.json"));
	const goalContext = agentId === "wiki-shard-builder" ? requireWikiGoalContext(request.goal_context) : undefined;
	const captureInput: WikiCaptureInput = {
		agentId,
		recordDirectory: input.recordDirectory,
		runId: input.candidateCase.sourceRunId,
		inputDirectory: input.caseInputDirectory,
		goal: goalContext ? [goalContext.title, goalContext.description].filter(Boolean).join("\n\n") : request.goal,
		models: request.models,
		workDirectory: input.workDirectory,
		logicalWorkspaces: input.logicalWorkspaceCaptureRoot,
		signal: input.signal,
		capabilitySnapshotId: input.candidateCase.capabilitySnapshotId,
	};
	mkdirSync(input.workDirectory, { recursive: true });
	const workspace = emptyWorkspaceSnapshot();
	await snapshotWorkspaceTree(workspace, "input", input.workDirectory);
	const stage = captureRequest(captureInput, input.artifactStore);
	const draft = beginNodeEvaluationCase({
		request: stage,
		recordDirectory: input.recordDirectory,
		promptConfig: stage.promptConfig!,
		sessionContextFile: join(input.recordDirectory, `.missing-${agentId}-session`),
		composedSystemPrompt: "",
		actualModel: request.models.root,
		capabilitySnapshotId: input.candidateCase.capabilitySnapshotId,
	});
	if (!draft) throw new Error(`${agentId} Candidate Replay Case draft was not created`);
	const startedAt = Date.now();
	try {
		const result = await execute(input);
		await snapshotWorkspaceTree(workspace, "output", input.workDirectory);
		const capture = finishNodeEvaluationCase(draft, {
			status: "succeeded",
			workDirectory: input.workDirectory,
			result: validatedReplayResult(result, input.recordDirectory, input.workDirectory, agentId),
			validationErrors: [],
			traceDirectories: wikiTraceDirectories(input.workDirectory, agentId,
				listFilesRecursive(join(input.recordDirectory, "sessions"), { absolute: true, sort: false }).map(dirname)),
			logicalWorkspaces: input.logicalWorkspaceCaptureRoot,
			durationMs: Date.now() - startedAt,
			workspace,
		});
		if (capture.status !== "captured") throw new Error(capture.reason);
		return result;
	} catch (error) {
		await snapshotWorkspaceTree(workspace, "output", input.workDirectory);
		finishNodeEvaluationCase(draft, {
			status: input.signal.aborted ? "cancelled" : "failed",
			workDirectory: input.workDirectory,
			validationErrors: [],
			logicalWorkspaces: input.logicalWorkspaceCaptureRoot,
			error: toErrorMessage(error),
			durationMs: Date.now() - startedAt,
			workspace,
		});
		throw error;
	}
}

function wikiTraceDirectories(workDirectory: string, agentId: WikiAgentId, sessionPaths: string[]): string[] {
	return [...new Set([
		// Wiki Curator 的 Runtime 目录与 Worker Workspace 并列，避免 staged 凭证进入 Logical Workspace 快照。
		...(agentId === "wiki-curator" ? [join(workDirectory, "curator"), join(workDirectory, "curator-runtime")] : [join(workDirectory, "maintainer")]),
		...sessionPaths.filter(existsSync),
	])];
}

function validatedReplayResult(
	result: WikiReplayExecutionResult,
	recordDirectory: string,
	workDirectory: string,
	agentId: WikiAgentId,
): ValidatedStageArtifact<unknown> {
	const trace = listFilesRecursive(join(recordDirectory, "sessions"), { absolute: true, sort: false }).find((path) => path.endsWith(".jsonl"))
		?? listFilesRecursive(agentId === "wiki-curator" ? join(workDirectory, "curator-runtime") : join(workDirectory, "maintainer", "runtime"), { absolute: true, sort: false })
			.find((path) => path.endsWith(".jsonl"));
	return {
		value: result,
		artifact: result.artifact,
		submissionCount: 1,
		validationErrors: [],
		session: { id: "wiki", mode: "fresh" },
		turns: result.turns,
		toolCalls: result.toolCalls,
		toolCounts: {},
		usage: result.usage,
		sessionPath: trace ?? join(recordDirectory, ".missing-wiki-session"),
	};
}

function replayResult(
	result: WikiShardResult | WikiCuratorResult,
	input: WikiReplayExecutionInput,
	target: string,
	agentId: WikiAgentId,
): WikiReplayExecutionResult {
	return {
		artifact: publishWikiEvaluationOutput(result.knowledgeRoot, result, input.artifactStore, target, agentId),
		usage: result.usage,
		turns: result.usage.calls,
		toolCalls: countToolCalls(result.sessionPaths),
	};
}

function publishWikiEvaluationOutput(
	knowledgeRoot: string,
	result: Pick<WikiShardResult, "pageCount" | "usage" | "sessionPaths">,
	store: RunArtifactStore,
	target: string,
	agentId: WikiAgentId,
): PublishedArtifactDirectoryRef {
	const staging = mkdtempSync(join(dirname(knowledgeRoot), ".wiki-evaluation-"));
	try {
		cpSync(knowledgeRoot, join(staging, "knowledge"), { recursive: true });
		const markdown = listFilesRecursive(knowledgeRoot, { absolute: true, sort: false }).filter((path) => path.endsWith(".md"));
		const links = markdown.flatMap((path) => [...readFileSync(path, "utf-8").matchAll(/\[[^\]]+\]\(([^)]+\.md)\)/gu)]
			.map((match) => ({ path, target: match[1]! })));
		const brokenLinks = links.filter((link) => !existsSync(join(dirname(link.path), link.target))).length;
		const evidenceReferences = markdown.reduce((count, path) =>
			count + [...readFileSync(path, "utf-8").matchAll(/\[\^\d+\]/gu)].length, 0);
		writeFileSync(join(staging, "evaluation.json"), `${JSON.stringify({
			schema_version: 1,
			knowledge_sha256: hashWikiDirectory(knowledgeRoot),
			page_count: result.pageCount,
			markdown_file_count: markdown.length,
			internal_link_count: links.length,
			broken_link_count: brokenLinks,
			evidence_reference_count: evidenceReferences,
			usage: result.usage,
			tool_calls: countToolCalls(result.sessionPaths),
		}, null, 2)}\n`);
		cpSync(join(
			bundledAgentSkillPath("wiki", agentId, agentId),
			"references",
			"evaluation-rubric.md",
		), join(staging, "rubric.md"));
		return store.publishDirectory(staging, target, staging);
	} finally {
		rmSync(staging, { recursive: true, force: true });
	}
}

function validatedResult(
	result: WikiShardResult | WikiCuratorResult,
	artifact: PublishedArtifactDirectoryRef,
	sessionRoot: string,
): ValidatedStageArtifact<unknown> {
	return {
		value: result,
		artifact,
		submissionCount: 1,
		validationErrors: [],
		session: { id: "wiki", mode: "fresh" },
		turns: result.usage.calls,
		toolCalls: countToolCalls(result.sessionPaths),
		toolCounts: {},
		usage: result.usage,
		sessionPath: result.sessionPaths.flatMap((root) => listFilesRecursive(root, { absolute: true, sort: false })).find((path) => path.endsWith(".jsonl"))
			?? join(sessionRoot, ".missing-wiki-session"),
	};
}

interface FrozenWikiModels { root: string; child: string; thinking: ThinkingLevel }

function wikiModels(env: NodeJS.ProcessEnv): FrozenWikiModels {
	const root = resolveLLMConfig({
		envVarName: TASK_MODEL_ROLE_INFO.wikiMaintainer.legacyEnvVar,
		taskModelRole: "wikiMaintainer",
		envOverride: env,
	});
	if (!root.model) throw new Error("Wiki evaluation requires a configured Root model");
	return {
		root: root.model,
		child: resolvePrimeModel("primeChild", env).selector,
		thinking: resolveStageThinkingLevel("wikiMaintainer", "maintenance", env).thinkingLevel,
	};
}

function frozenWikiEnv(models: FrozenWikiModels): NodeJS.ProcessEnv {
	return {
		...process.env,
		TELOMI_WIKI_MAINTAINER_MODEL: models.root,
		TELOMI_PRIME_AGENT_CHILD_MODEL: models.child,
		TELOMI_WIKI_MAINTAINER_THINKING_LEVEL: models.thinking,
	};
}

function countToolCalls(roots: readonly string[]): number {
	let count = 0;
	for (const path of roots.flatMap((root) => listFilesRecursive(root, { absolute: true, sort: false })).filter((file) => file.endsWith(".jsonl"))) {
		for (const line of readFileSync(path, "utf-8").split(/\r?\n/u).filter(Boolean)) {
			try {
				const value = JSON.parse(line) as Record<string, unknown>;
				if (value.type === "tool_execution_start") count += 1;
				if (value.type === "message" && value.message && typeof value.message === "object") {
					const content = (value.message as { content?: unknown }).content;
					if (Array.isArray(content)) count += content.filter((item) =>
						item && typeof item === "object" && (item as { type?: unknown }).type === "toolCall").length;
				}
			} catch {
				// Ignore an incomplete final trace line.
			}
		}
	}
	return count;
}

function resetDirectory(path: string): string {
	rmSync(path, { recursive: true, force: true });
	mkdirSync(path, { recursive: true });
	return path;
}


function safe(value: string): string {
	return `${basename(value).replace(/[^A-Za-z0-9._-]/gu, "-")}-${sha256(value).slice(0, 8)}`;
}
