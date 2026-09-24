import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { ResearchScheduleReviewService } from "../../server/research/schedules/review-service.js";
import { ResearchScheduleScheduler } from "../../server/research/schedules/scheduler.js";
import { ResearchScheduleStore } from "../../server/research/schedules/store.js";
import type { GoalService } from "../../server/goals/service.js";

test("the scheduler reports the earliest active occurrence only while it runs", () => {
	const workspaceDir = mkdtempSync(join(tmpdir(), "schedule-next-occurrence-"));
	const created = new Date("2026-01-01T00:00:00.000Z");
	const make = (goalId: string, cron: string) => {
		const store = new ResearchScheduleStore(goalId, workspaceDir);
		try {
			return store.create({
				title: cron, question: "What changed?", monitoringScope: "Monitor releases.",
				reportContext: "Write for the team.", cron, timeZone: "UTC",
				initializedFromRunId: "run-baseline", coveredThrough: created.toISOString(), sources: [], now: created,
			});
		} finally {
			store.close();
		}
	};
	const daily = make("goal_a", "0 9 * * *");
	const hourly = make("goal_b", "0 * * * *");
	const paused = new ResearchScheduleStore("goal_b", workspaceDir);
	paused.pause(hourly.id);
	paused.close();
	// Busy Goals and Reviews keep the started scheduler from claiming or reviewing anything here.
	const scheduler = new ResearchScheduleScheduler(workspaceDir, {
		listGoals: () => [{ id: "goal_a" }, { id: "goal_b" }],
		isGoalActive: () => true,
	} as unknown as GoalService, { isRunning: () => true } as unknown as ResearchScheduleReviewService);
	try {
		assert.equal(scheduler.nextOccurrenceAt(), undefined, "a stopped scheduler starts nothing");
		scheduler.start();
		assert.equal(scheduler.nextOccurrenceAt(), daily.nextRunAt, "paused Schedules are not due");
		assert.equal(scheduler.hasClaimedOccurrence(), false);
	} finally {
		scheduler.stop();
		rmSync(workspaceDir, { recursive: true, force: true });
	}
});
