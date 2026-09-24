import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	parseYouTubeProviderRequest,
	parseYouTubeLocator,
} from "../../server/research/sources/contracts/youtube.js";
import {
	ControlledYtDlpRunner,
	transcriptText,
	type YouTubeMediaPort,
	type YouTubeMediaExtractorPort,
	type YtDlpFeedVideo,
	YouTubeMediaExtractor,
	TelomiAudioSpeechToTextAdapter,
	type YouTubeSpeechToTextPort,
	type YouTubeTranscriptArtifact,
	YouTubeTranscriptModule,
	youtubeResearchProvider,
} from "../../server/research/sources/providers/youtube/index.js";
import { ResearchNodeError } from "../../server/agent-runtime/retry-policy.js";
import type { ResearchProviderRequest, ResearchSearchRequest } from "../../server/providers/search-types.js";

const providerRequest = (operation: string, parameters: Record<string, unknown>): ResearchProviderRequest =>
	({ operation, parameters });

const root = mkdtempSync(join(tmpdir(), "pi-youtube-provider-"));
const originalBrowserProfile = process.env.PI_YOUTUBE_YTDLP_COOKIES_FROM_BROWSER;
process.env.PI_YOUTUBE_YTDLP_COOKIES_FROM_BROWSER = "chrome:Test";

try {
	testContract();
	testRollingCaptionOverlap();
	await testChapterExtractionAndMapping();
	await testAutomaticAsrFallback();
	await testTimeBasedChapterInference();
	await testSingleYtDlpDispatch();
	await testChannelPagination();
	await testConservativeChannelBoundary();
	await testFastChannelListing();
	await testPublicRequestsDoNotUseCookies();
	await testPublicInspectionDoesNotUseCookies();
	await testInspectionAuthenticationFallback();
	await testPublicCaptionDoesNotUseCookies();
	await testCaptionAuthenticationFallback();
	await testAccountRequestsPreferCookieFile();
	await testAccountRejectsUnsafeCookieFile();
	await testAccountRequiresExplicitCredentials();
	await testLiveChatIsNotCaption();
	await testAudioAuthenticationFallback();
	await testAudioFormatFailureIsRequestScoped();
	await testLocalAsrReadinessFailureIsRequestScoped();
	await testPartialOutput();
	console.log("youtube-provider tests: ok");
} finally {
	if (originalBrowserProfile === undefined) delete process.env.PI_YOUTUBE_YTDLP_COOKIES_FROM_BROWSER;
	else process.env.PI_YOUTUBE_YTDLP_COOKIES_FROM_BROWSER = originalBrowserProfile;
	rmSync(root, { recursive: true, force: true });
}

async function testLocalAsrReadinessFailureIsRequestScoped(): Promise<void> {
	let readinessCalls = 0;
	const adapter = new TelomiAudioSpeechToTextAdapter(async () => {
		readinessCalls += 1;
		throw new Error("local ASR sidecar unavailable");
	});
	await assert.rejects(
		adapter.transcribe({
			filePath: join(root, "missing.wav"),
			provider: "telomi-audio",
		}),
		(error: unknown) => {
			assert.ok(error instanceof ResearchNodeError);
			assert.equal(error.details?.circuit_scope, "request");
			assert.equal(error.code, "youtube_asr_failed");
			return true;
		},
	);
	assert.equal(readinessCalls, 1);
}

function testContract(): void {
	assert.deepEqual(parseYouTubeLocator("https://youtu.be/dQw4w9WgXcQ"), {
		kind: "video",
		id: "dQw4w9WgXcQ",
	});
	const transcript = parseYouTubeProviderRequest(providerRequest("get_transcript", {
		video_id: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
		preferred_languages: ["en"],
		max_duration_seconds: 7_200,
	}), "unused", 10);
	assert.equal(transcript.operation, "get_transcript");
	if (transcript.operation !== "get_transcript") throw new Error("expected get_transcript");
	assert.equal(transcript.parameters.video_id, "dQw4w9WgXcQ");
	assert.throws(() => parseYouTubeProviderRequest({
		operation: "get_transcript",
		parameters: {
			video_id: "dQw4w9WgXcQ",
			allow_asr: true,
		},
	}, "unused", 10), /Unsupported YouTube get_transcript parameter/u);
	assert.throws(() => parseYouTubeProviderRequest({
		operation: "get_transcript",
		parameters: {
			video_id: "dQw4w9WgXcQ",
			stt_provider: "telomi-audio",
		},
	}, "unused", 10), /Unsupported YouTube get_transcript parameter/u);
	assert.throws(() => parseYouTubeProviderRequest({
		operation: "resolve_url",
		parameters: { url: "https://youtu.be/dQw4w9WgXcQ" },
	}, "unused", 10), /Unsupported YouTube operation/u);
	assert.throws(() => parseYouTubeProviderRequest({
		operation: "list_subscriptions",
		parameters: { limit: 5, allow_account_cookies: true },
	}, "unused", 5), /Unsupported YouTube list_subscriptions parameter/u);
	const provider = youtubeResearchProvider();
	const accountPolicy = provider.runtimePolicy!(request("list_subscription_uploads", {
		limit: 100,
		include_shorts: true,
		include_live: true,
	}));
	assert.equal(accountPolicy.cacheScope, "youtube:account");
	assert.equal(accountPolicy.accessScope, "youtube:account");
	assert.equal(accountPolicy.maxConcurrency, 1);
	assert.equal(accountPolicy.minIntervalMs, 5_000);
	assert.equal(accountPolicy.cacheTtlMs, 10 * 60_000);
	const publicPolicy = provider.runtimePolicy!(request("list_subscription_uploads", {
		limit: 100,
		channel_ids: ["UC1234567890123456789012"],
		include_shorts: true,
		include_live: true,
	}));
	assert.equal(publicPolicy.cacheScope, "youtube:public");
	assert.equal(publicPolicy.accessScope, "youtube:public");
	assert.equal(publicPolicy.maxConcurrency, 2);
	assert.equal(publicPolicy.minIntervalMs, 100);
	const transcriptPolicy = provider.runtimePolicy!(request("get_transcript", {
		video_id: "dQw4w9WgXcQ",
		preferred_languages: [],
		max_duration_seconds: 7_200,
	}));
	assert.equal(transcriptPolicy.cacheScope, undefined);
	assert.equal(transcriptPolicy.accessScope, "youtube:public");
	assert.equal(transcriptPolicy.maxConcurrency, 2);
	assert.equal(transcriptPolicy.minIntervalMs, 100);
	assert.equal(transcriptPolicy.cacheTtlMs, undefined);
}

function testRollingCaptionOverlap(): void {
	assert.equal(transcriptText([
		{ startMs: 0, endMs: 1_000, text: "My colleague Dave and I" },
		{ startMs: 1_000, endMs: 2_000, text: "Dave and I are going to talk" },
		{ startMs: 2_000, endMs: 3_000, text: "are going to talk about evals." },
	]), "My colleague Dave and I are going to talk about evals.");
}

async function testAutomaticAsrFallback(): Promise<void> {
	let audioMaterialized = false;
	let audioCleaned = false;
	const extractor: YouTubeMediaExtractorPort = {
		async inspectVideo(videoId) {
			return {
				videoId,
				title: "No captions",
				webpageUrl: `https://www.youtube.com/watch?v=${videoId}`,
				description: "Demo: https://example.com/demo",
				manualCaptions: [],
				automaticCaptions: [],
				chapters: [],
				raw: {},
				extractorVersion: "2026.07.04",
			};
		},
		async materializeCaption() {
			throw new Error("caption materialization must not run without tracks");
		},
		async materializeAudio() {
			audioMaterialized = true;
			return {
				path: "/tmp/youtube-auto-asr.mp3",
				bytes: 42,
				cleanup() {
					audioCleaned = true;
				},
			};
		},
	};
	const speechToText: YouTubeSpeechToTextPort = {
		async transcribe(input) {
			assert.equal(input.filePath, "/tmp/youtube-auto-asr.mp3");
			assert.equal(input.provider, undefined);
			return {
				text: "自动转录",
				language: "zh",
				durationSec: 1,
				provider: "host-default",
				segments: [{ start: 0, end: 1, text: "自动转录" }],
			};
		},
	};
	const artifact = await new YouTubeTranscriptModule(
		extractor,
		speechToText,
	).get({
		video_id: "dQw4w9WgXcQ",
		preferred_languages: ["zh"],
		max_duration_seconds: 7_200,
	});
	assert.equal(artifact.status, "available");
	assert.equal(artifact.kind, "local_asr");
	assert.equal(artifact.text, "自动转录");
	assert.equal(
		(artifact as YouTubeTranscriptArtifact & { description?: string }).description,
		"Demo: https://example.com/demo",
	);
	assert.equal(audioMaterialized, true);
	assert.equal(audioCleaned, true);
}

async function testTimeBasedChapterInference(): Promise<void> {
	const artifact = await new YouTubeTranscriptModule({
		async inspectVideo(videoId) {
			return {
				videoId,
				title: "Long video without chapters",
				webpageUrl: `https://www.youtube.com/watch?v=${videoId}`,
				durationSeconds: 1_500,
				manualCaptions: [],
				automaticCaptions: [],
				chapters: [],
				raw: {},
				extractorVersion: "2026.07.04",
			};
		},
		async materializeCaption() {
			throw new Error("unused");
		},
		async materializeAudio() {
			return {
				path: "/tmp/long-video.mp3",
				bytes: 1,
				cleanup() {},
			};
		},
	}, {
		async transcribe() {
			return {
				text: "one two three four five",
				provider: "test",
				segments: [
					{ start: 0, end: 590, text: "one" },
					{ start: 590, end: 600, text: "two" },
					{ start: 605, end: 1_195, text: "three" },
					{ start: 1_195, end: 1_200, text: "four" },
					{ start: 1_205, end: 1_490, text: "five" },
				],
			};
		},
	}).get({
		video_id: "dQw4w9WgXcQ",
		preferred_languages: [],
		max_duration_seconds: 7_200,
	});
	assert.deepEqual(artifact.chapters.map(({ title, startMs, endMs }) => ({
		title,
		startMs,
		endMs,
	})), [
		{ title: "Part 1", startMs: 0, endMs: 605_000 },
		{ title: "Part 2", startMs: 605_000, endMs: 1_205_000 },
		{ title: "Part 3", startMs: 1_205_000, endMs: 1_500_000 },
	]);
	assert.deepEqual(artifact.segments.map(({ startMs, endMs, text }) => ({
		startMs,
		endMs,
		text,
	})), [
		{ startMs: 0, endMs: 605_000, text: "one two" },
		{ startMs: 605_000, endMs: 1_205_000, text: "three four" },
		{ startMs: 1_205_000, endMs: 1_500_000, text: "five" },
	]);
}

async function testChapterExtractionAndMapping(): Promise<void> {
	const binary = join(root, "chaptered-yt-dlp");
	writeFileSync(binary, `#!/bin/sh
for argument in "$@"; do
	if [ "$argument" = "--version" ]; then
		printf '2026.07.04\\n'
		exit 0
	fi
done
printf '%s\\n' '{"id":"dQw4w9WgXcQ","title":"Chaptered","duration":20,"webpage_url":"https://www.youtube.com/watch?v=dQw4w9WgXcQ","chapters":[{"title":"Intro","start_time":0,"end_time":10},{"title":"Topic","start_time":10}]}'
`);
	chmodSync(binary, 0o700);
	const inspection = await new YouTubeMediaExtractor(
		new ControlledYtDlpRunner(binary),
	).inspectVideo("dQw4w9WgXcQ");
	assert.deepEqual(inspection.chapters, [
		{ title: "Intro", startMs: 0, endMs: 10_000 },
		{ title: "Topic", startMs: 10_000, endMs: 20_000 },
	]);
	const artifact = await new YouTubeTranscriptModule({
		async inspectVideo() {
			return inspection;
		},
		async materializeCaption() {
			throw new Error("unused");
		},
		async materializeAudio() {
			return {
				path: "/tmp/chaptered.mp3",
				bytes: 1,
				cleanup() {},
			};
		},
	}, {
		async transcribe() {
			return {
				text: "intro boundary topic",
				provider: "test",
				segments: [
					{ start: 1, end: 2, text: "intro" },
					{ start: 9, end: 11, text: "boundary" },
					{ start: 12, end: 13, text: "topic" },
				],
			};
		},
	}).get({
		video_id: "dQw4w9WgXcQ",
		preferred_languages: [],
		max_duration_seconds: 7_200,
	});
	assert.deepEqual(artifact.chapters, [
		{ id: "chapter:1", title: "Intro", startMs: 0, endMs: 10_000 },
		{ id: "chapter:2", title: "Topic", startMs: 10_000, endMs: 20_000 },
	]);
	assert.deepEqual(artifact.segments, [
		{
			startMs: 0,
			endMs: 10_000,
			text: "intro boundary",
			chapterId: "chapter:1",
		},
		{
			startMs: 10_000,
			endMs: 20_000,
			text: "topic",
			chapterId: "chapter:2",
		},
	]);
}

async function testSingleYtDlpDispatch(): Promise<void> {
	const calls: string[] = [];
	const media: YouTubeMediaPort = {
		async version() {
			return "2026.07.04";
		},
		async inspectVideo(videoId) {
			calls.push(`video:${videoId}`);
			return {
				videoId,
				title: "Stable title",
				webpageUrl: `https://www.youtube.com/watch?v=${videoId}`,
				manualCaptions: [],
				automaticCaptions: [],
				chapters: [],
				timestamp: Date.parse("2026-07-24T00:00:00Z") / 1_000,
				raw: {},
				extractorVersion: "2026.07.04",
			};
		},
		async listAccountFeed(target) {
			calls.push(target);
			return [];
		},
		async listAccountSubscriptions() {
			calls.push("subscriptions");
			return [];
		},
		async listSubscriptionUploads() {
			calls.push("subscription_uploads");
			return [videoRow()];
		},
		async listVideos(target, input) {
			calls.push(`${target}:${input.mode ?? "full"}`);
			return [videoRow()];
		},
	};
	const transcriptModule = {
		async get(): Promise<YouTubeTranscriptArtifact> {
			return {
				schema_version: 1,
				status: "available",
				video_id: "dQw4w9WgXcQ",
				source_url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
				title: "Stable title",
				description: "Project: https://github.com/example/agent",
				duration_ms: 1_000,
				text: "Transcript",
				chapters: [{ id: "chapter:1", title: "Intro", startMs: 0, endMs: 1_000 }],
				segments: [{
					startMs: 0,
					endMs: 1_000,
					text: "Transcript",
					chapterId: "chapter:1",
				}],
				source_language: "en",
				output_language: "en",
				kind: "manual",
				translation: "none",
				is_machine_generated: false,
				is_machine_translated: false,
				extractor: "yt-dlp",
				extractor_version: "2026.07.04",
				content_sha256: "abc",
				generated_at: "2026-07-24T00:00:00.000Z",
				attempts: [],
			} as YouTubeTranscriptArtifact & { description: string };
		},
	};
	const provider = youtubeResearchProvider({ mediaExtractor: media, transcriptModule });
	const video = await provider.search(request("get_video", {
		video_id: "dQw4w9WgXcQ",
	}));
	const transcript = await provider.search(request("get_transcript", {
		video_id: "dQw4w9WgXcQ",
		preferred_languages: [],
		max_duration_seconds: 7_200,
	}));
	assert.notEqual(video[0]?.id, transcript[0]?.id);
	assert.equal(video[0]?.title, transcript[0]?.title);
	assert.equal(video[0]?.publishedAt, "2026-07-24T00:00:00.000Z");
	const timedPath = transcript[0]?.metadata?.provider_document_artifact_path;
	assert.equal(typeof timedPath, "string");
	const timed = JSON.parse(readFileSync(String(timedPath), "utf-8")) as Record<string, unknown>;
	assert.equal(timed.schema_name, "TimedTranscript");
	assert.equal(
		(timed.source as { description?: string }).description,
		"Project: https://github.com/example/agent",
	);
	assert.deepEqual(timed.chapters, [
		{ id: "chapter:1", title: "Intro", start_ms: 0, end_ms: 1_000 },
	]);
	const markdownPath = transcript[0]?.metadata?.provider_artifact_path;
	const markdown = readFileSync(String(markdownPath), "utf-8");
	assert.match(markdown, /## Intro[\s\S]*Chapter: 0:00 - 0:01/u);
	assert.doesNotMatch(markdown, /- \[0:00 - 0:01\]/u);
	await provider.search(request("list_subscription_uploads", {
		limit: 3,
		include_shorts: true,
		include_live: true,
	}));
	await provider.search(request("list_subscription_uploads", {
		limit: 3,
		channel_ids: ["UC1234567890123456789012"],
		include_shorts: true,
		include_live: true,
	}));
	await provider.search(request("search_videos", { query: "test", limit: 3 }));
	assert.deepEqual(calls, [
		"video:dQw4w9WgXcQ",
		"subscription_uploads",
		"https://www.youtube.com/channel/UC1234567890123456789012/videos:summary",
		"ytsearch9:test:full",
	]);
}

async function testConservativeChannelBoundary(): Promise<void> {
	const cutoff = Date.parse("2026-07-24T00:00:00Z") / 1_000;
	const rows = [
		videoRow("AAAAAAAAAAA", { timestamp: cutoff + 3_600, timestampPrecision: "exact" }),
		videoRow("BBBBBBBBBBB", { timestamp: cutoff - 3_600, timestampPrecision: "approximate" }),
		videoRow("CCCCCCCCCCC", { timestamp: cutoff - 3_600, timestampPrecision: "exact" }),
		videoRow("DDDDDDDDDDD", { timestamp: cutoff - 25 * 3_600, timestampPrecision: "approximate" }),
		videoRow("EEEEEEEEEEE", { timestamp: undefined, timestampPrecision: "approximate" }),
	];
	const media: YouTubeMediaPort = {
		async version() {
			return "2026.07.04";
		},
		async inspectVideo() {
			throw new Error("unused");
		},
		async listAccountFeed() {
			return [];
		},
		async listAccountSubscriptions() {
			return [];
		},
		async listSubscriptionUploads() {
			return [];
		},
		async listVideos() {
			return rows;
		},
	};
	const provider = youtubeResearchProvider({
		mediaExtractor: media,
		transcriptModule: { async get() { throw new Error("unused"); } },
	});
	const results = await provider.search(request("list_channel_videos", {
		channel_id: "UC1234567890123456789012",
		published_after: "2026-07-24T00:00:00Z",
		limit: 10,
		include_shorts: true,
		include_live: true,
	}, 10));
	assert.deepEqual(results.map((row) => row.metadata?.video_id), [
		"AAAAAAAAAAA",
		"BBBBBBBBBBB",
		"EEEEEEEEEEE",
	]);
	assert.ok(results.slice(1).every((row) => row.metadata?.timestamp_precision === "approximate"));
}

async function testChannelPagination(): Promise<void> {
	const rows = [
		videoRow("AAAAAAAAAAA", { durationSeconds: 60 }),
		videoRow("BBBBBBBBBBB", { durationSeconds: 600 }),
		videoRow("CCCCCCCCCCC", { durationSeconds: 600 }),
	];
	const offsets: number[] = [];
	const media: YouTubeMediaPort = {
		async version() {
			return "2026.07.04";
		},
		async inspectVideo() {
			throw new Error("unused");
		},
		async listAccountFeed() {
			return [];
		},
		async listAccountSubscriptions() {
			return [];
		},
		async listSubscriptionUploads() {
			return [];
		},
		async listVideos(_target, input) {
			offsets.push(input.offset);
			return rows.slice(input.offset, input.offset + input.limit);
		},
	};
	const provider = youtubeResearchProvider({
		mediaExtractor: media,
		transcriptModule: { async get() { throw new Error("unused"); } },
	});
	const first = await provider.search(request("list_channel_videos", {
		channel_id: "UC1234567890123456789012",
		limit: 1,
		include_shorts: false,
		include_live: true,
	}, 1));
	assert.equal(first[0]?.metadata?.video_id, "BBBBBBBBBBB");
	assert.equal(first[0]?.metadata?.next_page_token, "yt-dlp:2");
	const second = await provider.search(request("list_channel_videos", {
		channel_id: "UC1234567890123456789012",
		limit: 1,
		page_token: first[0]?.metadata?.next_page_token,
		include_shorts: false,
		include_live: true,
	}, 1));
	assert.equal(second[0]?.metadata?.video_id, "CCCCCCCCCCC");
	assert.equal(second[0]?.metadata?.next_page_token, undefined);
	assert.deepEqual(offsets, [0, 2]);
}

async function testFastChannelListing(): Promise<void> {
	const binary = join(root, "flat-channel-yt-dlp");
	const argsPath = join(root, "flat-channel-args.txt");
	writeFileSync(binary, `#!/bin/sh
for argument in "$@"; do
	if [ "$argument" = "--version" ]; then
		printf '2026.07.04\\n'
		exit 0
	fi
done
printf '%s\\n' "$@" > "${argsPath}"
printf '%s\\n' '{"id":"dQw4w9WgXcQ","title":"Flat title","webpage_url":"https://www.youtube.com/watch?v=dQw4w9WgXcQ","duration":754,"timestamp":1784934000}'
`);
	chmodSync(binary, 0o700);
	const rows = await new YouTubeMediaExtractor(
		new ControlledYtDlpRunner(binary),
	).listVideos("https://www.youtube.com/channel/UC1234567890123456789012/videos", {
		offset: 0,
		limit: 20,
		publishedAfter: "2026-07-22T14:30:00.000Z",
		mode: "summary",
	});
	const args = readFileSync(argsPath, "utf-8");
	assert.match(args, /--flat-playlist/u);
	assert.match(args, /youtubetab:approximate_date/u);
	assert.equal(rows[0]?.timestampPrecision, "approximate");
}

async function testPublicRequestsDoNotUseCookies(): Promise<void> {
	const binary = join(root, "public-no-cookie-yt-dlp");
	const argsPath = join(root, "public-no-cookie-args.txt");
	writeFileSync(binary, `#!/bin/sh
for argument in "$@"; do
	if [ "$argument" = "--version" ]; then printf '2026.07.04\\n'; exit 0; fi
done
printf '%s\\n' "$@" > "${argsPath}"
printf '%s\\n' '{"id":"dQw4w9WgXcQ","title":"Public","webpage_url":"https://www.youtube.com/watch?v=dQw4w9WgXcQ"}'
`);
	chmodSync(binary, 0o700);
	await new YouTubeMediaExtractor(new ControlledYtDlpRunner(binary)).listVideos(
		"ytsearch1:public",
		{ offset: 0, limit: 1 },
	);
	const args = readFileSync(argsPath, "utf-8");
	assert.doesNotMatch(args, /--cookies(?:-from-browser)?/u);
}

async function testPublicInspectionDoesNotUseCookies(): Promise<void> {
	const binary = join(root, "public-inspection-no-cookie-yt-dlp");
	const argsPath = join(root, "public-inspection-no-cookie-args.txt");
	writeFileSync(binary, `#!/bin/sh
for argument in "$@"; do
	if [ "$argument" = "--version" ]; then printf '2026.07.04\\n'; exit 0; fi
done
printf '%s\\n' "$@" > "${argsPath}"
printf '%s\\n' '{"id":"dQw4w9WgXcQ","title":"Public","webpage_url":"https://www.youtube.com/watch?v=dQw4w9WgXcQ"}'
`);
	chmodSync(binary, 0o700);
	await new YouTubeMediaExtractor(new ControlledYtDlpRunner(binary)).inspectVideo("dQw4w9WgXcQ");
	assert.doesNotMatch(readFileSync(argsPath, "utf-8"), /--cookies(?:-from-browser)?/u);
}

async function testInspectionAuthenticationFallback(): Promise<void> {
	const binary = join(root, "inspection-authentication-fallback-yt-dlp");
	const argsPath = join(root, "inspection-authentication-fallback-args.txt");
	writeFileSync(binary, `#!/bin/sh
for argument in "$@"; do
	if [ "$argument" = "--version" ]; then printf '2026.07.04\\n'; exit 0; fi
done
printf '%s\\n' CALL "$@" >> "${argsPath}"
cookie=false
for argument in "$@"; do
	if [ "$argument" = "--cookies-from-browser" ]; then cookie=true; fi
done
if [ "$cookie" = false ]; then
	echo 'ERROR: [youtube] Login details are needed to download this content' >&2
	exit 1
fi
printf '%s\\n' '{"id":"dQw4w9WgXcQ","title":"Account","webpage_url":"https://www.youtube.com/watch?v=dQw4w9WgXcQ"}'
`);
	chmodSync(binary, 0o700);
	const result = await new YouTubeMediaExtractor(new ControlledYtDlpRunner(binary)).inspectVideo("dQw4w9WgXcQ");
	assert.equal(result.title, "Account");
	const calls = readFileSync(argsPath, "utf-8").split(/^CALL$/mu).slice(1);
	assert.doesNotMatch(calls[0]!, /--cookies(?:-from-browser)?/u);
	assert.match(calls[1]!, /--cookies-from-browser/u);
}

async function testPublicCaptionDoesNotUseCookies(): Promise<void> {
	const binary = join(root, "public-caption-no-cookie-yt-dlp");
	const argsPath = join(root, "public-caption-no-cookie-args.txt");
	writeFileSync(binary, `#!/bin/sh
printf '%s\\n' "$@" > "${argsPath}"
previous=
output=
for argument in "$@"; do
	if [ "$previous" = "--output" ]; then output="$argument"; fi
	previous="$argument"
done
path=$(printf '%s' "$output" | sed 's/%(ext)s/vtt/')
printf 'caption' > "$path"
`);
	chmodSync(binary, 0o700);
	const result = await new YouTubeMediaExtractor(new ControlledYtDlpRunner(binary)).materializeCaption(
		"dQw4w9WgXcQ",
		{ language: "en", automatic: false, formats: ["vtt"] },
	);
	assert.equal(result.content, "caption");
	assert.doesNotMatch(readFileSync(argsPath, "utf-8"), /--cookies(?:-from-browser)?/u);
}

async function testCaptionAuthenticationFallback(): Promise<void> {
	const binary = join(root, "caption-authentication-fallback-yt-dlp");
	const argsPath = join(root, "caption-authentication-fallback-args.txt");
	writeFileSync(binary, `#!/bin/sh
printf '%s\\n' CALL "$@" >> "${argsPath}"
cookie=false
previous=
output=
for argument in "$@"; do
	if [ "$argument" = "--cookies-from-browser" ]; then cookie=true; fi
	if [ "$previous" = "--output" ]; then output="$argument"; fi
	previous="$argument"
done
if [ "$cookie" = false ]; then
	echo 'ERROR: [youtube] Login details are needed to download this content' >&2
	exit 1
fi
path=$(printf '%s' "$output" | sed 's/%(ext)s/vtt/')
printf 'caption' > "$path"
`);
	chmodSync(binary, 0o700);
	const result = await new YouTubeMediaExtractor(new ControlledYtDlpRunner(binary)).materializeCaption(
		"dQw4w9WgXcQ",
		{ language: "en", automatic: false, formats: ["vtt"] },
	);
	assert.equal(result.content, "caption");
	const calls = readFileSync(argsPath, "utf-8").split(/^CALL$/mu).slice(1);
	assert.doesNotMatch(calls[0]!, /--cookies(?:-from-browser)?/u);
	assert.match(calls[1]!, /--cookies-from-browser/u);
}

async function testAccountRequestsPreferCookieFile(): Promise<void> {
	const binary = join(root, "account-cookie-file-yt-dlp");
	const argsPath = join(root, "account-cookie-file-args.txt");
	const cookiePath = join(root, "youtube-cookies.txt");
	writeFileSync(cookiePath, "# Netscape HTTP Cookie File\n", { mode: 0o600 });
	writeFileSync(binary, `#!/bin/sh
for argument in "$@"; do
	if [ "$argument" = "--version" ]; then printf '2026.07.04\\n'; exit 0; fi
done
printf '%s\\n' "$@" > "${argsPath}"
printf '%s\\n' '{"id":"dQw4w9WgXcQ","title":"Account","webpage_url":"https://www.youtube.com/watch?v=dQw4w9WgXcQ"}'
`);
	chmodSync(binary, 0o700);
	const previous = process.env.PI_YOUTUBE_YTDLP_COOKIE_FILE;
	process.env.PI_YOUTUBE_YTDLP_COOKIE_FILE = cookiePath;
	try {
		await new YouTubeMediaExtractor(new ControlledYtDlpRunner(binary)).listAccountFeed(
			":ythis",
			{ limit: 1 },
		);
	} finally {
		if (previous === undefined) delete process.env.PI_YOUTUBE_YTDLP_COOKIE_FILE;
		else process.env.PI_YOUTUBE_YTDLP_COOKIE_FILE = previous;
	}
	const args = readFileSync(argsPath, "utf-8");
	assert.match(args, new RegExp(`--cookies\\n${realpathSync(cookiePath).replaceAll("/", "\\/")}\\n`, "u"));
	assert.doesNotMatch(args, /--cookies-from-browser/u);
}

async function testAccountRejectsUnsafeCookieFile(): Promise<void> {
	const binary = join(root, "unsafe-cookie-file-yt-dlp");
	writeFileSync(binary, "#!/bin/sh\nprintf '2026.07.04\\n'\n");
	chmodSync(binary, 0o700);
	const previous = process.env.PI_YOUTUBE_YTDLP_COOKIE_FILE;
	process.env.PI_YOUTUBE_YTDLP_COOKIE_FILE = "relative-cookies.txt";
	try {
		await assert.rejects(
			new YouTubeMediaExtractor(new ControlledYtDlpRunner(binary)).listAccountFeed(":ythis", { limit: 1 }),
			(error: unknown) => error instanceof ResearchNodeError && error.code === "youtube_cookie_file_invalid",
		);
	} finally {
		if (previous === undefined) delete process.env.PI_YOUTUBE_YTDLP_COOKIE_FILE;
		else process.env.PI_YOUTUBE_YTDLP_COOKIE_FILE = previous;
	}
}

async function testAccountRequiresExplicitCredentials(): Promise<void> {
	const binary = join(root, "missing-account-credentials-yt-dlp");
	writeFileSync(binary, "#!/bin/sh\nprintf '2026.07.04\\n'\n");
	chmodSync(binary, 0o700);
	const previousFile = process.env.PI_YOUTUBE_YTDLP_COOKIE_FILE;
	const previousProfile = process.env.PI_YOUTUBE_YTDLP_COOKIES_FROM_BROWSER;
	delete process.env.PI_YOUTUBE_YTDLP_COOKIE_FILE;
	delete process.env.PI_YOUTUBE_YTDLP_COOKIES_FROM_BROWSER;
	try {
		await assert.rejects(
			new YouTubeMediaExtractor(new ControlledYtDlpRunner(binary)).listAccountFeed(":ythis", { limit: 1 }),
			(error: unknown) => error instanceof ResearchNodeError && error.code === "youtube_account_credentials_required",
		);
	} finally {
		if (previousFile !== undefined) process.env.PI_YOUTUBE_YTDLP_COOKIE_FILE = previousFile;
		if (previousProfile !== undefined) process.env.PI_YOUTUBE_YTDLP_COOKIES_FROM_BROWSER = previousProfile;
	}
}

async function testLiveChatIsNotCaption(): Promise<void> {
	const binary = join(root, "live-chat-yt-dlp");
	writeFileSync(binary, `#!/bin/sh
for argument in "$@"; do
	if [ "$argument" = "--version" ]; then
		printf '2026.07.04\\n'
		exit 0
	fi
done
printf '%s\\n' '{"id":"dQw4w9WgXcQ","title":"Live replay","webpage_url":"https://www.youtube.com/watch?v=dQw4w9WgXcQ","subtitles":{"live_chat":[{"ext":"json"}]}}'
`);
	chmodSync(binary, 0o700);
	const inspection = await new YouTubeMediaExtractor(
		new ControlledYtDlpRunner(binary),
	).inspectVideo("dQw4w9WgXcQ");
	assert.deepEqual(inspection.manualCaptions, []);
	assert.deepEqual(inspection.automaticCaptions, []);
}

async function testPartialOutput(): Promise<void> {
	const binary = join(root, "partial-yt-dlp");
	writeFileSync(binary, "#!/bin/sh\nprintf '{\"id\":\"ok\"}\\n'\nprintf 'one item failed\\n' >&2\nexit 1\n");
	chmodSync(binary, 0o700);
	const result = await new ControlledYtDlpRunner(binary).run(["test"], {
		acceptPartialOutput: true,
	});
	assert.match(result.stdout, /"id":"ok"/u);
	await assert.rejects(
		new ControlledYtDlpRunner(binary).run(["test"]),
		/youtube_ytdlp_failed|yt-dlp failed/u,
	);
}

async function testAudioAuthenticationFallback(): Promise<void> {
	const binary = join(root, "audio-authentication-fallback-yt-dlp");
	const argsPath = join(root, "audio-authentication-fallback-args.txt");
	writeFileSync(binary, `#!/bin/sh
cookie=false
output=
previous=
printf '%s\\n' CALL "$@" >> "${argsPath}"
for argument in "$@"; do
	if [ "$previous" = "--output" ]; then output="$argument"; fi
	if [ "$argument" = "--cookies-from-browser" ]; then cookie=true; fi
	previous="$argument"
done
if [ "$cookie" = false ]; then
	echo "ERROR: [youtube] test: Login details are needed to download this content" >&2
	exit 1
fi
path=$(printf "%s" "$output" | sed "s/%(ext)s/mp3/")
printf "audio" > "$path"
`);
	chmodSync(binary, 0o700);
	const extractor = new YouTubeMediaExtractor(new ControlledYtDlpRunner(binary));
	const audio = await extractor.materializeAudio({
		videoId: "dQw4w9WgXcQ",
		title: "Public fallback",
		webpageUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
		manualCaptions: [],
		automaticCaptions: [],
		chapters: [],
		raw: {},
		extractorVersion: "2026.07.04",
	}, {
		maxDurationSeconds: 7_200,
	});
	assert.match(audio.path, /audio-auth\.mp3$/u);
	assert.equal(audio.bytes, 5);
	const calls = readFileSync(argsPath, "utf-8").split(/^CALL$/mu).slice(1);
	assert.doesNotMatch(calls[0]!, /--cookies(?:-from-browser)?/u);
	assert.match(calls[1]!, /--cookies-from-browser/u);
	audio.cleanup();
}

async function testAudioFormatFailureIsRequestScoped(): Promise<void> {
	const binary = join(root, "format-unavailable-yt-dlp");
	writeFileSync(binary, `#!/bin/sh
echo "ERROR: [youtube] test: Requested format is not available. Use --list-formats for a list of available formats" >&2
exit 1
`);
	chmodSync(binary, 0o700);
	const extractor = new YouTubeMediaExtractor(new ControlledYtDlpRunner(binary));
	await assert.rejects(extractor.materializeAudio({
		videoId: "dQw4w9WgXcQ",
		title: "Unavailable format",
		webpageUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
		manualCaptions: [],
		automaticCaptions: [],
		chapters: [],
		raw: {},
		extractorVersion: "2026.07.04",
	}, {
		maxDurationSeconds: 7_200,
	}), (error: unknown) => error instanceof ResearchNodeError
		&& error.code === "youtube_ytdlp_format_unavailable"
		&& error.failureClass === "provider"
		&& error.retryable === false
		&& error.details?.circuit_scope === "request");
}

function request(
	operation: string,
	parameters: Record<string, unknown>,
	maxResults = 10,
): ResearchSearchRequest {
	return {
		query: operation,
		maxResults,
		criterionIds: ["youtube-test"],
		purpose: "YouTube Provider test",
		signal: new AbortController().signal,
		workspaceDir: root,
		providerRequest: { operation, parameters },
	};
}

function videoRow(
	videoId = "dQw4w9WgXcQ",
	overrides: Partial<YtDlpFeedVideo> = {},
): YtDlpFeedVideo {
	return { ...baseVideoRow(videoId), ...overrides };
}

function baseVideoRow(videoId: string): YtDlpFeedVideo {
	return {
		videoId,
		title: "Stable title",
		url: `https://www.youtube.com/watch?v=${videoId}`,
		channelId: "UC1234567890123456789012",
		timestamp: Date.parse("2026-07-24T00:00:00Z") / 1_000,
		extractorVersion: "2026.07.04",
	};
}
