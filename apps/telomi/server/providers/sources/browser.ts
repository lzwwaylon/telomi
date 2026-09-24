import type { SourceDescriptor } from "../source-descriptors.js";

export const browser: SourceDescriptor = {
	id: "browser",
	auth: "browser_session",
	verify: "browser",
	provider: {
		id: "browser",
		runtime: { kind: "browser" },
		catalog: {
			implementationVersion: "agent-browser-python-v3-materialize",
			capability: "authenticated and dynamic website exploration",
			// The child drives the Runtime-owned session from ipython through this module; the
			// workerTool entry below is what makes the Runtime open that session for the child.
			workerPython: { module: "tools.browser" },
			workerTool: {
				name: "browser",
				skill: "prime-browser-provider-skill",
				tools: ["browser", "materialize_source"],
			},
			workerSkills: ["prime-browser-provider-skill"],
			fullTextAvailability: "browser_render",
			credentialRequirement: "optional",
			reliabilityTier: 2,
			freshness: "realtime",
			costClass: "free",
			latencyClass: "high",
			sourceClass: "specialized",
			queryContract: {
				input: "natural_language",
				schemaVersion: 1,
				instructions: [
					"Use Browser only for authenticated, dynamic, or interaction-dependent evidence that ordinary Providers cannot retrieve.",
					"Use browser to explore pages and materialize_source to retain evidence for the Candidate Ledger.",
				],
				examples: ["Inspect the authenticated member feed and retain the latest relevant article."],
			},
			supportedContentTypes: [
				"text/html", "text/plain", "text/markdown", "text/csv", "application/json", "application/pdf", "audio/*",
				"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
				"application/vnd.openxmlformats-officedocument.presentationml.presentation",
				"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
			],
			capabilities: ["authenticated_web", "dynamic_web", "browser_navigation"],
			supportedFields: ["title", "url", "content", "published_at", "artifact_path"],
			supportedFilters: ["allowed_origins", "risk_mode"],
			evidenceTypes: ["web_page", "authenticated_page", "browser_capture"],
			operations: ["browser_exploration", "page_capture", "attachment_materialization"],
		},
	},
};
