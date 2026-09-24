import { isAbsolute } from "node:path";

import { sha256, stableJson } from "../../lib/hash.js";

export type CanonicalDocumentNodeKind =
	| "heading"
	| "paragraph"
	| "list_item"
	| "table"
	| "figure"
	| "formula"
	| "code";

export interface CanonicalDocumentTableCell {
	row: number;
	column: number;
	row_span: number;
	column_span: number;
	text: string;
	role?: "column_header" | "row_header" | "row_section";
}

export interface CanonicalDocumentFigureContent {
	id: string;
	kind: Exclude<CanonicalDocumentNodeKind, "table" | "figure">;
	page: number | null;
	text: string;
	level?: number;
	depth?: number;
	source: {
		collection: string;
		index: number;
		label: string;
	};
}

export interface CanonicalDocumentNode {
	id: string;
	kind: CanonicalDocumentNodeKind;
	page: number | null;
	text?: string;
	level?: number;
	depth?: number;
	captions?: string[];
	content?: CanonicalDocumentFigureContent[];
	asset_path?: string;
	row_count?: number;
	column_count?: number;
	cells?: CanonicalDocumentTableCell[];
	source: {
		collection: string;
		index: number;
		label: string;
	};
}

export interface CanonicalDocumentTimeline {
	duration_ms?: number;
	chapters: Array<{
		node_id: string;
		start_ms: number;
		end_ms: number;
	}>;
	segments: Array<{
		node_id: string;
		start_ms: number;
		end_ms: number;
		chapter_node_id?: string;
	}>;
}

export interface CanonicalDocument {
	schema_name: "CanonicalDocument";
	version: 1;
	source: {
		filename: string;
		mimetype: string | null;
		page_count: number;
	};
	nodes: CanonicalDocumentNode[];
	pages: Array<{
		number: number;
		label: string | null;
		node_ids: string[];
	}>;
	outline: Array<{
		node_id: string;
		level: number;
		title: string;
		parent_node_id: string | null;
	}>;
	page_labels: Array<{ page: number | null; text: string }>;
	document_notes: Array<{
		label: "page_header" | "page_footer";
		page: number | null;
		text: string;
	}>;
	cleaning: {
		raw_text_nodes: number;
		retained_nodes: number;
		retained_picture_text_nodes?: number;
		dropped_picture_text_nodes: number;
		dropped_table_text_nodes: number;
		dropped_page_furniture_nodes: number;
		retained_page_labels: number;
		retained_document_notes: number;
		dropped_empty_text_nodes: number;
		raw_table_cells: number;
		retained_table_cells: number;
		coordinates_removed: true;
		reference_graph_removed: true;
	};
	provenance: {
		parser: string;
		parser_schema_name: string | null;
		parser_schema_version: string | null;
		content_sha256: string;
		page_range: [number, number] | null;
	};
	timeline?: CanonicalDocumentTimeline;
}

export function parseCanonicalDocument(value: unknown): CanonicalDocument {
	const document = requireRecord(value, "Canonical document");
	if (document.schema_name !== "CanonicalDocument" || document.version !== 1) {
		throw new Error("Canonical document must use CanonicalDocument version 1");
	}
	const source = requireRecord(document.source, "Canonical document source");
	if (typeof source.filename !== "string"
		|| (source.mimetype !== null && typeof source.mimetype !== "string")
		|| !isNonNegativeInteger(source.page_count)) {
		throw new Error("Canonical document source is invalid");
	}
	const nodes = requireArray(document.nodes, "Canonical document nodes");
	const nodeIds = new Set<string>();
	const nodeKinds = new Map<string, CanonicalDocumentNodeKind>();
	const allIds = new Set<string>();
	for (const [index, rawNode] of nodes.entries()) {
		const node = requireRecord(rawNode, `Canonical document node ${index}`);
		if (typeof node.id !== "string" || !node.id || allIds.has(node.id)) {
			throw new Error(`Canonical document node ${index} has an invalid or duplicate id`);
		}
		nodeIds.add(node.id);
		allIds.add(node.id);
		if (typeof node.kind !== "string" || !CANONICAL_NODE_KINDS.has(node.kind as CanonicalDocumentNodeKind)) {
			throw new Error(`Canonical document node ${index} has an invalid kind`);
		}
		nodeKinds.set(node.id, node.kind as CanonicalDocumentNodeKind);
		if (node.page !== null && !isNonNegativeInteger(node.page)) {
			throw new Error(`Canonical document node ${index} has an invalid page`);
		}
		if (node.text !== undefined && typeof node.text !== "string") {
			throw new Error(`Canonical document node ${index} has invalid text`);
		}
		if (node.content !== undefined) {
			if (node.kind !== "figure") {
				throw new Error(`Canonical document node ${index} has content but is not a figure`);
			}
			for (const [contentIndex, rawContent] of requireArray(
				node.content,
				`Canonical document figure ${index} content`,
			).entries()) {
				const content = requireRecord(rawContent, `Canonical document figure ${index} content ${contentIndex}`);
				if (typeof content.id !== "string" || !content.id || allIds.has(content.id)) {
					throw new Error(`Canonical document figure ${index} content ${contentIndex} has an invalid or duplicate id`);
				}
				allIds.add(content.id);
				if (typeof content.kind !== "string"
					|| !CANONICAL_TEXT_NODE_KINDS.has(content.kind as CanonicalDocumentFigureContent["kind"])
					|| (content.page !== null && !isNonNegativeInteger(content.page))
					|| typeof content.text !== "string"
					|| !content.text.trim()) {
					throw new Error(`Canonical document figure ${index} content ${contentIndex} is invalid`);
				}
				requireRecord(content.source, `Canonical document figure ${index} content ${contentIndex} source`);
			}
		}
		if (node.asset_path !== undefined
			&& (node.kind !== "figure" || !isSafeRelativeAssetPath(node.asset_path))) {
			throw new Error(`Canonical document node ${index} has an invalid asset path`);
		}
		requireRecord(node.source, `Canonical document node ${index} source`);
	}
	const pages = requireArray(document.pages, "Canonical document pages");
	for (const [index, rawPage] of pages.entries()) {
		const page = requireRecord(rawPage, `Canonical document page ${index}`);
		if (!isNonNegativeInteger(page.number)
			|| (page.label !== null && typeof page.label !== "string")
			|| !Array.isArray(page.node_ids)
			|| page.node_ids.some((id) => typeof id !== "string" || !nodeIds.has(id))) {
			throw new Error(`Canonical document page ${index} is invalid`);
		}
	}
	requireArray(document.outline, "Canonical document outline");
	requireArray(document.page_labels, "Canonical document page labels");
	requireArray(document.document_notes, "Canonical document notes");
	const cleaning = requireRecord(document.cleaning, "Canonical document cleaning audit");
	if (cleaning.coordinates_removed !== true || cleaning.reference_graph_removed !== true) {
		throw new Error("Canonical document must remove coordinates and the parser reference graph");
	}
	if (cleaning.retained_picture_text_nodes !== undefined
		&& !isNonNegativeInteger(cleaning.retained_picture_text_nodes)) {
		throw new Error("Canonical document has an invalid retained picture text count");
	}
	const provenance = requireRecord(document.provenance, "Canonical document provenance");
	if (typeof provenance.parser !== "string"
		|| typeof provenance.content_sha256 !== "string"
		|| !/^[a-f0-9]{64}$/u.test(provenance.content_sha256)) {
		throw new Error("Canonical document provenance is invalid");
	}
	if (document.timeline !== undefined) validateTimeline(document.timeline, nodeIds, nodeKinds);
	return value as CanonicalDocument;
}

function validateTimeline(
	value: unknown,
	nodeIds: Set<string>,
	nodeKinds: Map<string, CanonicalDocumentNodeKind>,
): void {
	const timeline = requireRecord(value, "Canonical document timeline");
	if (timeline.duration_ms !== undefined && !isNonNegativeInteger(timeline.duration_ms)) {
		throw new Error("Canonical document timeline duration is invalid");
	}
	const chapterNodes = new Set<string>();
	for (const [index, rawChapter] of requireArray(timeline.chapters, "Canonical document timeline chapters").entries()) {
		const chapter = requireRecord(rawChapter, `Canonical document timeline chapter ${index}`);
		if (
			typeof chapter.node_id !== "string"
			|| !nodeIds.has(chapter.node_id)
			|| nodeKinds.get(chapter.node_id) !== "heading"
			|| chapterNodes.has(chapter.node_id)
			|| !validTimeRange(chapter)
		) {
			throw new Error(`Canonical document timeline chapter ${index} is invalid`);
		}
		chapterNodes.add(chapter.node_id);
	}
	const segmentNodes = new Set<string>();
	for (const [index, rawSegment] of requireArray(timeline.segments, "Canonical document timeline segments").entries()) {
		const segment = requireRecord(rawSegment, `Canonical document timeline segment ${index}`);
		if (
			typeof segment.node_id !== "string"
			|| !nodeIds.has(segment.node_id)
			|| nodeKinds.get(segment.node_id) !== "paragraph"
			|| segmentNodes.has(segment.node_id)
			|| !validTimeRange(segment)
			|| (segment.chapter_node_id !== undefined
				&& (typeof segment.chapter_node_id !== "string" || !chapterNodes.has(segment.chapter_node_id)))
		) {
			throw new Error(`Canonical document timeline segment ${index} is invalid`);
		}
		segmentNodes.add(segment.node_id);
	}
}

function validTimeRange(value: Record<string, unknown>): boolean {
	return isNonNegativeInteger(value.start_ms)
		&& isNonNegativeInteger(value.end_ms)
		&& value.end_ms >= value.start_ms;
}

export function canonicalDocumentSha256(document: CanonicalDocument): string {
	return sha256(stableJson(document, "lexical"));
}

export function renderCanonicalDocumentMarkdown(document: CanonicalDocument): string {
	const parts: string[] = [];
	for (const node of document.nodes) {
		const text = node.text?.trim() ?? "";
		if (node.kind === "heading" && text) {
			parts.push(`${"#".repeat(Math.min(6, Math.max(1, node.level ?? 1)))} ${text}`);
		} else if (node.kind === "list_item" && text) {
			parts.push(`${"  ".repeat(Math.min(12, Math.max(0, node.depth ?? 0)))}- ${text}`);
		} else if (node.kind === "formula" && text) {
			parts.push(`$$\n${text}\n$$`);
		} else if (node.kind === "code" && text) {
			parts.push(`\`\`\`\n${text}\n\`\`\``);
		} else if (node.kind === "table") {
			parts.push(...(node.captions ?? []).map((caption) => caption.trim()).filter(Boolean));
			const table = renderTable(node);
			if (table) parts.push(table);
		} else if (node.kind === "figure") {
			const captions = (node.captions ?? []).map((caption) => caption.trim()).filter(Boolean);
			const content = (node.content ?? []).map((item) => item.text.trim()).filter(Boolean);
			parts.push(...captions);
			if (node.asset_path) parts.push(`![${markdownAlt(captions[0] ?? "Source figure")}](${node.asset_path})`);
			if (content.length > 0) parts.push(content.join("\n"));
			else if (captions.length === 0 && text) parts.push(text);
		} else if (text) {
			parts.push(text);
		}
	}
	return parts.join("\n\n").trim();
}

function isSafeRelativeAssetPath(value: unknown): value is string {
	if (typeof value !== "string" || !value || value.length > 1_000 || isAbsolute(value) || value.includes("\0")) return false;
	return !value.replaceAll("\\", "/").split("/").some((part) => !part || part === "." || part === "..");
}

function markdownAlt(value: string): string {
	return value.replace(/[\[\]\\]/gu, " ").trim();
}


function renderTable(node: CanonicalDocumentNode): string {
	const rowCount = node.row_count ?? 0;
	const columnCount = node.column_count ?? 0;
	if (rowCount <= 0 || columnCount <= 0) return "";
	const rows = Array.from({ length: rowCount }, () => Array.from({ length: columnCount }, () => ""));
	for (const cell of node.cells ?? []) {
		if (cell.row < 0 || cell.row >= rowCount || cell.column < 0 || cell.column >= columnCount) continue;
		rows[cell.row]![cell.column] = cell.text.replace(/\|/gu, "\\|").replace(/\n/gu, " ");
	}
	return [
		`| ${rows[0]!.join(" | ")} |`,
		`| ${rows[0]!.map(() => "---").join(" | ")} |`,
		...rows.slice(1).map((row) => `| ${row.join(" | ")} |`),
	].join("\n");
}

function requireArray(value: unknown, description: string): unknown[] {
	if (!Array.isArray(value)) throw new Error(`${description} must be an array`);
	return value;
}

function requireRecord(value: unknown, description: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${description} must be an object`);
	return value as Record<string, unknown>;
}

function isNonNegativeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

const CANONICAL_NODE_KINDS = new Set<CanonicalDocumentNodeKind>([
	"heading",
	"paragraph",
	"list_item",
	"table",
	"figure",
	"formula",
	"code",
]);

const CANONICAL_TEXT_NODE_KINDS = new Set<CanonicalDocumentFigureContent["kind"]>([
	"heading",
	"paragraph",
	"list_item",
	"formula",
	"code",
]);
