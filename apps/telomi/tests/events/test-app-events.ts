import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AppEvent } from "../../shared/events/app-events.js";
import { createActivityProjection } from "../../server/app/activity-projection.js";
import { GoalTopicPlanStore } from "../../server/goals/topic-plan/index.js";
import { publish, subscribe } from "../../server/events/event-bus.js";
import { ensureGoalWorkspace } from "../../server/workspaces/goal-project.js";
import { executeResearchRun } from "../../server/research/execute-run.js";
import { RunStateStore } from "../../server/research/run-state.js";

const first: AppEvent[] = [];
const second: AppEvent[] = [];
let warnings = 0;
const originalWarn = console.warn;
console.warn = () => { warnings += 1; };
const unsubscribeFirst = subscribe((event) => first.push(event));
const unsubscribeBroken = subscribe(() => {
	throw new Error("broken listener");
});
const unsubscribeSecond = subscribe((event) => second.push(event));

const started = {
	type: "goal:run-started",
	goalId: "goal-1",
	messageCount: 0,
	timestamp: "2026-08-31T00:00:00.000Z",
} satisfies AppEvent;
assert.doesNotThrow(() => publish(started), "one broken listener must not stop publication");
assert.deepEqual(first, [started]);
assert.deepEqual(second, [started]);

unsubscribeFirst();
const activity = { type: "activity-projection:changed", goalId: "goal-1" } satisfies AppEvent;
publish(activity);
assert.deepEqual(first, [started], "unsubscribed listeners must stop receiving events");
assert.deepEqual(second, [started, activity]);

unsubscribeBroken();
unsubscribeSecond();
console.warn = originalWarn;
assert.equal(warnings, 2, "broken listeners must be reported independently");

const researchWorkspace = mkdtempSync(join(tmpdir(), "telomi-research-events-"));
const researchGoalId = "goal-research-events";
const researchGoalDir = join(researchWorkspace, researchGoalId);
ensureGoalWorkspace({ goalDir: researchGoalDir, goalId: researchGoalId, title: "Research activity events" });
const topicStore = new GoalTopicPlanStore(researchGoalId, researchWorkspace);
const topicProposal = topicStore.proposePatch({
	source: "main_agent",
	patch: {
		schema_version: 1,
		base_revision: null,
		summary: "Track Research Activity events",
		operations: [{
			op: "add",
			topic: {
				id: "activity-events",
				title: "Activity events",
				intent: "Verify running Research is visible",
				questions: [],
				include: [],
				exclude: [],
			},
		}],
	},
});
topicStore.activate(topicProposal.proposal_id);
const researchProjection = createActivityProjection({
	workspaceDir: researchWorkspace,
	listGoalIds: () => [researchGoalId],
});
let projectedRunningResearch = false;
const unsubscribeResearch = subscribe((event) => {
	if (event.type !== "activity-projection:changed" || event.goalId !== researchGoalId) return;
	projectedRunningResearch = researchProjection.getGoal(researchGoalId).liveActivities.some(
		(item) => item.kind === "research" && item.lifecycle === "running",
	);
});
try {
	const research = executeResearchRun({
		goalDir: researchGoalDir,
		goalId: researchGoalId,
		workspaceDir: researchWorkspace,
		taskSource: "main_agent",
		reason: "Verify Activity invalidation",
		question: "Research Activity events",
		reportContext: "Verify that a running Research stage refreshes Activity Projection.",
		researchExecutor: async (request) => {
			const store = new RunStateStore(request.controlDirectory);
			const initialized = store.create({
				runId: request.runId,
				goalId: researchGoalId,
				question: request.question,
				language: "zh-CN",
				pins: {
					harness_snapshot: "harness:test",
					workspace_content_hash: "a".repeat(64),
					knowledge_memory_hash: "knowledge:test",
					run_context_snapshot: "1".repeat(64),
					pipeline: "pipeline:test",
					prompt_bundle: "prompts:test",
					schema_bundle: "schemas:test",
					model_policy: "model:test",
					skill_bundle: "skills:test",
					tool_schema: "tools:test",
				},
			});
			const planning = {
				...initialized,
				status: "search_batch_running" as const,
				updated_at: new Date().toISOString(),
			};
			store.save(initialized, planning);
			store.save(planning, {
				...planning,
				status: "search_batch_running",
				updated_at: new Date().toISOString(),
			});
			request.onNodeState?.({
				nodeId: "search_batch:1",
				status: "running",
				visit: 1,
				attempt: 1,
			});
			throw new Error("stop after observing the running Activity");
		},
	});
	await assert.rejects(research, /stop after observing the running Activity/u);
	assert.equal(projectedRunningResearch, true,
		"a normal running Research stage must invalidate and refresh Activity Projection");
} finally {
	unsubscribeResearch();
	rmSync(researchWorkspace, { recursive: true, force: true });
}
console.log("app event bus test passed");
