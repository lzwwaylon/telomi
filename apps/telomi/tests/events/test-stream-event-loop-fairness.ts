import assert from "node:assert/strict";

import { fairlyScheduled } from "../../server/accounts/stream-fallback.js";
import { mapConcurrentFairly } from "../../server/research/pipeline/fair-concurrency.js";

async function* burst(size: number): AsyncGenerator<number> {
	for (let index = 0; index < size; index += 1) yield index;
}

let timerObserved = false;
let processedBeforeTimer = 0;
const timer = new Promise<void>((resolve) => {
	setTimeout(() => {
		timerObserved = true;
		resolve();
	}, 0);
});

await Promise.all(Array.from({ length: 32 }, async () => {
	for await (const _event of fairlyScheduled(burst(500))) {
		if (!timerObserved) processedBeforeTimer += 1;
	}
}));
await timer;

assert.equal(timerObserved, true);
assert.ok(
	processedBeforeTimer < 32 * 500,
	"Model event bursts must yield to timers and HTTP/SSE work before draining every stream",
);

let queueTimerObserved = false;
let queueItemsBeforeTimer = 0;
const queueTimer = new Promise<void>((resolve) => {
	setTimeout(() => {
		queueTimerObserved = true;
		resolve();
	}, 0);
});
await mapConcurrentFairly(
	Array.from({ length: 500 }, (_, index) => index),
	32,
	async (item) => {
		if (!queueTimerObserved) queueItemsBeforeTimer += 1;
		return item;
	},
);
await queueTimer;
assert.ok(
	queueItemsBeforeTimer < 500,
	"Immediately reusable checkpoints must yield to timers and HTTP/SSE work before draining the queue",
);

let launchHeartbeats = 0;
const launchHeartbeat = setInterval(() => {
	launchHeartbeats += 1;
}, 1);
await mapConcurrentFairly(
	Array.from({ length: 32 }, (_, index) => index),
	32,
	async (item) => {
		const blockUntil = Date.now() + 3;
		while (Date.now() < blockUntil) {
			// Reproduce synchronous Agent setup such as process creation and snapshot capture.
		}
		return item;
	},
);
clearInterval(launchHeartbeat);
assert.ok(
	launchHeartbeats > 1,
	"Concurrent Agent setup must be admitted across event-loop turns instead of one blocking burst",
);

let siblingSettled = false;
await assert.rejects(mapConcurrentFairly(["failed", "slow"], 2, async (item) => {
	if (item === "failed") throw new Error("worker_failed");
	await new Promise((resolve) => setTimeout(resolve, 20));
	siblingSettled = true;
	return item;
}), /worker_failed/u);
assert.equal(siblingSettled, true,
	"a fatal Worker failure must wait for already-started siblings to settle before returning");

console.log("Model stream event-loop fairness tests passed");
