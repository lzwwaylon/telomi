import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

import type { AgentTool } from "@earendil-works/pi-agent-core";

import { CONTROL_MARKDOWN } from "../../wiki/model/files.js";
import { splitFrontmatter } from "../../wiki/model/frontmatter.js";
import type { PublishedArtifactDirectoryRef } from "../../agent-runtime/artifact-store.js";

interface WikiEvidenceAnchor {
	path: string;
	startLine: number;
	endLine: number;
	format: "markdown" | "text";
	content: string;
	assets: Array<{ sourceId: string; path: string }>;
}

interface WikiEvidence {
	id: string;
	index: number;
	section: string;
	sectionSummary?: string;
	cue: string;
	note: string;
	source: { id: string; title: string; url: string };
	anchors: WikiEvidenceAnchor[];
}

export interface ResolvedWikiReportCitation {
	ref: string;
	page: { ref: string; path: string; title: string; type: string; content: string };
	entry: WikiEvidence;
	evidence: WikiEvidence[];
}

export interface WikiReportReferenceAdapter {
	tools: AgentTool[];
	pageRefs: string[];
	resolvePageRef(ref: string): string;
	hydrateCitationRefs(refs: readonly string[], signal?: AbortSignal): Promise<void>;
	resolveCitationRef(ref: string): ResolvedWikiReportCitation;
}

/** Agent-facing short refs over one immutable Wiki snapshot. */
export function createWikiReportReferenceAdapter(
	knowledge: PublishedArtifactDirectoryRef,
	tools: readonly AgentTool[],
): WikiReportReferenceAdapter {
	return createWikiReferenceAdapter(knowledge.files
		.map((file) => file.relativePath)
		.filter((path) => path.startsWith("wiki/") && path.endsWith(".md"))
		.sort()
		.map((path) => ({ path, absolutePath: join(knowledge.absolutePath, path) })), tools);
}

/** Main Agent short refs over the currently pinned Goal Wiki edition. */
export function createWikiReferenceAdapterFromRoot(
	knowledgeRoot: string,
	tools: readonly AgentTool[],
): WikiReportReferenceAdapter {
	const files: string[] = [];
	const visit = (directory: string): void => {
		for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
			if (entry.name.startsWith(".")) continue;
			const path = join(directory, entry.name);
			if (entry.isDirectory()) visit(path);
			else if (entry.isFile() && entry.name.endsWith(".md") && !CONTROL_MARKDOWN.has(entry.name)) files.push(path);
		}
	};
	visit(knowledgeRoot);
	return createWikiReferenceAdapter(files.map((absolutePath) => ({
		absolutePath,
		path: `wiki/${relative(knowledgeRoot, absolutePath).replaceAll("\\", "/")}`,
	})), tools);
}

function createWikiReferenceAdapter(
	pageFiles: readonly { path: string; absolutePath: string }[],
	tools: readonly AgentTool[],
): WikiReportReferenceAdapter {
	const pages = [...pageFiles].sort((left, right) => left.path.localeCompare(right.path))
		.map((page, index) => ({ ...page, ref: `P${index + 1}` }));
	const pageByRef = new Map(pages.map((page) => [page.ref, page]));
	const pageByPath = new Map(pages.map((page) => [page.path, page]));
	const pageById = new Map(pages.map((page) => [page.path.replace(/^wiki\//u, "").replace(/\.md$/u, ""), page]));
	const citationRefByPageEntry = new Map<string, string>();
	const citationTargetByRef = new Map<string, { pageRef: string; entryId: string }>();
	let citationIndex = 0;
	for (const page of pages) {
		const content = readFileSync(page.absolutePath, "utf-8");
		const fields = splitFrontmatter(content).fields;
		for (const entryId of Array.isArray(fields?.entry_ids)
			? fields.entry_ids.filter((value): value is string => typeof value === "string")
			: []) {
			const ref = `C${++citationIndex}`;
			citationRefByPageEntry.set(`${page.path}\0${entryId}`, ref);
			citationTargetByRef.set(ref, { pageRef: page.ref, entryId });
		}
	}
	const resolvedCitations = new Map<string, ResolvedWikiReportCitation>();

	const resolvePageRef = (ref: string): string => {
		const page = pageByRef.get(ref);
		if (!page) throw new Error(`unknown Wiki Page ref '${ref}'`);
		return page.path;
	};
	const projectPageRef = (value: string): string => {
		const normalized = value.startsWith("wiki/")
			? value.endsWith(".md") ? value : `${value}.md`
			: `wiki/${value.endsWith(".md") ? value : `${value}.md`}`;
		return pageByPath.get(normalized)?.ref ?? pageById.get(value.replace(/^wiki\//u, "").replace(/\.md$/u, ""))?.ref ?? value;
	};
	const projectSummary = (value: unknown): unknown => {
		if (!value || typeof value !== "object" || Array.isArray(value)) return value;
		const record = value as Record<string, unknown>;
		const path = typeof record.path === "string" ? record.path : undefined;
		const id = typeof record.id === "string" ? record.id : undefined;
		const page = path ? pageByPath.get(path) : id ? pageById.get(id) : undefined;
		const { path: _path, id: _id, knowledgeContext, graphRelatedTo, ...rest } = record;
		return {
			...rest,
			...(page ? { page_ref: page.ref } : {}),
			...(!path || page ? {} : { path }),
			...(!id || page ? {} : { id }),
			...(knowledgeContext ? { knowledgeContext: projectSummary(knowledgeContext) } : {}),
			...(Array.isArray(graphRelatedTo)
				? { graphRelatedTo: graphRelatedTo.map((item) => typeof item === "string" ? projectPageRef(item) : item) }
				: {}),
			...(Array.isArray(record.outgoingLinks)
				? { outgoingLinks: record.outgoingLinks.map((item) => typeof item === "string" ? projectPageRef(item) : item) }
				: {}),
			...(Array.isArray(record.backlinks)
				? { backlinks: record.backlinks.map((item) => typeof item === "string" ? projectPageRef(item) : item) }
				: {}),
		};
	};
	const projectToolResult = (toolName: string, value: unknown, requestedRef?: string): unknown => {
		const record = requireRecord(value, `${toolName} result`);
		if (toolName === "wiki_search") {
			return { ...record, results: Array.isArray(record.results) ? record.results.map(projectSummary) : [] };
		}
		if (toolName === "wiki_graph_search") {
			return {
				...record,
				seeds: Array.isArray(record.seeds) ? record.seeds.map(projectSummary) : [],
				nodes: Array.isArray(record.nodes) ? record.nodes.map(projectSummary) : [],
				edges: Array.isArray(record.edges) ? record.edges.map((edge) => {
					if (!edge || typeof edge !== "object" || Array.isArray(edge)) return edge;
					const value = edge as Record<string, unknown>;
					return {
						...value,
						...(typeof value.source === "string" ? { source: projectPageRef(value.source) } : {}),
						...(typeof value.target === "string" ? { target: projectPageRef(value.target) } : {}),
					};
				}) : [],
			};
		}
		const path = resolvePageRef(requestedRef!);
		const page = pageByRef.get(requestedRef!)!;
		const title = requireString(record.title, "Wiki Page title");
		const type = requireString(record.type, "Wiki Page type");
		const content = requireString(record.content, "Wiki Page content");
		const pageEvidence = Array.isArray(record.evidence) ? record.evidence as WikiEvidence[] : [];
		const evidence = pageEvidence.map((entry) => {
			const citeRef = citationRefByPageEntry.get(`${path}\0${entry.id}`);
			if (!citeRef) throw new Error(`Wiki Page ref '${requestedRef}' returned unknown Entry '${entry.id}'`);
			resolvedCitations.set(citeRef, {
				ref: citeRef,
				page: { ref: page.ref, path, title, type, content },
				entry,
				// ponytail: duplicate one Page's Evidence per cited ref; normalize final.json only if report artifacts grow measurably.
				evidence: pageEvidence,
			});
			return {
				cite_ref: citeRef,
				index: entry.index,
				section: entry.section,
				...(entry.sectionSummary ? { sectionSummary: entry.sectionSummary } : {}),
				cue: entry.cue,
				note: entry.note,
				source: { title: entry.source.title },
				anchors: entry.anchors,
			};
		});
		const { path: _path, frontmatter: _frontmatter, evidence: _evidence, links, backlinks, knowledgeContext, ...rest } = record;
		return {
			...rest,
			page_ref: page.ref,
			evidence,
			...(Array.isArray(links) ? { links: links.map((item) => typeof item === "string" ? projectPageRef(item) : item) } : {}),
			...(Array.isArray(backlinks) ? { backlinks: backlinks.map((item) => typeof item === "string" ? projectPageRef(item) : item) } : {}),
			...(knowledgeContext ? { knowledgeContext: projectSummary(knowledgeContext) } : {}),
		};
	};
	const adaptedTools = tools.map((tool): AgentTool => ({
		...tool,
		execute: async (toolCallId, args, signal, onUpdate) => {
			const requestedRef = tool.name === "wiki_read_page"
				? requireString((args as { path?: unknown }).path, "Wiki Page ref")
				: undefined;
			const rawArgs = requestedRef ? { ...(args as Record<string, unknown>), path: resolvePageRef(requestedRef) } : args;
			const result = await tool.execute(toolCallId, rawArgs, signal, onUpdate);
			const raw = result.details ?? JSON.parse(result.content[0]?.type === "text" ? result.content[0].text : "{}");
			const details = projectToolResult(tool.name, raw, requestedRef);
			return { ...result, details, content: [{ type: "text", text: JSON.stringify(details, null, 2) }] };
		},
	}));

	return {
		tools: adaptedTools,
		pageRefs: pages.map((page) => page.ref),
		resolvePageRef,
		async hydrateCitationRefs(refs, signal) {
			const read = tools.find((tool) => tool.name === "wiki_read_page");
			if (!read) throw new Error("Wiki Report short refs require wiki_read_page");
			const pageRefs = [...new Set(refs.filter((ref) => !resolvedCitations.has(ref)).map((ref) => {
				const target = citationTargetByRef.get(ref);
				if (!target) throw new Error(`unknown Wiki Citation ref '${ref}'`);
				return target.pageRef;
			}))];
			for (const pageRef of pageRefs) {
				const raw = await read.execute("wiki-report-ref-hydrate", { path: resolvePageRef(pageRef) }, signal);
				const value = raw.details ?? JSON.parse(raw.content[0]?.type === "text" ? raw.content[0].text : "{}");
				projectToolResult("wiki_read_page", value, pageRef);
			}
		},
		resolveCitationRef(ref) {
			const citation = resolvedCitations.get(ref);
			if (!citation) throw new Error(`unknown or unread Wiki Citation ref '${ref}'`);
			return citation;
		},
	};
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
	return value as Record<string, unknown>;
}

function requireString(value: unknown, label: string): string {
	if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`);
	return value.trim();
}
