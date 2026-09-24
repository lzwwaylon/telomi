import assert from "node:assert/strict";

import { bustSharedFetch, sharedFetch } from "../../web/src/shared/lib/use-shared-fetch.js";

const originalFetch = globalThis.fetch;
let calls = 0;
const releases: Array<() => void> = [];
globalThis.fetch = async () => {
	calls += 1;
	const value = calls;
	await new Promise<void>((resolve) => { releases.push(resolve); });
	return new Response(JSON.stringify({ value }), { headers: { "Content-Type": "application/json" } });
};

try {
	const first = sharedFetch<{ value: number }>("/shared", { ttlMs: 1_500 });
	bustSharedFetch("/shared");
	const second = sharedFetch<{ value: number }>("/shared", { ttlMs: 1_500 });
	bustSharedFetch("/shared");
	const duplicateConsumer = sharedFetch<{ value: number }>("/shared", { ttlMs: 1_500 });
	assert.equal(calls, 2, "invalidation during a request must fetch a fresh snapshot");
	releases[1]?.();
	assert.deepEqual(await Promise.all([second, duplicateConsumer]), [{ value: 2 }, { value: 2 }],
		"multiple consumers handling one event must share the fresh request");
	releases[0]?.();
	assert.deepEqual(await first, { value: 1 });
	assert.deepEqual(
		await sharedFetch<{ value: number }>("/shared", { ttlMs: 1_500 }),
		{ value: 2 },
		"the older request must not replace the fresh cached snapshot",
	);
} finally {
	globalThis.fetch = originalFetch;
}

console.log("shared fetch invalidation test passed");
