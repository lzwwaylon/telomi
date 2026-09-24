/**
 * 获取部分失败必须对用户可见。
 *
 * degraded_bundle 原本只存在于已发布的 Search Execution Record 里：Run 状态不记录，
 * Activity 不呈现，普通 Run 也不据此做任何决策。结果是一次所有素材获取都失败、
 * 只剩 Provider 元数据的研究，和一次正常研究长得一模一样。
 *
 * 这里锁两件事：
 *   1) Runtime 把客观计数写进 Run 状态（不做「证据够不够」的语义判断）
 *   2) Activity 摘要里能看到它，但不升格为 Attention——它没有可执行的下一步
 */

import assert from "node:assert/strict";
import i18n from "../../web/src/app/i18n.js";
import { activityText } from "../../web/src/shared/lib/activity-text.js";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createActivityProjection } from "../../server/app/activity-projection.js";
import { runRecordDir } from "../../server/observability/run-records.js";

const workspaceDir = mkdtempSync(join(tmpdir(), "pi-degraded-search-"));
const goalId = "goal_degraded";

function writeRun(runId: string, degraded: unknown[] | undefined, failedNotes = 0): void {
	const runDir = runRecordDir(workspaceDir, goalId, runId);
	mkdirSync(runDir, { recursive: true });
	writeFileSync(join(runDir, "run-state.json"), JSON.stringify({
		schema_version: 2,
		workflow_id: "research-run",
		workflow_version: 22,
		run_id: runId,
		goal_id: goalId,
		question: "获取降级可见性",
		language: "zh-CN",
		status: "published",
		state_revision: 2,
		pins: {},
		source_bundles: [],
		search_execution_records: [],
		cornell_note_snapshots: [],
		cornell_note_failure_count: failedNotes,
		writer_outputs: [],
		accepted_chapters: [],
		...(degraded ? { degraded_searches: degraded } : {}),
		canonical_report: { relative_path: "report/final.md", sha256: "a".repeat(64), byte_length: 12 },
		usage: {
			input_tokens: 20, output_tokens: 10, cost_usd: 0.01,
			model_calls: 3, agent_stages: 1, search_attempts: 1,
		},
		started_at: "2026-08-25T10:00:00.000Z",
		updated_at: "2026-08-25T10:01:00.000Z",
		finished_at: "2026-08-25T10:01:00.000Z",
	}), "utf8");
}

const healthyRunId = "2026-08-25T10-00-00.000Z";
const degradedRunId = "2026-08-25T11-00-00.000Z";
writeRun(healthyRunId, undefined);
writeRun(degradedRunId, [{
	provider_execution_id: "provider-execution:1:github",
	provider_id: "github",
	attempt_id: "attempt:prime:provider-execution-1-github:abc123",
	operations_total: 12,
	operations_failed: 5,
	failed_operations: ["clone_repository", "download_file"],
}], 1);

const service = createActivityProjection({
	workspaceDir,
	listGoalIds: () => [goalId],
});
const projection = service.getGoal(goalId);
const items = [...projection.liveActivities, ...projection.history.items];
const healthy = items.find((item) => item.activityId === `research:${healthyRunId}`);
const degraded = items.find((item) => item.activityId === `research:${degradedRunId}`);

assert.ok(healthy, "healthy run must be projected");
assert.ok(degraded, "degraded run must be projected");

// 摘要投影的是 message id，这里断言 zh-CN UI 渲染出来的文案。
await i18n.changeLanguage("zh-CN");
const healthySummary = activityText(healthy.summary);
const degradedSummary = activityText(degraded.summary);

// 1) 正常 Run 的摘要不受影响
assert.equal(healthySummary.includes("获取操作失败"), false, `healthy summary leaked: ${healthySummary}`);

// 2) 降级 Run 的摘要必须让人看见，且带上 provider 与失败计数
assert.ok(degradedSummary.includes("github"), `summary must name the provider: ${degradedSummary}`);
assert.ok(degradedSummary.includes("5"), `summary must carry the failure count: ${degradedSummary}`);
assert.ok(degradedSummary.includes("证据可能不完整"), `summary must warn about evidence: ${degradedSummary}`);
assert.ok(degradedSummary.includes("1 个 Source Note 失败"), `summary must carry Cornell failures: ${degradedSummary}`);

// 3) 两个 Run 的摘要必须不同——这正是原本缺失的区分
assert.notEqual(healthySummary, degradedSummary, "degraded run must not look identical to a healthy run");

// 4) 不升格为 Attention：获取降级没有可执行的下一步
assert.equal(degraded.attention, undefined, "degraded acquisition has no actionable next step");
assert.equal(degraded.outcome, "succeeded", "the Run itself still succeeded; Runtime does not judge sufficiency");

console.log(JSON.stringify({
	event: "degraded_search_visibility_ok",
	healthy_summary: healthySummary,
	degraded_summary: degradedSummary,
}, null, 2));
rmSync(workspaceDir, { recursive: true, force: true });
