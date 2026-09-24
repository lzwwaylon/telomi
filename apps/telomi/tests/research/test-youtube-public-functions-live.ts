import assert from "node:assert/strict";

import { youtubeResearchProvider } from "../../server/research/sources/providers/youtube/index.js";

const provider = youtubeResearchProvider();
const signal = new AbortController().signal;
const workspaceDir = "/tmp/telomi-youtube-public-functions-live";
const videoId = "yfEdhlBuxCU";
const channelId = "UCLKPca3kwwd-B59HNr-_lvA";

async function call(operation: string, parameters: Record<string, unknown>, maxResults: number) {
	return provider.search({
		query: operation,
		maxResults,
		criterionIds: ["youtube-public-functions-live"],
		purpose: `Verify real YouTube operation ${operation}`,
		signal,
		workspaceDir,
		providerRequest: { operation, parameters },
	});
}

const capabilities = await call("capabilities", {}, 1);
assert.equal(capabilities.length, 1);

const videos = await call("get_video", { video_id: videoId }, 1);
assert.equal(videos[0]?.metadata?.video_id, videoId);

const transcripts = await call("get_transcript", {
	video_id: videoId,
	preferred_languages: ["en"],
	max_duration_seconds: 7_200,
}, 1);
assert.equal(transcripts[0]?.metadata?.resource_type, "youtube_transcript");

const search = await call("search_videos", { query: "OpenAI agents", limit: 3 }, 3);
assert.ok(search.length > 0);

const channel = await call("list_channel_videos", {
	channel_id: channelId,
	limit: 3,
	include_shorts: true,
	include_live: true,
}, 3);
assert.equal(channel.length, 3);

const subscriptionUploads = await call("list_subscription_uploads", {
	channel_ids: [channelId],
	limit: 3,
	include_shorts: true,
	include_live: true,
}, 3);
assert.equal(subscriptionUploads.length, 3);

const playlist = await call("list_playlist_videos", {
	playlist_id: `UU${channelId.slice(2)}`,
	limit: 3,
}, 3);
assert.equal(playlist.length, 3);

console.log(JSON.stringify({
	event: "youtube_public_functions_live_passed",
	counts: {
		capabilities: capabilities.length,
		get_video: videos.length,
		get_transcript: transcripts.length,
		search_videos: search.length,
		list_channel_videos: channel.length,
		list_subscription_uploads: subscriptionUploads.length,
		list_playlist_videos: playlist.length,
	},
}, null, 2));
