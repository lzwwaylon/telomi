import type { ResearchSourceCatalogEntry } from "../search-types.js";
import type { SourceDescriptor } from "../source-descriptors.js";
import type { GeneralWebBackend } from "../../research/harness/prime-search.js";

/** Each backend carries its own catalog so the Runtime can cache and record it on its own. */
export const generalWebCatalog = (backend: GeneralWebBackend): ResearchSourceCatalogEntry => ({
	implementationVersion: `general-web-${backend}-v2`, capability: `general public web discovery through ${backend}`, supportedContentTypes: ["text/html", "application/pdf"], fullTextAvailability: "mixed",
	credentialRequirement: "optional", reliabilityTier: 2, freshness: "index_dependent", costClass: "low", latencyClass: "medium",
	sourceClass: "general", queryContract: { input: "natural_language", schemaVersion: 1,
		instructions: ["Use a concise web search query.", "Use site: only when an authoritative domain is known.", "Treat results as Metadata candidates, not Evidence.",
			"Return selected Provider Metadata rows unchanged. Prime Search Root validates candidates and acquires supported pages after child discovery completes.",
			"Runtime does not apply hard publication-date filters during general-web discovery; date language remains query context only.",
			`Host Runtime prefers the configured ${backend} backend and falls back to the other configured backends when it is unavailable; each row's general_web_backend names the one that answered.`],
		examples: ["recent research on retrieval evaluation", "site:who.int annual health report"] },
	capabilities: ["general_web"],
	supportedFields: ["title", "url", "snippet", "publication_date", "general_web_backend"], supportedFilters: [],
	evidenceTypes: ["web_page"], operations: ["keyword_discovery"],
});

function generalWebBackend(backend: GeneralWebBackend, minIntervalMs: number, field: { id: string; env: string; legacyEnv: string[] }): SourceDescriptor {
	return {
		id: backend,
		auth: "api_key",
		verify: "source_service",
		provider: { id: `general_web_${backend}`, runtime: { kind: "source_service", minIntervalMs }, catalog: generalWebCatalog(backend) },
		fields: [field],
	};
}

export const firecrawl = generalWebBackend("firecrawl", 12_500, { id: "firecrawl_api_key", env: "SOURCE_SERVICE_FIRECRAWL_API_KEY", legacyEnv: ["FIRECRAWL_API_KEY"] });
export const tavily = generalWebBackend("tavily", 650, { id: "tavily_api_key", env: "SOURCE_SERVICE_TAVILY_API_KEY", legacyEnv: ["TAVILY_API_KEY"] });
export const exa = generalWebBackend("exa", 125, { id: "exa_api_key", env: "SOURCE_SERVICE_EXA_API_KEY", legacyEnv: ["EXA_API_KEY"] });
