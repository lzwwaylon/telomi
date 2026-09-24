import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createResearchSourceRegistry } from "../../server/research/sources/builtin-registry.js";
import { getResearchSourceServiceManager } from "../../server/providers/source-service-client.js";
import type { ResearchProviderRequest } from "../../server/providers/search-types.js";

const configuredCookie = [
	process.env.SOURCE_SERVICE_TWITTER_COOKIE,
	process.env.TWITTER_COOKIE,
	process.env.X_COOKIE,
	process.env.SOURCE_SERVICE_TWITTER_COOKIE_FILE,
	process.env.TWITTER_COOKIE_FILE,
	process.env.X_COOKIE_FILE,
].some((value) => Boolean(value?.trim()));
if (!configuredCookie) {
	throw new Error(
		"Configure SOURCE_SERVICE_TWITTER_COOKIE_FILE or SOURCE_SERVICE_TWITTER_COOKIE before running this test",
	);
}

const workspaceDir = mkdtempSync(join(tmpdir(), "telomi-twitter-followers-lists-live-"));
const registry = createResearchSourceRegistry(process.env);
const signal = AbortSignal.timeout(5 * 60 * 1_000);

async function read(
	query: string,
	providerRequest: ResearchProviderRequest,
	maxResults: number,
) {
	return registry.search("twitter", {
		query,
		maxResults,
		criterionIds: ["twitter-followers-lists-live"],
		purpose: `Verify live Twitter operation ${providerRequest.operation}`,
		providerRequest,
		signal,
		workspaceDir,
	});
}

try {
	const currentProfile = await read(
		"current X session profile",
		{ operation: "profile", parameters: {} },
		1,
	);
	const publicProfile = await read(
		"OpenAI X profile",
		{ operation: "profile", parameters: { username: "OpenAI" } },
		1,
	);
	const publicUserId = publicProfile[0]?.metadata?.user_id;
	assert.equal(typeof publicUserId, "string");

	const followers = await read(
		"followers of @OpenAI",
		{
			operation: "followers",
			parameters: { user_id: publicUserId, limit: 10 },
		},
		10,
	);
	assert.ok(followers.length > 0, "signed Followers must return live public-account data");
	assert.ok(followers.every((row) => row.metadata?.resource_type === "user_profile"));

	const lists = await read(
		"lists owned or subscribed to by the current X account",
		{ operation: "lists", parameters: { limit: 100 } },
		100,
	);
	assert.ok(lists.every((row) => row.metadata?.resource_type === "list"));
	assert.ok(lists.every((row) => row.metadata?.twitter_operation === "lists"));

	console.log(JSON.stringify({
		event: "twitter_followers_lists_live_passed",
		currentAccount: currentProfile[0]?.metadata?.screen_name ?? null,
		followers: {
			target: "@OpenAI",
			count: followers.length,
			sampleHandles: followers.slice(0, 3).map((row) => row.metadata?.screen_name),
		},
		lists: {
			count: lists.length,
			interpretation: lists.length > 0
				? "owned-or-subscribed lists returned"
				: "valid empty owned-or-subscribed timeline",
		},
	}, null, 2));
} finally {
	await getResearchSourceServiceManager().close();
	rmSync(workspaceDir, { recursive: true, force: true });
}
