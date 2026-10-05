import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { nextGoalAvatar } from "../../shared/avatar.js";
import type { GoalSummary } from "../../shared/types.js";
import { ObservabilityActivityProjection } from "../../server/observability/activity-projection.js";
import { createTraceRouter } from "../../server/observability/trace-api.js";
import type { TraceRun } from "../../server/observability/trace-reader.js";
import { WikiActivityProjection } from "../../server/wiki/activity-projection.js";
import { wikiUpdateRecordsDir } from "../../server/wiki/update-runner.js";
import { WikiUpdateJobStore } from "../../server/wiki/wiki-update-job.js";

const workspaceDir = mkdtempSync(join(tmpdir(), "wiki-current-identity-"));
const goalId = "goal_current_identity", runId = "wiki_current_identity";
const directory = join(wikiUpdateRecordsDir(workspaceDir, goalId), runId);
mkdirSync(directory, { recursive: true });
mkdirSync(join(workspaceDir, goalId), { recursive: true });
const jobs = new WikiUpdateJobStore(directory);
jobs.start({
	compiler: "wiki-compilation", goalId, runId, goal: "Identity regression fixture",
	goalContext: { title: "Identity fixture", description: "No models or historical data" },
	topicPlan: { schema_version: 1, goal_id: goalId, revision: "fixture", status: "active", topics: [{
		id: "identity", title: "Identity", intent: "Inspect current identity", questions: ["Which stage?"],
		include: ["Identity"], exclude: ["Noise"],
	}] },
	sourceNotes: { relative_path: "artifacts/input/notes.json", sha256: "a".repeat(64), byte_length: 1 },
});
const usage = { inputTokens: 0, outputTokens: 0, costUsd: 0, calls: 0 };
jobs.recordBatch({ batchIndex: 0, totalBatches: 1, status: "succeeded", pageCount: 0, usage, reused: false });
jobs.recordStage({ kind: "merge-objects", stageIndex: 0, totalStages: 2, status: "succeeded", pageCount: 0, usage });
jobs.recordStage({ kind: "publication", stageIndex: 0, totalStages: 1, status: "succeeded", pageCount: 0, usage });
const now = "2026-10-05T00:00:00Z";
const goal: GoalSummary = {
	id: goalId, title: "Identity fixture", description: "", createdAt: now, updatedAt: now,
	preview: "", messageCount: 0, isStreaming: false, lastActivityAt: now, fresh: false,
	pulseLine: null, avatar: nextGoalAvatar([]), discoveryEnabled: false, outputLanguage: "auto",
};
const app = express();
app.use(createTraceRouter(workspaceDir, { getGoal: () => goal }));
const server = app.listen(0, "127.0.0.1");
await new Promise<void>((resolve) => server.once("listening", resolve));
try {
	const port = (server.address() as AddressInfo).port;
	const response = await fetch(`http://127.0.0.1:${port}/api/goals/${goalId}/traces/wiki/${runId}`);
	const body = await response.json() as { run: TraceRun };
	assert.equal(response.status, 200);
	assert.deepEqual(body.run.nodes.map((node) => node.agent), ["wiki_compilation", "wiki_compilation", undefined]);
	assert.equal(body.run.nodes.at(-1)?.nodeType, "runtime", "publication is Runtime, not an Agent");
	assert.ok(!JSON.stringify(body.run.nodes).match(/shard|curator/u), "fresh Trace cannot invent retired identities");
	assert.ok(body.run.nodes.every((node) => !node.caseRef), "stage nodes cannot borrow retired per-stage Cases");
	const projection = new WikiActivityProjection({ workspaceDir }, new ObservabilityActivityProjection()).project(goalId);
	const steps = projection.flatMap((contribution) => contribution.items.flatMap((item) => item.steps));
	assert.deepEqual(steps.map((step) => step.stepId), ["wiki-objects:1", "wiki-stage:merge-objects:0", "wiki-stage:publication:0"]);
	assert.deepEqual(steps.flatMap((step) => step.agentActivities.map((agent) => agent.agentName)),
		["wiki_compilation", "wiki_compilation", "wiki_publication"]);
	assert.ok(!JSON.stringify(projection).match(/shard|curator/u), "fresh Activity cannot invent retired identities");
	console.log("Fresh Wiki Compilation HTTP Trace and Activity contain current stage identities and Runtime publication");
} finally {
	await new Promise<void>((resolve) => server.close(() => resolve()));
	rmSync(workspaceDir, { recursive: true, force: true });
}
