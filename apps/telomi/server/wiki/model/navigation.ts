import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { isRecord } from "../../lib/values.js";
import type { WikiNode } from "./graph.js";

export interface WikiSection {
	id: string;
	heading: string;
	anchor: string;
	topicRefs: string[];
}

/** Canonical page identities retain the authored direction, independently of graph layout. */
export interface WikiRelation { from: string; to: string; label: string }

async function optionalJson(root: string, name: string): Promise<unknown> {
	try { return JSON.parse(await readFile(join(root, name), "utf8")); }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

function text(value: unknown): value is string { return typeof value === "string" && Boolean(value.trim()); }
function invalid(message: string): never { throw new Error(`Invalid Wiki navigation: ${message}`); }

/** Project navigation onto a single Edition without rewriting any authored Markdown. */
export async function readWikiNavigation(root: string, nodes: WikiNode[]): Promise<WikiRelation[]> {
	const byPageId = new Map<string, WikiNode>();
	for (const node of nodes) {
		if (byPageId.has(node.pageId)) invalid(`duplicate page identity ${node.pageId}`);
		byPageId.set(node.pageId, node);
	}
	const [index, storedRelations] = await Promise.all([
		optionalJson(root, ".topic-index.json"), optionalJson(root, ".object-first-relations.json"),
	]);
	if (index !== undefined) {
		if (!isRecord(index) || index.schema_version !== 1 || !Array.isArray(index.sections) || !Array.isArray(index.topics)) invalid("invalid Topic index");
		// A present index is authoritative, including empty membership. Never revive stale frontmatter.
		for (const node of nodes) { node.topicRefs = []; node.primaryTopicRef = ""; }
		const sections = new Map<string, { section: WikiSection; page: WikiNode }>();
		for (const row of index.sections) {
			if (!isRecord(row) || !text(row.ref) || !text(row.pageId) || !text(row.heading) || !text(row.anchor)) invalid("invalid section");
			const page = byPageId.get(row.pageId);
			if (!page || sections.has(row.ref) || page.sections.some(section => section.anchor === row.anchor)) invalid(`unresolved or duplicate section ${row.ref}`);
			const section = { id: row.ref, heading: row.heading, anchor: row.anchor, topicRefs: [] as string[] };
			page.sections.push(section);
			sections.set(row.ref, { section, page });
		}
		const topicIds = new Set<string>();
		for (const topic of index.topics) {
			if (!isRecord(topic) || !text(topic.topicId) || topicIds.has(topic.topicId) || !Array.isArray(topic.sections)) invalid("invalid Topic membership");
			topicIds.add(topic.topicId);
			for (const id of topic.sections) {
				if (!text(id) || !sections.has(id)) invalid(`unknown Topic section ${String(id)}`);
				const { section, page } = sections.get(id)!;
				if (!section.topicRefs.includes(topic.topicId)) section.topicRefs.push(topic.topicId);
				if (!page.topicRefs.includes(topic.topicId)) page.topicRefs.push(topic.topicId);
			}
		}
	}
	if (storedRelations === undefined) return [];
	if (!Array.isArray(storedRelations)) invalid("relationships must be an array");
	const seen = new Set<string>();
	return storedRelations.flatMap(row => {
		if (!isRecord(row) || !text(row.from) || !text(row.to) || !text(row.label)) invalid("invalid relationship");
		if (!byPageId.has(row.from) || !byPageId.has(row.to) || row.from === row.to) invalid("relationship has an unknown or identical endpoint");
		const key = JSON.stringify([row.from, row.to, row.label]);
		if (seen.has(key)) return [];
		seen.add(key);
		return [{ from: row.from, to: row.to, label: row.label }];
	});
}
