import type { SourceDescriptor } from "../source-descriptors.js";

/**
 * No `login`: the X session is copied from the user's own browser. X keeps a long-lived
 * `auth_token` rather than a token the page rotates, so a copy does not fight the original.
 */
export const twitter: SourceDescriptor = {
	id: "twitter",
	auth: "browser_session",
	verify: "source_service",
	fields: [
		{
			id: "twitter_cookie",
			env: "SOURCE_SERVICE_TWITTER_COOKIE",
			legacyEnv: ["TWITTER_COOKIE", "X_COOKIE"],
			locationEnv: [
				"SOURCE_SERVICE_TWITTER_COOKIE_FILE",
				"TWITTER_COOKIE_FILE",
				"X_COOKIE_FILE",
			],
		},
		{
			id: "twitter_bearer_token",
			env: "SOURCE_SERVICE_TWITTER_BEARER_TOKEN",
			legacyEnv: ["TWITTER_BEARER_TOKEN"],
			optional: true,
		},
	],
	provider: {
		id: "twitter",
		runtime: { kind: "source_service", minIntervalMs: 750 },
		catalog: {
			implementationVersion: "twitter-web-session-graphql-v1",
			capability: "authenticated read-only X/Twitter profiles, posts, timelines, relationships, saved items, lists, notifications, trends, and media metadata",
			supportedContentTypes: ["application/json", "text/plain"],
			workerPython: { module: "tools.twitter" },
			workerSkills: ["prime-twitter-provider-skill"],
			fullTextAvailability: "mixed",
			credentialRequirement: "required",
			reliabilityTier: 2,
			freshness: "realtime",
			costClass: "free",
			latencyClass: "low",
			capabilities: [
				"social_search", "user_profiles", "posts", "timelines", "social_graph",
				"saved_items", "lists", "notifications", "trends", "media_metadata",
			],
			sourceClass: "specialized",
			queryContract: {
				input: "provider_syntax",
				schemaVersion: 1,
				instructions: [
					"Use tools.twitter for all X/Twitter access. Direct HTTP and browser automation are unavailable.",
					"Provider results already contain authenticated post, article, thread, profile, or timeline content. Publish only returned fields as grounded Markdown or JSON.",
					"Do not revisit public X URLs. Provider children use only authenticated Provider-returned Metadata fields.",
					"Use native X search syntax in twitter.search, including from:, filter:, -filter:, lang:, since:, and until: when useful.",
					"Call profile once when a numeric user ID is useful. The SDK accepts either a handle or a numeric user ID for user-scoped reads.",
					"For explicitly exhaustive discovery, pass each opaque cursor back unchanged to the terminal cursor. Otherwise paginate only while assigned evidence remains uncovered.",
					"Treat bookmarks, home timelines, notifications, lists, and trends as private session-scoped data.",
				],
				examples: [
					'twitter.search(\'"agent evaluation" lang:en -filter:replies\', product="latest", max_results=50)',
					'twitter.tweets("OpenAI", max_results=50)',
					'twitter.thread("1234567890123456789", max_results=100)',
					'twitter.bookmarks(max_results=50)',
					'twitter.media(user="OpenAI", max_results=50)',
				],
			},
			supportedFields: [
				"title", "url", "text", "publication_date", "author", "display_name", "bio",
				"user_id", "tweet_id", "followers", "following", "likes", "retweets", "replies",
				"bookmarks", "views", "media_urls", "media_type", "list_id",
				"notification_action", "trend_rank", "next_cursor",
			],
			supportedFilters: [
				"query", "product", "username", "user_id", "tweet_id", "feed", "list_id",
				"cursor", "limit",
			],
			evidenceTypes: ["social_post", "user_profile", "social_timeline", "notification", "trend"],
			operations: [
				"search", "profile", "tweets", "thread", "article", "timeline", "following",
				"followers", "likes", "bookmarks",
				"lists", "list_tweets", "device_follow", "notifications", "trending", "media",
			],
		},
	},
};
