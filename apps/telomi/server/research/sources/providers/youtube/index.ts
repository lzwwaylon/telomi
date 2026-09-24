import { sha256 } from "../../../../lib/hash.js";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

import {
	canonicalYouTubeQuery,
	youTubeOperationMaterializesWorkspace,
	parseYouTubeProviderRequest,
	type ParsedYouTubeProviderRequest,
} from "../../contracts/youtube.js";
import { ResearchNodeError } from "../../../../agent-runtime/retry-policy.js";
import type {
	ResearchSearchProvider,
	ResearchSearchRequest,
	ResearchSearchResult,
} from "../../../../providers/search-types.js";
import {
	YouTubeMediaExtractor,
	type YtDlpAccountSubscription,
	type YtDlpFeedVideo,
	type YtDlpVideoInspection,
} from "./media-extractor.js";
import {
	YouTubeTranscriptModule,
	type YouTubeTranscriptArtifact,
} from "./transcript.js";
import { toErrorMessage } from "../../../../lib/values.js";
import { writeFileAtomic } from "../../../../lib/fs.js";

export interface YouTubeTranscriptPort {
	get(
		parameters: Extract<ParsedYouTubeProviderRequest, { operation: "get_transcript" }>["parameters"],
		signal?: AbortSignal,
	): Promise<YouTubeTranscriptArtifact>;
}

export interface YouTubeMediaPort {
	version(signal?: AbortSignal): Promise<string>;
	inspectVideo(videoId: string, input?: { signal?: AbortSignal }): Promise<YtDlpVideoInspection>;
	listAccountFeed(
		target: ":ytrec" | ":ytwatchlater" | ":ythis",
		input: { limit: number; signal?: AbortSignal },
	): Promise<YtDlpFeedVideo[]>;
	listAccountSubscriptions(input: {
		offset: number;
		limit: number;
		signal?: AbortSignal;
	}): Promise<YtDlpAccountSubscription[]>;
	listSubscriptionUploads(input: {
		limit: number;
		candidateLimit?: number;
		publishedAfter?: string;
		signal?: AbortSignal;
	}): Promise<YtDlpFeedVideo[]>;
	listVideos(target: string, input: {
		offset: number;
		limit: number;
		candidateLimit?: number;
		publishedAfter?: string;
		mode?: "summary" | "full";
		signal?: AbortSignal;
	}): Promise<YtDlpFeedVideo[]>;
}

export interface YouTubeResearchProviderOptions {
	transcriptModule?: YouTubeTranscriptPort;
	mediaExtractor?: YouTubeMediaPort;
}

export function youtubeResearchProvider(
	options: YouTubeResearchProviderOptions = {},
): ResearchSearchProvider {
	const transcriptModule = options.transcriptModule ?? new YouTubeTranscriptModule();
	const media = options.mediaExtractor ?? new YouTubeMediaExtractor();
	return {
		id: "youtube",
		policy: { maxConcurrency: 2, minIntervalMs: 100 },
		runtimePolicy: (request) => {
			const operation = parseYouTubeProviderRequest(
				request.providerRequest,
				request.query,
				request.maxResults,
			);
			const account = operationUsesAccount(operation);
			const scope = account ? "youtube:account" : "youtube:public";
			const policy = {
				accessScope: scope,
				maxConcurrency: account ? 1 : 2,
				minIntervalMs: account ? 5_000 : 100,
			};
			return {
				...policy,
				// get_transcript 会把产物写进当前工作区并返回绝对路径，进 Provider
				// 缓存会让后续命中拿到指向已删除工作区的路径，所以和 github /
				// huggingface / arxiv 一样把物化类操作排除在外。
				...(youTubeOperationMaterializesWorkspace(operation.operation) ? {} : {
					cacheScope: scope,
					cacheKey: canonicalYouTubeQuery(operation),
					cacheTtlMs: operation.operation === "capabilities"
						? 24 * 60 * 60_000
						: 10 * 60_000,
				}),
			};
		},
		async search(request) {
			let operation: ParsedYouTubeProviderRequest;
			try {
				operation = parseYouTubeProviderRequest(
					request.providerRequest,
					request.query,
					request.maxResults,
				);
			} catch (error) {
				throw new ResearchNodeError(
					toErrorMessage(error),
					"validation",
					false,
					{ code: "youtube_request_invalid", cause: asError(error) },
				);
			}
			switch (operation.operation) {
				case "capabilities":
					return [capabilityResult(await media.version(request.signal))];
				case "list_subscriptions": {
					const offset = pageOffset(operation.parameters.page_token);
					const rows = await media.listAccountSubscriptions({
						offset,
						limit: operation.parameters.limit + 1,
						signal: request.signal,
					});
					const hasMore = rows.length > operation.parameters.limit;
					return subscriptionResults(
						rows.slice(0, operation.parameters.limit),
						hasMore ? pageToken(offset + operation.parameters.limit) : undefined,
					);
				}
				case "list_subscription_uploads": {
					const limit = Math.min(request.maxResults, operation.parameters.limit);
					const channelId = operation.parameters.channel_ids?.length === 1
						? operation.parameters.channel_ids[0]
						: undefined;
					const rows = channelId
						? await media.listVideos(channelUrl(channelId), {
							offset: 0,
							limit: paginationScanLimit(limit, {
								...operation.parameters,
								channel_ids: undefined,
							}),
							publishedAfter: operation.parameters.published_after,
							mode: "summary",
							signal: request.signal,
						})
						: await media.listSubscriptionUploads({
							limit,
							candidateLimit: candidateLimit(limit, operation.parameters),
							publishedAfter: operation.parameters.published_after,
							signal: request.signal,
						});
					return filteredVideoResults(rows, {
						limit,
						publishedAfter: operation.parameters.published_after,
						channelIds: channelId ? undefined : operation.parameters.channel_ids,
						includeShorts: operation.parameters.include_shorts,
						includeLive: operation.parameters.include_live,
						discoverySource: "youtube_subscriptions",
						fallbackChannelId: channelId,
					});
				}
				case "list_channel_videos": {
					const offset = pageOffset(operation.parameters.page_token);
					const limit = Math.min(request.maxResults, operation.parameters.limit);
					const scannedLimit = paginationScanLimit(limit, operation.parameters);
					const rows = await media.listVideos(channelUrl(operation.parameters.channel_id), {
						offset,
						limit: scannedLimit,
						publishedAfter: operation.parameters.published_after,
						mode: "summary",
						signal: request.signal,
					});
					return filteredVideoResults(rows, {
						offset,
						limit,
						publishedAfter: operation.parameters.published_after,
						includeShorts: operation.parameters.include_shorts,
						includeLive: operation.parameters.include_live,
						discoverySource: "youtube_channel",
						scannedLimit,
						fallbackChannelId: operation.parameters.channel_id.startsWith("UC")
							? operation.parameters.channel_id
							: undefined,
					});
				}
				case "list_playlist_videos": {
					const offset = pageOffset(operation.parameters.page_token);
					const limit = Math.min(request.maxResults, operation.parameters.limit);
					const scannedLimit = Math.min(500, limit + 1);
					return filteredVideoResults(await media.listVideos(
						`https://www.youtube.com/playlist?list=${encodeURIComponent(operation.parameters.playlist_id)}`,
						{ offset, limit: scannedLimit, signal: request.signal },
					), {
						offset,
						limit,
						includeShorts: true,
						includeLive: true,
						discoverySource: "youtube_playlist",
						scannedLimit,
					});
				}
				case "search_videos": {
					const offset = pageOffset(operation.parameters.page_token);
					const limit = Math.min(request.maxResults, operation.parameters.limit);
					const scannedLimit = Math.min(500, Math.max(limit + 1, limit * 3));
					const rows = await media.listVideos(
						`ytsearch${Math.min(500, offset + limit * 3)}:${operation.parameters.query}`,
						{
							offset,
							limit: scannedLimit,
							publishedAfter: operation.parameters.published_after,
							signal: request.signal,
						},
					);
					return filteredVideoResults(rows, {
						offset,
						limit,
						publishedAfter: operation.parameters.published_after,
						channelIds: operation.parameters.channel_id
							? [operation.parameters.channel_id]
							: undefined,
						includeShorts: true,
						includeLive: true,
						discoverySource: "youtube_search",
						scannedLimit,
					});
				}
				case "get_video":
					return [inspectionResult(
						await media.inspectVideo(operation.parameters.video_id, { signal: request.signal }),
					)];
				case "get_transcript":
					return [materializeTranscriptResult(
						await transcriptModule.get(operation.parameters, request.signal),
						request,
						operation,
					)];
				case "snapshot_home_recommendations":
					return feedResults(await media.listAccountFeed(":ytrec", {
						limit: Math.min(request.maxResults, operation.parameters.limit),
						signal: request.signal,
					}), "youtube_home_recommendations");
				case "list_watch_later":
					return feedResults(await media.listAccountFeed(":ytwatchlater", {
						limit: Math.min(request.maxResults, operation.parameters.limit),
						signal: request.signal,
					}), "youtube_watch_later");
				case "list_history":
					return feedResults(await media.listAccountFeed(":ythis", {
						limit: Math.min(request.maxResults, operation.parameters.limit),
						signal: request.signal,
					}), "youtube_history");
			}
		},
	};
}

function operationUsesAccount(operation: ParsedYouTubeProviderRequest): boolean {
	if (operation.operation === "list_subscription_uploads") {
		return !operation.parameters.channel_ids?.length;
	}
	return operation.operation === "list_subscriptions"
		|| operation.operation === "snapshot_home_recommendations"
		|| operation.operation === "list_watch_later"
		|| operation.operation === "list_history";
}

function capabilityResult(version: string): ResearchSearchResult {
	return {
		id: "youtube-capabilities-v1",
		title: "YouTube Provider capabilities",
		url: "https://github.com/yt-dlp/yt-dlp",
		snippet: `Ready through yt-dlp ${version} with Cookie-free public access and Host-managed account credentials.`,
		metadata: {
			resource_type: "provider_capabilities",
			transport: "yt-dlp",
			extractor_version: version,
		},
	};
}

function inspectionResult(row: YtDlpVideoInspection): ResearchSearchResult {
	return {
		id: `youtube-video-${row.videoId}`,
		title: row.title,
		url: row.webpageUrl,
		snippet: row.description ?? "",
		...(row.timestamp ? { publishedAt: new Date(row.timestamp * 1_000).toISOString() } : {}),
		...(row.channel ? { authors: [row.channel] } : {}),
		metadata: {
			resource_type: "video",
			video_id: row.videoId,
			channel_id: row.channelId,
			channel_title: row.channel,
			duration_seconds: row.durationSeconds,
			timestamp_precision: row.timestamp ? "exact" : undefined,
			caption_available: row.manualCaptions.length + row.automaticCaptions.length > 0,
			extractor: "yt-dlp",
			extractor_version: row.extractorVersion,
		},
	};
}

function materializeTranscriptResult(
	artifact: YouTubeTranscriptArtifact,
	request: ResearchSearchRequest,
	operation: Extract<ParsedYouTubeProviderRequest, { operation: "get_transcript" }>,
): ResearchSearchResult {
	const fingerprint = sha256(canonicalYouTubeQuery(operation))
		.slice(0, 16);
	const directory = join(
		request.workspaceDir,
		"artifacts",
		"provider-plugins",
		"youtube",
		artifact.video_id,
		fingerprint,
	);
	mkdirSync(directory, { recursive: true });
	const markdown = transcriptMarkdown(artifact);
	const markdownPath = join(directory, "transcript.md");
	const metadataPath = join(directory, "transcript.timed.json");
	writeFileAtomic(markdownPath, markdown);
	writeFileAtomic(metadataPath, `${JSON.stringify(timedTranscriptDocument(artifact), null, 2)}\n`);
	return {
		id: `youtube-transcript-${artifact.video_id}`,
		title: artifact.title,
		url: artifact.source_url,
		snippet: artifact.status === "available"
			? artifact.text.slice(0, 4_000)
			: "No usable transcript was produced.",
		...(artifact.channel ? { authors: [artifact.channel] } : {}),
		metadata: {
			resource_type: "youtube_transcript",
			video_id: artifact.video_id,
			channel_id: artifact.channel_id,
			video_description: artifact.description,
			transcript_status: artifact.status,
			transcript_kind: artifact.kind,
			transcript_source_language: artifact.source_language,
			transcript_output_language: artifact.output_language,
			transcript_translation: artifact.translation,
			is_machine_generated: artifact.is_machine_generated,
			is_machine_translated: artifact.is_machine_translated,
			extractor: artifact.extractor,
			extractor_version: artifact.extractor_version,
			content_sha256: artifact.content_sha256,
			provider_artifact_path: markdownPath,
			provider_artifact_sha256: sha256(markdown),
			provider_artifact_media_type: "text/markdown",
			provider_artifact_metadata_path: metadataPath,
			provider_document_artifact_path: metadataPath,
			provider_document_artifact_media_type: "application/vnd.pi.timed-transcript+json",
		},
	};
}

function transcriptMarkdown(artifact: YouTubeTranscriptArtifact): string {
	const header = [
		`# ${artifact.title}`,
		"",
		`- Video: ${artifact.source_url}`,
		`- Status: ${artifact.status}`,
		`- Kind: ${artifact.kind ?? "unavailable"}`,
		`- Source language: ${artifact.source_language ?? "unknown"}`,
		`- Output language: ${artifact.output_language ?? "unknown"}`,
		`- Translation: ${artifact.translation}`,
		`- Extractor: ${artifact.extractor} ${artifact.extractor_version}`,
		"",
		...(artifact.description
			? [
				"## Video Description",
				"",
				artifact.description,
				"",
			]
			: []),
	];
	const sections = artifact.chapters.length > 0
		? artifact.chapters.flatMap((chapter) => [
			`## ${chapter.title}`,
			"",
			`_Chapter: ${formatTimestamp(chapter.startMs)} - ${formatTimestamp(chapter.endMs)}_`,
			"",
			...artifact.segments
				.filter((segment) => segment.chapterId === chapter.id)
				.map((segment) => segment.text),
			"",
		])
		: [
			"## Transcript",
			"",
			...artifact.segments.map((segment) =>
				`- [${formatTimestamp(segment.startMs)} - ${formatTimestamp(segment.endMs)}] ${segment.text}`),
			"",
		];
	const unchaptered = artifact.chapters.length > 0
		? artifact.segments.filter((segment) => !segment.chapterId)
		: [];
	return [
		...header,
		...sections,
		...(unchaptered.length > 0
			? [
				"## Unchaptered",
				"",
				...unchaptered.map((segment) =>
					`- [${formatTimestamp(segment.startMs)} - ${formatTimestamp(segment.endMs)}] ${segment.text}`),
				"",
			]
			: []),
	].join("\n");
}

function timedTranscriptDocument(artifact: YouTubeTranscriptArtifact): Record<string, unknown> {
	return {
		schema_name: "TimedTranscript",
		version: 1,
		source: {
			title: artifact.title,
			url: artifact.source_url,
			...(artifact.description ? { description: artifact.description } : {}),
			...(artifact.duration_ms === undefined ? {} : { duration_ms: artifact.duration_ms }),
		},
		chapters: artifact.chapters.map((chapter) => ({
			id: chapter.id,
			title: chapter.title,
			start_ms: chapter.startMs,
			end_ms: chapter.endMs,
		})),
		segments: artifact.segments.map((segment, index) => ({
			id: `segment:${index + 1}`,
			start_ms: segment.startMs,
			end_ms: segment.endMs,
			text: segment.text,
			...(segment.chapterId ? { chapter_id: segment.chapterId } : {}),
		})),
		provenance: {
			provider: "youtube",
			status: artifact.status,
			video_id: artifact.video_id,
			...(artifact.channel ? { channel: artifact.channel } : {}),
			...(artifact.channel_id ? { channel_id: artifact.channel_id } : {}),
			...(artifact.source_language ? { source_language: artifact.source_language } : {}),
			...(artifact.output_language ? { output_language: artifact.output_language } : {}),
			...(artifact.kind ? { transcript_kind: artifact.kind } : {}),
			translation: artifact.translation,
			is_machine_generated: artifact.is_machine_generated,
			is_machine_translated: artifact.is_machine_translated,
			extractor: artifact.extractor,
			extractor_version: artifact.extractor_version,
			...(artifact.stt_provider ? { stt_provider: artifact.stt_provider } : {}),
			...(artifact.stt_model ? { stt_model: artifact.stt_model } : {}),
			content_sha256: artifact.content_sha256,
			generated_at: artifact.generated_at,
			attempts: artifact.attempts,
		},
	};
}

function filteredVideoResults(
	rows: YtDlpFeedVideo[],
	input: {
		limit: number;
		offset?: number;
		scannedLimit?: number;
		publishedAfter?: string;
		channelIds?: string[];
		includeShorts: boolean;
		includeLive: boolean;
		discoverySource: string;
		fallbackChannelId?: string;
	},
): ResearchSearchResult[] {
	const publishedAfter = input.publishedAfter
		? Date.parse(input.publishedAfter) / 1_000
		: undefined;
	const channelIds = input.channelIds ? new Set(input.channelIds) : undefined;
	const eligible = rows
		.map((row, rawIndex) => ({ row, rawIndex }))
		.filter(({ row }) => publishedAfter === undefined || isAfterBoundary(row, publishedAfter))
		.filter(({ row }) => !channelIds || (row.channelId !== undefined && channelIds.has(row.channelId)))
		.filter(({ row }) => input.includeLive || !isLiveVideo(row))
		.filter(({ row }) => input.includeShorts || !isShortVideo(row));
	const page = eligible.slice(0, input.limit);
	const nextPageToken = paginationToken(rows, eligible, page, input);
	const selected = page
		.map(({ row }) => row)
		.sort((left, right) => (right.timestamp ?? 0) - (left.timestamp ?? 0))
	return feedResults(selected, input.discoverySource, {
		nextPageToken,
		fallbackChannelId: input.fallbackChannelId,
	});
}

function feedResults(
	rows: YtDlpFeedVideo[],
	discoverySource: string,
	options: { nextPageToken?: string; fallbackChannelId?: string } = {},
): ResearchSearchResult[] {
	return rows.map((row, index) => ({
		id: `youtube-video-${row.videoId}`,
		title: row.title,
		url: row.url,
		snippet: row.description ?? "",
		...(row.timestamp ? { publishedAt: new Date(row.timestamp * 1_000).toISOString() } : {}),
		...(row.channel ? { authors: [row.channel] } : {}),
		metadata: {
			resource_type: "video",
			video_id: row.videoId,
			channel_id: row.channelId ?? options.fallbackChannelId,
			channel_title: row.channel,
			duration_seconds: row.durationSeconds,
			view_count: row.viewCount,
			like_count: row.likeCount,
			comment_count: row.commentCount,
			live_status: row.liveStatus,
			timestamp_precision: row.timestampPrecision,
			next_page_token: options.nextPageToken,
			thumbnail_url: row.thumbnailUrl,
			is_short_candidate: isShortVideo(row),
			discovery_source: discoverySource,
			recommendation_rank: discoverySource === "youtube_home_recommendations" ? index + 1 : undefined,
			extractor: "yt-dlp",
			extractor_version: row.extractorVersion,
			snapshot_at: new Date().toISOString(),
		},
	}));
}

function subscriptionResults(
	rows: YtDlpAccountSubscription[],
	nextPageToken: string | undefined,
): ResearchSearchResult[] {
	return rows.map((row) => ({
		id: `youtube-subscription-${row.channelId}`,
		title: row.title,
		url: row.url,
		snippet: "",
		authors: [row.title],
		metadata: {
			resource_type: "account_subscription",
			channel_id: row.channelId,
			channel_title: row.title,
			handle: row.handle,
			next_page_token: nextPageToken,
			extractor: "yt-dlp",
			extractor_version: row.extractorVersion,
			discovery_source: "youtube_subscriptions",
			snapshot_at: new Date().toISOString(),
		},
	}));
}

function candidateLimit(
	limit: number,
	parameters: { channel_ids?: string[]; include_shorts: boolean; include_live: boolean },
): number {
	return parameters.channel_ids?.length || !parameters.include_shorts || !parameters.include_live
		? Math.min(500, Math.max(limit * 3, limit + 20))
		: limit;
}

function paginationScanLimit(
	limit: number,
	parameters: { channel_ids?: string[]; include_shorts: boolean; include_live: boolean },
): number {
	return Math.min(500, Math.max(limit + 1, candidateLimit(limit, parameters)));
}

function paginationToken(
	rows: YtDlpFeedVideo[],
	eligible: Array<{ row: YtDlpFeedVideo; rawIndex: number }>,
	page: Array<{ row: YtDlpFeedVideo; rawIndex: number }>,
	input: { limit: number; offset?: number; scannedLimit?: number; publishedAfter?: string },
): string | undefined {
	if (input.offset === undefined || input.scannedLimit === undefined || page.length === 0) return undefined;
	if (eligible.length > input.limit) {
		return pageToken(input.offset + page.at(-1)!.rawIndex + 1);
	}
	if (
		input.publishedAfter
		&& rows.at(-1)?.timestamp !== undefined
		&& rows.at(-1)!.timestamp! <= Date.parse(input.publishedAfter) / 1_000 - 24 * 60 * 60
	) {
		return undefined;
	}
	if (rows.length >= input.scannedLimit) {
		return pageToken(input.offset + rows.length);
	}
	return undefined;
}

function isAfterBoundary(row: YtDlpFeedVideo, publishedAfter: number): boolean {
	if (row.timestamp === undefined) return row.timestampPrecision === "approximate";
	if (row.timestampPrecision !== "approximate") return row.timestamp > publishedAfter;
	return row.timestamp > publishedAfter - 24 * 60 * 60;
}

function pageOffset(value: string | undefined): number {
	if (!value) return 0;
	const match = /^yt-dlp:(\d{1,6})$/u.exec(value);
	const offset = match ? Number(match[1]) : Number.NaN;
	if (!Number.isInteger(offset) || offset < 0 || offset > 500) {
		throw new ResearchNodeError(
			"YouTube pagination token is invalid",
			"validation",
			false,
			{ code: "youtube_page_token_invalid" },
		);
	}
	return offset;
}

function pageToken(offset: number): string {
	return `yt-dlp:${offset}`;
}

function channelUrl(channel: string): string {
	return channel.startsWith("@")
		? `https://www.youtube.com/${encodeURIComponent(channel)}/videos`
		: `https://www.youtube.com/channel/${encodeURIComponent(channel)}/videos`;
}

function isLiveVideo(row: YtDlpFeedVideo): boolean {
	return Boolean(row.liveStatus && row.liveStatus !== "not_live");
}

function isShortVideo(row: YtDlpFeedVideo): boolean {
	return !isLiveVideo(row)
		&& row.durationSeconds !== undefined
		&& row.durationSeconds <= 180;
}

function formatTimestamp(milliseconds: number): string {
	const totalSeconds = Math.max(0, Math.floor(milliseconds / 1_000));
	const hours = Math.floor(totalSeconds / 3_600);
	const minutes = Math.floor((totalSeconds % 3_600) / 60);
	const seconds = totalSeconds % 60;
	return hours > 0
		? `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
		: `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function asError(value: unknown): Error | undefined {
	return value instanceof Error ? value : undefined;
}

export * from "./caption-formats.js";
export * from "./media-extractor.js";
export * from "./transcript.js";
export * from "./ytdlp-runner.js";
