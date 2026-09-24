import type { SourceDescriptor } from "../source-descriptors.js";

export const arxiv: SourceDescriptor = {
	id: "arxiv",
	auth: "none",
	verify: "none",
	provider: {
		id: "arxiv",
		runtime: { kind: "source_service", minIntervalMs: 4_000 },
		catalog: { implementationVersion: "arxiv-fastapi-atom-html-document-runtime-v5", capability: "arXiv metadata, HTML front matter, original PDFs, and Document Convert Markdown through native APIs", supportedContentTypes: ["application/atom+xml", "text/html", "application/pdf", "text/markdown"],
			workerPython: { module: "tools.arxiv", files: ["links.py"] },
			workerSkills: ["prime-arxiv-selection-skill"],
			fullTextAvailability: "full_text", credentialRequirement: "none", reliabilityTier: 1, freshness: "daily", costClass: "free", latencyClass: "medium", capabilities: ["scholarly_papers", "preprints"],
			sourceClass: "specialized", queryContract: { input: "provider_syntax", schemaVersion: 1,
				instructions: ["Use native arXiv search_query grammar, including field prefixes, boolean operators, date ranges, id_list, start, sortBy, and sortOrder. Every submittedDate endpoint must contain exactly 12 digits in YYYYMMDDHHMM form, including 0000 or 2359 time digits.",
					"Use tools.arxiv.native_query for the complete Export API query surface, including combined search_query and id_list plus GET or POST selection.",
					"For an explicitly exhaustive assignment, loop tools.arxiv.native_query with start and max_results until arxiv_feed.total_results proves the terminal boundary, or until a short or empty page when that metadata is absent. Otherwise paginate only while assigned evidence remains uncovered.",
					"Fixed arXiv IDs must come from an `[exact]` Planner input. In a discovery program, discovery-derived IDs must come from that final execution before calling tools.arxiv.fetch_ids.",
					"Use tools.arxiv.paper_profile with depth='metadata' for the discovery pool and depth='front' to inspect candidate affiliations, email domains, links, and availability statements without downloading PDFs.",
					"Use tools.arxiv.download_pdf for selected exact IDs; it preserves the original PDF and returns converted Markdown in download_path."],
				examples: ["ti:\"graph neural network\" AND submittedDate:[202601010000 TO 202607142359]", "cat:cs.CL AND (all:retrieval OR all:evaluation)", "id_list=1706.03762,2401.00001"] },
			supportedFields: ["title", "url", "authors", "abstract", "publication_date", "updated_at", "pdf_url", "pdf_path", "markdown_path", "artifact_path", "arxiv_id",
				"categories", "primary_category", "comment", "journal_ref", "doi", "links", "source_url"],
			supportedFilters: ["search_query", "id_list", "start", "max_results", "sortBy", "sortOrder", "all", "title", "author", "abstract", "comment",
				"journal_reference", "category", "report_number", "id", "submitted_date"],
			evidenceTypes: ["primary_document", "preprint_metadata"], operations: ["native_query", "id_lookup", "paginated_acquisition", "paper_front", "download_pdf"] },
	},
};
