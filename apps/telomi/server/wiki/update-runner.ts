import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { LlmWikiCompiler } from "./compiler.js";
import type { GoalTopicPlan, WikiCompilationRequest, WikiCompilationResult, WikiGoalContext } from "./contracts.js";
import {
	canResumeWikiUpdateJob,
	MAX_WIKI_UPDATE_ATTEMPTS,
	WIKI_UPDATE_JOB_FILE,
	WikiUpdateJobStore,
	type WikiUpdateJob,
} from "./wiki-update-job.js";
import { RunArtifactStore } from "../agent-runtime/artifact-store.js";
import { serverRuntimeDirForGoal } from "../workspaces/server-runtime-paths.js";
import { publishCompilation } from "./publication.js";
import { toErrorMessage } from "../lib/values.js";

export interface WikiUpdateExecution {
	status: "succeeded" | "partial";
	compilationId: string;
	pageCount: number;
	publicationStatus: string;
	changedPaths: string[];
	usage: WikiCompilationResult["usage"];
	failedBatches: NonNullable<WikiCompilationResult["failedBatches"]>;
}

export interface WikiUpdateTarget {
	goalId: string;
	runId: string;
	goal: string;
	goalContext: WikiGoalContext;
	topicPlan: GoalTopicPlan;
	/** Goal Workspace 目录，Wiki 的发布目标。 */
	goalDir: string;
	/** 数据根目录，发布锁与审计记录挂在它下面。 */
	workspaceDir: string;
	/** Run 的产物目录，Cornell Notes 与编译产物都在这里。 */
	runDirectory: string;
	/** Run 的控制目录，可变的运行状态写在这里。 */
	controlDirectory: string;
	cornellNotes: WikiUpdateJob["cornell_notes"];
	wikiUpdateId?: string;
	sourceRunId?: string;
	parentActivityId?: string;
	trigger?: NonNullable<WikiUpdateJob["trigger"]>;
	reason?: string;
	rebuild?: boolean;
}

export type StartedWikiUpdate =
	| { wikiUpdateId: string; reused: true; status: WikiUpdateJob["status"] }
	| { wikiUpdateId: string; reused: false; execution: Promise<WikiUpdateExecution> };

export interface WikiUpdateDependencies {
	compile?: (request: WikiCompilationRequest) => Promise<WikiCompilationResult>;
	publish?: typeof publishCompilation;
}

const RESULT_ARTIFACT = "artifacts/wiki-update/result.json";

/**
 * 执行一次 Wiki 更新，并在任务记录里留下它的开始与结束。
 *
 * Run 首次触发和重启后的续跑走同一条路径：编译器按批次自带续跑，发布是内容寻址的原子提交，
 * 所以重复执行同一个任务只会补上没做完的部分。
 */
export async function executeWikiUpdate(input: WikiUpdateTarget & {
	env: Record<string, string | undefined>;
	signal: AbortSignal;
	dependencies?: WikiUpdateDependencies;
	onSettled?: (status: WikiUpdateJob["status"], message?: string) => void;
}): Promise<WikiUpdateExecution> {
	const jobs = new WikiUpdateJobStore(input.controlDirectory);
	let publicationStarted = false;
	let publicationPageCount = 0;
	jobs.start({
		goalId: input.goalId,
		runId: input.runId,
		goal: input.goal,
		goalContext: input.goalContext,
		topicPlan: input.topicPlan,
		cornellNotes: input.cornellNotes,
		...(input.wikiUpdateId ? { wikiUpdateId: input.wikiUpdateId } : {}),
		...(input.sourceRunId ? { sourceRunId: input.sourceRunId } : {}),
		...(input.parentActivityId ? { parentActivityId: input.parentActivityId } : {}),
		...(input.trigger ? { trigger: input.trigger } : {}),
		...(input.reason ? { reason: input.reason } : {}),
		...(input.rebuild !== undefined ? { rebuild: input.rebuild } : {}),
	});
	try {
		const compile = input.dependencies?.compile
			?? ((request: WikiCompilationRequest) => new LlmWikiCompiler().compile(request));
		const publish = input.dependencies?.publish ?? publishCompilation;
		const compilation = await compile({
			env: input.env,
			goalDir: input.goalDir,
			goal: input.goal,
			goalContext: input.goalContext,
			runId: input.runId,
			runDirectory: input.runDirectory,
			controlDirectory: input.controlDirectory,
			cornellNotesSnapshot: input.cornellNotes,
			topicPlan: input.topicPlan,
			...(input.rebuild ? { rebuild: true } : {}),
			signal: input.signal,
			onStarted: (totalBatches) => jobs.markRunning(totalBatches),
			onBatchProgress: (progress) => jobs.recordBatch(progress),
			onStageProgress: (progress) => jobs.recordStage(progress),
		});
		publicationPageCount = compilation.pageCount;
		jobs.recordStage({
			kind: "publication",
			stageIndex: 0,
			totalStages: 1,
			status: "running",
			pageCount: compilation.pageCount,
			usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, calls: 0 },
		});
		publicationStarted = true;
		const publication = await publish({
			goalId: input.goalId,
			goalDir: input.goalDir,
			workspaceDir: input.workspaceDir,
			compilation,
			env: input.env,
			signal: input.signal,
		});
		jobs.recordStage({
			kind: "publication",
			stageIndex: 0,
			totalStages: 1,
			status: "succeeded",
			pageCount: compilation.pageCount,
			usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, calls: 0 },
		});
		const execution: WikiUpdateExecution = {
			status: compilation.failedBatches.length ? "partial" : "succeeded",
			compilationId: compilation.compilationId,
			pageCount: compilation.pageCount,
			publicationStatus: publication.status,
			changedPaths: publication.changedPaths,
			usage: compilation.usage,
			failedBatches: compilation.failedBatches,
		};
		// 结果产物是不可变的：上一次可能已经写过它，但没来得及结算任务记录。
		if (!existsSync(join(input.runDirectory, RESULT_ARTIFACT))) {
			new RunArtifactStore(input.runDirectory).publishText(`${JSON.stringify({
				schema_version: 1,
				status: execution.status,
				compilation_id: execution.compilationId,
				publication_status: execution.publicationStatus,
				page_count: execution.pageCount,
				changed_paths: execution.changedPaths,
				usage: execution.usage,
				failed_batches: execution.failedBatches,
				finished_at: new Date().toISOString(),
			}, null, 2)}\n`, RESULT_ARTIFACT);
		}
		jobs.settle(execution.status, {
			compilationId: execution.compilationId,
			publicationStatus: publication.status,
			changedPaths: publication.changedPaths,
			failedBatches: execution.failedBatches.map((failure) => ({
				batch_index: failure.batchIndex,
				source_ids: failure.sourceIds,
				message: failure.message,
				usage: {
					input_tokens: failure.usage.inputTokens,
					output_tokens: failure.usage.outputTokens,
					cost_usd: failure.usage.costUsd,
					model_calls: failure.usage.calls,
				},
			})),
			...(execution.status === "partial" ? {
				message: `Wiki 已发布，但 ${execution.failedBatches.length} 个 Source 批次失败。`,
			} : {}),
		});
		input.onSettled?.(execution.status);
		return execution;
	} catch (error) {
		const message = toErrorMessage(error);
		const status = input.signal.aborted ? "cancelled" as const : "failed" as const;
		if (publicationStarted) jobs.recordStage({
			kind: "publication",
			stageIndex: 0,
			totalStages: 1,
			status: "failed",
			pageCount: publicationPageCount,
			usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, calls: 0 },
			message,
		});
		jobs.settle(status, { message });
		if (!existsSync(join(input.runDirectory, RESULT_ARTIFACT))) {
			new RunArtifactStore(input.runDirectory).publishText(`${JSON.stringify({
				schema_version: 1,
				status,
				message,
				finished_at: new Date().toISOString(),
			}, null, 2)}\n`, RESULT_ARTIFACT);
		}
		input.onSettled?.(status, message);
		throw error;
	}
}

/**
 * 创建一条独立 Wiki Update Activity。输入快照复制到自己的不可变 Artifact Store，
 * 后续执行、续跑和回放不再依赖 Research Run 的生命周期。
 */
export function startWikiUpdateActivity(input: {
	workspaceDir: string;
	goalId: string;
	goalDir: string;
	goal: string;
	goalContext: WikiGoalContext;
	topicPlan: GoalTopicPlan;
	sourceRunId?: string;
	sourceRunDirectory: string;
	cornellNotes: WikiUpdateJob["cornell_notes"];
	parentActivityId?: string;
	trigger: NonNullable<WikiUpdateJob["trigger"]>;
	reason: string;
	rebuild?: boolean;
	env: Record<string, string | undefined>;
	signal?: AbortSignal;
	dependencies?: WikiUpdateDependencies;
}): StartedWikiUpdate {
	if (input.sourceRunId && !input.rebuild) {
		const matches = listWikiUpdateJobs(input.workspaceDir, input.goalId)
			.flatMap((entry) => {
				const job = new WikiUpdateJobStore(entry.controlDirectory).load();
				return job
					&& job.source_run_id === input.sourceRunId
					&& job.topic_plan.revision === input.topicPlan.revision
					&& job.goal_context.title === input.goalContext.title
					&& job.goal_context.description === input.goalContext.description
					&& job.cornell_notes.sha256 === input.cornellNotes.sha256
					? [{ ...entry, job }]
					: [];
			})
			.sort((left, right) => right.job.started_at.localeCompare(left.job.started_at));
		const existing = matches.find(({ job }) => ["queued", "running", "succeeded"].includes(job.status));
		if (existing) {
			return {
				wikiUpdateId: existing.job.wiki_update_id ?? existing.runId,
				reused: true,
				status: existing.job.status,
			};
		}
		const failed = matches.find(({ job }) => job.status === "failed" && job.attempts < MAX_WIKI_UPDATE_ATTEMPTS
			&& existsSync(join(wikiUpdateArtifactDir(input.goalDir, job.wiki_update_id ?? job.run_id), job.cornell_notes.relative_path)));
		if (failed) {
			const wikiUpdateId = failed.job.wiki_update_id ?? failed.runId;
			return {
				wikiUpdateId,
				reused: false,
				execution: executeWikiUpdate({
					goalId: input.goalId,
					runId: wikiUpdateId,
					wikiUpdateId,
					sourceRunId: input.sourceRunId,
					...(input.parentActivityId ? { parentActivityId: input.parentActivityId } : {}),
					trigger: input.trigger,
					reason: input.reason,
					goal: input.goal,
					goalContext: input.goalContext,
					topicPlan: input.topicPlan,
					goalDir: input.goalDir,
					workspaceDir: input.workspaceDir,
					runDirectory: wikiUpdateArtifactDir(input.goalDir, wikiUpdateId),
					controlDirectory: failed.controlDirectory,
					cornellNotes: failed.job.cornell_notes,
					env: input.env,
					signal: input.signal ?? new AbortController().signal,
					...(input.dependencies ? { dependencies: input.dependencies } : {}),
				}),
			};
		}
	}
	const wikiUpdateId = `wiki_${Date.now().toString(36)}${randomUUID().replaceAll("-", "").slice(0, 8)}`;
	const controlDirectory = wikiUpdateRecordDir(input.workspaceDir, input.goalId, wikiUpdateId);
	const runDirectory = wikiUpdateArtifactDir(input.goalDir, wikiUpdateId);
	mkdirSync(controlDirectory, { recursive: true });
	mkdirSync(runDirectory, { recursive: true });
	const source = new RunArtifactStore(input.sourceRunDirectory).openFile(input.cornellNotes);
	const copied = new RunArtifactStore(runDirectory).publishFile(source.absolutePath, "artifacts/input/cornell-notes.json");
	const execution = executeWikiUpdate({
		goalId: input.goalId,
		runId: wikiUpdateId,
		wikiUpdateId,
		...(input.sourceRunId ? { sourceRunId: input.sourceRunId } : {}),
		...(input.parentActivityId ? { parentActivityId: input.parentActivityId } : {}),
		trigger: input.trigger,
		reason: input.reason,
		...(input.rebuild ? { rebuild: true } : {}),
		goal: input.goal,
		goalContext: input.goalContext,
		topicPlan: input.topicPlan,
		goalDir: input.goalDir,
		workspaceDir: input.workspaceDir,
		runDirectory,
		controlDirectory,
		cornellNotes: {
			relative_path: copied.relativePath,
			sha256: copied.sha256,
			byte_length: copied.byteLength,
		},
		env: input.env,
		signal: input.signal ?? new AbortController().signal,
		...(input.dependencies ? { dependencies: input.dependencies } : {}),
	});
	return { wikiUpdateId, reused: false, execution };
}

/**
 * 后端启动时把上一次没跑完的 Wiki 更新标成中断，让它成为可续跑的任务。
 */
export function markInterruptedWikiUpdates(workspaceDir: string, goalId: string): string[] {
	return listWikiUpdateJobs(workspaceDir, goalId)
		.filter((entry) => new WikiUpdateJobStore(entry.controlDirectory).markInterrupted())
		.map((entry) => entry.runId);
}

/**
 * 续跑一个中断的 Wiki 更新。
 *
 * Wiki 更新脱离 Run 主链路，它的中断只有任务记录能证明，因此由用户在活动流里显式继续，
 * Runtime 不替用户决定要不要再烧一次 token。
 */
export async function resumeWikiUpdate(input: {
	workspaceDir: string;
	goalId: string;
	goalDir: string;
	runId: string;
	env: Record<string, string | undefined>;
	signal?: AbortSignal;
	dependencies?: WikiUpdateDependencies;
}): Promise<WikiUpdateExecution> {
	const controlDirectory = wikiUpdateRecordDir(input.workspaceDir, input.goalId, input.runId);
	const job = new WikiUpdateJobStore(controlDirectory).load();
	if (!job) throw new Error("Unknown Wiki update");
	if (!canResumeWikiUpdateJob(job)) {
		throw new Error(job.status === "interrupted"
			? `Wiki update reached the resume attempt limit of ${MAX_WIKI_UPDATE_ATTEMPTS}`
			: "Wiki update has no resumable checkpoint");
	}
	return executeWikiUpdate({
		goalId: input.goalId,
		runId: input.runId,
		goal: job.goal,
		goalContext: job.goal_context,
		topicPlan: job.topic_plan,
		goalDir: input.goalDir,
		workspaceDir: input.workspaceDir,
		runDirectory: wikiUpdateArtifactDir(input.goalDir, input.runId),
		controlDirectory,
		cornellNotes: job.cornell_notes,
		...(job.rebuild ? { rebuild: true } : {}),
		env: input.env,
		signal: input.signal ?? new AbortController().signal,
		...(input.dependencies ? { dependencies: input.dependencies } : {}),
	});
}

function listWikiUpdateJobs(workspaceDir: string, goalId: string): Array<{
	runId: string;
	controlDirectory: string;
}> {
	const root = wikiUpdateRecordsDir(workspaceDir, goalId);
	return !existsSync(root) ? [] : readdirSync(root, { withFileTypes: true })
		.filter((entry) => entry.isDirectory() && existsSync(join(root, entry.name, WIKI_UPDATE_JOB_FILE)))
		.flatMap((entry) => {
			const controlDirectory = join(root, entry.name);
			try {
				// Discovery must isolate incompatible history. Explicit resume still uses strict load().
				return new WikiUpdateJobStore(controlDirectory).load()
					? [{ runId: entry.name, controlDirectory }] : [];
			} catch (error) {
				console.warn(`[telomi][wiki] skipped unreadable job ${goalId}/${entry.name}: ${
					toErrorMessage(error)}`);
				return [];
			}
		});
}

export function wikiUpdateRecordsDir(workspaceDir: string, goalId: string): string {
	return join(serverRuntimeDirForGoal(goalId, workspaceDir), "wiki-updates");
}

export function hasActiveWikiUpdate(workspaceDir: string, goalId: string): boolean {
	return listWikiUpdateJobs(workspaceDir, goalId).some(({ controlDirectory }) => {
		const status = new WikiUpdateJobStore(controlDirectory).load()?.status;
		return status === "queued" || status === "running";
	});
}

export function wikiUpdateRecordDir(workspaceDir: string, goalId: string, wikiUpdateId: string): string {
	return join(wikiUpdateRecordsDir(workspaceDir, goalId), safeId(wikiUpdateId));
}

export function wikiUpdateArtifactDir(goalDir: string, wikiUpdateId: string): string {
	return join(goalDir, "wiki", "updates", safeId(wikiUpdateId));
}

function safeId(value: string): string {
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(value)) throw new Error("Invalid Wiki Update id");
	return value;
}
