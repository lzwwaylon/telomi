import assert from "node:assert/strict";

import { createResearchSourceRegistry } from "../../server/research/sources/builtin-registry.js";

const registry = createResearchSourceRegistry(process.env);
const signal = new AbortController().signal;
const outcomes: Array<{ operation: string; status: "passed" | "failed"; count?: number; code?: string; error?: string }> = [];

for (const [operation, parameters, maxResults] of [
	["list_subscriptions", { limit: 3 }, 3],
	["snapshot_home_recommendations", { limit: 3 }, 3],
	["list_watch_later", { limit: 3 }, 3],
	["list_history", { limit: 3 }, 3],
] as const) {
	try {
		const rows = await registry.search("youtube", {
			query: operation,
			maxResults,
			criterionIds: ["youtube-account-functions-live"],
			purpose: `Verify real YouTube account operation ${operation}`,
			signal,
			workspaceDir: "/tmp/telomi-youtube-account-functions-live",
			providerRequest: { operation, parameters },
		});
		outcomes.push({ operation, status: "passed", count: rows.length });
	} catch (error) {
		outcomes.push({
			operation,
			status: "failed",
			code: error && typeof error === "object" && "code" in error ? String(error.code) : undefined,
			error: error instanceof Error ? error.message : String(error),
		});
	}
}

console.log(JSON.stringify({ event: "youtube_account_functions_live", outcomes }, null, 2));
assert.equal(
	outcomes.filter((outcome) => outcome.status === "failed").length,
	0,
	"Every YouTube account function requires a valid owner-only Cookie file or dedicated authenticated browser Profile",
);
