import type { ResearchProviderRequest } from "../../../providers/search-types.js";

const MAX_PAGE_SIZE = 100;
const MAX_CURSOR_LENGTH = 4_096;
const HANDLE = /^[A-Za-z0-9_]{1,15}$/u;
const DECIMAL_ID = /^\d{1,32}$/u;

export const TWITTER_OPERATIONS = [
	"search",
	"profile",
	"tweets",
	"thread",
	"article",
	"timeline",
	"following",
	"followers",
	"likes",
	"bookmarks",
	"lists",
	"list_tweets",
	"device_follow",
	"notifications",
	"trending",
	"media",
] as const;

export type TwitterOperation = typeof TWITTER_OPERATIONS[number];
export type TwitterSearchProduct = "top" | "latest" | "photos" | "videos";
export type TwitterTimelineFeed = "for_you" | "following";

export interface TwitterParametersByOperation {
	search: { query: string; product: TwitterSearchProduct; limit: number; cursor?: string };
	profile: { username?: string; user_id?: string };
	tweets: { user_id: string; limit: number; cursor?: string };
	thread: { tweet_id: string; limit: number; cursor?: string };
	article: { tweet_id: string };
	timeline: { feed: TwitterTimelineFeed; limit: number; cursor?: string };
	following: { user_id: string; limit: number; cursor?: string };
	followers: { user_id: string; limit: number; cursor?: string };
	likes: { user_id: string; limit: number; cursor?: string };
	bookmarks: { limit: number; cursor?: string };
	lists: { limit: number };
	list_tweets: { list_id: string; limit: number; cursor?: string };
	device_follow: { limit: number };
	notifications: { limit: number; cursor?: string };
	trending: { limit: number };
	media: { user_id?: string; tweet_id?: string; limit: number; cursor?: string };
}

export type ParsedTwitterProviderRequest = {
	[K in TwitterOperation]: {
		operation: K;
		parameters: TwitterParametersByOperation[K];
	};
}[TwitterOperation];

export function parseTwitterProviderRequest(
	request: ResearchProviderRequest | undefined,
	requestQuery: string,
	requestMaxResults: number,
): ParsedTwitterProviderRequest {
	if (!request) throw new Error("Twitter Provider requests require an explicit operation");
	if (!TWITTER_OPERATIONS.includes(request.operation as TwitterOperation)) {
		throw new Error(`Unsupported Twitter operation '${request.operation}'`);
	}
	const operation = request.operation as TwitterOperation;
	const row = strictObject(request.parameters, allowedKeys(operation), operation);
	const defaultLimit = Math.min(integer(requestMaxResults, "max_results", 1, MAX_PAGE_SIZE), MAX_PAGE_SIZE);
	const limit = optionalInteger(row.limit, "limit", 1, MAX_PAGE_SIZE) ?? defaultLimit;
	const cursor = optionalText(row.cursor, "cursor", MAX_CURSOR_LENGTH);

	if (operation === "search") {
		const query = optionalText(row.query, "query", 2_000) ?? requiredText(requestQuery, "query", 2_000);
		return {
			operation,
			parameters: {
				query,
				product: optionalEnum(row.product, "product", ["top", "latest", "photos", "videos"] as const) ?? "top",
				limit,
				...(cursor ? { cursor } : {}),
			},
		};
	}
	if (operation === "profile") {
		const username = optionalHandle(row.username, "username");
		const userId = optionalId(row.user_id, "user_id");
		if (username && userId) throw new Error("Twitter profile accepts username or user_id, not both");
		return {
			operation,
			parameters: {
				...(username ? { username } : {}),
				...(userId ? { user_id: userId } : {}),
			},
		};
	}
	if (operation === "thread") {
		return {
			operation,
			parameters: {
				tweet_id: requiredId(row.tweet_id, "tweet_id"),
				limit,
				...(cursor ? { cursor } : {}),
			},
		};
	}
	if (operation === "article") {
		return { operation, parameters: { tweet_id: requiredId(row.tweet_id, "tweet_id") } };
	}
	if (operation === "timeline") {
		return {
			operation,
			parameters: {
				feed: optionalEnum(row.feed, "feed", ["for_you", "following"] as const) ?? "for_you",
				limit,
				...(cursor ? { cursor } : {}),
			},
		};
	}
	if (operation === "bookmarks" || operation === "notifications") {
		return { operation, parameters: { limit, ...(cursor ? { cursor } : {}) } };
	}
	if (operation === "lists" || operation === "device_follow" || operation === "trending") {
		return { operation, parameters: { limit } } as ParsedTwitterProviderRequest;
	}
	if (operation === "list_tweets") {
		return {
			operation,
			parameters: {
				list_id: requiredId(row.list_id, "list_id"),
				limit,
				...(cursor ? { cursor } : {}),
			},
		};
	}
	if (operation === "media") {
		const userId = optionalId(row.user_id, "user_id");
		const tweetId = optionalId(row.tweet_id, "tweet_id");
		if (Boolean(userId) === Boolean(tweetId)) {
			throw new Error("Twitter media requires exactly one of user_id or tweet_id");
		}
		return {
			operation,
			parameters: {
				...(userId ? { user_id: userId } : {}),
				...(tweetId ? { tweet_id: tweetId } : {}),
				limit,
				...(cursor ? { cursor } : {}),
			},
		};
	}
	return {
		operation,
		parameters: {
			user_id: requiredId(row.user_id, "user_id"),
			limit,
			...(cursor ? { cursor } : {}),
		},
	} as ParsedTwitterProviderRequest;
}

export function canonicalTwitterQuery(request: ParsedTwitterProviderRequest): string {
	return `twitter:${request.operation}:${JSON.stringify(request.parameters)}`;
}

function allowedKeys(operation: TwitterOperation): string[] {
	switch (operation) {
		case "search": return ["query", "product", "limit", "cursor"];
		case "profile": return ["username", "user_id"];
		case "thread": return ["tweet_id", "limit", "cursor"];
		case "article": return ["tweet_id"];
		case "timeline": return ["feed", "limit", "cursor"];
		case "bookmarks":
		case "notifications": return ["limit", "cursor"];
		case "lists":
		case "device_follow":
		case "trending": return ["limit"];
		case "list_tweets": return ["list_id", "limit", "cursor"];
		case "media": return ["user_id", "tweet_id", "limit", "cursor"];
		default: return ["user_id", "limit", "cursor"];
	}
}

function strictObject(
	value: unknown,
	allowedKeys: string[],
	operation: TwitterOperation,
): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("Twitter parameters must be an object");
	}
	const row = value as Record<string, unknown>;
	const allowed = new Set(allowedKeys);
	for (const key of Object.keys(row)) {
		if (!allowed.has(key)) throw new Error(`Unsupported Twitter ${operation} parameter '${key}'`);
	}
	return row;
}

function requiredText(value: unknown, label: string, maxLength: number): string {
	const parsed = optionalText(value, label, maxLength);
	if (!parsed) throw new Error(`Twitter ${label} is required`);
	return parsed;
}

function optionalText(value: unknown, label: string, maxLength: number): string | undefined {
	if (value === undefined || value === null || value === "") return undefined;
	if (typeof value !== "string" || !value.trim() || value.length > maxLength) {
		throw new Error(`Twitter ${label} must be a non-empty string up to ${maxLength} characters`);
	}
	return value.trim();
}

function optionalHandle(value: unknown, label: string): string | undefined {
	const parsed = optionalText(value, label, 64)?.replace(/^@+/u, "");
	if (parsed && !HANDLE.test(parsed)) {
		throw new Error(`Twitter ${label} must contain 1 to 15 letters, numbers, or underscores`);
	}
	return parsed;
}

function requiredId(value: unknown, label: string): string {
	const parsed = optionalId(value, label);
	if (!parsed) throw new Error(`Twitter ${label} is required`);
	return parsed;
}

function optionalId(value: unknown, label: string): string | undefined {
	const parsed = optionalText(value, label, 32);
	if (parsed && !DECIMAL_ID.test(parsed)) throw new Error(`Twitter ${label} must be a decimal identifier`);
	return parsed;
}

function integer(value: unknown, label: string, minimum: number, maximum: number): number {
	const parsed = optionalInteger(value, label, minimum, maximum);
	if (parsed === undefined) throw new Error(`Twitter ${label} is required`);
	return parsed;
}

function optionalInteger(
	value: unknown,
	label: string,
	minimum: number,
	maximum: number,
): number | undefined {
	if (value === undefined || value === null) return undefined;
	if (!Number.isInteger(value) || Number(value) < minimum || Number(value) > maximum) {
		throw new Error(`Twitter ${label} must be an integer from ${minimum} to ${maximum}`);
	}
	return Number(value);
}

function optionalEnum<const T extends readonly string[]>(
	value: unknown,
	label: string,
	values: T,
): T[number] | undefined {
	if (value === undefined || value === null || value === "") return undefined;
	if (typeof value !== "string" || !values.includes(value)) {
		throw new Error(`Twitter ${label} must be one of ${values.join(", ")}`);
	}
	return value as T[number];
}
