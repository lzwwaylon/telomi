import assert from "node:assert/strict";
import i18n from "../../web/src/app/i18n.js";
import { activityText } from "../../web/src/shared/lib/activity-text.js";

await i18n.changeLanguage("zh-CN");
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createActivityProjection } from "../../server/app/activity-projection.js";
import { runRecordDir } from "../../server/observability/run-records.js";

const workspaceDir = mkdtempSync(join(tmpdir(), "pi-provider-activity-"));
const goalId = "goal_provider_activity";
const runId = "2026-09-14T08-00-00.000Z";
const runDir = runRecordDir(workspaceDir, goalId, runId);
mkdirSync(runDir, { recursive: true });

function writeState(status: "search_batch_running" | "published"): void {
	writeFileSync(join(runDir, "run-state.json"), JSON.stringify({
		schema_version: 2, workflow_id: "research-run", workflow_version: 26,
		run_id: runId, goal_id: goalId, question: "调研最近的 TTS 论文", language: "zh-CN",
		status, state_revision: status === "published" ? 2 : 1, pins: {}, source_bundles: [],
		search_execution_records: [], cornell_note_snapshots: [], cornell_note_failure_manifests: [],
		cornell_note_failure_count: 0, writer_outputs: [], accepted_chapters: [],
		...(status === "published" ? { canonical_report: { relative_path: "report/final.md", sha256: "a".repeat(64), byte_length: 12 } } : {}),
		usage: { input_tokens: 0, output_tokens: 0, cost_usd: 0, model_calls: 2, agent_stages: 1, search_attempts: 1 },
		started_at: "2026-09-14T08:00:00.000Z", updated_at: "2026-09-14T08:00:05.000Z",
		...(status === "published" ? { finished_at: "2026-09-14T08:01:00.000Z" } : {}),
	}), "utf8");
}

function appendRuntime(event: Record<string, unknown>): void {
	appendFileSync(join(runDir, "runtime--research.jsonl"), `${JSON.stringify(event)}\n`, "utf8");
}

function item() {
	const service = createActivityProjection({ workspaceDir, listGoalIds: () => [goalId] });
	const projection = service.getGoal(goalId);
	return [...projection.liveActivities, ...projection.history.items]
		.find((candidate) => candidate.activityId === `research:${runId}`)!;
}

writeState("search_batch_running");
appendRuntime({
	type: "runtime.provider_access", provider_id: "arxiv", sub_execution_id: "sub-paper",
	state: "cooling", failure_class: "rate_limit", wait_started_at: "2026-09-14T08:00:02.000Z",
	budget_deadline_at: "2026-09-14T08:01:02.000Z", next_attempt_at: "2026-09-14T08:00:32.000Z",
	created_at: "2026-09-14T08:00:02.000Z",
});
let projected = item();
const cooling = projected.steps.find((step) => step.providerAccess?.kind === "cooling");
assert.equal(cooling?.providerAccess?.providerId, "arxiv");
assert.equal(cooling?.providerAccess?.failureClass, "rate_limit");
assert.equal(cooling?.lifecycle, "running");
assert.doesNotMatch(JSON.stringify(projected), /credential|access_scope|\/Users\//u,
	"public Activity carries timing and reason only, never Provider request or private paths");

appendRuntime({
	type: "runtime.provider_access", provider_id: "arxiv", sub_execution_id: "sub-paper",
	state: "recovered", failure_class: "rate_limit", wait_started_at: "2026-09-14T08:00:02.000Z",
	ended_at: "2026-09-14T08:00:33.000Z", created_at: "2026-09-14T08:00:33.000Z",
});
projected = item();
assert.equal(projected.steps.some((step) => step.providerAccess?.kind === "cooling"), false);
assert.equal(projected.steps.find((step) => step.providerAccess?.kind === "recovered")?.outcome, "succeeded",
	"successful retry clears persisted cooling after refresh while the Run is still active");

appendRuntime({
	type: "runtime.provider_access", provider_id: "arxiv", sub_execution_id: "sub-paper",
	state: "unavailable", failure_class: "rate_limit", wait_started_at: "2026-09-14T08:00:02.000Z",
	ended_at: "2026-09-14T08:00:03.000Z", reason: "retry_after_exceeds_budget",
	created_at: "2026-09-14T08:00:03.000Z",
});
appendRuntime({
	type: "runtime.provider_fallback_selected", from_provider_id: "arxiv", to_provider_id: "browser",
	created_at: "2026-09-14T08:00:04.000Z",
});
const fallbackWork = join(runDir, "workspaces", "search-batch-1", "agent", "provider-executions", "sub-fallback", "work");
mkdirSync(fallbackWork, { recursive: true });
writeFileSync(join(fallbackWork, ".provider-assignment"), "browser\n", "utf8");
appendFileSync(join(runDir, "provider-calls.jsonl"), `${JSON.stringify({
	seq: 1, node_id: "prime-search-batch-1", attempt_id: "attempt-1", sub_execution_id: "sub-fallback",
	provider: "huggingface", at: "2026-09-14T08:00:05.000Z", latency_ms: 10,
	request: { query: "private query", purpose: "test", criterion_ids: [], max_results: 10 },
	response: { status: "ok", cache: "miss", doc_ids: ["paper-1"], docs: [], material_sha256: [] },
})}\n`, "utf8");
writeState("published");

// A fresh projection instance proves refresh/reconnect recovery comes from persisted records.
projected = item();
const unavailable = projected.steps.find((step) => step.providerAccess?.kind === "unavailable");
const fallback = projected.steps.find((step) => step.providerAccess?.kind === "fallback");
assert.equal(unavailable?.outcome, "partial");
assert.equal(fallback?.providerAccess?.providerId, "browser");
assert.equal(fallback?.providerAccess?.fallbackOutcome, "succeeded");
assert.match(activityText(projected.summary), /arXiv 不可用，已改用 Browser/u);
assert.doesNotMatch(JSON.stringify(projected), /private query/u, "Provider requests stay out of Activity projection");

writeState("search_batch_running");
appendRuntime({
	type: "runtime.provider_access", provider_id: "arxiv", sub_execution_id: "sub-interrupted",
	state: "cooling", failure_class: "rate_limit", wait_started_at: "2026-09-14T08:03:00.000Z",
	created_at: "2026-09-14T08:03:00.000Z",
});
appendRuntime({ type: "runtime.run_resumed", created_at: "2026-09-14T08:04:00.000Z" });
const historicalWait = item().steps.find((step) => step.stepId === "provider-access:sub-interrupted:arxiv");
assert.equal(historicalWait?.lifecycle, "finished", "resuming cannot reactivate an abandoned Provider wait");
assert.equal(historicalWait?.timing.finishedAt, "2026-09-14T08:04:00.000Z");

console.log("Provider cooldown, circuit break and fallback survive Activity projection reload");
rmSync(workspaceDir, { recursive: true, force: true });
