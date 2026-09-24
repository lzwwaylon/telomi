import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createResearchSourceRegistry } from "../../server/research/sources/builtin-registry.js";
import { getResearchSourceServiceManager } from "../../server/providers/source-service-client.js";
import {
	TWITTER_OPERATIONS,
	type TwitterOperation,
} from "../../server/research/sources/contracts/twitter.js";
import type {
	ResearchProviderRequest,
	ResearchSearchResult,
} from "../../server/providers/search-types.js";

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
		"Configure SOURCE_SERVICE_TWITTER_COOKIE_FILE or SOURCE_SERVICE_TWITTER_COOKIE before running the live Twitter Source test",
	);
}

const root = mkdtempSync(join(tmpdir(), "telomi-twitter-source-live-"));
const registry = createResearchSourceRegistry(process.env);
const signal = AbortSignal.timeout(10 * 60 * 1_000);

interface LiveOutcome {
	operation: TwitterOperation;
	status: "passed_with_data" | "passed_empty" | "failed";
	count: number;
	resourceTypes: string[];
	note?: string;
	error?: string;
}

const outcomes: LiveOutcome[] = [];

async function read(
	query: string,
	providerRequest: ResearchProviderRequest,
	maxResults = 5,
) {
	return registry.search("twitter", {
		query,
		maxResults,
		criterionIds: ["live-twitter-contract"],
		purpose: `Verify live Twitter operation ${providerRequest.operation}`,
		providerRequest,
		signal,
		workspaceDir: root,
	});
}

async function verify(
	operation: TwitterOperation,
	parameters: Record<string, unknown>,
	options: {
		query?: string;
		maxResults?: number;
		expectedResourceTypes?: string[];
		note?: string;
	} = {},
): Promise<ResearchSearchResult[]> {
	try {
		const results = await read(
			options.query ?? `live ${operation}`,
			{ operation, parameters },
			options.maxResults ?? 5,
		);
		const resourceTypes = [...new Set(
			results
				.map((row) => row.metadata?.resource_type)
				.filter((value): value is string => typeof value === "string"),
		)].sort();
		if (results.length > 0 && options.expectedResourceTypes?.length) {
			assert.ok(
				resourceTypes.every((value) => options.expectedResourceTypes!.includes(value)),
				`${operation} returned unexpected resource types: ${resourceTypes.join(", ")}`,
			);
		}
		outcomes.push({
			operation,
			status: results.length > 0 ? "passed_with_data" : "passed_empty",
			count: results.length,
			resourceTypes,
			...(options.note ? { note: options.note } : {}),
		});
		return results;
	} catch (error) {
		const message = String(error instanceof Error ? error.message : error).replaceAll(/\s+/gu, " ").slice(0, 500);
		outcomes.push({
			operation,
			status: "failed",
			count: 0,
			resourceTypes: [],
			...(options.note ? { note: options.note } : {}),
			error: message,
		});
		return [];
	}
}

function metadataString(
	rows: ResearchSearchResult[],
	key: string,
): string | undefined {
	const value = rows[0]?.metadata?.[key];
	return typeof value === "string" && value ? value : undefined;
}

try {
	const search = await verify("search", {
		query: '"agent evaluation" -filter:replies',
		product: "latest",
		limit: 10,
	}, {
		query: '"agent evaluation" -filter:replies',
		maxResults: 10,
		expectedResourceTypes: ["tweet"],
	});
	const profile = await verify("profile", {}, {
		query: "current session profile",
		maxResults: 1,
		expectedResourceTypes: ["user_profile"],
	});
	const currentUserId = metadataString(profile, "user_id");
	const screenName = metadataString(profile, "screen_name");

	let publicProfile: ResearchSearchResult[] = [];
	try {
		publicProfile = await read("OpenAI profile dependency", {
			operation: "profile",
			parameters: { username: "OpenAI" },
		}, 1);
	} catch {
		publicProfile = [];
	}
	const publicUserId = metadataString(publicProfile, "user_id") ?? currentUserId ?? "0";

	const posts = await verify("tweets", {
		user_id: publicUserId,
		limit: 5,
	}, {
		query: "posts by @OpenAI",
		expectedResourceTypes: ["tweet"],
	});
	const focalTweetId = metadataString(search, "tweet_id")
		?? metadataString(posts, "tweet_id")
		?? "1";

	await verify("thread", {
		tweet_id: focalTweetId,
		limit: 20,
	}, {
		query: `thread ${focalTweetId}`,
		maxResults: 20,
		expectedResourceTypes: ["tweet"],
	});
	await verify("article", {
		tweet_id: process.env.TELOMI_TWITTER_LIVE_ARTICLE_TWEET_ID?.trim() || focalTweetId,
	}, {
		query: `article ${focalTweetId}`,
		maxResults: 1,
		expectedResourceTypes: ["article", "note_tweet"],
		note: process.env.TELOMI_TWITTER_LIVE_ARTICLE_TWEET_ID
			? "explicit article fixture"
			: "focal live post, article falls back to note-tweet text when needed",
	});
	await verify("timeline", {
		feed: "following",
		limit: 10,
	}, {
		query: "current following timeline",
		maxResults: 10,
		expectedResourceTypes: ["tweet"],
	});
	await verify("following", {
		user_id: publicUserId,
		limit: 10,
	}, {
		query: "accounts followed by @OpenAI",
		maxResults: 10,
		expectedResourceTypes: ["user_profile"],
	});
	await verify("followers", {
		user_id: currentUserId ?? publicUserId,
		limit: 10,
	}, {
		query: "followers of current account",
		maxResults: 10,
		expectedResourceTypes: ["user_profile"],
		note: "current account avoids large-profile follower route variants",
	});
	await verify("likes", {
		user_id: currentUserId ?? publicUserId,
		limit: 10,
	}, {
		query: "current account likes",
		maxResults: 10,
		expectedResourceTypes: ["tweet"],
	});
	await verify("bookmarks", {
		limit: 10,
	}, {
		query: "current account bookmarks",
		maxResults: 10,
		expectedResourceTypes: ["tweet"],
	});
	const lists = await verify("lists", {
		limit: 100,
	}, {
		query: "current account lists",
		maxResults: 100,
		expectedResourceTypes: ["list"],
	});
	const listId = metadataString(lists, "list_id")
		?? process.env.TELOMI_TWITTER_LIVE_LIST_ID?.trim()
		?? "84839422";
	await verify("list_tweets", {
		list_id: listId,
		limit: 10,
	}, {
		query: `list posts ${listId}`,
		maxResults: 10,
		expectedResourceTypes: ["tweet"],
		note: lists.length > 0 ? "list discovered from current account" : "public X documentation example list",
	});
	await verify("device_follow", {
		limit: 10,
	}, {
		query: "device-follow notification stream",
		maxResults: 10,
		expectedResourceTypes: ["tweet"],
	});
	await verify("notifications", {
		limit: 10,
	}, {
		query: "current account notifications",
		maxResults: 10,
		expectedResourceTypes: ["notification"],
	});
	await verify("trending", {
		limit: 10,
	}, {
		query: "current trends",
		maxResults: 10,
		expectedResourceTypes: ["trend"],
	});
	await verify("media", {
		user_id: publicUserId,
		limit: 10,
	}, {
		query: "media posted by @OpenAI",
		maxResults: 10,
		expectedResourceTypes: ["media"],
	});

	assert.deepEqual(
		outcomes.map((outcome) => outcome.operation),
		[...TWITTER_OPERATIONS],
		"the live test must execute every supported Twitter read operation in contract order",
	);
	const failed = outcomes.filter((outcome) => outcome.status === "failed");
	console.log(JSON.stringify({
		event: failed.length === 0 ? "twitter_all_reads_live_passed" : "twitter_all_reads_live_failed",
		currentAccount: screenName ? `@${screenName}` : null,
		operations: outcomes,
		summary: {
			total: outcomes.length,
			passedWithData: outcomes.filter((outcome) => outcome.status === "passed_with_data").length,
			passedEmpty: outcomes.filter((outcome) => outcome.status === "passed_empty").length,
			failed: failed.length,
		},
		samples: search.slice(0, 3).map((row) => ({
			title: row.title,
			url: row.url,
		})),
	}, null, 2));
	assert.equal(
		failed.length,
		0,
		`Twitter live operations failed: ${failed.map((outcome) => outcome.operation).join(", ")}`,
	);
} finally {
	await getResearchSourceServiceManager().close();
	rmSync(root, { recursive: true, force: true });
}
