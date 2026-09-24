import type { ProjectionContribution } from "../events/activity-projection.js";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { canResumeWikiUpdateJob, MAX_WIKI_UPDATE_ATTEMPTS, WikiUpdateJobStore } from "./wiki-update-job.js";
import { wikiUpdateRecordsDir } from "./update-runner.js";
import { serverRuntimeDirForGoal } from "../workspaces/server-runtime-paths.js";
import { activityTiming, compareHistory } from "../events/projection-helpers.js";
import type { ObservabilityActivityProjection } from "../observability/activity-projection.js";
import type { ActivityAction, ActivityLifecycle, ActivityMessage, ActivityOutcome, ActivityProjectionItem, ActivityStep } from "../../shared/events/activity-projection.js";
import { chrome } from "../../shared/events/activity-text.js";

export class WikiActivityProjection {
	constructor(private readonly options: { workspaceDir: string }, private readonly outputs: ObservabilityActivityProjection) {}
	project(goalId: string): ProjectionContribution[] {
		return [{ source: "wiki-update", items: this.readWikiUpdates(goalId) }];
	}

	private readWikiUpdates(goalId: string): ActivityProjectionItem[] {
		const root = wikiUpdateRecordsDir(this.options.workspaceDir, goalId);
		if (!existsSync(root)) return [];
		return readdirSync(root, { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.flatMap((entry) => {
				try {
					const controlDirectory = join(root, entry.name);
					const job = new WikiUpdateJobStore(controlDirectory).load();
					return job ? [this.fromWikiUpdate(job, controlDirectory)] : [];
				} catch {
					return [];
				}
			})
			.sort(compareHistory);
	}

	private fromWikiUpdate(job: NonNullable<ReturnType<WikiUpdateJobStore["load"]>>, controlDirectory: string): ActivityProjectionItem {
		const id = job.wiki_update_id ?? job.run_id;
		const lifecycle: ActivityLifecycle = job.status === "queued"
			? "queued"
			: job.status === "running" ? "running" : job.status === "interrupted" ? "waiting" : "finished";
		const outcome: ActivityOutcome | undefined = job.status === "succeeded"
			? job.publication_status === "no_change" ? "no-change" : "succeeded"
			: job.status === "partial" ? "partial"
			: job.status === "failed" ? "failed" : job.status === "cancelled" ? "cancelled" : undefined;
		const progress = job.progress;
		const batchSteps = (progress?.batches ?? []).map((batch): ActivityStep => {
			const batchLifecycle: ActivityLifecycle = batch.status === "running"
				? "running" : batch.status === "interrupted" ? "waiting" : "finished";
			const batchOutcome: ActivityOutcome | undefined = batch.status === "succeeded"
				? "succeeded" : batch.status === "failed" ? "failed" : batch.status === "cancelled" ? "cancelled" : undefined;
			const outputRef = batch.trace_ref ? this.outputs.registerOutput({
				kind: "wiki-agent",
				goalId: job.goal_id,
				controlDirectory,
				traceRoot: serverRuntimeDirForGoal(job.goal_id, this.options.workspaceDir),
				traceRef: batch.trace_ref,
				lifecycle: batchLifecycle,
				...(batchOutcome ? { outcome: batchOutcome } : {}),
			}) : undefined;
			const timing = activityTiming(batch.started_at, batch.finished_at ?? job.updated_at, batch.finished_at);
			return {
				stepId: `wiki-batch:${batch.batch_index + 1}`,
				title: chrome("activityChrome.wiki.batchTitle", { index: batch.batch_index + 1 }),
				// batch.message 是 Runtime 原始错误文本，作为内容原样附在固定 chrome 之后。
				summary: batch.status === "running"
					? chrome("activityChrome.wiki.batchRunning")
					: batch.status === "interrupted" ? chrome("activityChrome.wiki.batchInterrupted")
						: batch.status === "failed" ? failureText("activityChrome.wiki.batchFailed", batch.message)
							: batch.status === "cancelled" ? chrome("activityChrome.wiki.batchCancelled")
					: [
						...chrome("activityChrome.wiki.pageCount", { count: batch.page_count }),
						...chrome("activityChrome.usage.modelCalls", { count: batch.usage.model_calls }),
						...(batch.reused ? chrome("activityChrome.wiki.reusedCheckpoint") : []),
					],
				lifecycle: batchLifecycle,
				...(batchOutcome ? { outcome: batchOutcome } : {}),
				timing,
				round: batch.attempt,
				dependsOnStepIds: [],
				parallelSteps: [],
				agentActivities: [{
					agentActivityId: `wiki-maintainer:${id}:${batch.batch_index}`,
					agentName: "wiki_maintainer",
					summary: batch.status === "running" ? chrome("activityChrome.wiki.maintainerRunning")
						: batch.status === "interrupted" ? chrome("activityChrome.wiki.maintainerInterrupted")
							: batch.status === "failed" ? failureText("activityChrome.wiki.maintainerFailed", batch.message)
								: batch.status === "cancelled" ? chrome("activityChrome.wiki.maintainerCancelled")
									: chrome("activityChrome.usage.modelCalls", { count: batch.usage.model_calls }),
					lifecycle: batchLifecycle,
					...(batchOutcome ? { outcome: batchOutcome } : {}),
					timing,
					...(outputRef ? { outputRef } : {}),
					attempts: [{
						attemptId: `wiki-maintainer:${id}:${batch.batch_index}:${batch.attempt}`,
						number: batch.attempt,
						lifecycle: batchLifecycle,
						...(batchOutcome ? { outcome: batchOutcome } : {}),
						timing,
						...(outputRef ? { outputRef } : {}),
					}],
				}],
			};
		});
		const curationStages = (progress?.stages ?? []).filter((stage) => stage.kind === "curation");
		const batchStepIds = new Set((progress?.batches ?? []).map((batch) => `wiki-batch:${batch.batch_index + 1}`));
		const stageSteps = (progress?.stages ?? []).map((stage): ActivityStep => {
			const stageLifecycle: ActivityLifecycle = stage.status === "running"
				? "running" : stage.status === "interrupted" ? "waiting" : "finished";
			const stageOutcome: ActivityOutcome | undefined = stage.status === "succeeded"
				? "succeeded" : stage.status === "failed" ? "failed" : undefined;
			const outputRef = stage.trace_ref ? this.outputs.registerOutput({
				kind: "wiki-agent",
				goalId: job.goal_id,
				controlDirectory,
				traceRoot: serverRuntimeDirForGoal(job.goal_id, this.options.workspaceDir),
				traceRef: stage.trace_ref,
				lifecycle: stageLifecycle,
				...(stageOutcome ? { outcome: stageOutcome } : {}),
			}) : undefined;
			const curation = stage.kind === "curation";
			const title = curation
				? stage.total_stages > 1
					? chrome("activityChrome.wiki.curatorTitleIndexed", { index: stage.stage_index + 1, total: stage.total_stages })
					: chrome("activityChrome.wiki.curatorTitle")
				: chrome("activityChrome.wiki.publishTitle");
			const timing = activityTiming(stage.started_at, stage.finished_at ?? job.updated_at, stage.finished_at);
			const previousCuration = curationStages.filter((candidate) => candidate.stage_index < stage.stage_index).at(-1);
			const ownBatchStepId = `wiki-batch:${stage.stage_index + 1}`;
			return {
				stepId: `wiki-stage:${stage.kind}:${stage.stage_index}`,
				title,
				// stage.message 是 Runtime 原始错误文本，作为内容原样附在固定 chrome 之后。
				summary: stage.status === "running"
					? chrome(curation ? "activityChrome.wiki.curatorRunning" : "activityChrome.wiki.publishRunning")
					: stage.status === "interrupted"
						? chrome(curation ? "activityChrome.wiki.curatorInterrupted" : "activityChrome.wiki.publishInterrupted")
						: stage.status === "failed"
							? failureText(curation ? "activityChrome.wiki.curatorFailed" : "activityChrome.wiki.publishFailed", stage.message)
							: [
								...chrome("activityChrome.wiki.pageCount", { count: stage.page_count }),
								...chrome("activityChrome.usage.modelCalls", { count: stage.usage.model_calls }),
							],
				lifecycle: stageLifecycle,
				...(stageOutcome ? { outcome: stageOutcome } : {}),
				timing,
				dependsOnStepIds: stage.kind === "publication"
					? curationStages.map((candidate) => `wiki-stage:curation:${candidate.stage_index}`)
					: [
						...(batchStepIds.has(ownBatchStepId) ? [ownBatchStepId] : []),
						...(previousCuration ? [`wiki-stage:curation:${previousCuration.stage_index}`] : []),
					],
				parallelSteps: [],
				agentActivities: [{
					agentActivityId: `wiki-stage:${id}:${stage.kind}:${stage.stage_index}`,
					agentName: curation ? "wiki_curator" : "wiki_publication",
					summary: title,
					lifecycle: stageLifecycle,
					...(stageOutcome ? { outcome: stageOutcome } : {}),
					timing,
					...(outputRef ? { outputRef } : {}),
					attempts: [{
						attemptId: `wiki-stage:${id}:${stage.kind}:${stage.stage_index}:1`,
						number: 1,
						lifecycle: stageLifecycle,
						...(stageOutcome ? { outcome: stageOutcome } : {}),
						timing,
						...(outputRef ? { outputRef } : {}),
					}],
				}],
			};
		});
		const steps = [...batchSteps, ...stageSteps];
		const resumeAction: ActivityAction = {
			actionId: `resume-wiki:${id}`,
			kind: "continue",
			label: chrome("activityChrome.wiki.resume"),
			enabled: canResumeWikiUpdateJob(job),
			...(!canResumeWikiUpdateJob(job)
				? { disabledReason: chrome("activityChrome.wiki.resumeLimit", { count: MAX_WIKI_UPDATE_ATTEMPTS }) }
				: {}),
			requiresConfirmation: false,
			href: `/api/goals/${encodeURIComponent(job.goal_id)}/wiki-updates/${encodeURIComponent(id)}/resume`,
		};
		const trigger = job.trigger?.kind === "schedule"
			? { kind: "schedule" as const, scheduleId: job.trigger.schedule_id }
			: job.trigger?.kind === "agent"
				? { kind: "agent" as const, agentName: job.trigger.agent_name }
				: job.trigger?.kind === "manual" ? { kind: "manual" as const } : { kind: "system" as const };
		return {
			activityId: `wiki-update:${id}`,
			kind: "wiki-update",
			scope: { kind: "goal", goalId: job.goal_id },
			trigger,
			...(job.parent_activity_id ? { parentActivityId: job.parent_activity_id } : {}),
			title: chrome("activityChrome.wiki.updateTitle"),
			summary: wikiUpdateSummary(job),
			lifecycle,
			...(outcome ? { outcome } : {}),
			...(job.status === "interrupted" ? {
				waiting: {
					kind: "external" as const,
					// job.message 在这个状态下是 Runtime 写死的固定文案，不能当内容展示；原文留在 Job 记录与服务端日志里。
					reason: chrome("activityChrome.wiki.interruptedReason"),
					waitingSince: job.updated_at,
					actions: [resumeAction],
				},
				// Attention says the Activity still waits on the user, so it needs an action the user
				// can actually take. Past the resume limit there is none, and a partial Wiki has
				// nothing to resume at all: both are Outcomes the summary already reports, and an
				// alert nobody can act on or clear is the one thing attention must never become.
				...(canResumeWikiUpdateJob(job) ? {
					attention: {
						kind: "failure" as const,
						summary: chrome("activityChrome.wiki.batchCheckpoint"),
						actions: [resumeAction],
					},
				} : {}),
			} : {}),
			...(progress ? { progress: { completed: progress.completed_batches, total: progress.total_batches, label: chrome("activityChrome.wiki.batches") } } : {}),
			timing: activityTiming(job.started_at, job.updated_at, job.finished_at),
			resultLinks: job.status === "succeeded" || job.status === "partial" ? [{
				kind: "artifact",
				label: chrome("activityChrome.wiki.open"),
				href: `/wiki/${encodeURIComponent(job.goal_id)}`,
				available: true,
				primary: true,
			}] : [],
			steps,
			sourceRef: `wiki-update:${id}`,
		};
	}

}
/** 未处理的 Source 批次事实计数，来自 Job 记录本身而不是 Runtime 拼好的那句话。 */
function unprocessedParts(job: NonNullable<ReturnType<WikiUpdateJobStore["load"]>>): ActivityMessage[] {
	return [
		...chrome("activityChrome.wiki.partialBatches", { count: job.failed_batches?.length ?? 0 }),
		...chrome("activityChrome.wiki.partialSources", {
			count: job.failed_batches?.reduce((total, failure) => total + failure.source_ids.length, 0) ?? 0,
		}),
	];
}

/** Fixed chrome followed by the Runtime's own diagnostic text, which keeps its original language. */
function failureText(key: Parameters<typeof chrome>[0], message?: string): ActivityMessage[] {
	return [...chrome(key), ...(message ? [{ text: message }] : [])];
}

function wikiUpdateSummary(job: NonNullable<ReturnType<WikiUpdateJobStore["load"]>>): ActivityMessage[] {
	const progress = job.progress;
	const stages = progress?.stages ?? [];
		const finalStage = stages.find((stage) => stage.kind === "publication" && stage.status === "succeeded")
			?? stages.find((stage) => stage.kind === "curation" && stage.status === "succeeded")
		?? [...stages].reverse().find((stage) => stage.status === "succeeded");
	const pageCount = finalStage?.page_count ?? progress?.page_count ?? 0;
	const modelCalls = (progress?.usage.model_calls ?? 0)
		+ stages.reduce((total, stage) => total + stage.usage.model_calls, 0);
	const costUsd = (progress?.usage.cost_usd ?? 0)
		+ stages.reduce((total, stage) => total + stage.usage.cost_usd, 0);
	if (job.status === "queued") return chrome("activityChrome.wiki.queued");
	if (job.status === "interrupted") return chrome("activityChrome.wiki.interruptedSummary");
	// job.message 是 Runtime 原始错误文本（可能是含宿主机路径的 stack trace）。
	// 摘要只用已知事实描述失败，原文留在 Activity Step、Node Trace 和服务端日志里。
	if (job.status === "failed") {
		const failedStage = stages.find((stage) => stage.status === "failed");
		return chrome(failedStage?.kind === "curation" ? "activityChrome.wiki.failedCurator"
			: failedStage?.kind === "publication" ? "activityChrome.wiki.failedPublication"
				: "activityChrome.wiki.failedGeneric");
	}
	if (job.status === "cancelled") return chrome("activityChrome.wiki.cancelled");
	if (job.status === "partial") return [...chrome("activityChrome.wiki.partialSummary"), ...unprocessedParts(job)];
	if (job.status === "succeeded") {
		return job.publication_status === "no_change" ? chrome("activityChrome.wiki.noChange") : [
			...chrome("activityChrome.wiki.updated"),
			...(progress ? [
				...chrome("activityChrome.wiki.pageCount", { count: pageCount }),
				...chrome("activityChrome.usage.modelCalls", { count: modelCalls }),
			] : []),
		];
	}
	return [
		...chrome("activityChrome.wiki.creating"),
		...(progress ? [
			...chrome("activityChrome.wiki.batchProgress", { completed: progress.completed_batches, total: progress.total_batches }),
			...chrome("activityChrome.wiki.pageCount", { count: pageCount }),
			...chrome("activityChrome.usage.cost", { cost: costUsd.toFixed(4) }),
		] : []),
	];
}
