import assert from "node:assert/strict";
import test from "node:test";

import { readIdleVerdict, SCHEDULED_RESEARCH_HORIZON_MS, type IdleSources } from "../../server/app/idle-verdict.js";
import type { ActivityProjectionSummary, GlobalActivityProjectionSummary } from "../../shared/events/activity-projection.js";

const NOW = Date.parse("2026-01-01T00:00:00.000Z");
const quiet: ActivityProjectionSummary = { attention: 0, running: 0, queued: 0, waiting: 0 };

function sources(overrides: Partial<IdleSources> = {}): IdleSources {
	return {
		listGoalIds: () => ["goal_a", "goal_b"],
		isGoalActive: () => false,
		activitySummary: () => summaryOf([]),
		hasClaimedScheduledResearch: () => false,
		nextScheduledAt: () => undefined,
		hasRunningScheduleReview: () => false,
		hasExecutingEvolutionRun: () => false,
		userMemoryActiveOperations: async () => 0,
		...overrides,
	};
}

function summaryOf(goals: GlobalActivityProjectionSummary["goals"]): GlobalActivityProjectionSummary {
	return { schemaVersion: 2, revision: "r", generatedAt: new Date(NOW).toISOString(), summary: quiet, activities: [], goals, system: quiet };
}

test("an instance with no work is idle and still reports the next scheduled occurrence", async () => {
	const later = new Date(NOW + SCHEDULED_RESEARCH_HORIZON_MS + 1).toISOString();
	assert.deepEqual(await readIdleVerdict(sources({ nextScheduledAt: () => later }), NOW), {
		idle: true, reasons: [], nextScheduledAt: later, checkedAt: new Date(NOW).toISOString(),
	});
});

test("each kind of work makes the instance busy and names itself", async () => {
	const dueSoon = new Date(NOW + SCHEDULED_RESEARCH_HORIZON_MS).toISOString();
	const cases: Array<[Partial<IdleSources>, unknown]> = [
		[{ isGoalActive: (goalId) => goalId === "goal_b" }, { kind: "goal-work", goalId: "goal_b" }],
		[{ activitySummary: () => summaryOf([{ goalId: "goal_a", summary: { ...quiet, running: 1 } }]) },
			{ kind: "activity", goalId: "goal_a", running: 1, queued: 0 }],
		[{ activitySummary: () => summaryOf([{ goalId: "goal_a", summary: { ...quiet, queued: 2 } }]) },
			{ kind: "activity", goalId: "goal_a", running: 0, queued: 2 }],
		// Waiting Activities are stopped until the user acts, and attention alone is not work.
		[{ activitySummary: () => summaryOf([{ goalId: "goal_a", summary: { ...quiet, waiting: 1, attention: 1 } }]) }, undefined],
		[{ hasClaimedScheduledResearch: () => true }, { kind: "scheduled-research" }],
		[{ nextScheduledAt: () => dueSoon }, { kind: "scheduled-research", nextScheduledAt: dueSoon }],
		[{ hasRunningScheduleReview: () => true }, { kind: "schedule-review" }],
		[{ hasExecutingEvolutionRun: () => true }, { kind: "evolution" }],
		[{ userMemoryActiveOperations: async () => 2 }, { kind: "user-memory", activeOperations: 2 }],
		[{ userMemoryActiveOperations: async () => null }, { kind: "user-memory", activeOperations: null }],
	];
	for (const [override, reason] of cases) {
		const verdict = await readIdleVerdict(sources(override), NOW);
		assert.deepEqual(verdict.reasons, reason ? [reason] : [], JSON.stringify(reason));
		assert.equal(verdict.idle, !reason);
	}
});

test("an overdue occurrence waiting for its Goal keeps the instance busy", async () => {
	const overdue = new Date(NOW - 60_000).toISOString();
	const verdict = await readIdleVerdict(sources({ nextScheduledAt: () => overdue }), NOW);
	assert.equal(verdict.idle, false);
	assert.deepEqual(verdict.reasons, [{ kind: "scheduled-research", nextScheduledAt: overdue }]);
});
