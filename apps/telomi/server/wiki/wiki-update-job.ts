import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { Type, type Static } from "@sinclair/typebox";

import { publish } from "../events/event-bus.js";
import { validateJsonSchema } from "../agent-runtime/structured-output.js";
import type { WikiGoalContext } from "./contracts.js";
import { writeJsonAtomic } from "../lib/fs.js";

const NonEmptyString = Type.String({ minLength: 1 });
const UsageSchema = Type.Object({
	input_tokens: Type.Number({ minimum: 0 }),
	output_tokens: Type.Number({ minimum: 0 }),
	cost_usd: Type.Number({ minimum: 0 }),
	model_calls: Type.Integer({ minimum: 0 }),
}, { additionalProperties: false });
const TriggerSchema = Type.Union([
	Type.Object({ kind: Type.Literal("manual") }, { additionalProperties: false }),
	Type.Object({ kind: Type.Literal("system") }, { additionalProperties: false }),
	Type.Object({ kind: Type.Literal("agent"), agent_name: NonEmptyString }, { additionalProperties: false }),
	Type.Object({ kind: Type.Literal("schedule"), schedule_id: NonEmptyString }, { additionalProperties: false }),
]);
const GoalTopicPlanSchema = Type.Object({
	schema_version: Type.Literal(1),
	goal_id: NonEmptyString,
	revision: NonEmptyString,
	status: Type.Literal("active"),
	topics: Type.Array(Type.Object({
		id: Type.String({ pattern: "^[a-z0-9][a-z0-9_-]*$" }),
		title: NonEmptyString,
		intent: NonEmptyString,
		questions: Type.Array(NonEmptyString),
		include: Type.Array(NonEmptyString),
		exclude: Type.Array(NonEmptyString),
	}, { additionalProperties: false }), { minItems: 1 }),
}, { additionalProperties: false });

export const WikiUpdateJobSchema = Type.Object({
	schema_version: Type.Literal(1),
	status: Type.Union([
		Type.Literal("queued"),
		Type.Literal("running"),
		Type.Literal("interrupted"),
		Type.Literal("succeeded"),
		Type.Literal("partial"),
		Type.Literal("failed"),
		Type.Literal("cancelled"),
	]),
	goal_id: NonEmptyString,
	run_id: NonEmptyString,
	wiki_update_id: Type.Optional(NonEmptyString),
	source_run_id: Type.Optional(NonEmptyString),
	parent_activity_id: Type.Optional(NonEmptyString),
	trigger: Type.Optional(TriggerSchema),
	reason: Type.Optional(NonEmptyString),
	rebuild: Type.Optional(Type.Boolean()),
	goal: NonEmptyString,
	goal_context: Type.Object({
		title: Type.String({ pattern: "\\S" }),
		description: Type.String(),
		language: Type.Optional(Type.Union([Type.Literal("zh-CN"), Type.Literal("en")])),
	}, { additionalProperties: false }),
	topic_plan: GoalTopicPlanSchema,
	cornell_notes: Type.Object({
		relative_path: NonEmptyString,
		sha256: Type.String({ pattern: "^[a-f0-9]{64}$" }),
		byte_length: Type.Integer({ minimum: 0 }),
	}, { additionalProperties: false }),
	attempts: Type.Integer({ minimum: 1 }),
	started_at: NonEmptyString,
	updated_at: NonEmptyString,
	finished_at: Type.Optional(NonEmptyString),
	message: Type.Optional(NonEmptyString),
	compilation_id: Type.Optional(NonEmptyString),
	publication_status: Type.Optional(Type.Union([Type.Literal("promoted"), Type.Literal("no_change")])),
	changed_paths: Type.Optional(Type.Array(NonEmptyString)),
	failed_batches: Type.Optional(Type.Array(Type.Object({
		batch_index: Type.Integer({ minimum: 0 }),
		source_ids: Type.Array(NonEmptyString),
		message: NonEmptyString,
		usage: UsageSchema,
	}, { additionalProperties: false }))),
	progress: Type.Optional(Type.Object({
		total_batches: Type.Integer({ minimum: 0 }),
		completed_batches: Type.Integer({ minimum: 0 }),
		page_count: Type.Integer({ minimum: 0 }),
		usage: UsageSchema,
		batches: Type.Array(Type.Object({
			batch_index: Type.Integer({ minimum: 0 }),
			status: Type.Union([
				Type.Literal("running"),
				Type.Literal("succeeded"),
				Type.Literal("interrupted"),
				Type.Literal("failed"),
				Type.Literal("cancelled"),
			]),
			attempt: Type.Integer({ minimum: 1 }),
			reused: Type.Boolean(),
			started_at: NonEmptyString,
			finished_at: Type.Optional(NonEmptyString),
			page_count: Type.Integer({ minimum: 0 }),
			usage: UsageSchema,
			trace_ref: Type.Optional(NonEmptyString),
			message: Type.Optional(NonEmptyString),
		}, { additionalProperties: false })),
		stages: Type.Optional(Type.Array(Type.Object({
			kind: Type.Union([
				Type.Literal("curation"),
				Type.Literal("publication"),
			]),
			stage_index: Type.Integer({ minimum: 0 }),
			total_stages: Type.Integer({ minimum: 1 }),
			status: Type.Union([Type.Literal("running"), Type.Literal("succeeded"), Type.Literal("failed"), Type.Literal("interrupted")]),
			started_at: NonEmptyString,
			finished_at: Type.Optional(NonEmptyString),
			page_count: Type.Integer({ minimum: 0 }),
			usage: UsageSchema,
			trace_ref: Type.Optional(NonEmptyString),
			message: Type.Optional(NonEmptyString),
		}, { additionalProperties: false }))),
	}, { additionalProperties: false })),
}, { additionalProperties: false });

export type WikiUpdateJob = Static<typeof WikiUpdateJobSchema>;
export type WikiUpdateJobStatus = WikiUpdateJob["status"];

export const WIKI_UPDATE_JOB_FILE = "wiki-update-job.json";

/**
 * 同一个 Wiki 更新最多续跑的次数。反复重启一个必然失败的任务只会重复烧钱，
 * 而 Wiki 更新是后台维护，没有人在旁边判断该不该继续。
 */
export const MAX_WIKI_UPDATE_ATTEMPTS = 3;

/**
 * Wiki 更新任务的持久记录。它和 Research Run 的 state.json 放在同一个 Run 控制目录下：
 * Wiki 更新是脱离 Run 主链路的后台工作，进程消失后只有这份记录能证明它没跑完。
 */
export class WikiUpdateJobStore {
	private readonly path: string;

	constructor(controlDirectory: string) {
		this.path = join(controlDirectory, WIKI_UPDATE_JOB_FILE);
	}

	load(): WikiUpdateJob | undefined {
		if (!existsSync(this.path)) return undefined;
		const value = JSON.parse(readFileSync(this.path, "utf-8")) as unknown;
		validateJsonSchema(WikiUpdateJobSchema, value);
		return value as WikiUpdateJob;
	}

	start(input: {
		goalId: string;
		runId: string;
		goal: string;
		goalContext: WikiGoalContext;
		topicPlan: WikiUpdateJob["topic_plan"];
		cornellNotes: WikiUpdateJob["cornell_notes"];
		wikiUpdateId?: string;
		sourceRunId?: string;
		parentActivityId?: string;
		trigger?: NonNullable<WikiUpdateJob["trigger"]>;
		reason?: string;
		rebuild?: boolean;
		now?: Date;
	}): WikiUpdateJob {
		const now = (input.now ?? new Date()).toISOString();
		const previous = this.load();
		const job: WikiUpdateJob = {
			schema_version: 1,
			status: "queued",
			goal_id: input.goalId,
			run_id: input.runId,
			...(input.wikiUpdateId || previous?.wiki_update_id
				? { wiki_update_id: input.wikiUpdateId ?? previous!.wiki_update_id! } : {}),
			...(input.sourceRunId || previous?.source_run_id
				? { source_run_id: input.sourceRunId ?? previous!.source_run_id! } : {}),
			...(input.parentActivityId || previous?.parent_activity_id
				? { parent_activity_id: input.parentActivityId ?? previous!.parent_activity_id! } : {}),
			...(input.trigger || previous?.trigger ? { trigger: input.trigger ?? previous!.trigger! } : {}),
			...(input.reason || previous?.reason ? { reason: input.reason ?? previous!.reason! } : {}),
			...(input.rebuild !== undefined || previous?.rebuild !== undefined
				? { rebuild: input.rebuild ?? previous!.rebuild! } : {}),
			goal: input.goal,
			goal_context: input.goalContext,
			topic_plan: input.topicPlan,
			cornell_notes: input.cornellNotes,
			attempts: (previous?.attempts ?? 0) + 1,
			started_at: previous?.started_at ?? now,
			updated_at: now,
			...(previous?.progress ? { progress: previous.progress } : {}),
		};
		this.write(job);
		return job;
	}

	markRunning(totalBatches: number, now = new Date()): WikiUpdateJob {
		const previous = this.load();
		if (!previous) throw new Error("Wiki update job has no record to start");
		const job: WikiUpdateJob = {
			...previous,
			status: "running",
			updated_at: now.toISOString(),
			progress: previous.progress ?? {
				total_batches: totalBatches,
				completed_batches: 0,
				page_count: 0,
				usage: emptyUsage(),
				batches: [],
			},
		};
		delete job.message;
		delete job.finished_at;
		this.write(job);
		return job;
	}

	recordBatch(input: {
		batchIndex: number;
		totalBatches: number;
		status: "running" | "succeeded" | "failed";
		pageCount: number;
		usage: { inputTokens: number; outputTokens: number; costUsd: number; calls: number };
		traceRef?: string;
		message?: string;
		reused: boolean;
		now?: Date;
	}): WikiUpdateJob {
		const previous = this.load();
		if (!previous) throw new Error("Wiki update job has no record to update");
		const now = (input.now ?? new Date()).toISOString();
		const existing = previous.progress?.batches.find((batch) => batch.batch_index === input.batchIndex);
		const batch = {
			batch_index: input.batchIndex,
			status: input.status,
			attempt: existing?.status === "running" && input.status === "running"
				? existing.attempt
				: input.status === "running" ? (existing?.attempt ?? 0) + 1 : existing?.attempt ?? 1,
			reused: input.reused,
			started_at: existing?.started_at ?? now,
			...(input.status !== "running" ? { finished_at: now } : {}),
			page_count: input.pageCount,
			usage: usageRecord(input.usage),
			...(input.traceRef
				? { trace_ref: input.traceRef }
				: input.status === "running" && existing?.trace_ref ? { trace_ref: existing.trace_ref } : {}),
			...(input.message ? { message: input.message } : {}),
		};
		const batches = [
			...(previous.progress?.batches ?? []).filter((candidate) => candidate.batch_index !== input.batchIndex),
			batch,
		].sort((left, right) => left.batch_index - right.batch_index);
		const completed = batches.filter((candidate) => new Set(["succeeded", "failed", "cancelled"]).has(candidate.status));
		const job: WikiUpdateJob = {
			...previous,
			status: "running",
			updated_at: now,
			progress: {
				total_batches: input.totalBatches,
				completed_batches: completed.length,
				page_count: input.pageCount,
				usage: completed.reduce((total, candidate) => addUsage(total, candidate.usage), emptyUsage()),
				batches,
				...(previous.progress?.stages ? { stages: previous.progress.stages } : {}),
			},
		};
		this.write(job);
		return job;
	}

	recordStage(input: {
		kind: "curation" | "publication";
		stageIndex: number;
		totalStages: number;
		status: "running" | "succeeded" | "failed";
		pageCount: number;
		usage: { inputTokens: number; outputTokens: number; costUsd: number; calls: number };
		traceRef?: string;
		message?: string;
		now?: Date;
	}): WikiUpdateJob {
		const previous = this.load();
		if (!previous) throw new Error("Wiki update job has no record to update");
		const progress = previous.progress ?? {
			total_batches: 0,
			completed_batches: 0,
			page_count: 0,
			usage: emptyUsage(),
			batches: [],
		};
		const now = (input.now ?? new Date()).toISOString();
		const existing = progress.stages?.find((stage) =>
			stage.kind === input.kind && stage.stage_index === input.stageIndex);
		const stage = {
			kind: input.kind,
			stage_index: input.stageIndex,
			total_stages: input.totalStages,
			status: input.status,
			started_at: existing?.started_at ?? now,
			...(input.status !== "running" ? { finished_at: now } : {}),
			page_count: input.pageCount,
			usage: usageRecord(input.usage),
			...(input.traceRef ? { trace_ref: input.traceRef } : existing?.trace_ref ? { trace_ref: existing.trace_ref } : {}),
			...(input.message ? { message: input.message } : {}),
		};
		const stages = [
			...(progress.stages ?? []).filter((candidate) =>
				candidate.kind !== input.kind || candidate.stage_index !== input.stageIndex),
			stage,
		].sort((left, right) => stageOrder(left.kind) - stageOrder(right.kind)
			|| left.stage_index - right.stage_index);
		const job: WikiUpdateJob = {
			...previous,
			status: "running",
			updated_at: now,
			progress: { ...progress, stages },
		};
		this.write(job);
		return job;
	}

	settle(
		status: Exclude<WikiUpdateJobStatus, "queued" | "running" | "interrupted">,
		details: {
			message?: string;
			compilationId?: string;
			publicationStatus?: "promoted" | "no_change";
			changedPaths?: string[];
			failedBatches?: NonNullable<WikiUpdateJob["failed_batches"]>;
			now?: Date;
		} = {},
	): WikiUpdateJob {
		const previous = this.load();
		if (!previous) throw new Error("Wiki update job has no record to settle");
		const finishedAt = (details.now ?? new Date()).toISOString();
		const job: WikiUpdateJob = {
			...previous,
			status,
			updated_at: finishedAt,
			finished_at: finishedAt,
			...(previous.progress ? {
				progress: finalizeRunningBatches(previous.progress, status, finishedAt),
			} : {}),
			...(details.message ? { message: details.message } : {}),
			...(details.compilationId ? { compilation_id: details.compilationId } : {}),
			...(details.publicationStatus ? { publication_status: details.publicationStatus } : {}),
			...(details.changedPaths ? { changed_paths: details.changedPaths } : {}),
			...(details.failedBatches ? { failed_batches: details.failedBatches } : {}),
		};
		this.write(job);
		return job;
	}

	/** 后端进程在任务完成前停止时调用。返回是否确实收敛了一个未完成的任务。 */
	markInterrupted(now = new Date()): boolean {
		const job = this.load();
		if (!job || (job.status !== "running" && job.status !== "queued")) return false;
		this.write({
			...job,
			status: "interrupted",
			updated_at: now.toISOString(),
			...(job.progress ? {
				progress: finalizeRunningBatches(job.progress, "interrupted", now.toISOString()),
			} : {}),
			message: "Wiki 更新因后端进程在完成前停止而中断，可以继续运行。",
		});
		return true;
	}

	private write(job: WikiUpdateJob): void {
		validateJsonSchema(WikiUpdateJobSchema, job);
		writeJsonAtomic(this.path, job);
		publish({
			type: "wiki-update:changed",
			goalId: job.goal_id,
			runId: job.run_id,
			status: job.status,
			ts: job.updated_at,
		});
	}
}

function emptyUsage(): NonNullable<WikiUpdateJob["progress"]>["usage"] {
	return { input_tokens: 0, output_tokens: 0, cost_usd: 0, model_calls: 0 };
}

function usageRecord(usage: { inputTokens: number; outputTokens: number; costUsd: number; calls: number }) {
	return {
		input_tokens: usage.inputTokens,
		output_tokens: usage.outputTokens,
		cost_usd: usage.costUsd,
		model_calls: usage.calls,
	};
}

function addUsage(
	left: NonNullable<WikiUpdateJob["progress"]>["usage"],
	right: NonNullable<WikiUpdateJob["progress"]>["usage"],
): NonNullable<WikiUpdateJob["progress"]>["usage"] {
	return {
		input_tokens: left.input_tokens + right.input_tokens,
		output_tokens: left.output_tokens + right.output_tokens,
		cost_usd: left.cost_usd + right.cost_usd,
		model_calls: left.model_calls + right.model_calls,
	};
}

function finalizeRunningBatches(
	progress: NonNullable<WikiUpdateJob["progress"]>,
	status: "interrupted" | "succeeded" | "partial" | "failed" | "cancelled",
	finishedAt: string,
): NonNullable<WikiUpdateJob["progress"]> {
	if (status === "succeeded" || status === "partial") return progress;
	return {
		...progress,
		batches: progress.batches.map((batch) => batch.status === "running"
			? { ...batch, status, finished_at: finishedAt }
			: batch),
		...(progress.stages ? {
			stages: progress.stages.map((stage) => stage.status === "running"
				? { ...stage, status: status === "interrupted" ? "interrupted" as const : "failed" as const, finished_at: finishedAt }
				: stage),
		} : {}),
	};
}

function stageOrder(kind: "curation" | "publication"): number {
	return kind === "curation" ? 0 : 1;
}

export function canResumeWikiUpdateJob(job: WikiUpdateJob): boolean {
	return job.status === "interrupted" && job.attempts < MAX_WIKI_UPDATE_ATTEMPTS;
}
