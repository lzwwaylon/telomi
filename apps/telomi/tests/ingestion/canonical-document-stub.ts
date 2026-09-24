import type { FastApiDocumentParser } from "../../server/research/documents/fastapi-parser.js";

type ParseRequest = Parameters<FastApiDocumentParser["parse"]>[0];
type ParseResponse = Awaited<ReturnType<FastApiDocumentParser["parse"]>>;

/** Minimal well-formed parser response, so ingestion tests only state the text they care about. */
export function canonicalDocumentResponse(request: ParseRequest, text: string, documentId = "doc-test"): ParseResponse {
	return {
		schema_version: 2,
		document: {
			schema_name: "CanonicalDocument",
			version: 1,
			source: { filename: request.sourceName ?? "source", mimetype: request.contentType ?? null, page_count: 1 },
			nodes: [{ id: "node:1", kind: "paragraph", page: 1, text, source: { collection: "texts", index: 0, label: "text" } }],
			pages: [{ number: 1, label: null, node_ids: ["node:1"] }],
			outline: [],
			page_labels: [],
			document_notes: [],
			cleaning: {
				raw_text_nodes: 1, retained_nodes: 1, dropped_picture_text_nodes: 0,
				dropped_table_text_nodes: 0, dropped_page_furniture_nodes: 0,
				retained_page_labels: 0, retained_document_notes: 0, dropped_empty_text_nodes: 0,
				raw_table_cells: 0, retained_table_cells: 0, coordinates_removed: true, reference_graph_removed: true,
			},
			provenance: { parser: "test-parser", parser_schema_name: null, parser_schema_version: null, content_sha256: "a".repeat(64), page_range: null },
		},
		manifest: {
			schema_version: 2,
			document_id: documentId,
			content_sha256: "b".repeat(64),
			document_sha256: "c".repeat(64),
			parser: "test-parser",
			source_name: request.sourceName ?? "source",
			parse_metadata: {},
		},
	};
}
