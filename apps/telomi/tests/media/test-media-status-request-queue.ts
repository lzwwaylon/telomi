import assert from "node:assert/strict";

import { fetchMediaProductStatus } from "../../web/src/features/goals/data/useMediaProductStatus.js";

let active = 0;
let peak = 0;
const releases: Array<() => void> = [];
const originalFetch = globalThis.fetch;

globalThis.fetch = async (input) => {
	active += 1;
	peak = Math.max(peak, active);
	await new Promise<void>((resolve) => releases.push(resolve));
	active -= 1;
	return new Response(JSON.stringify({
		cardId: String(input),
		sourceMtimeMs: 0,
		podcast: { status: "idle", implemented: true },
	}), {
		status: 200,
		headers: { "Content-Type": "application/json" },
	});
};

try {
	const first = fetchMediaProductStatus("/status/first");
	const second = fetchMediaProductStatus("/status/second");
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(peak, 1, "background media status snapshots must leave a browser connection free for user-triggered POSTs");
	releases.shift()?.();
	await first;
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(active, 1);
	releases.shift()?.();
	await second;
} finally {
	globalThis.fetch = originalFetch;
}

console.log("media status request queue test passed");
