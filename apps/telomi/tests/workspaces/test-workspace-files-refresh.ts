import assert from "node:assert/strict";

import { startWorkspaceFilesRefresh } from "../../web/src/features/goals/data/workspaceFilesRefresh.js";

let refreshCount = 0;
let scheduledCount = 0;
let eventListener: ((event: { type: string; goalId?: string; status?: string }) => void) | undefined;
let connectionListener: ((connected: boolean) => void) | undefined;
const originalSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = ((..._args: Parameters<typeof setTimeout>) => {
	scheduledCount += 1;
	return 1 as unknown as ReturnType<typeof setTimeout>;
}) as typeof setTimeout;

const stop = startWorkspaceFilesRefresh({
	goalId: "goal_workspace_refresh",
	refresh: () => {
		refreshCount += 1;
	},
	subscribe: (_goalId, listener, onConnectionChange) => {
		eventListener = listener;
		connectionListener = onConnectionChange;
		return () => {
			eventListener = undefined;
			connectionListener = undefined;
		};
	},
});
globalThis.setTimeout = originalSetTimeout;

assert.equal(refreshCount, 1, "mounting must load the workspace once");
assert.equal(scheduledCount, 0, "an idle workspace must not schedule polling scans");
assert.equal(typeof eventListener, "function", "workspace refresh must subscribe to existing Goal events");

connectionListener?.(true);
assert.equal(refreshCount, 2, "the first SSE open must close the initial load-to-subscribe race");
connectionListener?.(false);
connectionListener?.(true);
assert.equal(refreshCount, 3, "a later SSE reconnect must refresh the workspace snapshot");

eventListener?.({ type: "goal:run-started", goalId: "goal_workspace_refresh" });
assert.equal(refreshCount, 3, "starting a Run must not rescan an unchanged workspace");
eventListener?.({ type: "goal:run-completed", goalId: "goal_workspace_refresh" });
assert.equal(refreshCount, 4, "completing a Run must refresh published workspace files");
eventListener?.({ type: "media-product:status", goalId: "goal_workspace_refresh", status: "done" });
assert.equal(refreshCount, 5, "publishing media must refresh workspace files");
eventListener?.({ type: "research-run:changed", goalId: "goal_workspace_refresh", status: "settled" });
assert.equal(refreshCount, 6, "settling a resumed research Run must refresh workspace files");

stop();
assert.equal(eventListener, undefined, "unmounting must remove the Goal event subscription");

console.log("workspace files event-driven refresh test passed");
