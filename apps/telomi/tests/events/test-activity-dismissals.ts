import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { goalActivityDismissalStore } from "../../server/events/activity-dismissals.js";
import { ActivityProjectionService } from "../../server/events/activity-projection.js";
import { activityTiming } from "../../server/events/projection-helpers.js";
import type { ActivityAttention, ActivityProjectionItem } from "../../shared/events/activity-projection.js";

const goalId = "goal_activity_dismissals";
const workspaceDir = mkdtempSync(join(tmpdir(), "telomi-activity-dismissals-"));

function activity(activityId: string, updatedAt: string, attentionKind?: ActivityAttention["kind"]): ActivityProjectionItem {
	return {
		activityId,
		kind: "podcast",
		scope: { kind: "goal", goalId },
		trigger: { kind: "manual" },
		title: activityId,
		summary: activityId,
		lifecycle: attentionKind === "decision" ? "waiting" : "finished",
		...(attentionKind === "decision" ? {} : { outcome: "failed" as const }),
		...(attentionKind ? { attention: { kind: attentionKind, summary: activityId, actions: [] } } : {}),
		timing: activityTiming("2026-09-25T08:00:00.000Z", updatedAt, updatedAt),
		resultLinks: [],
		steps: [],
		sourceRef: activityId,
	};
}

let items: ActivityProjectionItem[] = [];
const serviceWithStore = () => {
	const service = new ActivityProjectionService({
		listGoalIds: () => [goalId],
		dismissals: goalActivityDismissalStore((id) => join(workspaceDir, id)),
	});
	service.registerProjection(() => [{ source: "podcast", items }]);
	return service;
};
const find = (service: ActivityProjectionService, activityId: string) => {
	const projection = service.getGoal(goalId);
	return [...projection.liveActivities, ...projection.history.items].find((item) => item.activityId === activityId)!;
};

try {
	items = [
		activity("failed-a", "2026-09-25T09:00:00.000Z", "failure"),
		activity("failed-b", "2026-09-25T09:10:00.000Z", "failure"),
		activity("decision", "2026-09-25T09:20:00.000Z", "decision"),
		activity("quiet", "2026-09-25T09:30:00.000Z"),
	];
	let service = serviceWithStore();

	// Only a failure offers a dismissal; a decision still needs its answer.
	const offered = find(service, "failed-a").attention!.dismiss!;
	assert.equal(offered.kind, "dismiss");
	assert.equal(offered.href, `/api/goals/${goalId}/events/activity-projection/dismissals`);
	assert.deepEqual(offered.requestBody, { activities: [{ activityId: "failed-a", updatedAt: "2026-09-25T09:00:00.000Z" }] });
	assert.equal(find(service, "decision").attention!.dismiss, undefined);
	assert.equal(service.getGoal(goalId).summary.attention, 3);

	// A dismissal names the failure as the user saw it; a changed failure is not settled by a stale one.
	assert.equal(service.dismiss(goalId, { activities: [{ activityId: "failed-a", updatedAt: "2026-09-25T08:59:00.000Z" }] }), 0);
	assert.equal(service.dismiss(goalId, { activities: [{ activityId: "decision", updatedAt: "2026-09-25T09:20:00.000Z" }] }), 0);
	assert.equal(service.dismiss(goalId, offered.requestBody as { activities: Array<{ activityId: string; updatedAt: string }> }), 1);

	// The dismissed failure stays in history as failed and stops counting, here and in the global summary,
	// and the dismissal outlives the service that recorded it.
	service = serviceWithStore();
	const dismissed = find(service, "failed-a");
	assert.equal(dismissed.outcome, "failed");
	assert.equal(dismissed.attention, undefined);
	assert.equal(service.getGoal(goalId).summary.attention, 2);
	assert.equal(service.getGlobalSummary().summary.attention, 2);

	// The same Activity failing again is a new failure and asks for attention again.
	items = items.map((item) => item.activityId === "failed-a" ? activity("failed-a", "2026-09-25T10:00:00.000Z", "failure") : item);
	assert.ok(find(service, "failed-a").attention?.dismiss);

	// Dismissing everything settles only failures recorded up to the projection on screen.
	items = [...items, activity("failed-later", "2026-09-25T11:00:00.000Z", "failure")];
	assert.equal(service.dismiss(goalId, { through: "2026-09-25T10:30:00.000Z" }), 2);
	const after = service.getGoal(goalId);
	assert.equal(after.summary.attention, 2, "the decision and the later failure remain");
	assert.ok(find(service, "failed-later").attention);
	assert.equal(find(service, "failed-b").attention, undefined);
	assert.equal(service.dismiss(goalId, { through: "2026-09-25T10:30:00.000Z" }), 0, "nothing left to settle");

	// Without a store nothing offers a dismissal.
	const plain = new ActivityProjectionService({ listGoalIds: () => [goalId] });
	plain.registerProjection(() => [{ source: "podcast", items }]);
	assert.equal(plain.getGoal(goalId).history.items.find((item) => item.activityId === "failed-later")!.attention!.dismiss, undefined);

	console.log("activity dismissals test passed");
} finally {
	rmSync(workspaceDir, { recursive: true, force: true });
}
