import assert from "node:assert/strict";

import { removeCodexUsageHome } from "../../server/accounts/codex/app-server-usage-client.js";

let attempts = 0;
const waits: number[] = [];

await removeCodexUsageHome("/tmp/fake-codex-home", {
	remove: async () => {
		attempts += 1;
		if (attempts < 3) {
			throw Object.assign(new Error("Directory not empty"), { code: "ENOTEMPTY" });
		}
	},
	wait: async (delayMs) => {
		waits.push(delayMs);
	},
});

assert.equal(attempts, 3, "transient ENOTEMPTY cleanup races must be retried");
assert.deepEqual(waits, [50, 100], "cleanup retries must use bounded exponential backoff");

let permanentAttempts = 0;
await assert.rejects(
	() =>
		removeCodexUsageHome("/tmp/fake-codex-home", {
			remove: async () => {
				permanentAttempts += 1;
				throw Object.assign(new Error("Permission denied"), { code: "EACCES" });
			},
			wait: async () => undefined,
		}),
	/Permission denied/,
);
assert.equal(permanentAttempts, 1, "non-race cleanup errors must not be retried");

console.log("codex usage lifecycle test passed");
