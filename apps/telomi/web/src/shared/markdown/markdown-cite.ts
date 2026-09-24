import type { Link, Parent, Root, RootContent } from "mdast";
import type { Plugin } from "unified";

import { sourceKind } from "./source-kind.js";

export interface CiteData {
	/** `ref` is a numbered Reference whose Source URL the Runtime withheld as unavailable; it has no target. */
	kind: "url" | "file" | "ref";
	target: string;
	label?: string;
	index?: number;
	lineStart?: number;
	lineEnd?: number;
	fragment?: string;
}

function encodeCiteData(data: CiteData): string {
	return encodeURIComponent(JSON.stringify(data));
}

function encodeCiteDataList(list: CiteData[]): string {
	return encodeURIComponent(JSON.stringify(list));
}

function textOf(node: { children?: unknown }): string {
	if (!Array.isArray(node.children)) return "";
	return node.children
		.map((child) => {
			if (!child || typeof child !== "object") return "";
			const value = (child as { value?: unknown }).value;
			return typeof value === "string" ? value : textOf(child as { children?: unknown });
		})
		.join("");
}

function findFirstLink(node: { children?: unknown }): Link | null {
	if (!Array.isArray(node.children)) return null;
	for (const child of node.children) {
		if (!child || typeof child !== "object") continue;
		if ((child as { type?: unknown }).type === "link") return child as Link;
		const nested = findFirstLink(child as { children?: unknown });
		if (nested) return nested;
	}
	return null;
}

function referenceLabels(tree: Root): Map<number, string> {
	const labels = new Map<number, string>();
	const headingIndex = tree.children.findIndex((node) =>
		node.type === "heading" &&
		/^(references|参考文献|参考资料)$/iu.test(textOf(node).trim()));
	if (headingIndex < 0) return labels;

	const list = tree.children.slice(headingIndex + 1).find((node) => node.type === "list");
	if (!list || list.type !== "list" || !list.ordered) return labels;

	const start = list.start ?? 1;
	for (let i = 0; i < list.children.length; i++) {
		const item = list.children[i]!;
		const link = findFirstLink(item);
		// Unavailable Sources are listed as plain text, so fall back to the item text.
		const label = (link ? textOf(link) : textOf(item)).trim();
		if (label) labels.set(start + i, label);
	}
	return labels;
}

/** Placeholder node for a linkless `[[n]]` citation split out of a text node. */
interface BareCitationNode {
	type: "piBareCitation";
	index: number;
}

const BARE_CITATION = /\[\[(\d+)\]\]/gu;

/**
 * The Runtime writes `[[n]]` without a link when the Source URL is unavailable. Markdown parses
 * that as plain text, so split it into placeholder nodes that group into chips like linked citations.
 */
function splitBareCitations(parent: Parent): void {
	parent.children = parent.children.flatMap((child): RootContent[] => {
		if (child.type !== "text" || !BARE_CITATION.test(child.value)) return [child];
		BARE_CITATION.lastIndex = 0;
		const nodes: RootContent[] = [];
		let last = 0;
		for (const match of child.value.matchAll(BARE_CITATION)) {
			if (match.index > last) nodes.push({ type: "text", value: child.value.slice(last, match.index) });
			nodes.push({ type: "piBareCitation", index: Number(match[1]) } as BareCitationNode as unknown as RootContent);
			last = match.index + match[0].length;
		}
		if (last < child.value.length) nodes.push({ type: "text", value: child.value.slice(last) });
		return nodes;
	});
}

function indexedCitation(node: RootContent, labels: Map<number, string>): CiteData | null {
	if ((node as { type: string }).type === "piBareCitation") {
		const index = (node as unknown as BareCitationNode).index;
		return { kind: "ref", target: "", label: labels.get(index), index };
	}
	if (node.type !== "link") return null;
	const match = /^\[(\d+)\]$/u.exec(textOf(node));
	if (!match) return null;

	let url: URL;
	try {
		url = new URL(node.url);
	} catch {
		return null;
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") return null;

	const index = Number(match[1]);
	const fragment = url.hash.length > 1 ? url.hash.slice(1) : undefined;
	url.hash = "";
	return {
		kind: "url",
		target: url.toString(),
		label: labels.get(index),
		index,
		fragment,
	};
}

const CITATION_GAP = /^[\s,;、，；]*$/u;

function transformParent(parent: Parent, labels: Map<number, string>): void {
	for (const child of parent.children) {
		if ("children" in child && Array.isArray(child.children)) {
			transformParent(child as Parent, labels);
		}
	}
	splitBareCitations(parent);

	for (let i = 0; i < parent.children.length; i++) {
		const first = indexedCitation(parent.children[i], labels);
		if (!first) continue;

		const citations = [first];
		let end = i + 1;
		while (end < parent.children.length) {
			const next = indexedCitation(parent.children[end], labels);
			if (next) {
				citations.push(next);
				end++;
				continue;
			}
			const gap = parent.children[end];
			if (
				gap.type === "text" &&
				CITATION_GAP.test(gap.value) &&
				end + 1 < parent.children.length &&
				indexedCitation(parent.children[end + 1], labels)
			) {
				end++;
				continue;
			}
			break;
		}

		const value = citations.length === 1
			? `<span data-pi-cite="${encodeCiteData(citations[0])}"></span>`
			: `<span data-pi-cites="${encodeCiteDataList(citations)}"></span>`;
		parent.children.splice(i, end - i, { type: "html", value });
	}
}

/**
 * Ordered-list items that open with an http(s) link list Sources, like the Runtime References
 * section, which chat block splitting separates from its heading. Each gets a site icon placeholder.
 */
function markSourceListItems(parent: Parent): void {
	for (const child of parent.children) {
		if (child.type === "list" && child.ordered) {
			for (const item of child.children) {
				const paragraph = item.children[0];
				if (paragraph?.type !== "paragraph" || paragraph.children[0]?.type !== "link") continue;
				const kind = sourceKind(paragraph.children[0].url);
				if (kind) paragraph.children.unshift({ type: "html", value: `<span data-pi-source="${kind}"></span>` });
			}
		}
		if ("children" in child && Array.isArray(child.children)) markSourceListItems(child as Parent);
	}
}

export function transformIndexedCitations(tree: Root): void {
	transformParent(tree, referenceLabels(tree));
	markSourceListItems(tree);
}

export const remarkIndexedCitations: Plugin<[], Root> = () => transformIndexedCitations;

export function citeKey(data: CiteData): string {
	if (data.kind === "file") {
		const start = data.lineStart ?? "";
		const end = data.lineEnd ?? "";
		return `file:${data.target}:${start}-${end}`;
	}
	if (data.kind === "ref") return `ref:${data.index ?? ""}`;
	return `url:${data.target}#${data.fragment ?? ""}:${data.index ?? ""}`;
}

function coerceCiteData(raw: unknown): CiteData | null {
	if (!raw || typeof raw !== "object") return null;
	const value = raw as Record<string, unknown>;
	if (value.kind !== "url" && value.kind !== "file" && value.kind !== "ref") return null;
	if (typeof value.target !== "string" || (!value.target && value.kind !== "ref")) return null;
	return {
		kind: value.kind,
		target: value.target,
		label: typeof value.label === "string" && value.label.trim() ? value.label : undefined,
		index: typeof value.index === "number" ? value.index : undefined,
		lineStart: typeof value.lineStart === "number" ? value.lineStart : undefined,
		lineEnd: typeof value.lineEnd === "number" ? value.lineEnd : undefined,
		fragment: typeof value.fragment === "string" ? value.fragment : undefined,
	};
}

export function decodeCiteData(encoded: string): CiteData | null {
	try {
		return coerceCiteData(JSON.parse(decodeURIComponent(encoded)));
	} catch {
		return null;
	}
}

export function decodeCiteDataList(encoded: string): CiteData[] | null {
	try {
		const raw = JSON.parse(decodeURIComponent(encoded));
		if (!Array.isArray(raw)) return null;
		return raw.flatMap((item) => {
			const citation = coerceCiteData(item);
			return citation ? [citation] : [];
		});
	} catch {
		return null;
	}
}
