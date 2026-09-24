import assert from "node:assert/strict";

import {
	canonicalDocumentSha256,
	parseCanonicalDocument,
	renderCanonicalDocumentMarkdown,
	type CanonicalDocument,
} from "../../server/research/documents/canonical-document.js";

const canonical: CanonicalDocument = {
	schema_name: "CanonicalDocument",
	version: 1,
	source: {
		filename: "paper.pdf",
		mimetype: "application/pdf",
		page_count: 2,
	},
	nodes: [
		{
			id: "node:text:0",
			kind: "heading",
			page: 1,
			text: "Methods",
			level: 1,
			source: { collection: "texts", index: 0, label: "section_header" },
		},
		{
			id: "node:text:1",
			kind: "paragraph",
			page: 1,
			text: "The retained body paragraph.",
			source: { collection: "texts", index: 1, label: "text" },
		},
		{
			id: "node:figure:0",
			kind: "figure",
			page: 1,
			captions: ["Figure 1: Overview."],
			asset_path: "assets/figure-p0001-0001.png",
			content: [
				{
					id: "node:text:2",
					kind: "paragraph",
					page: 1,
					text: "2,014,000 Unique Skills",
					source: { collection: "texts", index: 2, label: "text" },
				},
			],
			source: { collection: "pictures", index: 0, label: "picture" },
		},
		{
			id: "node:table:0",
			kind: "table",
			page: 2,
			captions: ["Table 1: Results."],
			row_count: 2,
			column_count: 2,
			cells: [
				{ row: 0, column: 0, row_span: 1, column_span: 2, text: "Metric", role: "column_header" },
				{ row: 1, column: 0, row_span: 1, column_span: 1, text: "Accuracy", role: "row_header" },
				{ row: 1, column: 1, row_span: 1, column_span: 1, text: "95" },
			],
			source: { collection: "tables", index: 0, label: "table" },
		},
	],
	pages: [
		{ number: 1, label: "1", node_ids: ["node:text:0", "node:text:1", "node:figure:0"] },
		{ number: 2, label: "2", node_ids: ["node:table:0"] },
	],
	outline: [{ node_id: "node:text:0", level: 1, title: "Methods", parent_node_id: null }],
	page_labels: [{ page: 1, text: "1" }, { page: 2, text: "2" }],
	document_notes: [{ label: "page_header", page: 1, text: "arXiv:1234 [cs] 1 Jan 2026" }],
	cleaning: {
		raw_text_nodes: 6,
		retained_nodes: 4,
		retained_picture_text_nodes: 1,
		dropped_picture_text_nodes: 0,
		dropped_table_text_nodes: 1,
		dropped_page_furniture_nodes: 0,
		retained_page_labels: 2,
		retained_document_notes: 1,
		dropped_empty_text_nodes: 0,
		raw_table_cells: 3,
		retained_table_cells: 3,
		coordinates_removed: true,
		reference_graph_removed: true,
	},
	provenance: {
		parser: "docling",
		parser_schema_name: "DoclingDocument",
		parser_schema_version: "1.10.0",
		content_sha256: "a".repeat(64),
		page_range: [1, 2],
	},
};

assert.deepEqual(parseCanonicalDocument(JSON.parse(JSON.stringify(canonical))), canonical);
assert.equal(canonicalDocumentSha256(canonical).length, 64);
assert.equal(renderCanonicalDocumentMarkdown(canonical), [
	"# Methods",
	"The retained body paragraph.",
	"Figure 1: Overview.",
	"![Figure 1: Overview.](assets/figure-p0001-0001.png)",
	"2,014,000 Unique Skills",
	"Table 1: Results.",
	"| Metric |  |",
	"| --- | --- |",
	"| Accuracy | 95 |",
].join("\n\n").replace("| Metric |  |\n\n| --- | --- |\n\n| Accuracy | 95 |", "| Metric |  |\n| --- | --- |\n| Accuracy | 95 |"));

const serialized = JSON.stringify(canonical);
for (const forbidden of ["bbox", "coord_origin", "charspan", '"$ref"', "binary_hash"]) {
	assert.equal(serialized.includes(forbidden), false, `Canonical document leaked '${forbidden}'`);
}

assert.throws(
	() => parseCanonicalDocument({ ...canonical, cleaning: { coordinates_removed: false } }),
	/remove coordinates/,
);
assert.throws(
	() => parseCanonicalDocument({ ...canonical, nodes: [{ ...canonical.nodes[2], asset_path: "../escape.png" }] }),
	/invalid asset path/,
);

console.log("canonical document tests passed");
