import { randomUUID } from "node:crypto";
import {
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, sep } from "node:path";
import { listFilesRecursive } from "../lib/fs.js";
import { fileURLToPath } from "node:url";

import { resolvePrimeAgentModels } from "../agent-runtime/model-policy.js";
import { snapshotSkills } from "../agent-runtime/skill-registry.js";
import { sha256 } from "../lib/hash.js";
import { loadResearchHarnessSnapshot } from "../research/harness/snapshot.js";
import { createHarnessResearchSourceRegistry } from "../research/sources/builtin-registry.js";
import {
	beginNodeEvaluationCase,
	finishNodeEvaluationCase,
	type NodeEvaluationCaseDraft,
	type NodeReplayRecipe,
} from "../agent-runtime/node-evaluation.js";
import { PrimeSearchBatchExecutor, primeProviderCatalog, primeSearchRootUserPrompt } from "../research/pipeline/prime-search-batch.js";
import type {
	SearchBatchExecutor,
	SearchBatchRequest,
	SearchBatchResult,
} from "../research/pipeline/search-batch.js";
import { RunArtifactStore, type PublishedArtifactDirectoryRef } from "../agent-runtime/artifact-store.js";
import type { AgentStageRequest, ValidatedStageArtifact } from "../agent-runtime/agent-stage-runtime.js";
import { appendRuntimeContext, readRuntimeRecords } from "../observability/run-records.js";
import { recordCaseCaptureFailure } from "../observability/case-capture.js";
import { emptyWorkspaceSnapshot } from "../agent-runtime/workspace-snapshot.js";
import { toErrorMessage } from "../lib/values.js";

import { isThinkingLevel, resolveStageThinkingLevel, type ThinkingLevel } from "../agent-runtime/model-config/resolve.js";

const LIVE_RECIPE_VERSION = 4;
const PRIME_SEARCH_EVALUATION_RUBRIC = fileURLToPath(new URL(
	"../../agents/research/prime-search/references/evaluation-rubric.md",
	import.meta.url,
));

/** Current input contract: Main-owned search question and direct research scope. */
interface CapturedPrimeSearchRequest {
	schema_version: 3;
	goal_id: string;
	run_id: string;
	sequence: number;
	question: string;
	scheduled_research?: SearchBatchRequest["scheduledResearch"];
	topic_plan?: SearchBatchRequest["topicPlan"];
	available_provider_ids: string[];
	temporal_context: SearchBatchRequest["temporalContext"];
	models: { root: string; child: string };
	thinking_level: ThinkingLevel;
	root_prompt_sha256: string;
}

export interface PrimeSearchReplayExecutionInput {
	caseInputDirectory: string;
	harnessWorkspaceDirectory: string;
	recordDirectory: string;
	workDirectory: string;
	artifactStore: RunArtifactStore;
	candidateCase?: { sourceRunId: string; capabilitySnapshotId: string };
	promptOverride?: { systemPrompt?: string; userPrompt?: string };
	signal: AbortSignal;
}

export interface PrimeSearchReplayExecutionResult {
	artifact: PublishedArtifactDirectoryRef | ReturnType<RunArtifactStore["publishText"]>;
	usage: { inputTokens: number; outputTokens: number; costUsd: number; calls: number };
	turns: number;
	toolCalls: number;
}

export function withPrimeSearchNodeEvaluationCapture(
	executor: SearchBatchExecutor,
	options: {
		availableProviders: ReturnType<typeof primeProviderCatalog>;
		env?: NodeJS.ProcessEnv;
		skillWorkspaceDirectory?: string;
		candidateCase?: { sourceRunId: string; capabilitySnapshotId: string };
		rootUserPromptOverride?: string;
	},
): SearchBatchExecutor {
	// Candidate Replay Evidence 必须 fail-closed；正式产品 Capture 必须 fail-open。
	const candidateEvidence = options.candidateCase !== undefined;
	const captureFailed = (reason: unknown): void => {
		if (candidateEvidence) throw reason instanceof Error ? reason : new Error(String(reason));
		recordCaseCaptureFailure("prime-search", reason);
	};
	return {
		async execute(request) {
			request = { ...request, attemptId: randomUUID() };
			const workspace = emptyWorkspaceSnapshot();
			const inputDirectory = join(request.controlDirectory, "node-evaluation", `prime-search-input-${request.sequence}`);
			const workDirectory = join(request.controlDirectory, "node-evaluation", `prime-search-work-${request.sequence}`);
			let draft: NodeEvaluationCaseDraft | undefined;
			let stageId = "prime-search";
			let reported = false;
			try {
				const models = resolvePrimeAgentModels(options.env ?? process.env);
				// Goal Skills that override a Provider worker Skill follow their Provider child, not the Root.
				const providerSkillNames = new Set(options.availableProviders
					.flatMap((provider) => provider.worker_interface.required_skills));
				const rootAgentSkills = snapshotSkills([
					join(options.skillWorkspaceDirectory ?? request.workspaceDirectory, "skills", "prime-search"),
				]).skills.filter((skill) => !providerSkillNames.has(skill.name))
					.map((skill) => `skills/root-agent/${skill.name}/SKILL.md`);
				const rootPrompt = options.rootUserPromptOverride ?? primeSearchRootUserPrompt({
					question: request.question,
					temporalContext: request.temporalContext,
					scheduledResearch: request.scheduledResearch,
					topicPlan: request.topicPlan,
					childModel: models.child.selector,
					availableProviders: options.availableProviders.filter((provider) => request.availableProviderIds.includes(provider.provider_id)),
					rootAgentSkills,
				});
				rmSync(inputDirectory, { recursive: true, force: true });
				mkdirSync(inputDirectory, { recursive: true });
				const captured: CapturedPrimeSearchRequest = {
					schema_version: 3,
					goal_id: request.goalId,
					run_id: request.runId,
					sequence: request.sequence,
					question: request.question,
					scheduled_research: request.scheduledResearch,
					topic_plan: request.topicPlan,
					available_provider_ids: [...request.availableProviderIds],
					temporal_context: request.temporalContext,
					models: { root: models.root.selector, child: models.child.selector },
					thinking_level: resolveStageThinkingLevel("primeRoot", "searchAcquisition", options.env ?? process.env).thinkingLevel,
					root_prompt_sha256: sha256(rootPrompt),
				};
				writeFileSync(join(inputDirectory, "request.json"), `${JSON.stringify(captured, null, 2)}\n`);
				writeFileSync(join(inputDirectory, "root-user-prompt.txt"), rootPrompt);
				mkdirSync(workDirectory, { recursive: true });
				const stageRequest = captureRequest(request, captured, rootPrompt, inputDirectory, workDirectory);
				if (options.candidateCase) stageRequest.runId = options.candidateCase.sourceRunId;
				stageId = stageRequest.stageId;
				draft = beginNodeEvaluationCase({
					request: stageRequest,
					recordDirectory: request.controlDirectory,
					promptConfig: stageRequest.promptConfig!,
					sessionContextFile: join(request.controlDirectory, ".missing-prime-search-session"),
					composedSystemPrompt: "",
					actualModel: captured.models.root,
					...(options.candidateCase ? { capabilitySnapshotId: options.candidateCase.capabilitySnapshotId } : {}),
				});
			} catch (error) {
				reported = true;
				captureFailed(error);
			}
			if (!draft) {
				if (!reported) captureFailed("Prime Search Node Evaluation draft was not created");
				return executor.execute(request);
			}
			const startedAt = Date.now();
			const logicalWorkspaces = join(inputDirectory, "logical-workspaces");
			let result: SearchBatchResult;
			try {
				result = await executor.execute({
					...request,
					workspaceSnapshot: workspace,
					logicalWorkspaceCaptureRoot: logicalWorkspaces,
				});
			} catch (error) {
				try {
					finishNodeEvaluationCase(draft, {
						status: request.signal.aborted ? "cancelled" : "failed",
						workDirectory,
						validationErrors: [],
						error: toErrorMessage(error),
						durationMs: Date.now() - startedAt,
						workspace,
					});
				} catch (captureError) {
					recordCaseCaptureFailure("prime-search", captureError);
				}
				throw error;
			} finally {
				rmSync(workDirectory, { recursive: true, force: true });
			}
			try {
				const artifact = publishPrimeSearchEvaluationOutput(result, request.controlDirectory, request.artifactStore,
					`artifacts/node-evaluation/prime-search-${request.sequence}`, logicalWorkspaces);
				const capture = finishNodeEvaluationCase(draft, {
					status: "succeeded",
					workDirectory,
					result: stageResult(result, artifact, request.controlDirectory, request.sequence),
					validationErrors: [],
					durationMs: Date.now() - startedAt,
					workspace,
				});
				if (capture.status !== "captured") {
					appendRuntimeContext(request.controlDirectory, "research", {
						type: "runtime.node_evaluation_capture_failed",
						stage_id: stageId,
						error: capture.reason,
					});
					captureFailed(capture.reason);
				}
			} finally {
				rmSync(inputDirectory, { recursive: true, force: true });
			}
			return result;
		},
	};
}

export function createLivePrimeSearchReplayRecipe(options: {
	execute?: (input: PrimeSearchReplayExecutionInput) => Promise<PrimeSearchReplayExecutionResult>;
} = {}): NodeReplayRecipe {
	return {
		identity: { id: "prime-search", version: LIVE_RECIPE_VERSION },
		async replay(input) {
			if (input.value.agentId !== "prime-search") throw new Error(`Node Case belongs to Agent '${input.value.agentId}'`);
			const result = await (options.execute ?? executeProductionLivePrimeSearchReplay)({
				caseInputDirectory: join(dirname(input.casePath), "input"),
				harnessWorkspaceDirectory: input.harnessWorkspaceDirectory,
				recordDirectory: input.recordDirectory,
				workDirectory: input.workDirectory,
				artifactStore: input.artifactStore,
				...(input.candidateCase ? { candidateCase: input.candidateCase } : {}),
				...(input.promptOverride ? { promptOverride: input.promptOverride } : {}),
				signal: input.signal,
			});
			return { caseId: input.value.caseId, agentId: "prime-search", ...result };
		},
	};
}

export const livePrimeSearchReplayRecipe = createLivePrimeSearchReplayRecipe();

async function executeProductionLivePrimeSearchReplay(
	input: PrimeSearchReplayExecutionInput,
): Promise<PrimeSearchReplayExecutionResult> {
	if (input.promptOverride?.systemPrompt) throw new Error("Prime Search replay does not accept systemPrompt override");
	const captured = readPrimeSearchRequest(input.caseInputDirectory);
	const harness = loadResearchHarnessSnapshot(input.harnessWorkspaceDirectory);
	const env: NodeJS.ProcessEnv = {
		...process.env,
		TELOMI_PRIME_AGENT_ROOT_MODEL: captured.models.root,
		TELOMI_PRIME_AGENT_CHILD_MODEL: captured.models.child,
		TELOMI_PRIME_SEARCH_THINKING_LEVEL: captured.thinking_level,
	};
	const registry = createHarnessResearchSourceRegistry(harness, env);
	// The Harness Snapshot already points at the immutable Candidate Skill copy, so no redirect applies.
	const executor = withPrimeSearchNodeEvaluationCapture(new PrimeSearchBatchExecutor(registry, harness, {
		env,
		...(input.promptOverride?.userPrompt ? { rootUserPromptOverride: input.promptOverride.userPrompt } : {}),
	}), {
		availableProviders: primeProviderCatalog(registry.catalog(), Object.fromEntries(
			registry.catalog().map((provider) => [provider.id, provider.workerSkills ?? []]),
		)),
		env,
		skillWorkspaceDirectory: input.harnessWorkspaceDirectory,
		...(input.candidateCase ? { candidateCase: input.candidateCase } : {}),
		...(input.promptOverride?.userPrompt ? { rootUserPromptOverride: input.promptOverride.userPrompt } : {}),
	});
	const result = await executor.execute({
		goalId: captured.goal_id,
		runId: captured.run_id,
		sequence: captured.sequence,
		question: captured.question,
		scheduledResearch: captured.scheduled_research,
		topicPlan: captured.topic_plan,
		availableProviderIds: captured.available_provider_ids,
		workspaceDirectory: input.recordDirectory,
		controlDirectory: input.recordDirectory,
		artifactStore: input.artifactStore,
		temporalContext: captured.temporal_context,
		organizerStorageRoot: join(input.recordDirectory, "source-history"),
		signal: input.signal,
	});
	return {
		artifact: publishPrimeSearchEvaluationOutput(result, input.recordDirectory, input.artifactStore, "result"),
		usage: result.usage,
		turns: result.usage.calls,
		toolCalls: result.toolCalls,
	};
}

function captureRequest(
	request: SearchBatchRequest,
	captured: CapturedPrimeSearchRequest,
	rootPrompt: string,
	inputDirectory: string,
	workDirectory: string,
): AgentStageRequest<unknown> {
	return {
		runId: request.runId,
		stageId: `prime-search-batch-${request.sequence}`,
		// Each resumed acquisition is a new attempt; an interrupted draft remains immutable.
		attemptId: request.attemptId!,
		attempt: 1,
		role: "prime_search",
		promptConfig: { domain: "research", id: "prime-search", sandboxRole: "research.prime_search" as never },
		recordKind: "research",
		evaluation: {
			agentId: "prime-search",
			recipe: { id: "prime-search", version: LIVE_RECIPE_VERSION },
			recipeInput: {},
			inputRelativePath: relative(request.controlDirectory, inputDirectory).split(sep).join("/"),
			harnessMounts: [],
			liveExternalState: true,
		},
		session: { key: "prime-search", policy: "fresh" },
		modelPolicy: { preferred: [captured.models.root], fallback: [captured.models.child], reasoning: captured.thinking_level },
		systemPrompt: "",
		userPrompt: rootPrompt,
		workDirectory,
		readonlyMounts: [],
		controlDirectory: request.controlDirectory,
		recordDirectory: request.controlDirectory,
		artifactStore: request.artifactStore,
		output: {
			kind: "source_bundle",
			publishRelativePath: `artifacts/node-evaluation/prime-search-${request.sequence}`,
			validate: () => ({}),
		},
		signal: request.signal,
	};
}

function stageResult(
	result: SearchBatchResult,
	artifact: PublishedArtifactDirectoryRef,
	sessionRoot: string,
	sequence: number,
): ValidatedStageArtifact<unknown> {
	return {
		value: result,
		artifact,
		submissionCount: 1,
		validationErrors: [],
		session: { id: "prime-search", mode: "fresh" },
		turns: result.usage.calls,
		toolCalls: result.toolCalls,
		toolCounts: {},
		usage: result.usage,
		sessionPath: findPrimeTrace(sessionRoot, sequence) ?? join(sessionRoot, ".missing-prime-search-session"),
	};
}

function publishPrimeSearchEvaluationOutput(
	result: SearchBatchResult,
	recordDirectory: string,
	store: RunArtifactStore,
	target: string,
	logicalWorkspaces?: string,
): PublishedArtifactDirectoryRef {
	const staging = mkdtempSync(join(recordDirectory, ".prime-search-evaluation-"));
	try {
		writeFileSync(join(staging, "result.json"), `${JSON.stringify({
			schema_version: 1,
			logical_sources: result.logicalSources.map(({ directoryPath: _directoryPath, ...source }) => source),
			execution_records: result.executionRecords.map(({ record }) => record),
			source_bundles: result.sourceBundles.map((bundle) => ({
				sha256: bundle.sha256,
				byte_length: bundle.byteLength,
				file_count: bundle.files.length,
			})),
			find_out_sources: {
				sha256: result.findOutSources.sha256,
				byte_length: result.findOutSources.byteLength,
				file_count: result.findOutSources.files.length,
			},
			usage: result.usage,
			tool_calls: result.toolCalls,
			agent_stages: result.agentStages,
		}, null, 2)}\n`);
		for (const [index, bundle] of result.sourceBundles.entries()) {
			cpSync(bundle.absolutePath, join(staging, "source-bundles", String(index + 1)), { recursive: true });
		}
		cpSync(result.findOutSources.absolutePath, join(staging, "find-out-sources"), { recursive: true });
		for (const [index, execution] of result.executionRecords.entries()) {
			mkdirSync(join(staging, "search-executions"), { recursive: true });
			cpSync(execution.artifact.absolutePath, join(staging, "search-executions", `${index + 1}.json`));
		}
		const decisions = findPrimeDecisions(recordDirectory);
		if (decisions) cpSync(decisions, join(staging, "decisions"), { recursive: true });
		if (logicalWorkspaces && existsSync(logicalWorkspaces)) {
			cpSync(logicalWorkspaces, join(staging, "logical-workspaces"), { recursive: true });
		}
		cpSync(PRIME_SEARCH_EVALUATION_RUBRIC, join(staging, "rubric.md"));
		sanitizeEvaluationJson(staging, recordDirectory);
		return store.publishDirectory(staging, target, staging);
	} finally {
		rmSync(staging, { recursive: true, force: true });
	}
}

function readPrimeSearchRequest(inputDirectory: string): CapturedPrimeSearchRequest {
	const value = JSON.parse(readFileSync(join(inputDirectory, "request.json"), "utf-8")) as CapturedPrimeSearchRequest;
	if (value.schema_version !== 3 || !value.question || !Array.isArray(value.available_provider_ids)
		|| !isThinkingLevel(value.thinking_level)
		|| !value.models?.root || !value.models.child || !/^[a-f0-9]{64}$/u.test(value.root_prompt_sha256)
		|| sha256(readFileSync(join(inputDirectory, "root-user-prompt.txt"))) !== value.root_prompt_sha256) {
		throw new Error("Prime Search Case request is invalid");
	}
	return value;
}

function findPrimeTrace(root: string, sequence: number): string | undefined {
	const event = [...readRuntimeRecords(root, "research")].reverse().find((value) =>
		value.type === "node_execution" && value.node_id === `prime-search-batch-${sequence}`);
	const path = typeof event?.trace_ref === "string" ? join(root, event.trace_ref) : undefined;
	return path && existsSync(path) ? path : undefined;
}

function findPrimeDecisions(root: string): string | undefined {
	const traceRoot = join(root, "prime-search-traces");
	if (!existsSync(traceRoot)) return undefined;
	return readdirSync(traceRoot, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => join(traceRoot, entry.name, "decisions"))
		.find(existsSync);
}

function sanitizeEvaluationJson(root: string, recordDirectory: string): void {
	for (const path of listFilesRecursive(root, { absolute: true, sort: false, strict: true }).filter((file) => {
		const ref = relative(root, file).split(sep).join("/");
		return ref === "result.json" || ref.startsWith("decisions/") || ref.startsWith("search-executions/");
	})) {
		let value: unknown;
		try { value = JSON.parse(readFileSync(path, "utf-8")); } catch { continue; }
		writeFileSync(path, `${JSON.stringify(sanitizeValue(value, recordDirectory), null, 2)}\n`);
	}
}

function sanitizeValue(value: unknown, recordDirectory: string): unknown {
	if (typeof value === "string") {
		if (value.startsWith(recordDirectory)) return `<RUN>/${relative(recordDirectory, value).split(sep).join("/")}`;
		if (value.startsWith("/")) return `<ABS>/${basename(value)}`;
		return value;
	}
	if (Array.isArray(value)) return value.map((item) => sanitizeValue(item, recordDirectory));
	if (!value || typeof value !== "object") return value;
	return Object.fromEntries(Object.entries(value as Record<string, unknown>)
		.map(([key, item]) => [key, sanitizeValue(item, recordDirectory)]));
}
