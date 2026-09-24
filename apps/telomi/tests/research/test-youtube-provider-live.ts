import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
	ControlledYtDlpRunner,
	YouTubeMediaExtractor,
	YouTubeTranscriptModule,
	youtubeResearchProvider,
} from "../../server/research/sources/providers/youtube/index.js";

const binary = process.env.PI_YOUTUBE_YTDLP_BINARY?.trim();
if (!binary) {
	throw new Error("PI_YOUTUBE_YTDLP_BINARY must point to a current yt-dlp executable");
}

const videoId = process.env.PI_YOUTUBE_TEST_VIDEO_ID?.trim() || "UUs3q3ZrUS0";
const runner = new ControlledYtDlpRunner(binary);
const extractor = new YouTubeMediaExtractor(runner);
const signal = AbortSignal.timeout(180_000);

const version = await runner.version(signal);
assert.match(version, /^\d{4}\.\d{2}\.\d{2}(?:\.\d+)?$/u);

const inspection = await extractor.inspectVideo(videoId, { signal });
const expectChapters = process.env.PI_YOUTUBE_TEST_EXPECT_CHAPTERS === "1";
assert.equal(inspection.videoId, videoId);
assert.ok(inspection.title);
assert.ok(inspection.description?.trim(), "Live test video must expose a description");
assert.ok((inspection.durationSeconds ?? 0) > 0);
assert.equal(inspection.extractorVersion, version);
if (expectChapters) assert.ok(inspection.chapters.length > 0, "Live test video must expose chapters");
assert.ok(
	inspection.manualCaptions.length + inspection.automaticCaptions.length > 0,
	"Live test video must expose at least one caption track",
);
const liveChatVideoId = process.env.PI_YOUTUBE_TEST_LIVE_CHAT_VIDEO_ID?.trim() || "hacEQHHhu2Q";
const liveChatInspection = await extractor.inspectVideo(liveChatVideoId);
assert.ok(
	[...liveChatInspection.manualCaptions, ...liveChatInspection.automaticCaptions]
		.every((track) => track.language !== "live_chat"),
);

const sourceTrack = inspection.manualCaptions.find((track) => /^en(?:-orig)?$/u.test(track.language))
	?? inspection.automaticCaptions.find((track) => /^en(?:-orig)?$/u.test(track.language))
	?? inspection.manualCaptions[0]
	?? inspection.automaticCaptions[0];
assert.ok(sourceTrack);
const targetLanguage = process.env.PI_YOUTUBE_TEST_TARGET_LANGUAGE?.trim();
let segmentCount: number;
if (targetLanguage) {
	const transcript = await new YouTubeTranscriptModule(extractor).get({
		video_id: videoId,
		target_language: targetLanguage,
		preferred_languages: [targetLanguage, sourceTrack.language],
		max_duration_seconds: 7_200,
	}, signal);
	assert.equal(transcript.status, "available");
	assert.ok(transcript.text.trim());
	assert.ok(transcript.segments.length > 0);
	segmentCount = transcript.segments.length;
	if (transcript.output_language === targetLanguage) {
		assert.equal(transcript.translation, "youtube");
		assert.equal(transcript.is_machine_translated, true);
	} else {
		assert.equal(transcript.translation, "required");
		assert.ok(transcript.attempts.some((attempt) =>
			attempt.language === targetLanguage && attempt.outcome === "failed"));
	}
} else if (expectChapters) {
	const transcript = await new YouTubeTranscriptModule(extractor).get({
		video_id: videoId,
		preferred_languages: [sourceTrack.language],
		max_duration_seconds: 6 * 60 * 60,
	}, signal);
	assert.ok(transcript.chapters.length > 0);
	assert.equal(transcript.segments.length, transcript.chapters.length);
	assert.ok(transcript.segments.every((segment) => segment.chapterId));
	segmentCount = transcript.segments.length;
} else {
	const transcript = await new YouTubeTranscriptModule(extractor).get({
		video_id: videoId,
		preferred_languages: [sourceTrack.language],
		max_duration_seconds: 6 * 60 * 60,
	}, signal);
	assert.ok(transcript.chapters.length > 0);
	assert.equal(transcript.segments.length, transcript.chapters.length);
	assert.ok(transcript.segments.every((segment) => segment.chapterId));
	segmentCount = transcript.segments.length;
}

const provider = youtubeResearchProvider();
const providerRequest = (
	operation: string,
	parameters: Record<string, unknown>,
	maxResults: number,
) => ({
	query: operation,
	maxResults,
	criterionIds: ["youtube-live"],
	purpose: "Live browser-cookie YouTube Provider acceptance",
	signal: AbortSignal.timeout(180_000),
	workspaceDir: "/tmp/telomi-youtube-provider-live",
	providerRequest: { operation, parameters },
});
const subscriptions = await provider.search(providerRequest("list_subscriptions", {
	limit: 5,
}, 5));
assert.ok(subscriptions.length > 0, "yt-dlp Provider must return subscriptions");
const results = await provider.search(providerRequest("get_transcript", {
	video_id: videoId,
	preferred_languages: [sourceTrack.language],
	max_duration_seconds: 6 * 60 * 60,
}, 1));
const videos = await provider.search(providerRequest("get_video", {
	video_id: videoId,
}, 1));
assert.notEqual(results[0]?.id, videos[0]?.id);
assert.equal(videos[0]?.snippet, inspection.description);
assert.equal(results[0]?.metadata?.video_description, inspection.description);
const path = results[0]?.metadata?.provider_document_artifact_path;
assert.equal(typeof path, "string");
const timed = JSON.parse(readFileSync(String(path), "utf-8")) as {
	schema_name?: string;
	source?: { description?: string };
	chapters?: unknown[];
	segments?: Array<{ chapter_id?: string }>;
};
assert.equal(timed.schema_name, "TimedTranscript");
assert.equal(timed.source?.description, inspection.description);
assert.ok((timed.chapters?.length ?? 0) > 0);
assert.equal(timed.segments?.length, timed.chapters?.length);
assert.ok(timed.segments?.every((segment) => segment.chapter_id));
const channelId = process.env.PI_YOUTUBE_TEST_CHANNEL_ID?.trim() || "UCLKPca3kwwd-B59HNr-_lvA";
const uploads = await provider.search(providerRequest("list_subscription_uploads", {
	limit: 3,
	include_shorts: true,
	include_live: true,
}, 3));
assert.ok(uploads.length > 0, "yt-dlp Provider must return subscription uploads");
assert.ok(uploads.every((row) => row.metadata?.discovery_source === "youtube_subscriptions"));
const channelUploadsStartedAt = Date.now();
const channelUploads = await provider.search(providerRequest("list_subscription_uploads", {
	limit: 5,
	channel_ids: [channelId],
	include_shorts: true,
	include_live: true,
}, 5));
assert.equal(channelUploads.length, 5);
assert.ok(channelUploads.every((row) => row.metadata?.channel_id === channelId));
const channelUploadsDurationMs = Date.now() - channelUploadsStartedAt;
const channelStartedAt = Date.now();
const firstChannelPage = await provider.search(providerRequest("list_channel_videos", {
	channel_id: channelId,
	limit: 5,
	include_shorts: true,
	include_live: true,
}, 5));
assert.equal(firstChannelPage.length, 5);
const nextPageToken = firstChannelPage[0]?.metadata?.next_page_token;
assert.equal(typeof nextPageToken, "string");
const secondChannelPage = await provider.search(providerRequest("list_channel_videos", {
	channel_id: channelId,
	limit: 5,
	page_token: nextPageToken,
	include_shorts: true,
	include_live: true,
}, 5));
assert.equal(secondChannelPage.length, 5);
const firstPageIds = new Set(firstChannelPage.map((row) => row.metadata?.video_id));
assert.ok(secondChannelPage.every((row) => !firstPageIds.has(row.metadata?.video_id)));
const cookieAccountTest = {
	subscriptionCount: subscriptions.length,
	uploadCount: uploads.length,
		firstSubscription: subscriptions[0]!.title,
	};

console.log(JSON.stringify({
	ok: true,
	video_id: inspection.videoId,
	title: inspection.title,
	yt_dlp_version: version,
	live_chat_filtered_video_id: liveChatVideoId,
	caption_language: sourceTrack.language,
	caption_kind: sourceTrack.automatic ? "youtube_auto" : "manual",
	segment_count: segmentCount,
	translated_caption_tested: Boolean(targetLanguage),
	chapter_count: inspection.chapters.length,
	cookie_account_provider_test: cookieAccountTest,
	single_channel_upload_test: {
		channel_id: channelId,
		count: channelUploads.length,
		duration_ms: channelUploadsDurationMs,
	},
	channel_pagination_test: {
		channel_id: channelId,
		first_page_count: firstChannelPage.length,
		second_page_count: secondChannelPage.length,
		duration_ms: Date.now() - channelStartedAt,
	},
}, null, 2));
