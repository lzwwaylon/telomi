import { isOutputLanguage, type ResolvedOutputLanguage } from "../../shared/languages.js";
import { isThinkingLevel, resolveStageThinkingLevel, type ThinkingLevel } from "../agent-runtime/model-config/resolve.js";
/**
 * Research Schedule Reviewer 的 Case Capture 与 Candidate Replay。
 *
 * Reviewer 的全部外部状态来自 Runtime 持有的桥：长期用户记忆与 Goal Wiki 的只读回答。
 * 正式执行把每一次桥调用连同答案冻结进 Case，Replay 再用同一份答案回答同名调用，
 * 因此 Candidate Replay 看到的记忆与 Wiki 与当时完全一致，也不需要任何 live 服务。
 */
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { pinTaskModelSelection, resolvePrimeModel } from "../agent-runtime/model-policy.js";
import { renderAgentPrompt } from "../agent-runtime/prompt-registry.js";
import type { AgentStageRequest, ValidatedStageArtifact } from "../agent-runtime/agent-stage-runtime.js";
import { readAgentToolBridgeCalls } from "../agent-runtime/agent-tool-bridge.js";
import { RunArtifactStore, type PublishedArtifactDirectoryRef } from "../agent-runtime/artifact-store.js";
import {
	beginNodeEvaluationCase,
	frozenInteractionLedger,
	readNodeEvaluationFile,
	type NodeEvaluationInteraction,
	type NodeReplayRecipe,
	finishNodeEvaluationCase,
	type NodeEvaluationCaseDraft,
} from "../agent-runtime/node-evaluation.js";
import type { ResearchModelUsage } from "../agent-runtime/model-usage.js";
import { readJson } from "../lib/fs.js";
import { toErrorMessage } from "../lib/values.js";
import { recordCaseCaptureFailure } from "../observability/case-capture.js";
import { parseScheduleReviewOutput, type ScheduleReviewOutput } from "../research/schedules/review-contract.js";
import {
	runPrimeScheduleReviewer,
	scheduleReviewRoot,
	scheduleReviewToolLog,
	SCHEDULE_REVIEW_RECENT_OCCURRENCES,
	type ReviewedSchedule,
	type ScheduleReviewToolAnswer,
	type ScheduleReviewer,
	type ScheduleReviewerInput,
} from "../research/schedules/reviewer.js";

export const SCHEDULE_REVIEWER_AGENT_ID = "schedule-reviewer";
export const SCHEDULE_REVIEWER_RECIPE_VERSION = 1;

const INPUT_DIRECTORY = "node-evaluation/schedule-reviewer-input";
const ARTIFACT_DIRECTORY = "artifacts/node-evaluation/schedule-reviewer";
const RUBRIC_FILE = fileURLToPath(new URL(
	"../../agents/research/schedule-reviewer/references/evaluation-rubric.md",
	import.meta.url,
));

interface FrozenScheduleReviewRequest {
	schema_version: 1;
	goal_id: string;
	review_id: string;
	schedule: ReviewedSchedule;
	language: ResolvedOutputLanguage;
	previous_review: unknown;
	models: { root: string; thinking: ThinkingLevel };
}

export interface ScheduleReviewCaptureOptions {
	/** The Reviewer to run. Product passes the Prime Reviewer; Replay and tests pass their own. */
	execute?: ScheduleReviewer;
	/** The deterministic output Contract, evaluated against the Schedule under review. */
	validate: (output: unknown) => ScheduleReviewOutput;
	/** Present during Candidate Replay, where missing Case evidence is fail-closed. */
	candidateCase?: { sourceRunId: string; capabilitySnapshotId: string };
	/** Where the Case tree is written. Defaults to the execution's own Review directory. */
	recordDirectory?: string;
	/** Where the decision is published. Defaults to the Case artifact tree. */
	artifactStore?: RunArtifactStore;
	env?: NodeJS.ProcessEnv;
}

export interface ScheduleReviewExecution {
	outcome: ScheduleReviewOutput;
	/** Absent only on the fail-open path, where no Case and no Case artifact exist. */
	artifact?: PublishedArtifactDirectoryRef;
	usage: ResearchModelUsage;
	turns: number;
	toolCalls: number;
}

/**
 * 正式 Capture 的 Hook。fail-open：Capture 不可用时照常执行 Reviewer 并校验契约，
 * 用户可见的 Review 结果不受影响。
 */
export async function runScheduleReviewNodeEvaluation(
	input: ScheduleReviewerInput,
	options: ScheduleReviewCaptureOptions,
): Promise<ScheduleReviewOutput> {
	return (await captureScheduleReview(input, options)).outcome;
}

export async function captureScheduleReview(
	input: ScheduleReviewerInput,
	options: ScheduleReviewCaptureOptions,
): Promise<ScheduleReviewExecution> {
	const execute = options.execute ?? runPrimeScheduleReviewer;
	const env = pinTaskModelSelection(["primeRoot"], options.env ?? input.env ?? process.env);
	// 现场（Trace、桥日志、Worker Workspace）与 Case 树在正式 Capture 时是同一个目录；
	// Candidate Replay 把现场放在这次执行的 work 目录里，Case 仍然写在执行记录目录下。
	const executionRoot = input.root ?? scheduleReviewRoot(input.goalId, input.workspaceDir, input.reviewId);
	const recordDirectory = options.recordDirectory ?? executionRoot;
	let draft: NodeEvaluationCaseDraft | undefined;
	let artifactStore: RunArtifactStore | undefined;
	try {
		artifactStore = options.artifactStore ?? new RunArtifactStore(recordDirectory);
		const inputDirectory = resetDirectory(join(recordDirectory, INPUT_DIRECTORY));
		const frozen: FrozenScheduleReviewRequest = {
			schema_version: 1,
			goal_id: input.goalId,
			review_id: input.reviewId,
			schedule: {
				id: input.schedule.id,
				question: input.schedule.question,
				monitoringScope: input.schedule.monitoringScope,
				reportContext: input.schedule.reportContext,
				// 只冻结 Reviewer 真正看到的那几条 occurrence。
				runs: input.schedule.runs.slice(0, SCHEDULE_REVIEW_RECENT_OCCURRENCES),
			},
			language: input.language,
			previous_review: input.previousReview ?? null,
			models: { root: resolvePrimeModel("primeRoot", env).selector, thinking: resolveStageThinkingLevel("primeRoot", "scheduleReview", env).thinkingLevel },
		};
		writeFileSync(join(inputDirectory, "request.json"), `${JSON.stringify(frozen, null, 2)}\n`);
		const stage = captureRequest({
			input,
			frozen,
			recordDirectory,
			executionRoot,
			inputDirectory,
			artifactStore,
			...(options.candidateCase ? { candidateCase: options.candidateCase } : {}),
		});
		draft = beginNodeEvaluationCase({
			request: stage,
			recordDirectory,
			promptConfig: stage.promptConfig!,
			sessionContextFile: join(recordDirectory, ".missing-schedule-reviewer-session"),
			composedSystemPrompt: stage.systemPrompt,
			actualModel: frozen.models.root,
			...(options.candidateCase ? { capabilitySnapshotId: options.candidateCase.capabilitySnapshotId } : {}),
		});
	} catch (error) {
		reportCaptureFailure(error, options.candidateCase);
	}
	if (!draft || !artifactStore) {
		const outcome = options.validate(await execute({ ...input, env }));
		return { outcome, usage: emptyUsage(), turns: 0, toolCalls: 0 };
	}
	const startedAt = Date.now();
	const store = artifactStore;
	const settledDraft = draft;
	let raw: unknown;
	try {
		raw = await execute({ ...input, env });
	} catch (error) {
		finish(settledDraft, executionRoot, {
			status: input.signal.aborted ? "cancelled" : "failed",
			error: toErrorMessage(error),
			validationErrors: [],
			durationMs: Date.now() - startedAt,
		});
		throw error;
	}
	let outcome: ScheduleReviewOutput;
	try {
		outcome = options.validate(raw);
	} catch (error) {
		// 契约违规是 fail closed 的终态：没有 Observed 输出，现场与理由留作 Recovery 证据。
		finish(settledDraft, executionRoot, {
			status: "failed",
			error: toErrorMessage(error),
			validationErrors: [toErrorMessage(error)],
			durationMs: Date.now() - startedAt,
		});
		throw error;
	}
	const interactions = readScheduleReviewInteractions(executionRoot);
	const metrics = readReviewMetrics(executionRoot);
	const artifact = publishReviewDecision(outcome, store, recordDirectory);
	const execution: ScheduleReviewExecution = {
		outcome,
		artifact,
		usage: metrics,
		turns: metrics.calls,
		toolCalls: interactions.length,
	};
	try {
		const capture = finishNodeEvaluationCase(settledDraft, {
			status: "succeeded",
			workDirectory: join(executionRoot, "agent"),
			result: validatedResult(execution, executionRoot),
			validationErrors: [],
			interactions,
			traceDirectories: [join(executionRoot, "runtime"), join(executionRoot, "agent")],
			durationMs: Date.now() - startedAt,
		});
		if (capture.status !== "captured") throw new Error(capture.reason);
	} catch (captureError) {
		reportCaptureFailure(captureError, options.candidateCase);
	}
	return execution;
}

export function createScheduleReviewerReplayRecipe(options: {
	execute?: ScheduleReviewer;
} = {}): NodeReplayRecipe {
	return {
		identity: { id: SCHEDULE_REVIEWER_AGENT_ID, version: SCHEDULE_REVIEWER_RECIPE_VERSION },
		async replay(input) {
			if (input.value.agentId !== SCHEDULE_REVIEWER_AGENT_ID) {
				throw new Error(`Node Case belongs to Agent '${input.value.agentId}'`);
			}
			const request = readJson<FrozenScheduleReviewRequest>(
				join(dirname(input.casePath), "input", "request.json"),
			);
			if (!isThinkingLevel(request.models?.thinking)) throw new Error("Schedule Review Case requires a valid thinking level");
			const language: unknown = request.language;
			if (!isOutputLanguage(language) || language === "auto") throw new Error("Schedule Review Case requires a resolved output language");
			const interactions = input.value.request.interactions
				? JSON.parse(readNodeEvaluationFile(input.casePath, input.value.request.interactions)) as NodeEvaluationInteraction[]
				: [];
			const root = join(input.workDirectory, "research", "schedule-reviews", request.review_id);
			const execution = await captureScheduleReview({
				goalId: request.goal_id,
				workspaceDir: input.workDirectory,
				reviewId: request.review_id,
				schedule: request.schedule,
				language: request.language,
				previousReview: request.previous_review,
				signal: input.signal,
				root,
				answerTool: frozenScheduleReviewAnswer(interactions),
				env: { ...process.env, TELOMI_PRIME_AGENT_ROOT_MODEL: request.models.root, TELOMI_SCHEDULE_REVIEW_THINKING_LEVEL: request.models.thinking },
			}, {
				...(options.execute ? { execute: options.execute } : {}),
				// Replay 用产品同一份契约判断 Candidate，冻结的 Schedule 就是它的当前值。
				validate: (output) => parseScheduleReviewOutput(output, request.schedule),
				...(input.candidateCase ? { candidateCase: input.candidateCase } : {}),
				recordDirectory: input.recordDirectory,
				artifactStore: input.artifactStore,
			});
			if (!execution.artifact) throw new Error("Research Schedule Review Replay published no decision artifact");
			return {
				caseId: input.value.caseId,
				agentId: SCHEDULE_REVIEWER_AGENT_ID,
				artifact: execution.artifact,
				usage: execution.usage,
				turns: execution.turns,
				toolCalls: execution.toolCalls,
			};
		},
	};
}

export const scheduleReviewerReplayRecipe = createScheduleReviewerReplayRecipe();

/** 冻结回答：Case 里记录的那一次调用，回答同名同参的那一次调用。 */
function frozenScheduleReviewAnswer(interactions: readonly NodeEvaluationInteraction[]): ScheduleReviewToolAnswer {
	const answer = frozenInteractionLedger(interactions);
	return async (operation, args) => answer(operation, args);
}

/**
 * 决定与 Rubric 一起发布，Observed 与 Candidate 因此形状相同：匿名评审者拿到的每一侧
 * 都自带这次判断该用的标准，不必回到仓库里找。
 */
function publishReviewDecision(
	outcome: ScheduleReviewOutput,
	store: RunArtifactStore,
	recordDirectory: string,
): PublishedArtifactDirectoryRef {
	const staging = mkdtempSync(join(recordDirectory, ".schedule-review-evaluation-"));
	try {
		writeFileSync(join(staging, "decision.json"), `${JSON.stringify(outcome, null, 2)}\n`);
		cpSync(RUBRIC_FILE, join(staging, "rubric.md"));
		return store.publishDirectory(staging, ARTIFACT_DIRECTORY, staging);
	} finally {
		rmSync(staging, { recursive: true, force: true });
	}
}

/** Every bridged memory and Wiki read of this execution, in the order the Reviewer made them. */
export function readScheduleReviewInteractions(executionRoot: string): NodeEvaluationInteraction[] {
	return readAgentToolBridgeCalls(scheduleReviewToolLog(executionRoot)).map((call) => ({
		kind: "tool",
		name: call.operation,
		label: call.operation,
		description: `Research Schedule Review ${call.operation}`,
		arguments: call.args,
		result: call.value,
	}));
}

/** Candidate Evidence 是 fail-closed 的；正式 Capture 只记录健康度，产品结果不受影响。 */
function reportCaptureFailure(error: unknown, candidateCase?: { capabilitySnapshotId: string }): void {
	if (candidateCase) throw error;
	recordCaseCaptureFailure(SCHEDULE_REVIEWER_AGENT_ID, error);
}

function captureRequest(context: {
	input: ScheduleReviewerInput;
	frozen: FrozenScheduleReviewRequest;
	recordDirectory: string;
	executionRoot: string;
	inputDirectory: string;
	artifactStore: RunArtifactStore;
	candidateCase?: { sourceRunId: string; capabilitySnapshotId: string };
}): AgentStageRequest<unknown> {
	const { input, frozen, recordDirectory, executionRoot, inputDirectory, artifactStore, candidateCase } = context;
	return {
		runId: candidateCase?.sourceRunId ?? input.reviewId,
		stageId: SCHEDULE_REVIEWER_AGENT_ID,
		attemptId: "1",
		attempt: 1,
		role: "schedule_reviewer",
		promptConfig: { domain: "research", id: "schedule-reviewer", sandboxRole: "research.schedule-reviewer" as never },
		recordKind: "evaluation",
		evaluation: {
			agentId: SCHEDULE_REVIEWER_AGENT_ID,
			recipe: { id: SCHEDULE_REVIEWER_AGENT_ID, version: SCHEDULE_REVIEWER_RECIPE_VERSION },
			recipeInput: {},
			inputRelativePath: relative(recordDirectory, inputDirectory).split(sep).join("/"),
			harnessMounts: [],
			...(candidateCase ? { capabilitySnapshotId: candidateCase.capabilitySnapshotId } : {}),
			liveExternalState: false,
		},
		session: { key: SCHEDULE_REVIEWER_AGENT_ID, policy: "fresh" },
		modelPolicy: { preferred: [frozen.models.root], fallback: [], reasoning: frozen.models.thinking },
		systemPrompt: renderAgentPrompt("research", "schedule-reviewer", "system-append").content,
		userPrompt: renderAgentPrompt("research", "schedule-reviewer", "user").content,
		workDirectory: join(executionRoot, "agent"),
		readonlyMounts: [],
		controlDirectory: recordDirectory,
		recordDirectory,
		artifactStore,
		output: {
			kind: "json_candidate",
			publishRelativePath: "artifacts/node-evaluation/schedule-reviewer",
			validate: () => ({}),
		},
		signal: input.signal,
	};
}

function finish(
	draft: NodeEvaluationCaseDraft,
	executionRoot: string,
	input: {
		status: "failed" | "cancelled";
		error: string;
		validationErrors: string[];
		durationMs: number;
	},
): void {
	try {
		finishNodeEvaluationCase(draft, {
			...input,
			workDirectory: join(executionRoot, "agent"),
			sessionPath: join(executionRoot, "runtime", "root-events.jsonl"),
			interactions: readScheduleReviewInteractions(executionRoot),
			traceDirectories: [join(executionRoot, "runtime"), join(executionRoot, "agent")],
		});
	} catch (error) {
		recordCaseCaptureFailure(SCHEDULE_REVIEWER_AGENT_ID, error);
	}
}

function validatedResult(
	execution: ScheduleReviewExecution,
	executionRoot: string,
): ValidatedStageArtifact<unknown> {
	return {
		value: execution.outcome,
		artifact: execution.artifact!,
		submissionCount: 1,
		validationErrors: [],
		session: { id: SCHEDULE_REVIEWER_AGENT_ID, mode: "fresh" },
		turns: execution.turns,
		toolCalls: execution.toolCalls,
		toolCounts: {},
		usage: execution.usage,
		sessionPath: join(executionRoot, "runtime", "root-events.jsonl"),
	};
}

function readReviewMetrics(executionRoot: string): ResearchModelUsage {
	try {
		const value = readJson<{ usage?: { input_tokens?: number; output_tokens?: number; cost_usd?: number; model_calls?: number } }>(
			join(executionRoot, "runtime", "result.json"),
		);
		return {
			inputTokens: value.usage?.input_tokens ?? 0,
			outputTokens: value.usage?.output_tokens ?? 0,
			costUsd: value.usage?.cost_usd ?? 0,
			calls: value.usage?.model_calls ?? 0,
		};
	} catch {
		return emptyUsage();
	}
}

function emptyUsage(): ResearchModelUsage {
	return { inputTokens: 0, outputTokens: 0, costUsd: 0, calls: 0 };
}

function resetDirectory(path: string): string {
	rmSync(path, { recursive: true, force: true });
	mkdirSync(path, { recursive: true });
	return path;
}
