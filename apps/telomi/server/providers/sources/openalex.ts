import type { SourceDescriptor } from "../source-descriptors.js";

export const openalex: SourceDescriptor = {
	id: "openalex",
	auth: "api_key",
	verify: "source_service",
	fields: [{ id: "openalex_api_key", env: "SOURCE_SERVICE_OPENALEX_API_KEY", legacyEnv: [], optional: true }],
	provider: {
		id: "openalex",
		runtime: { kind: "source_service", minIntervalMs: 1_000, maxConcurrency: 1 },
		catalog: {
			implementationVersion: "openalex-native-topics-cursor-free-budget-v1",
			capability: "OpenAlex Topic taxonomy, native date-bounded work discovery, exact ID/DOI lookup, and cached PDF material",
			workerPython: { module: "tools.openalex" },
			workerSkills: ["prime-openalex-selection-skill"],
			supportedContentTypes: ["application/json", "application/pdf", "text/markdown"],
			fullTextAvailability: "mixed", credentialRequirement: "optional", reliabilityTier: 2,
			freshness: "index_dependent", costClass: "free", latencyClass: "medium", sourceClass: "specialized",
			capabilities: ["scholarly_papers", "topic_discovery", "citation_metadata"],
			queryContract: {
				input: "provider_syntax", schemaVersion: 1,
				instructions: [
					"Use topics() and topic_info() to select native OpenAlex Topic IDs by their descriptions before discover_papers(). Topic assignments are predictions; default topics.id includes secondary topics, while primary_topic.id is narrower.",
					"Use discover_papers(topic_ids, start_date=..., end_date=...) to retrieve a cursor-paginated candidate pool. Review titles and abstracts semantically; native keyword search supplements taxonomy coverage.",
					"Use work_info() for exact W IDs or DOIs. OpenAlex publication_date is not arXiv submission/update time; preserve native dates and identifiers.",
					"Use download_pdf() only for selected works with cached OpenAlex PDFs and a configured free API key. Missing full text is an evidence gap, not an empty search or Provider outage.",
					"Free-only local shared daily admission stops this Provider at the allowance ceiling. Runtime owns retries; hand off unavailable or uncovered needs to Root and preserve partial candidates.",
				],
				examples: ["topics.id:T11636,from_publication_date:2026-01-01,to_publication_date:2026-09-25", "W2741809807", "https://doi.org/10.7717/peerj.4375"],
			},
			supportedFields: ["title", "url", "abstract", "authors", "publication_date", "updated_date", "doi", "openalex_id", "topics", "primary_topic", "locations", "has_content", "content_urls", "native_query", "openalex_page", "pdf_path", "markdown_path"],
			supportedFilters: ["topics.id", "primary_topic.id", "from_publication_date", "to_publication_date", "filter", "search", "sort", "cursor", "per_page"],
			evidenceTypes: ["scholarly_metadata", "primary_document"],
			operations: ["topics", "topic_info", "query", "work_info", "download_pdf"],
		},
	},
};
