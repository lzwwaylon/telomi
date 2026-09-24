import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PodcastActivityStore, activitySort, type GoalActivityItem } from "../../server/events/activity-store.js";

const now = Date.UTC(2026, 6, 15, 2, 0, 0);

function activity(overrides: Partial<GoalActivityItem> = {}): GoalActivityItem {
	return {
		id: "podcast-job",
		goalId: "goal_status_isolation",
		kind: "podcast",
		agent: "Podcast AI",
		action: "timer",
		status: "queued",
		updatedAt: now,
		...overrides,
	};
}

const queuedPodcast = activity();
const podcastActivities = new PodcastActivityStore();
const queued = podcastActivities.record({ ...queuedPodcast, updatedAt: undefined });
assert.equal(queued.status, "queued");
assert.equal(queued.startedAt, undefined);
assert.equal(queued.finishedAt, undefined);

const running = podcastActivities.record({ ...queuedPodcast, status: "running", updatedAt: undefined });
assert.equal(running.status, "running");
assert.equal(typeof running.startedAt, "number");
assert.equal(running.finishedAt, undefined);

const done = podcastActivities.record({ ...queuedPodcast, status: "done", updatedAt: undefined });
assert.equal(done.status, "done");
assert.equal(typeof done.finishedAt, "number");

const ordered = [
	activity({ id: "done", status: "done" }),
	activity({ id: "queued", status: "queued" }),
	activity({ id: "running", status: "running" }),
].sort(activitySort);
assert.deepEqual(ordered.map((item) => item.status), ["running", "queued", "done"]);

const activityDir = mkdtempSync(join(tmpdir(), "telomi-activity-"));
try {
	const logPath = join(activityDir, "events.jsonl");
	const persistedHub = new PodcastActivityStore({ logPath });
	persistedHub.record(activity({ id: "deleted", goalId: "goal_deleted" }));
	persistedHub.record(activity({ id: "retained", goalId: "goal_retained" }));
	persistedHub.purgeGoal("goal_deleted");
	assert.deepEqual(persistedHub.list("goal_retained").map((item) => item.goalId), ["goal_retained"]);
	assert.equal(readFileSync(logPath, "utf-8").includes("goal_deleted"), false);
	assert.deepEqual(new PodcastActivityStore({ logPath }).list("goal_retained").map((item) => item.goalId), ["goal_retained"]);
} finally {
	rmSync(activityDir, { recursive: true, force: true });
}

console.log("Goal activity lifecycle and persistence tests passed");
