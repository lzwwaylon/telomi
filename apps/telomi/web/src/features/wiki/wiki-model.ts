import type { ActivityProjectionItem } from "@shared/events/activity-projection";
import { uiText } from "@/app/ui-text";

export interface WikiPageSummary {
	path: string;
	title: string;
	type: string;
	description: string;
	primaryTopicRef: string;
	topicRefs: string[];
}

export interface WikiPage extends WikiPageSummary {
	content: string;
	frontmatter: WikiFrontmatterEntry[];
	sources: string[];
	evidence: WikiEvidenceEntry[];
	links: string[];
	backlinks: string[];
	missingLinks: string[];
}

export interface WikiEvidenceEntry {
	id: string;
	index: number;
	section: string;
	sectionSummary?: string;
	cue: string;
	note: string;
	source: { id: string; title: string; url: string };
	anchors: Array<{
		path: string;
		startLine: number;
		endLine: number;
		format: "markdown" | "text";
		content: string;
		assets: Array<{ sourceId: string; path: string }>;
	}>;
}

export function normalizeWikiEvidence(value: unknown): WikiEvidenceEntry[] {
	if (!Array.isArray(value)) return [];
	return value.flatMap((item) => {
		if (!item || typeof item !== "object") return [];
		const row = item as Record<string, unknown>;
		const source = row.source && typeof row.source === "object" ? row.source as Record<string, unknown> : null;
		if (typeof row.id !== "string" || typeof row.index !== "number" || typeof row.section !== "string"
			|| typeof row.cue !== "string" || typeof row.note !== "string" || !source
			|| typeof source.id !== "string" || typeof source.title !== "string" || typeof source.url !== "string") return [];
		const anchors = Array.isArray(row.anchors) ? row.anchors.flatMap((anchor) => {
			if (!anchor || typeof anchor !== "object") return [];
			const value = anchor as Record<string, unknown>;
			if (typeof value.path !== "string" || typeof value.startLine !== "number" || typeof value.endLine !== "number"
				|| !["markdown", "text"].includes(String(value.format)) || typeof value.content !== "string") return [];
			const assets = Array.isArray(value.assets) ? value.assets.flatMap((asset) => asset && typeof asset === "object"
				&& typeof (asset as Record<string, unknown>).sourceId === "string"
				&& typeof (asset as Record<string, unknown>).path === "string"
				? [{ sourceId: (asset as Record<string, string>).sourceId, path: (asset as Record<string, string>).path }] : []) : [];
			return [{ path: value.path, startLine: value.startLine, endLine: value.endLine,
				format: value.format as "markdown" | "text", content: value.content, assets }];
		}) : [];
		return [{ id: row.id, index: row.index, section: row.section,
			...(typeof row.sectionSummary === "string" ? { sectionSummary: row.sectionSummary } : {}),
			cue: row.cue, note: row.note,
			source: { id: source.id, title: source.title, url: source.url }, anchors }];
	});
}

export interface WikiFrontmatterEntry {
	key: string;
	value: string;
}

export interface WikiGraphNode {
	id: string;
	title: string;
	type: string;
	description: string;
	primaryTopicRef: string;
	topicRefs: string[];
	size: number;
	links: string[];
	backlinks: string[];
	missingLinks: string[];
	sources: string[];
	linkCount: number;
	community: number;
}

export interface WikiCommunity {
	id: number;
	nodeCount: number;
	cohesion: number;
	topNodes: string[];
}

export interface WikiGraph {
	generatedAt: string;
	types: string[];
	nodes: WikiGraphNode[];
	edges: WikiGraphEdge[];
	communities: WikiCommunity[];
}

export interface WikiGraphEdgeSignals {
	direct: number;
	sourceOverlap: number;
	adamicAdar: number;
	typeAffinity: number;
}

export interface WikiGraphEdge {
	source: string;
	target: string;
	weight: number;
	signals?: WikiGraphEdgeSignals;
}

export function edgeRelevanceLabel(edge: Pick<WikiGraphEdge, "weight" | "signals">): string {
	const total = uiText("wiki.model.relevanceValue", { value: edge.weight.toFixed(2) });
	if (!edge.signals) return total;
	return uiText("wiki.model.totalDirectDirectSourceOverlapSourceoverlapAdamicAdarAdamicadar", {
		total,
		direct: edge.signals.direct.toFixed(2),
		sourceOverlap: edge.signals.sourceOverlap.toFixed(2),
		adamicAdar: edge.signals.adamicAdar.toFixed(2),
		typeAffinity: edge.signals.typeAffinity.toFixed(2),
	});
}

export function splitSearchHighlights(text: string, query: string): Array<{ text: string; match: boolean }> {
	const terms = [...new Set(query.match(/[\p{L}\p{N}_-]+/gu)?.map((term) => term.toLocaleLowerCase()) ?? [])]
		.sort((left, right) => right.length - left.length);
	if (!text || terms.length === 0) return [{ text, match: false }];
	const pattern = new RegExp(`(${terms.map((term) => term.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")).join("|")})`, "giu");
	return text.split(pattern).filter(Boolean).map((part) => ({ text: part, match: terms.includes(part.toLocaleLowerCase()) }));
}

const EXTERNAL_SCHEME = /^[a-z][a-z\d+.-]*:/i;

export const WIKI_GRAPH_PALETTE = [
	"#4FA8F0",
	"#B6DE3E",
	"#D96FA6",
	"#A97FE0",
	"#D98A6B",
	"#3FBFA0",
	"#E0A63E",
	"#6E8FF0",
] as const;

export function colorsForWikiTypes(types: readonly string[]): Record<string, string> {
	return Object.fromEntries(types.map((type, index) => [type, WIKI_GRAPH_PALETTE[index % WIKI_GRAPH_PALETTE.length]]));
}

/** Runtime identifiers that only mean something to the Wiki builder, not to a reader. */
const INTERNAL_FRONTMATTER_KEYS = new Set(["page_id", "entry_ids", "topic_refs", "primary_topic_ref", "sources"]);

export function normalizeWikiFrontmatter(value: unknown): WikiFrontmatterEntry[] {
	if (!value || typeof value !== "object" || Array.isArray(value)) return [];
	return Object.entries(value).filter(([key]) => !INTERNAL_FRONTMATTER_KEYS.has(key)).map(([key, field]) => ({
		key,
		value: Array.isArray(field)
			? field.map(formatFrontmatterValue).join(", ")
			: formatFrontmatterValue(field),
	}));
}

function formatFrontmatterValue(value: unknown): string {
	if (value && typeof value === "object") return JSON.stringify(value);
	return String(value);
}

export function normalizeWikiPath(input: string): string | null {
	const withoutFragment = input.trim().split(/[?#]/, 1)[0]?.replace(/\\/g, "/") ?? "";
	if (!withoutFragment || EXTERNAL_SCHEME.test(withoutFragment)) return null;
	let decoded = withoutFragment;
	try {
		decoded = decodeURIComponent(withoutFragment);
	} catch {
		// Keep malformed-but-readable paths so the server remains the final validator.
	}
	const parts: string[] = [];
	for (const part of decoded.split("/")) {
		if (!part || part === ".") continue;
		if (part === "..") {
			if (parts.length === 0) return null;
			parts.pop();
			continue;
		}
		parts.push(part);
	}
	if (parts.length === 0) return null;
	const path = parts.join("/");
	return path.toLowerCase().endsWith(".md") ? path : `${path}.md`;
}

export function resolveWikiLink(currentPath: string, target: string): string | null {
	const trimmed = target.trim();
	if (!trimmed || trimmed.startsWith("#") || EXTERNAL_SCHEME.test(trimmed)) return null;
	const path = trimmed.split(/[?#]/, 1)[0] ?? "";
	const resolvedTarget = path.endsWith("/") ? `${path}index.md` : path;
	if (resolvedTarget.startsWith("/")) return normalizeWikiPath(resolvedTarget);
	const base = currentPath.split("/").slice(0, -1).join("/");
	return normalizeWikiPath(base ? `${base}/${resolvedTarget}` : resolvedTarget);
}

export function stripWikiFrontmatter(content: string): string {
	if (!content.startsWith("---\n")) return content;
	const end = content.indexOf("\n---", 4);
	if (end < 0) return content;
	const nextLine = content.indexOf("\n", end + 4);
	return nextLine < 0 ? "" : content.slice(nextLine + 1);
}

export function stripDuplicateLeadingHeading(content: string, title: string): string {
	const match = content.match(/^(?:[ \t]*\r?\n)*#\s+(.+)\r?\n(?:\r?\n)?/);
	if (!match || match[1].trim() !== title.trim()) return content;
	return content.slice(match[0].length);
}

export function plainWikiSnippet(content: string): string {
	return content
		.replace(/<!--[\s\S]*?-->/gu, " ")
		.replace(/\[\[([^\]|\n]+)(?:\|([^\]\n]*))?\]\]/gu, (_match, target: string, alias?: string) => alias?.trim() || target.trim().split("/").at(-1)!)
		.replace(/\[([^\]\n]+)\]\([^\)\n]+\)/gu, "$1")
		.replace(/`([^`\n]+)`/gu, "$1")
		.replace(/(^|\s)#{1,6}\s+/gu, " ")
		.replace(/(^|\s)[*+-]\s+/gu, " ")
		.replace(/\s+/gu, " ")
		.trim();
}

function pageSort(a: WikiPageSummary, b: WikiPageSummary): number {
	const aIndex = /(^|\/)index\.md$/i.test(a.path);
	const bIndex = /(^|\/)index\.md$/i.test(b.path);
	if (aIndex !== bIndex) return aIndex ? -1 : 1;
	return a.title.localeCompare(b.title, undefined, { numeric: true });
}

export function filterWikiPages(pages: WikiPageSummary[], query: string): WikiPageSummary[] {
	const needle = query.trim().toLocaleLowerCase();
	if (!needle) return pages;
	return pages.filter((page) =>
		[page.title, page.path, page.description, page.type]
			.join("\n")
			.toLocaleLowerCase()
			.includes(needle),
	);
}

export function wikiPageBelongsToTopic(
	page: Pick<WikiPageSummary, "primaryTopicRef" | "topicRefs">,
	topic: { id: string },
): boolean {
	return page.primaryTopicRef === topic.id
		|| page.topicRefs.includes(topic.id);
}

export function groupWikiPagesByType(pages: readonly WikiPageSummary[]): Array<{
	type: "concept" | "entity";
	pages: WikiPageSummary[];
}> {
	return (["concept", "entity"] as const).map((type) => ({
		type,
		pages: pages.filter((page) => page.type.toLocaleLowerCase() === type).sort(pageSort),
	})).filter((group) => group.pages.length > 0);
}

export function graphIdForPath(path: string): string {
	return (normalizeWikiPath(path) ?? path).replace(/\.md$/i, "");
}

export function listedWikiPages(pages: readonly WikiPageSummary[]): WikiPageSummary[] {
	return groupWikiPagesByType(pages).flatMap((group) => group.pages);
}

export function defaultWikiPage(pages: WikiPageSummary[]): string | null {
	const listed = listedWikiPages(pages);
	for (const preferred of ["quickstart.md", "index.md"]) {
		const match = listed.find((page) => page.path.toLowerCase() === preferred);
		if (match) return match.path;
	}
	return listed[0]?.path ?? null;
}

export function wikiSearchSnippetParts(content: string): Array<{ text: string; evidenceIndex?: number }> {
	return content.split(/(\[E\d+\]\(#evidence-\d+\))/gu).filter(Boolean).map((part) => {
		const citation = part.match(/^\[E(\d+)\]\(#evidence-(\d+)\)$/u);
		return citation && citation[1] === citation[2]
			? { text: `E${citation[1]}`, evidenceIndex: Number(citation[1]) }
			: { text: plainWikiSnippet(part) };
	});
}

export function wikiStatusFromActivities(
	items: readonly Pick<ActivityProjectionItem, "kind" | "lifecycle">[],
): "updating" | "rebuilding" | null {
	const active = (kind: ActivityProjectionItem["kind"]) => items.some((item) => item.kind === kind
		&& (item.lifecycle === "queued" || item.lifecycle === "running"));
	return active("wiki-update") ? "updating" : active("topic-plan") ? "rebuilding" : null;
}
