import type { SourceDescriptor } from "../source-descriptors.js";

export const github: SourceDescriptor = {
	id: "github",
	auth: "api_key",
	verify: "source_service",
	fields: [{ id: "github_token", env: "SOURCE_SERVICE_GITHUB_TOKEN", legacyEnv: ["GITHUB_TOKEN"] }],
	provider: {
		id: "github",
		runtime: { kind: "source_service", minIntervalMs: 2_100 },
		catalog: { implementationVersion: "github-fastapi-gh-v4", capability: "read-only GitHub discovery, issue discussions, and workspace downloads", supportedContentTypes: ["application/json", "text/html", "text/plain", "application/zip", "application/gzip"],
			workerPython: { module: "tools.github" },
			workerSkills: ["prime-github-selection-skill"],
			fullTextAvailability: "mixed", credentialRequirement: "optional", reliabilityTier: 1, freshness: "realtime", costClass: "free", latencyClass: "low",
			capabilities: ["github_repositories", "github_code", "github_issues", "github_downloads"],
			sourceClass: "specialized", queryContract: { input: "provider_syntax", schemaVersion: 1,
				instructions: [
					"Use tools.github for read-only GitHub Metadata discovery.",
					"Resolve an exact GitHub topic name with search_topics (community topics such as text-to-speech count; curated is only a flag), then use discover_repositories or search_repositories with topics as the reliable repository filter.",
					"GitHub repository search combines whitespace-separated terms with AND. Use free-text queries only as a last resort, with one to three discriminative terms.",
					"In a discovery program, search during final execution and fetch repository details only for rows returned by that same final execution. A fixed repository or Issue ID must come from an `[exact]` Planner input.",
					"GitHub max_results is a request safety window. If a discovery query fills it and assigned evidence remains uncovered, refine or paginate the query; a full page alone does not require exhaustive enumeration.",
					"The assigned Provider child discovers, shortlists, and acquires the selected GitHub repositories, files, or releases.",
				],
				examples: [
					'github.discover_repositories("text-to-speech", start_date="2026-01-01", end_date="2026-08-31")',
					'github.get_issue("owner/repo", 123)',
					'github.search_code("streaming ASR", repository="owner/repo", max_results=20)',
				] },
			supportedFields: [
				"title", "url", "description", "repository", "owner", "path", "sha", "issue_number",
				"body", "comments", "updated_at", "created_at", "pushed_at", "stars", "forks",
				"language", "topics", "license", "archived", "artifact_path",
			],
			supportedFilters: [
				"topics", "language", "min_stars", "created_after", "created_before", "pushed_after",
				"sort", "order", "repository", "state", "match", "ref", "tag", "patterns", "archive",
			],
			evidenceTypes: ["repository", "code", "issue", "issue_discussion", "downloaded_artifact"],
			operations: [
				"search_topics", "search_repositories", "get_repository", "search_code", "search_issues",
				"get_issue", "clone_repository", "download_release", "download_file",
			] },
	},
};
