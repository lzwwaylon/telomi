import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createGenerateReportTool } from "../../server/main-agent/tools/generate-report.js";
import { serverRuntimeDirForGoal } from "../../server/workspaces/server-runtime-paths.js";
import { ReportRunService } from "../../server/research/reports/service.js";

const calls: Array<{ goalId: string; reportContext: string; title?: string }> = [];
const tool = createGenerateReportTool("/tmp/workspace/goal-1", {
	goalId: "goal-1",
	workspaceDir: "/tmp/workspace",
	reportRuntime: {
		generate: async (goalId, request) => {
			calls.push({ goalId, ...request });
			return {
				runId: "report-1",
				reportRef: "report/final.md",
				reportPath: "/tmp/report/final.md",
				content: "# Selection Report\n\nGrounded in the frozen Wiki.",
				usage: { input_tokens: 10, output_tokens: 5, cost_usd: 0.01, model_calls: 2, agent_stages: 2, search_attempts: 0 },
			};
		},
	},
});
const result = await tool.execute("tool-1", { report_context: "Compare ASR models", title: "Selection Report" });
assert.deepEqual(calls, [{ goalId: "goal-1", reportContext: "Compare ASR models", title: "Selection Report", outputLanguage: "en" }]);
assert.equal(result.content[0]?.type === "text" ? result.content[0].text : "", [
	"Report published.",
	"Title: Selection Report",
	"Report: /reports/report-1/final.md (read it only when the user asks about its contents)",
].join("\n"));
assert.equal((result.details as { executionKind: string }).executionKind, "report_only");
assert.deepEqual(result.details, {
	runId: "report-1",
	status: "published",
	stableFinalReportPath: "/workspace/wiki/runs/report-1/report/final.md",
	reportTitle: "Selection Report",
	renderFormats: ["markdown"],
	// The reply follows the language of the published report, here English.
	userResponse: "The report is ready. Open it from the report card.",
	executionKind: "report_only",
});

const root = mkdtempSync(join(tmpdir(), "telomi-generate-report-current-wiki-"));
try {
	const topicPlan = {
		schema_version: 1 as const,
		goal_id: "goal-reframed-wiki",
		revision: "topic-v1",
		status: "active" as const,
		topics: [{ id: "tts", title: "TTS", intent: "Track TTS.", questions: [], include: [], exclude: [] }],
	};
	const reframeGoalId = "goal-reframed-wiki";
	const reframeRoot = join(root, reframeGoalId, "wiki", "knowledge");
	mkdirSync(join(reframeRoot, "concepts"), { recursive: true });
	writeFileSync(join(reframeRoot, ".topic-plan.json"), `${JSON.stringify({
		...topicPlan,
		goal_id: reframeGoalId,
		revision: "topic-v2",
	}, null, 2)}\n`);
	writeFileSync(join(reframeRoot, ".note-registry.json"), '{"schema_version":2,"entries":[]}\n');
	writeFileSync(join(reframeRoot, ".deferred-notes.json"), '[]\n');
	writeFileSync(join(reframeRoot, "concepts", "current.md"), "# Current reframed Wiki\n");
	const controller = new AbortController();
	controller.abort();
	const reports = new ReportRunService(root);
	const queued = reports.enqueueLatest(reframeGoalId, { reportContext: "Summarize the current Wiki" }, controller.signal);
	assert.equal((queued as typeof queued & { wikiRevision?: string }).wikiRevision, "topic-v2",
		"generate_report must snapshot the active Wiki Edition even without a source Research Run");
	assert.ok(existsSync(join(root, reframeGoalId, "wiki", "runs", queued.id,
		"artifacts", "report-run", "knowledge-snapshot", "wiki", "concepts", "current.md")));
	const completed = await reports.wait(reframeGoalId, queued.id);
	assert.equal(completed.status, "failed");
	assert.equal(reports.read(reframeGoalId, "missing"), null);
	const recordPath = join(root, reframeGoalId, "wiki", "runs", queued.id, "report-run.json");
	const indexPath = join(serverRuntimeDirForGoal(reframeGoalId, root), "report-runs", queued.id, "report-run.json");
	assert.equal(readFileSync(recordPath, "utf-8"), `${JSON.stringify(completed, null, 2)}\n`);
	assert.equal(readFileSync(indexPath, "utf-8"), readFileSync(recordPath, "utf-8"));
	for (const field of ["schemaVersion", "id", "goalId", "wikiRevision", "reportContext", "status", "createdAt", "updatedAt", "input"]) {
		const invalid: Record<string, unknown> = { ...completed };
		delete invalid[field];
		writeFileSync(recordPath, JSON.stringify(invalid));
		assert.throws(() => reports.read(reframeGoalId, queued.id), /report-run\.json.*Report Run record is invalid/u, `missing ${field}`);
	}
	writeFileSync(recordPath, JSON.stringify({ ...completed, status: ["failed"] }));
	assert.throws(() => reports.read(reframeGoalId, queued.id), /Report Run record is invalid/u);
	writeFileSync(recordPath, "{");
	assert.throws(() => reports.read(reframeGoalId, queued.id), /Invalid JSON.*report-run\.json/u);
	writeFileSync(recordPath, JSON.stringify(completed));
	assert.deepEqual(new ReportRunService(root).read(reframeGoalId, queued.id), completed);
} finally {
	rmSync(root, { recursive: true, force: true });
}
console.log("generate_report Tool contract passed");
