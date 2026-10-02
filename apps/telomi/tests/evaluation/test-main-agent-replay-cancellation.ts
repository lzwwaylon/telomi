import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runMainAgent } from "../../server/evaluation/main-agent-replay.js";
import type { GoalEventEnvelope, GoalSnapshot } from "../../shared/types.js";

const root = mkdtempSync(join(tmpdir(), "main-replay-cancellation-"));
const workspace = join(root, "main-runtime");
const listeners = new Set<(event: GoalEventEnvelope) => void>();
const snapshot = (isStreaming: boolean, errorMessage?: string): GoalSnapshot => ({
	goalId: "replay", title: "Replay", description: "", messages: [], pendingToolCalls: [],
	isStreaming, stopState: "idle", ...(errorMessage ? { errorMessage } : {}),
});
const emit = (isStreaming: boolean, errorMessage?: string) => {
	for (const listener of listeners) listener({ type: "snapshot", state: snapshot(isStreaming, errorMessage) });
};
let aborts = 0;
let starts = 0;
const runner: Parameters<typeof runMainAgent>[0] = {
	subscribe(listener) {
		listeners.add(listener);
		listener({ type: "snapshot", state: snapshot(false) });
		return () => { listeners.delete(listener); };
	},
	start() { starts++; emit(true); },
	abort() { aborts++; emit(true); },
};

try {
	mkdirSync(workspace);
	const controller = new AbortController();
	let cleaned = false;
	// Replay owns cleanup in finally; native work can still write after cancellation is requested.
	const outcome = runMainAgent(runner, "Investigate", controller.signal).then(
		() => undefined,
		(error: unknown) => error,
	).finally(() => { cleaned = true; rmSync(workspace, { recursive: true, force: true }); });
	controller.abort();
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(aborts, 1);
	assert.equal(starts, 1);
	assert.equal(cleaned, false, "Replay must not clean up while the cancelled Tool/Worker remains active");
	assert.equal(existsSync(workspace), true);
	assert.equal(listeners.size, 1, "the idle completion subscription survives the cancellation request");
	appendFileSync(join(workspace, "trace.jsonl"), '{"type":"late-native-output"}\n');
	assert.match(readFileSync(join(workspace, "trace.jsonl"), "utf8"), /late-native-output/u);
	// GoalRunner emits this only after its Tool, native Worker and Turn finally have settled.
	emit(false);
	const error = await outcome;
	assert.ok(error instanceof Error);
	assert.match(error.message, /Main Agent Node Backtest cancelled/u);
	assert.equal(cleaned, true);
	assert.equal(existsSync(workspace), false);
	assert.equal(listeners.size, 0);

	const preCancelled = new AbortController();
	preCancelled.abort();
	await assert.rejects(runMainAgent(runner, "Never starts", preCancelled.signal), /cancelled/u);
	assert.equal(starts, 1, "pre-start cancellation must not start a native Turn");
	assert.equal(listeners.size, 0);

	const completed = runMainAgent(runner, "Completes", new AbortController().signal);
	emit(false);
	await completed;
	assert.equal(listeners.size, 0);
	const failed = runMainAgent(runner, "Fails", new AbortController().signal);
	emit(false, "Native Tool failed");
	await assert.rejects(failed, /Native Tool failed/u);
	assert.equal(listeners.size, 0);
	await assert.rejects(runMainAgent({ ...runner, start: () => { throw new Error("Startup failed"); } },
		"Fails before running", new AbortController().signal), /Startup failed/u);
	assert.equal(listeners.size, 0, "synchronous startup failure also removes the completion subscription");
	console.log("Main Replay cancellation waits for native Tool/Worker completion before cleanup");
} finally {
	rmSync(root, { recursive: true, force: true });
}
