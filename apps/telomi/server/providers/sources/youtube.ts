import type { SourceDescriptor } from "../source-descriptors.js";

export const youtube: SourceDescriptor = {
	id: "youtube",
	auth: "browser_session",
	verify: "youtube",
	login: {
		url: "https://accounts.google.com/ServiceLogin?continue=https%3A%2F%2Fwww.youtube.com%2F",
		cookie: { domain: "youtube.com", name: "LOGIN_INFO" },
	},
	provider: {
		id: "youtube",
		runtime: { kind: "youtube" },
		catalog: {
			implementationVersion: "youtube-provider-v5",
			capability: "YouTube subscriptions, uploads, metadata, playlists, search, and transcripts through yt-dlp with scoped Host credentials",
			supportedContentTypes: ["application/json", "text/markdown", "text/vtt", "audio/mpeg"],
			workerPython: { module: "tools.youtube" },
			workerSkills: ["prime-youtube-provider-skill"],
			fullTextAvailability: "mixed",
			credentialRequirement: "required",
			reliabilityTier: 2,
			freshness: "realtime",
			costClass: "low",
			latencyClass: "medium",
			capabilities: [
				"account_subscriptions", "channel_uploads",
				"video_metadata", "playlists", "transcripts",
			],
			sourceClass: "specialized",
			queryContract: {
				input: "provider_syntax",
				schemaVersion: 1,
				instructions: [
					"Use tools.youtube functions. Provider URL and ID parsing stays inside Host Runtime.",
					"Use subscription_uploads for account-backed monitoring and pass an ISO 8601 published_after cursor for incremental acquisition.",
					"Public operations use yt-dlp without account Cookies; account operations use Host-managed credentials.",
					"Pass video IDs or URLs directly to video; pass playlist/channel IDs or URLs to their matching functions.",
					"For paged operations, read continuation with youtube.next_page_token(rows); never assume a top-level page envelope.",
					"When locating a named subscription, stop paging as soon as the matching channel is found.",
					"Filter from channel or upload list metadata before fetching full video details or transcripts, and use bounded concurrency for retained candidates.",
					"Channel-list timestamps marked approximate include a conservative one-day overlap; call video for retained candidates before applying an exact published_after boundary.",
					"Transcript acquisition automatically falls back to Host-owned audio extraction and ASR when captions are unavailable.",
					"The assigned Provider child discovers, shortlists, and retrieves transcripts for selected videos.",
					"Treat transcript source, language, machine-generation, translation, and extractor metadata as provenance.",
				],
				examples: [
					'youtube.subscription_uploads(published_after="2026-07-19T00:00:00Z", max_results=100)',
					'youtube.video("https://www.youtube.com/watch?v=dQw4w9WgXcQ")',
					'youtube.video("dQw4w9WgXcQ")',
				],
			},
			supportedFields: [
				"title", "url", "description", "published_at", "channel_id", "channel_title",
				"video_id", "playlist_id", "duration_seconds", "caption_available", "view_count",
				"like_count", "comment_count", "transcript_status", "transcript_source_language",
				"transcript_output_language", "provider_artifact_path",
			],
			supportedFilters: [
				"published_after", "channel_ids", "channel_id", "playlist_id", "video_id",
				"page_token", "limit", "target_language", "preferred_languages",
			],
			evidenceTypes: ["video_metadata", "video_transcript", "account_subscription"],
			operations: [
				"capabilities", "list_subscriptions", "list_subscription_uploads",
				"list_channel_videos", "list_playlist_videos", "search_videos",
				"get_video", "get_transcript", "snapshot_home_recommendations",
				"list_watch_later", "list_history",
			],
		},
	},
};
