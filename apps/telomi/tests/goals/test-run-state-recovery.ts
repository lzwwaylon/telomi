import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { canResumeRunState, RunStateStore } from "../../server/research/run-state.js";

const root = mkdtempSync(join(tmpdir(), "telomi-run-recovery-"));
try {
	const store = new RunStateStore(root);
	const sha = "a".repeat(64);
	const created = store.create({
		runId: "run-interrupted",
		goalId: "goal-interrupted",
		question: "test interrupted recovery",
		language: "zh-CN",
		pins: {
			harness_snapshot: sha,
			workspace_content_hash: sha,
			knowledge_memory_hash: sha,
			run_context_snapshot: sha,
			pipeline: sha,
			prompt_bundle: sha,
			schema_bundle: sha,
			model_policy: sha,
			skill_bundle: sha,
			tool_schema: sha,
		},
		now: "2026-08-06T05:03:30.000Z",
	});
	const planning = { ...created, status: "search_batch_running" as const };
	store.save(created, planning);
	const running = { ...planning, status: "search_batch_running" as const };
	store.save(planning, running);

	assert.equal(store.recoverInterrupted(new Date("2026-08-06T05:10:00.000Z")), true);
	const recovered = store.load();
	assert.equal(recovered?.status, "interrupted");
	assert.equal(recovered?.finished_at, undefined);
	assert.equal(recovered?.failure?.failure_class, "infrastructure");
	assert.equal(recovered?.failure?.failed_stage, "search_batch_running");
	assert.match(recovered?.failure?.message ?? "", /可以继续运行/u);
	assert.equal(store.recoverInterrupted(new Date("2026-08-06T05:11:00.000Z")), false);
	const resumed = store.resume(new Date("2026-08-06T05:12:00.000Z"));
	assert.equal(resumed.status, "search_batch_running");
	assert.equal(resumed.failure, undefined);
	assert.equal(resumed.updated_at, "2026-08-06T05:12:00.000Z");

	// 两个执行器从同一 Revision 启动时，后写入者不能覆盖先写入者。
	const staleRoot = join(root, "stale-writer");
	const firstWriter = new RunStateStore(staleRoot);
	const staleWriter = new RunStateStore(staleRoot);
	const staleCreated = firstWriter.create({
		runId: "run-stale-writer",
		goalId: "goal-stale-writer",
		question: "reject stale executor writes",
		language: "zh-CN",
		pins: created.pins,
		now: "2026-08-06T05:20:00.000Z",
	});
	const staleCopy = staleWriter.load()!;
	firstWriter.save(staleCreated, { ...staleCreated, status: "search_batch_running" });
	assert.throws(
		() => staleWriter.save(staleCopy, { ...staleCopy, status: "evidence_materializing" }),
		/Run state write is based on a stale revision/u,
	);
	assert.equal(firstWriter.load()?.status, "search_batch_running");

	const failedRoot = join(root, "failed");
	const failedStore = new RunStateStore(failedRoot);
	const initialized = failedStore.create({
		runId: "run-failed",
		goalId: "goal-failed",
		question: "resume retained evidence after a fixed plan authoring bug",
		language: "zh-CN",
		pins: created.pins,
		now: "2026-08-06T06:00:00.000Z",
	});
	const authoring = {
		...initialized,
		status: "plan_authoring" as const,
		cornell_note_snapshots: [{ relative_path: "artifacts/cornell-notes.json", sha256: sha, byte_length: 1 }],
	};
	failedStore.save(initialized, authoring);
	const failed = {
		...authoring,
		status: "failed" as const,
		finished_at: "2026-08-06T06:01:00.000Z",
		failure: {
			failure_class: "runtime_invariant",
			failed_stage: "plan_authoring",
			message: "fixed compiler bug",
		},
	};
	failedStore.save(authoring, failed);
	const resumedFailed = failedStore.resume(new Date("2026-08-06T06:02:00.000Z"));
	assert.equal(resumedFailed.status, "plan_authoring");
	assert.equal(resumedFailed.failure, undefined);
	assert.equal(resumedFailed.finished_at, undefined);
	assert.equal(resumedFailed.cornell_note_snapshots.length, 1);

	// 采集阶段失败同样可以原地继续：该阶段自己负责复用已封存的 Source。
	const searchFailedRoot = join(root, "failed-search");
	const searchStore = new RunStateStore(searchFailedRoot);
	let searchState = searchStore.create({
		runId: "run-failed-search",
		goalId: "goal-failed-search",
		question: "resume a Search Batch that failed after acquiring Sources",
		language: "zh-CN",
		pins: created.pins,
		now: "2026-08-06T07:00:00.000Z",
	});
	for (const status of ["search_batch_running"] as const) {
		const next = { ...searchState, status };
		searchStore.save(searchState, next);
		searchState = next;
	}
	const failAt = (previous: typeof searchState, at: string) => {
		const next = {
			...previous,
			status: "failed" as const,
			finished_at: at,
			failure: { failure_class: "provider", failed_stage: "search_batch_running", message: "provider timeout" },
		};
		searchStore.save(previous, next);
		return next;
	};
	let current = failAt(searchState, "2026-08-06T07:01:00.000Z");
	for (let attempt = 1; attempt <= 3; attempt += 1) {
		const resumedSearch = searchStore.resume(new Date(`2026-08-06T07:0${attempt + 1}:00.000Z`));
		assert.equal(resumedSearch.status, "search_batch_running");
		assert.equal(resumedSearch.resume_attempts, attempt);
		assert.equal(resumedSearch.failure, undefined);
		current = failAt(resumedSearch, `2026-08-06T07:1${attempt}:00.000Z`);
	}
	// 反复续跑同一个必然失败的阶段只会重复烧钱，超过上限后必须停下。
	assert.equal(canResumeRunState(current), false);
	assert.throws(() => searchStore.resume(new Date("2026-08-06T07:20:00.000Z")), /resume attempt limit/u);

	// 用户取消是明确意图，不应该被续跑覆盖。
	const cancelledRoot = join(root, "cancelled");
	const cancelledStore = new RunStateStore(cancelledRoot);
	const cancelledInitial = cancelledStore.create({
		runId: "run-cancelled",
		goalId: "goal-cancelled",
		question: "cancelled runs stay cancelled",
		language: "zh-CN",
		pins: created.pins,
		now: "2026-08-06T08:00:00.000Z",
	});
	cancelledStore.save(cancelledInitial, {
		...cancelledInitial,
		status: "cancelled" as const,
		finished_at: "2026-08-06T08:01:00.000Z",
		failure: {
			failure_class: "cancelled",
			failed_stage: "search_batch_running",
			message: "Research Run cancelled by request",
			cancellation_source: "request_signal" as const,
		},
	});
	assert.equal(canResumeRunState(cancelledStore.load()!), false);
} finally {
	rmSync(root, { recursive: true, force: true });
}

console.log("Run checkpoint recovery test passed");
