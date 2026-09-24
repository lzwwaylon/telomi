import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { ActivityProjectionService } from "../../server/events/activity-projection.js";
import { activityTiming } from "../../server/events/projection-helpers.js";
import { ObservabilityActivityProjection } from "../../server/observability/activity-projection.js";
import { agentSessionPath, appendRuntimeContext, runRecordDir } from "../../server/observability/run-records.js";
import { ResearchActivityProjection } from "../../server/research/activity-projection.js";
import type {
	ActivityLifecycle,
	ActivityProjectionItem,
	ActivityStep,
} from "../../shared/events/activity-projection.js";

const goalId = "goal_live_elapsed";
const startedAt = "2026-09-19T18:00:00.000Z";
// The Stage stopped reporting long before the projection is read, which is the case the reading is for.
const lastUpdate = "2026-09-19T18:07:00.000Z";
const finishedAt = "2026-09-19T18:20:00.000Z";
const firstRead = Date.parse("2026-09-19T18:40:00.000Z");
const secondRead = Date.parse("2026-09-19T18:41:30.000Z");

let clock = firstRead;

function agentActivity(id: string, lifecycle: ActivityLifecycle) {
	return {
		agentActivityId: id,
		agentName: "cornell_note",
		summary: id,
		lifecycle,
		timing: activityTiming(startedAt, lastUpdate),
		attempts: [{
			attemptId: `${id}:1`,
			number: 1,
			lifecycle,
			timing: activityTiming(startedAt, lastUpdate),
		}],
	};
}

function step(stepId: string, lifecycle: ActivityLifecycle, parallelSteps: ActivityStep[] = []): ActivityStep {
	return {
		stepId,
		title: stepId,
		summary: stepId,
		lifecycle,
		timing: lifecycle === "finished"
			? activityTiming(startedAt, finishedAt, finishedAt)
			: activityTiming(startedAt, lastUpdate),
		dependsOnStepIds: [],
		parallelSteps,
		agentActivities: [agentActivity(`agent:${stepId}`, lifecycle)],
	};
}

function activity(
	activityId: string,
	lifecycle: ActivityLifecycle,
	steps: ActivityStep[] = [],
): ActivityProjectionItem {
	return {
		activityId,
		kind: "research",
		scope: { kind: "goal", goalId },
		trigger: { kind: "manual" },
		title: activityId,
		summary: activityId,
		lifecycle,
		...(lifecycle === "finished" ? { outcome: "succeeded" as const } : {}),
		timing: lifecycle === "finished"
			? activityTiming(startedAt, finishedAt, finishedAt)
			: activityTiming(startedAt, lastUpdate),
		resultLinks: [],
		steps,
		sourceRef: activityId,
	};
}

const items: ActivityProjectionItem[] = [
	activity("running", "running", [
		step("running-step", "running", [step("parallel-running", "running"), step("parallel-done", "finished")]),
		step("done-step", "finished"),
	]),
	activity("waiting", "waiting"),
	activity("queued", "queued"),
	// A finished Activity whose last recorded Step status never turned over: nothing here is running.
	activity("finished", "finished", [step("stuck-step", "running")]),
];

const service = new ActivityProjectionService({
	listGoalIds: () => [goalId],
	now: () => clock,
});
service.registerProjection(() => [{ source: "research", items }]);

const first = service.getGoal(goalId);
clock = secondRead;
const second = service.getGoal(goalId);

const live = (projection: typeof first, activityId: string) => {
	const item = projection.liveActivities.find((candidate) => candidate.activityId === activityId);
	assert.ok(item, `missing live Activity ${activityId}`);
	return item;
};
const recordedSpan = Date.parse(lastUpdate) - Date.parse(startedAt);

// A running Activity is timed against the current reading, not against its last update.
assert.equal(live(first, "running").timing.durationMs, firstRead - Date.parse(startedAt));
assert.ok(live(first, "running").timing.durationMs! > recordedSpan,
	"a Stage that went quiet must not read as if it only ran until its last update");
assert.equal(live(second, "running").timing.durationMs! - live(first, "running").timing.durationMs!,
	secondRead - firstRead, "elapsed time keeps advancing with the clock alone");
assert.equal(live(second, "running").timing.updatedAt, finishedAt,
	"the last update stays the latest the Runtime recorded anywhere in the Activity, here its finished Step");

// Activity Steps, nested parallel Steps, Agent Activities and their Attempts advance the same way.
const runningStep = (projection: typeof first) => live(projection, "running").steps
	.find((candidate) => candidate.stepId === "running-step")!;
for (const timing of [
	runningStep(second).timing,
	runningStep(second).parallelSteps.find((candidate) => candidate.stepId === "parallel-running")!.timing,
	runningStep(second).agentActivities[0]!.timing,
	runningStep(second).agentActivities[0]!.attempts[0]!.timing,
]) {
	assert.equal(timing.durationMs, secondRead - Date.parse(startedAt));
}
assert.equal(runningStep(first).parallelSteps.find((candidate) => candidate.stepId === "parallel-done")!.timing.durationMs,
	Date.parse(finishedAt) - Date.parse(startedAt), "a finished parallel Step keeps its recorded span");
assert.equal(runningStep(second).agentActivities[0]!.attempts[0]!.lifecycle, "running");

// Finished work is fixed, and so is everything recorded under a finished Activity.
const finished = (projection: typeof first) => projection.history.items
	.find((candidate) => candidate.activityId === "finished")!;
assert.equal(finished(first).timing.durationMs, Date.parse(finishedAt) - Date.parse(startedAt));
assert.equal(finished(second).timing.durationMs, finished(first).timing.durationMs);
assert.equal(finished(second).steps[0]!.timing.durationMs, recordedSpan,
	"a Step left as running under a finished Activity is not still running");
assert.equal(live(first, "running").steps.find((candidate) => candidate.stepId === "done-step")!.timing.durationMs,
	Date.parse(finishedAt) - Date.parse(startedAt));

// Queued and waiting work is not spending time on the work, so its reading holds still.
for (const activityId of ["waiting", "queued"]) {
	assert.equal(live(first, activityId).timing.durationMs, recordedSpan);
	assert.deepEqual(live(second, activityId).timing, live(first, activityId).timing);
}

// Elapsed time is derived, so a projection that only kept counting is not a change to react to.
assert.equal(second.revision, first.revision, "counting time must not invalidate the Activity projection");
assert.equal(second.generatedAt, new Date(secondRead).toISOString());
assert.deepEqual(second.summary, { attention: 0, running: 1, queued: 1, waiting: 1 });

// Unusable timestamps read as a recorded span or zero, never as negative time.
const futureStart = "2026-09-19T23:00:00.000Z";
const odd: ActivityProjectionItem[] = [
	{ ...activity("future", "running"), timing: { createdAt: futureStart, startedAt: futureStart, updatedAt: futureStart } },
	{ ...activity("broken", "running"), timing: { createdAt: "not-a-time", startedAt: "not-a-time", updatedAt: "not-a-time", durationMs: 42 } },
];
const oddService = new ActivityProjectionService({ listGoalIds: () => [goalId], now: () => clock });
oddService.registerProjection(() => [{ source: "research", items: odd }]);
const oddProjection = oddService.getGoal(goalId);
assert.equal(live(oddProjection, "future").timing.durationMs, 0);
assert.equal(live(oddProjection, "broken").timing.durationMs, 42);

// One Worker of a pool stops reporting while its siblings keep going: its own last activity is what
// the reading must follow, so the pool's progress cannot make a stalled Worker look fresh.
const workspaceDir = mkdtempSync(join(tmpdir(), "telomi-live-elapsed-"));
try {
	const runId = "2026-09-19T18-00-00.000Z";
	const runDir = runRecordDir(workspaceDir, goalId, runId);
	mkdirSync(runDir, { recursive: true });
	writeFileSync(join(runDir, "run-state.json"), JSON.stringify({
		schema_version: 2,
		run_id: runId,
		goal_id: goalId,
		question: "并行 Cornell Note 的耗时读数",
		status: "evidence_materializing",
		usage: { model_calls: 1 },
		started_at: startedAt,
		updated_at: lastUpdate,
	}), "utf8");
	const quietAt = "2026-09-19T18:03:00.000Z";
	const busyAt = "2026-09-19T18:39:30.000Z";
	for (const [executionId, sessionAt] of [["note-quiet", quietAt], ["note-busy", busyAt]] as const) {
		const session = agentSessionPath(runDir, "cornell_note", executionId);
		writeFileSync(session, `${JSON.stringify({
			type: "message",
			timestamp: Date.parse(sessionAt),
			message: { role: "assistant", content: [{ type: "toolCall", name: "read_source", arguments: {} }] },
		})}\n`, "utf8");
		appendRuntimeContext(runDir, "research", {
			type: "runtime.agent_bound",
			stage_id: `cornell-note-29-${executionId}`,
			execution_id: executionId,
			agent: "cornell_note",
			session_file: basename(session),
			created_at: startedAt,
		});
	}

	// A later Worker joining the pool is fresh Run activity that says nothing about the quiet one.
	appendRuntimeContext(runDir, "research", {
		type: "runtime.agent_bound",
		stage_id: "cornell-note-30-note-late",
		execution_id: "note-late",
		agent: "cornell_note",
		created_at: busyAt,
	});

	const research = new ResearchActivityProjection({ workspaceDir }, new ObservabilityActivityProjection());
	const researchService = new ActivityProjectionService({ listGoalIds: () => [goalId], now: () => clock });
	researchService.registerProjection((id) => research.project(id));
	const run = live(researchService.getGoal(goalId), `research:${runId}`);
	const worker = (executionId: string) => {
		const step = run.steps.find((candidate) => candidate.stepId === `active:${executionId}`);
		assert.ok(step, `missing Worker ${executionId}`);
		return step;
	};

	assert.equal(worker("note-quiet").timing.updatedAt, quietAt,
		"a Worker's last activity comes from its own record, not from whichever sibling reported last");
	assert.equal(worker("note-busy").timing.updatedAt, busyAt);
	assert.equal(worker("note-late").timing.updatedAt, busyAt, "a Worker with no output yet is as old as its start");
	assert.notEqual(worker("note-quiet").timing.updatedAt, worker("note-busy").timing.updatedAt);
	assert.equal(worker("note-quiet").agentActivities[0]!.timing.updatedAt, quietAt);
	for (const step of [worker("note-quiet"), worker("note-busy")]) {
		assert.equal(step.lifecycle, "running");
		assert.equal(step.timing.durationMs, clock - Date.parse(startedAt));
		assert.equal(step.agentActivities[0]!.timing.durationMs, clock - Date.parse(startedAt));
	}
	assert.equal(run.timing.updatedAt, busyAt,
		"a Run whose own record changes only between Stages was last active when its busiest Worker was");
} finally {
	rmSync(workspaceDir, { recursive: true, force: true });
}

// Prime Search Root waits in one Tool call while its native Provider children work. The children's
// turns are that execution's progress, so neither its Step nor the Run reads as quiet; once every
// session stops, both go quiet again.
const primeWorkspace = mkdtempSync(join(tmpdir(), "telomi-live-prime-"));
try {
	const runId = "2026-09-19T18-00-00.000Z";
	const runDir = runRecordDir(primeWorkspace, goalId, runId);
	mkdirSync(runDir, { recursive: true });
	const pipelineStartAt = "2026-09-19T18:00:03.000Z";
	writeFileSync(join(runDir, "run-state.json"), JSON.stringify({
		schema_version: 2,
		run_id: runId,
		goal_id: goalId,
		question: "Prime Search 检索中的最后活动",
		status: "search_batch_running",
		usage: { model_calls: 1 },
		started_at: startedAt,
		updated_at: pipelineStartAt,
	}), "utf8");
	const executionId = "prime-exec-1";
	const trace = agentSessionPath(runDir, "prime_search", executionId);
	const rootQuietAt = "2026-09-19T18:04:00.000Z";
	writeFileSync(trace, `${JSON.stringify({
		type: "message",
		timestamp: Date.parse(rootQuietAt),
		message: { role: "assistant", content: [{ type: "toolCall", name: "ipython", arguments: {} }] },
	})}\n`, "utf8");
	appendRuntimeContext(runDir, "research", {
		type: "runtime.agent_bound",
		stage_id: "prime-search-batch-1",
		execution_id: executionId,
		agent: "prime_search",
		session_file: basename(trace),
		created_at: pipelineStartAt,
	});
	const acquisition = join(runDir, "workspaces", "search-batch-1", "runtime", "acquisition-session");
	mkdirSync(join(acquisition, "session"), { recursive: true });
	writeFileSync(join(acquisition, "session", "root.jsonl"), [
		{ type: "session", timestamp: "2026-09-19T18:00:04.000Z" },
		{ type: "message", timestamp: rootQuietAt, message: { role: "assistant", content: [] } },
	].map((entry) => JSON.stringify(entry)).join("\n") + "\n", "utf8");
	const childDir = join(acquisition, "session-artifacts", "sub-child1");
	mkdirSync(childDir, { recursive: true });
	const childSession = join(childDir, "child.jsonl");
	const childBusyAt = "2026-09-19T18:39:00.000Z";
	// A long tool result ahead of the last entry, so the reading does not depend on a whole-file parse.
	writeFileSync(childSession, [
		{ type: "session", timestamp: "2026-09-19T18:05:00.000Z" },
		{ type: "message", timestamp: "2026-09-19T18:20:00.000Z", message: { role: "toolResult", content: [{ type: "text", text: "x".repeat(200_000) }] } },
		{ type: "message", timestamp: childBusyAt, message: { role: "assistant", content: [] } },
	].map((entry) => JSON.stringify(entry)).join("\n") + "\n", "utf8");

	const research = new ResearchActivityProjection({ workspaceDir: primeWorkspace }, new ObservabilityActivityProjection());
	const primeService = new ActivityProjectionService({ listGoalIds: () => [goalId], now: () => clock });
	primeService.registerProjection((id) => research.project(id));
	const read = () => {
		const run = live(primeService.getGoal(goalId), `research:${runId}`);
		const step = run.steps.find((candidate) => candidate.stepId === `active:${executionId}`);
		assert.ok(step, "missing Prime Search Step");
		return { run, step };
	};

	const busy = read();
	assert.equal(busy.step.timing.updatedAt, childBusyAt, "a delegated child's turn is the Prime Search execution's progress");
	assert.equal(busy.run.timing.updatedAt, childBusyAt, "the Run reads as active while its Stage records progress");

	// The whole execution stops recording once the child started: the silence shows at every level.
	const childStartedAt = "2026-09-19T18:05:00.000Z";
	writeFileSync(childSession, `${JSON.stringify({ type: "session", timestamp: childStartedAt })}\n`, "utf8");
	const stalled = read();
	assert.equal(stalled.step.timing.updatedAt, childStartedAt);
	assert.equal(stalled.run.timing.updatedAt, childStartedAt, "a stalled Run keeps its last recorded activity");
} finally {
	rmSync(primeWorkspace, { recursive: true, force: true });
}

console.log("Activity live elapsed test passed");
