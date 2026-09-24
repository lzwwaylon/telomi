import type { ResearchProviderRequest } from "../../../providers/search-types.js";

const MAX_PAGE_SIZE = 50;
const MAX_BATCH_RESULTS = 500;
const MAX_PAGE_TOKEN_LENGTH = 2_048;
const MAX_LANGUAGE_LENGTH = 64;
const MAX_URL_LENGTH = 8_000;

export const YOUTUBE_OPERATIONS = [
	"capabilities",
	"list_subscriptions",
	"list_subscription_uploads",
	"list_channel_videos",
	"list_playlist_videos",
	"search_videos",
	"get_video",
	"get_transcript",
	"snapshot_home_recommendations",
	"list_watch_later",
	"list_history",
] as const;

export type YouTubeOperation = typeof YOUTUBE_OPERATIONS[number];

export interface YouTubeListParameters {
	limit: number;
	page_token?: string;
}

export interface YouTubeSubscriptionUploadsParameters {
	limit: number;
	published_after?: string;
	channel_ids?: string[];
	include_shorts: boolean;
	include_live: boolean;
}

export interface YouTubeChannelVideosParameters extends YouTubeListParameters {
	channel_id: string;
	published_after?: string;
	include_shorts: boolean;
	include_live: boolean;
}

export interface YouTubePlaylistVideosParameters extends YouTubeListParameters {
	playlist_id: string;
}

export interface YouTubeSearchVideosParameters extends YouTubeListParameters {
	query: string;
	published_after?: string;
	channel_id?: string;
}

export interface YouTubeVideoParameters {
	video_id: string;
}

export interface YouTubeTranscriptParameters extends YouTubeVideoParameters {
	target_language?: string;
	preferred_languages: string[];
	max_duration_seconds: number;
}

export interface YouTubeFeedParameters {
	limit: number;
}

export interface YouTubeParametersByOperation {
	capabilities: Record<string, never>;
	list_subscriptions: YouTubeListParameters;
	list_subscription_uploads: YouTubeSubscriptionUploadsParameters;
	list_channel_videos: YouTubeChannelVideosParameters;
	list_playlist_videos: YouTubePlaylistVideosParameters;
	search_videos: YouTubeSearchVideosParameters;
	get_video: YouTubeVideoParameters;
	get_transcript: YouTubeTranscriptParameters;
	snapshot_home_recommendations: YouTubeFeedParameters;
	list_watch_later: YouTubeFeedParameters;
	list_history: YouTubeFeedParameters;
}

export type ParsedYouTubeProviderRequest = {
	[K in YouTubeOperation]: {
		operation: K;
		parameters: YouTubeParametersByOperation[K];
	};
}[YouTubeOperation];

export function parseYouTubeProviderRequest(
	request: ResearchProviderRequest | undefined,
	requestQuery: string,
	requestMaxResults: number,
): ParsedYouTubeProviderRequest {
	if (!request) throw new Error("YouTube Provider requests require an explicit operation");
	const operation = parseOperation(request.operation);
	const input = objectValue(request.parameters, "YouTube parameters");
	const defaultLimit = boundedLimit(requestMaxResults);
	if (operation === "capabilities") {
		strictObject(input, [], operation);
		return { operation, parameters: {} };
	}
	if (operation === "list_subscriptions") {
		const row = strictObject(input, ["limit", "page_token"], operation);
		return { operation, parameters: listParameters(row, defaultLimit) };
	}
	if (operation === "list_subscription_uploads") {
		const row = strictObject(input, [
			"limit", "published_after", "channel_ids", "include_shorts", "include_live",
		], operation);
		return {
			operation,
			parameters: {
				limit: optionalInteger(row.limit, "limit", 1, MAX_BATCH_RESULTS) ?? defaultLimit,
				...optionalDateProperty(row.published_after, "published_after"),
				...optionalStringArrayProperty(row.channel_ids, "channel_ids", 500),
				include_shorts: optionalBoolean(row.include_shorts, "include_shorts") ?? true,
				include_live: optionalBoolean(row.include_live, "include_live") ?? true,
			},
		};
	}
	if (operation === "list_channel_videos") {
		const row = strictObject(input, [
			"channel_id", "url", "limit", "page_token", "published_after", "include_shorts", "include_live",
		], operation);
		const channelId = parseChannelInput(row.channel_id ?? row.url);
		return {
			operation,
			parameters: {
				channel_id: channelId,
				...listParameters(row, defaultLimit),
				...optionalDateProperty(row.published_after, "published_after"),
				include_shorts: optionalBoolean(row.include_shorts, "include_shorts") ?? true,
				include_live: optionalBoolean(row.include_live, "include_live") ?? true,
			},
		};
	}
	if (operation === "list_playlist_videos") {
		const row = strictObject(input, ["playlist_id", "url", "limit", "page_token"], operation);
		return {
			operation,
			parameters: {
				playlist_id: parsePlaylistInput(row.playlist_id ?? row.url),
				...listParameters(row, defaultLimit),
			},
		};
	}
	if (operation === "search_videos") {
		const row = strictObject(input, [
			"query", "limit", "page_token", "published_after", "channel_id",
		], operation);
		return {
			operation,
			parameters: {
				query: optionalText(row.query, "query", 2_000)
					?? requireText(requestQuery, "query", 2_000),
				...listParameters(row, defaultLimit),
				...optionalDateProperty(row.published_after, "published_after"),
				...optionalTextProperty(row.channel_id, "channel_id", 256),
			},
		};
	}
	if (operation === "get_video") {
		const row = strictObject(input, ["video_id", "url"], operation);
		return { operation, parameters: { video_id: parseVideoInput(row.video_id ?? row.url) } };
	}
	if (operation === "get_transcript") {
		const row = strictObject(input, [
			"video_id", "url", "target_language", "preferred_languages",
			"max_duration_seconds",
		], operation);
		const targetLanguage = optionalLanguage(row.target_language, "target_language");
		const preferredLanguages = optionalLanguageArray(row.preferred_languages, "preferred_languages");
		return {
			operation,
			parameters: {
				video_id: parseVideoInput(row.video_id ?? row.url),
				...(targetLanguage ? { target_language: targetLanguage } : {}),
				preferred_languages: uniqueStrings([
					...(targetLanguage ? [targetLanguage] : []),
					...preferredLanguages,
				]),
				max_duration_seconds: optionalInteger(
					row.max_duration_seconds,
					"max_duration_seconds",
					30,
					6 * 60 * 60,
				) ?? 2 * 60 * 60,
			},
		};
	}
	const row = strictObject(input, ["limit"], operation);
	return {
		operation,
		parameters: {
			limit: optionalInteger(row.limit, "limit", 1, 100) ?? Math.min(defaultLimit, 100),
		},
	} as ParsedYouTubeProviderRequest;
}

export function youTubeOperationMaterializesWorkspace(operation: string | undefined): boolean {
	// get_transcript 把 transcript.md 与 transcript.timed.json 写进当前 Run 的工作区，
	// 并把绝对路径放进结果。Provider 缓存命中时原样返回存下来的结果、不重新物化，
	// 所以这类操作一旦进缓存，后续命中拿到的就是指向已删除工作区的路径。
	return operation === "get_transcript";
}

export function canonicalYouTubeQuery(request: ParsedYouTubeProviderRequest): string {
	return `youtube:${request.operation}:${JSON.stringify(request.parameters)}`;
}

export type YouTubeLocator =
	| { kind: "video"; id: string }
	| { kind: "playlist"; id: string }
	| { kind: "channel"; id: string };

export function parseYouTubeLocator(value: string): YouTubeLocator {
	const raw = requireText(value, "YouTube URL or ID", MAX_URL_LENGTH);
	if (/^[A-Za-z0-9_-]{11}$/u.test(raw)) return { kind: "video", id: raw };
	if (/^(?:PL|UU|LL|OLAK5uy_|RD)[A-Za-z0-9_-]{8,}$/u.test(raw)) {
		return { kind: "playlist", id: raw };
	}
	if (/^UC[A-Za-z0-9_-]{20,}$/u.test(raw) || /^@[A-Za-z0-9._-]{3,}$/u.test(raw)) {
		return { kind: "channel", id: raw };
	}
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		throw new Error("YouTube locator must be a video, playlist, channel, or handle URL");
	}
	const host = url.hostname.toLowerCase().replace(/^www\./u, "");
	if (!["youtube.com", "m.youtube.com", "youtu.be", "music.youtube.com"].includes(host)) {
		throw new Error("YouTube URL must use youtube.com or youtu.be");
	}
	if (host === "youtu.be") {
		const id = url.pathname.split("/").filter(Boolean)[0];
		if (id && /^[A-Za-z0-9_-]{11}$/u.test(id)) return { kind: "video", id };
	}
	const videoId = url.searchParams.get("v")
		?? /^\/(?:shorts|embed|live)\/([^/?#]+)/u.exec(url.pathname)?.[1];
	if (videoId && /^[A-Za-z0-9_-]{11}$/u.test(videoId)) return { kind: "video", id: videoId };
	const playlistId = url.searchParams.get("list");
	if (playlistId && /^[A-Za-z0-9_-]{10,}$/u.test(playlistId)) return { kind: "playlist", id: playlistId };
	const channel = /^\/(?:channel\/([^/?#]+)|(@[^/?#]+))/u.exec(url.pathname);
	const channelId = channel?.[1] ?? channel?.[2];
	if (channelId) return { kind: "channel", id: channelId };
	throw new Error("Unsupported YouTube URL shape");
}

function parseOperation(value: string): YouTubeOperation {
	if (!YOUTUBE_OPERATIONS.includes(value as YouTubeOperation)) {
		throw new Error(`Unsupported YouTube operation '${value}'`);
	}
	return value as YouTubeOperation;
}

function listParameters(
	row: Record<string, unknown>,
	defaultLimit: number,
	maximum = MAX_PAGE_SIZE,
): YouTubeListParameters {
	return {
		limit: optionalInteger(row.limit, "limit", 1, maximum) ?? Math.min(defaultLimit, maximum),
		...optionalTextProperty(row.page_token, "page_token", MAX_PAGE_TOKEN_LENGTH),
	};
}

function boundedLimit(value: number): number {
	if (!Number.isInteger(value) || value <= 0) throw new Error("max_results must be a positive integer");
	return Math.min(value, MAX_BATCH_RESULTS);
}

function parseVideoInput(value: unknown): string {
	const raw = requireText(value, "video_id or url", MAX_URL_LENGTH);
	if (/^[A-Za-z0-9_-]{11}$/u.test(raw)) return raw;
	const locator = parseYouTubeLocator(raw);
	if (locator.kind !== "video") throw new Error("Expected a YouTube video URL or video ID");
	return locator.id;
}

function parsePlaylistInput(value: unknown): string {
	const raw = requireText(value, "playlist_id or url", MAX_URL_LENGTH);
	if (/^[A-Za-z0-9_-]{10,}$/u.test(raw) && !raw.startsWith("http")) return raw;
	const locator = parseYouTubeLocator(raw);
	if (locator.kind !== "playlist") throw new Error("Expected a YouTube playlist URL or playlist ID");
	return locator.id;
}

function parseChannelInput(value: unknown): string {
	const raw = requireText(value, "channel_id or url", MAX_URL_LENGTH);
	if (/^UC[A-Za-z0-9_-]{20,}$/u.test(raw) || /^@[A-Za-z0-9._-]{3,}$/u.test(raw)) return raw;
	const locator = parseYouTubeLocator(raw);
	if (locator.kind !== "channel") throw new Error("Expected a YouTube channel URL, channel ID, or handle");
	return locator.id;
}

function strictObject(
	value: Record<string, unknown>,
	allowedKeys: string[],
	operation: YouTubeOperation,
): Record<string, unknown> {
	const allowed = new Set(allowedKeys);
	for (const key of Object.keys(value)) {
		if (!allowed.has(key)) throw new Error(`Unsupported YouTube ${operation} parameter '${key}'`);
	}
	return value;
}

function objectValue(value: unknown, label: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`${label} must be an object`);
	}
	return value as Record<string, unknown>;
}

function requireText(value: unknown, label: string, limit: number): string {
	if (typeof value !== "string" || !value.trim() || value.length > limit) {
		throw new Error(`YouTube ${label} must be a non-empty string up to ${limit} characters`);
	}
	return value.trim();
}

function optionalText(value: unknown, label: string, limit: number): string | undefined {
	if (value === undefined || value === null || value === "") return undefined;
	return requireText(value, label, limit);
}

function optionalTextProperty(
	value: unknown,
	label: string,
	limit: number,
): Record<string, string> {
	const parsed = optionalText(value, label, limit);
	return parsed ? { [label]: parsed } : {};
}

function optionalInteger(
	value: unknown,
	label: string,
	minimum: number,
	maximum: number,
): number | undefined {
	if (value === undefined || value === null) return undefined;
	if (!Number.isInteger(value) || Number(value) < minimum || Number(value) > maximum) {
		throw new Error(`YouTube ${label} must be an integer from ${minimum} to ${maximum}`);
	}
	return Number(value);
}

function optionalBoolean(value: unknown, label: string): boolean | undefined {
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "boolean") throw new Error(`YouTube ${label} must be a boolean`);
	return value;
}

function optionalDateProperty(value: unknown, label: string): Record<string, string> {
	const parsed = optionalText(value, label, 64);
	if (!parsed) return {};
	const timestamp = Date.parse(parsed);
	if (!Number.isFinite(timestamp)) throw new Error(`YouTube ${label} must be an ISO 8601 timestamp`);
	return { [label]: new Date(timestamp).toISOString() };
}

function optionalStringArrayProperty(
	value: unknown,
	label: string,
	maximum: number,
): Record<string, string[]> {
	if (value === undefined || value === null) return {};
	if (!Array.isArray(value) || value.length > maximum) {
		throw new Error(`YouTube ${label} must be an array with at most ${maximum} strings`);
	}
	const rows = uniqueStrings(value.map((item) => requireText(item, label, 256)));
	if (label === "channel_ids" && rows.some((item) => !/^UC[A-Za-z0-9_-]{20,}$/u.test(item))) {
		throw new Error("YouTube channel_ids must contain canonical UC channel IDs");
	}
	return rows.length > 0 ? { [label]: rows } : {};
}

function optionalLanguage(value: unknown, label: string): string | undefined {
	const language = optionalText(value, label, MAX_LANGUAGE_LENGTH);
	if (!language) return undefined;
	if (!/^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/u.test(language)) {
		throw new Error(`YouTube ${label} must be a BCP 47-like language tag`);
	}
	return language;
}

function optionalLanguageArray(value: unknown, label: string): string[] {
	if (value === undefined || value === null) return [];
	if (!Array.isArray(value) || value.length > 20) {
		throw new Error(`YouTube ${label} must be an array with at most 20 language tags`);
	}
	return uniqueStrings(value.map((item) => {
		const language = optionalLanguage(item, label);
		if (!language) throw new Error(`YouTube ${label} cannot contain an empty language tag`);
		return language;
	}));
}

function uniqueStrings(values: string[]): string[] {
	return [...new Set(values)];
}
