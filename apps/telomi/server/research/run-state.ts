import {
	closeSync,
	existsSync,
	openSync,
	readFileSync,
	readdirSync,
	unlinkSync,
} from "node:fs";
import { join } from "node:path";

import { Type, type Static } from "@sinclair/typebox";

import { ArtifactRefSchema, type RunArtifactRef } from "../agent-runtime/artifact-store.js";
import { validateJsonSchema } from "../agent-runtime/structured-output.js";
import { stableJson } from "../lib/hash.js";
import { writeFileAtomic } from "../lib/fs.js";
import { isRecord } from "../lib/values.js";
import { notifyResearchRunSettled } from "../observability/case-capture.js";
import { readAgentNodeUsage, sealInterruptedAgentExecutions } from "../observability/run-records.js";

/** A Research Run in one of these states can no longer produce or change a node execution. */
export const TERMINAL_RUN_STATUSES = ["published", "skipped", "failed", "cancelled"] as const;

export const RUN_WORKFLOW_ID = "research-run";
export const RUN_WORKFLOW_VERSION = 26;

export const RunStatusSchema = Type.Union([
	Type.Literal("initialized"),
	Type.Literal("search_batch_running"),
	Type.Literal("evidence_materializing"),
	Type.Literal("plan_authoring"),
	Type.Literal("plan_selected"),
	Type.Literal("chapters_writing"),
	Type.Literal("citation_compiling"),
	Type.Literal("markdown_gating"),
	Type.Literal("interrupted"),
	Type.Literal("published"),
	Type.Literal("skipped"),
	Type.Literal("failed"),
	Type.Literal("cancelled"),
]);

const NonEmptyString = Type.String({ minLength: 1 });
const Sha256 = Type.String({ pattern: "^[a-f0-9]{64}$" });

const IdentityPinsSchema = Type.Object({
	harness_snapshot: NonEmptyString,
	workspace_content_hash: Sha256,
	knowledge_memory_hash: NonEmptyString,
	run_context_snapshot: Sha256,
	pipeline: NonEmptyString,
	prompt_bundle: NonEmptyString,
	schema_bundle: NonEmptyString,
	model_policy: NonEmptyString,
	skill_bundle: NonEmptyString,
	tool_schema: NonEmptyString,
	scheduled_research: Type.Optional(Sha256),
}, { additionalProperties: false });

const UsageSchema = Type.Object({
	input_tokens: Type.Integer({ minimum: 0 }),
	output_tokens: Type.Integer({ minimum: 0 }),
	cost_usd: Type.Number({ minimum: 0 }),
	model_calls: Type.Integer({ minimum: 0 }),
	agent_stages: Type.Integer({ minimum: 0 }),
	search_attempts: Type.Integer({ minimum: 0 }),
}, { additionalProperties: false });

const WriterOutputCheckpointSchema = Type.Object({
	assignment_id: NonEmptyString,
	output: ArtifactRefSchema,
}, { additionalProperties: false });

const AcceptedChapterSchema = Type.Object({
	section_id: NonEmptyString,
	chapter: ArtifactRefSchema,
}, { additionalProperties: false });

const ReportFlowCheckpointSchema = Type.Object({
	task: Type.Optional(ArtifactRefSchema),
	outline: ArtifactRefSchema,
	execution_plan: ArtifactRefSchema,
	cornell_notes_snapshot: Type.Optional(ArtifactRefSchema),
	knowledge_input: Type.Optional(Type.Object({
		mode: Type.Union([Type.Literal("wiki"), Type.Literal("findout")]),
		ref: NonEmptyString,
		sha256: Sha256,
		byte_length: Type.Integer({ minimum: 0 }),
	}, { additionalProperties: false })),
}, { additionalProperties: false });

export const RunStateSchema = Type.Object({
	schema_version: Type.Literal(2),
	workflow_id: Type.Literal(RUN_WORKFLOW_ID),
	workflow_version: Type.Literal(RUN_WORKFLOW_VERSION),
	run_id: NonEmptyString,
	goal_id: NonEmptyString,
	question: NonEmptyString,
	language: NonEmptyString,
	status: RunStatusSchema,
	state_revision: Type.Integer({ minimum: 0 }),
	resume_attempts: Type.Optional(Type.Integer({ minimum: 0 })),
	pins: IdentityPinsSchema,
	topic_plan: Type.Optional(Type.Object({
		revision: NonEmptyString,
		snapshot: ArtifactRefSchema,
	}, { additionalProperties: false })),
	source_bundles: Type.Array(ArtifactRefSchema),
	find_out_sources: Type.Optional(Type.Array(ArtifactRefSchema)),
	search_execution_records: Type.Array(ArtifactRefSchema),
	// Provider 获取部分失败的确定性事实。Runtime 只记录客观计数，不判断这份证据
	// 够不够——那是语义判断，属于 Agent。没有它的话 degraded_bundle 只存在于
	// 已发布的 Search Execution Record 里，不影响任何决策也不对用户可见。
	degraded_searches: Type.Optional(Type.Array(Type.Object({
		provider_execution_id: NonEmptyString,
		provider_id: NonEmptyString,
		attempt_id: NonEmptyString,
		operations_total: Type.Integer({ minimum: 0 }),
		operations_failed: Type.Integer({ minimum: 0 }),
		failed_operations: Type.Array(NonEmptyString),
	}, { additionalProperties: false }))),
	cornell_note_snapshots: Type.Array(ArtifactRefSchema),
	cornell_note_failure_manifests: Type.Optional(Type.Array(ArtifactRefSchema)),
	cornell_note_failure_count: Type.Optional(Type.Integer({ minimum: 0 })),
	report_flow: Type.Optional(ReportFlowCheckpointSchema),
	writer_outputs: Type.Array(WriterOutputCheckpointSchema),
	accepted_chapters: Type.Array(AcceptedChapterSchema),
	canonical_report: Type.Optional(ArtifactRefSchema),
	skip_reason: Type.Optional(Type.Union([
		Type.Literal("no_source_increment"),
		Type.Literal("no_qualifying_evidence"),
	])),
	usage: UsageSchema,
	started_at: NonEmptyString,
	updated_at: NonEmptyString,
	finished_at: Type.Optional(NonEmptyString),
	failure: Type.Optional(Type.Object({
		failure_class: NonEmptyString,
		failed_stage: NonEmptyString,
		message: NonEmptyString,
		cancellation_source: Type.Optional(Type.Literal("request_signal")),
	}, { additionalProperties: false })),
}, { additionalProperties: false });

export type RunStatus = Static<typeof RunStatusSchema>;
export type RunIdentityPins = Static<typeof IdentityPinsSchema>;
export type RunStateV2 = Static<typeof RunStateSchema>;

const allowedTransitions: Record<RunStatus, readonly RunStatus[]> = {
	initialized: ["search_batch_running", "evidence_materializing", "plan_authoring", "skipped", "failed", "cancelled", "interrupted"],
	search_batch_running: ["evidence_materializing", "skipped", "failed", "cancelled", "interrupted"],
	evidence_materializing: ["plan_authoring", "skipped", "failed", "cancelled", "interrupted"],
	plan_authoring: ["plan_selected", "failed", "cancelled", "interrupted"],
	plan_selected: ["chapters_writing", "failed", "cancelled", "interrupted"],
	chapters_writing: ["citation_compiling", "failed", "cancelled", "interrupted"],
	citation_compiling: ["chapters_writing", "markdown_gating", "failed", "cancelled", "interrupted"],
	markdown_gating: ["chapters_writing", "published", "failed", "cancelled", "interrupted"],
	interrupted: [
		"initialized",
		"search_batch_running",
		"evidence_materializing",
		"plan_authoring",
		"plan_selected",
		"chapters_writing",
		"citation_compiling",
		"markdown_gating",
		"failed",
		"cancelled",
	],
	published: [],
	skipped: [],
	failed: [
		"initialized",
		"search_batch_running",
		"evidence_materializing",
		"plan_authoring",
		"plan_selected",
		"chapters_writing",
		"citation_compiling",
		"markdown_gating",
	],
	cancelled: [],
};

export class RunStateStore {
	readonly statePath: string;

	constructor(readonly controlDirectory: string) {
		this.statePath = join(controlDirectory, "run-state.json");
	}

	create(input: {
		runId: string;
		goalId: string;
		question: string;
		language: string;
		pins: RunIdentityPins;
		topicPlan?: { revision: string; snapshot: RunArtifactRef };
		now?: string;
	}): RunStateV2 {
		if (existsSync(this.statePath)) throw new Error("Run state already exists");
		const now = input.now ?? new Date().toISOString();
		const state: RunStateV2 = {
			schema_version: 2,
			workflow_id: RUN_WORKFLOW_ID,
			workflow_version: RUN_WORKFLOW_VERSION,
			run_id: input.runId,
			goal_id: input.goalId,
			question: input.question,
			language: input.language,
			status: "initialized",
			state_revision: 0,
			pins: input.pins,
			...(input.topicPlan ? { topic_plan: input.topicPlan } : {}),
			source_bundles: [],
			search_execution_records: [],
			cornell_note_snapshots: [],
			cornell_note_failure_manifests: [],
			cornell_note_failure_count: 0,
			writer_outputs: [],
			accepted_chapters: [],
			usage: {
				input_tokens: 0,
				output_tokens: 0,
				cost_usd: 0,
				model_calls: 0,
				agent_stages: 0,
				search_attempts: 0,
			},
			started_at: now,
			updated_at: now,
		};
		this.write(state);
		return state;
	}

	load(expectedPins?: RunIdentityPins): RunStateV2 | undefined {
		if (!existsSync(this.statePath)) return undefined;
		const parsed = JSON.parse(readFileSync(this.statePath, "utf-8")) as unknown;
		const state = validateRunState(parsed);
		if (expectedPins && stableJson(state.pins) !== stableJson(expectedPins)) {
			throw new Error("checkpoint_identity_drift: Run identity pins do not match the current Runtime");
		}
		return state;
	}

	save(previous: RunStateV2, next: RunStateV2): void {
		if (previous.run_id !== next.run_id) throw new Error("Run state identity cannot change");
		if (stableJson(previous.pins) !== stableJson(next.pins)) throw new Error("Run identity pins cannot change");
		if (previous.status !== next.status && !allowedTransitions[previous.status].includes(next.status)) {
			throw new Error(`Invalid Run state transition: ${previous.status} -> ${next.status}`);
		}
		const expectedRevision = previous.state_revision;
		if (next.state_revision !== expectedRevision) {
			throw new Error("Run state write is based on a stale revision");
		}
		const lockPath = `${this.statePath}.lock`;
		let lock: number;
		try {
			lock = openSync(lockPath, "wx");
		} catch (error) {
			throw new Error("Run state write is already in progress", { cause: error });
		}
		try {
			const current = this.load();
			if (!current || current.state_revision !== expectedRevision) {
				throw new Error("Run state write is based on a stale revision");
			}
			const persisted = { ...next, state_revision: expectedRevision + 1 };
			this.write(persisted);
			next.state_revision = persisted.state_revision;
		} finally {
			closeSync(lock);
			unlinkSync(lockPath);
		}
		// Announced only once the terminal state is durable, so a listener never observes a
		// Run that could still add or change a node execution.
		if (isTerminalRunStatus(next.status) && !isTerminalRunStatus(previous.status)) {
			notifyResearchRunSettled(next.goal_id, next.run_id);
		}
	}

	isActive(): boolean {
		const state = this.load();
		return state !== undefined && isActiveRunStatus(state.status);
	}

	recoverInterrupted(now = new Date()): boolean {
		const state = this.load();
		if (!state || !isActiveRunStatus(state.status)) return false;
		const failedStage = state.status;
		this.save(state, {
			...state,
			status: "interrupted",
			updated_at: now.toISOString(),
			failure: {
				failure_class: "infrastructure",
				failed_stage: failedStage,
				message: "Research Run 因后端进程在完成前停止而中断，可以继续运行。",
			},
		});
		return true;
	}

	resume(now = new Date()): RunStateV2 {
		const state = this.load();
		if (!state) throw new Error("Research Run has no resumable checkpoint");
		const resumeStatus = resumableRunStatus(state);
		if (state.status === "interrupted") {
			sealInterruptedAgentExecutions(this.controlDirectory, "research", now.toISOString());
		}
		const traceUsage = readAgentNodeUsage(this.controlDirectory, "research");
		const resumed: RunStateV2 = {
			...state,
			status: resumeStatus,
			resume_attempts: (state.resume_attempts ?? 0) + 1,
			updated_at: now.toISOString(),
			...(traceUsage.completeExecutions > 0 && traceUsage.incompleteExecutionIds.length === 0 ? {
				usage: {
					...state.usage,
					input_tokens: traceUsage.inputTokens,
					output_tokens: traceUsage.outputTokens,
					cost_usd: traceUsage.costUsd,
					model_calls: traceUsage.modelCalls,
				},
			} : {}),
		};
		delete resumed.failure;
		delete resumed.finished_at;
		this.save(state, resumed);
		return resumed;
	}

	private write(state: RunStateV2): void {
		validateRunState(state);
		writeFileAtomic(this.statePath, `${JSON.stringify(state, null, 2)}\n`);
	}
}

type ActiveRunStatus = Exclude<RunStatus, "interrupted" | "published" | "skipped" | "failed" | "cancelled">;

function interruptedResumeStatus(value: string | undefined): ActiveRunStatus {
	const statuses = new Set<RunStatus>([
		"initialized",
		"search_batch_running",
		"evidence_materializing",
		"plan_authoring",
		"plan_selected",
		"chapters_writing",
		"citation_compiling",
		"markdown_gating",
	]);
	if (!value || !statuses.has(value as RunStatus)) {
		throw new Error(`Interrupted Research Run has invalid resume stage '${value ?? ""}'`);
	}
	return value as ActiveRunStatus;
}

/**
 * 反复续跑同一个必然失败的阶段只会重复烧钱，所以给出可续跑的次数上限。
 * 用户取消不在此列：取消是明确的意图，不应该被续跑覆盖。
 */
const MAX_RESUME_ATTEMPTS = 3;

function resumableRunStatus(state: RunStateV2): ActiveRunStatus {
	if (state.status !== "interrupted" && state.status !== "failed") {
		throw new Error("Research Run has no resumable checkpoint");
	}
	if ((state.resume_attempts ?? 0) >= MAX_RESUME_ATTEMPTS) {
		throw new Error(`Research Run reached the resume attempt limit of ${MAX_RESUME_ATTEMPTS}`);
	}
	// 失败与中断都从记录下来的阶段原地继续：该阶段之前已发布的产物都是不可变且经过校验的，
	// 阶段自身负责复用或重建它自己的中间产物。
	return interruptedResumeStatus(state.failure?.failed_stage);
}

export function canResumeRunState(state: RunStateV2): boolean {
	try {
		if (!isSupportedRunVersion(state)) return false;
		resumableRunStatus(state);
		return true;
	} catch {
		return false;
	}
}

export function validateRunState(value: unknown): RunStateV2 {
	if (isRecord(value) && !isSupportedRunVersion(value)) {
		throw new Error(`Unsupported Research Run checkpoint: schema ${value.schema_version}, workflow ${value.workflow_id}/${value.workflow_version}; resume requires schema 2 and ${RUN_WORKFLOW_ID}/${RUN_WORKFLOW_VERSION}`);
	}
	validateJsonSchema(RunStateSchema, value);
	const state = value as RunStateV2;
	if (state.status === "published" && !state.canonical_report) {
		throw new Error("Published Run requires a canonical report");
	}
	if (state.status === "skipped" && (!state.skip_reason || !state.finished_at)) {
		throw new Error("Skipped Run requires skip_reason and finished_at");
	}
	if (state.status !== "skipped" && state.skip_reason) {
		throw new Error("Only a skipped Run may declare skip_reason");
	}
	if ((state.status === "failed" || state.status === "cancelled") && !state.finished_at) {
		throw new Error(`Terminal Run state '${state.status}' requires finished_at`);
	}
	return state;
}

function isTerminalRunStatus(status: RunStatus): boolean {
	return (TERMINAL_RUN_STATUSES as readonly string[]).includes(status);
}

export function hasActiveResearchRun(runsDirectory: string): boolean {
	if (!existsSync(runsDirectory)) return false;
	return readdirSync(runsDirectory, { withFileTypes: true }).some((entry) =>
		entry.isDirectory() && new RunStateStore(join(runsDirectory, entry.name)).isActive());
}

function isActiveRunStatus(status: RunStatus): boolean {
	return status !== "interrupted" && !isTerminalRunStatus(status);
}

function isSupportedRunVersion(state: { schema_version?: unknown; workflow_id?: unknown; workflow_version?: unknown }): boolean {
	return state.schema_version === 2 && state.workflow_id === RUN_WORKFLOW_ID && state.workflow_version === RUN_WORKFLOW_VERSION;
}
