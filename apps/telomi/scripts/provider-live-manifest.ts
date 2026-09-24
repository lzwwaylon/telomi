export interface ProviderLiveManifestEntry {
	requirements: readonly string[];
	tests: ReadonlyArray<{ script: string; operations: readonly string[] }>;
	skips: ReadonlyArray<{ operation: string; reason: string }>;
}

export const PROVIDER_LIVE_MANIFEST = {
	arxiv: {
		requirements: ["public network access"],
		tests: [{
			script: "test:research-sources-live",
			operations: ["query", "categories", "paper_front", "download_pdf"],
		}],
		skips: [],
	},
	github: {
		requirements: ["GitHub CLI authentication", "public network access"],
		tests: [{
			script: "test:research-sources-live",
			operations: [
				"search_topics", "search_repositories", "get_repository", "search_code", "search_issues",
				"get_issue", "clone_repository", "download_release", "download_file",
			],
		}],
		skips: [],
	},
	huggingface: {
		requirements: ["public network access"],
		tests: [{
			script: "test:huggingface-source-live",
			operations: [
				"papers_list", "papers_search", "papers_info", "papers_preview", "papers_download", "models_info", "models_card",
				"model_tags", "models_list", "datasets_info", "datasets_leaderboard",
				"datasets_list", "spaces_list",
			],
		}],
		skips: [],
	},
	twitter: {
		requirements: ["authenticated X cookie", "public network access"],
		tests: [{
			script: "test:twitter-source-live",
			operations: [
				"search", "profile", "tweets", "thread", "article", "timeline", "following",
				"followers", "likes", "bookmarks", "lists", "list_tweets", "device_follow",
				"notifications", "trending", "media",
			],
		}],
		skips: [],
	},
	user_documents: {
		requirements: ["local attachment workspace"],
		tests: [{ script: "test:research-sources-live", operations: ["search"] }],
		skips: [],
	},
	youtube: {
		requirements: ["owner-only Cookie file or dedicated authenticated browser Profile for account operations", "public network access"],
		tests: [
			{
				script: "test:youtube-public-functions-live",
				operations: [
					"capabilities", "list_subscription_uploads", "list_channel_videos",
					"list_playlist_videos", "search_videos", "get_video", "get_transcript",
				],
			},
			{
				script: "test:youtube-account-functions-live",
				operations: [
					"list_subscriptions", "snapshot_home_recommendations", "list_watch_later", "list_history",
				],
			},
		],
		skips: [],
	},
} as const satisfies Record<string, ProviderLiveManifestEntry>;

export type ProviderLiveId = keyof typeof PROVIDER_LIVE_MANIFEST;
