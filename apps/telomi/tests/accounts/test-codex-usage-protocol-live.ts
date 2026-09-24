import assert from "node:assert/strict";
import { codexAccountManager } from "../../server/accounts/manager.js";
import { readCodexUsageViaAppServer } from "../../server/accounts/codex/app-server-usage-client.js";

await codexAccountManager.load();
const active = codexAccountManager.getActiveCredential();
assert.equal(active?.type, "oauth", "active Codex account must use OAuth");
assert.ok(active.access, "active Codex account has no access token");
assert.ok(active.accountId, "active Codex account has no ChatGPT account id");

const result = await readCodexUsageViaAppServer(active);
const bucket = result.rateLimits.rateLimits;
console.log(
	JSON.stringify(
		{
			passed: true,
			planType: bucket.planType ?? null,
			usedPercent: bucket.primary?.usedPercent ?? null,
			windowDurationMins: bucket.primary?.windowDurationMins ?? null,
			resetsAt: bucket.primary?.resetsAt ?? null,
			rateLimitReachedType: bucket.rateLimitReachedType ?? null,
			resetCreditsAvailable:
				result.rateLimits.rateLimitResetCredits?.availableCount ?? null,
			lifetimeTokens: result.tokenUsage.summary.lifetimeTokens ?? null,
			dailyBucketCount: result.tokenUsage.dailyUsageBuckets?.length ?? 0,
		},
		null,
		2,
	),
);
