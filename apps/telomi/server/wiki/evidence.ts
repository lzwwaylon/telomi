import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { stripMarkdownForPill } from "../../shared/strip-markdown.js";

import {
	findLogicalSourceInRun,
	readSourceEvidenceAnchors,
	type SourceEvidenceExcerpt,
} from "../workspaces/source-view.js";

interface NoteRegistryEntry {
	id: string;
	sourceRunId: string;
	sourceId: string;
	sourceTitle: string;
	canonicalLocator: string;
	sourceRevisionSha256?: string;
	section: string;
	sectionSummary?: string;
	cue: string;
	detail: string;
	anchors: Array<{ path: string; startLine: number; endLine: number; sha256: string;
		sourceRunId?: string; sourceId?: string; sourceRevisionSha256?: string; sourceTitle?: string; canonicalLocator?: string }>;
}

export interface WikiEvidenceEntry {
	id: string;
	index: number;
	section: string;
	sectionSummary?: string;
	cue: string;
	note: string;
	source: { id: string; title: string; url: string; runId?: string };
	anchors: Array<SourceEvidenceExcerpt & {
		sha256?: string;
		source?: { id: string; title: string; url: string; runId: string; revisionSha256: string };
	}>;
}

export function readWikiPageEvidence(
	knowledgeRoot: string,
	frontmatter: Record<string, unknown>,
	goalDirectory?: string,
): WikiEvidenceEntry[] {
	const ids = Array.isArray(frontmatter.entry_ids)
		? frontmatter.entry_ids.filter((value): value is string => typeof value === "string")
		: [];
	if (ids.length === 0) return [];
	const registryPath = join(knowledgeRoot, ".note-registry.json");
	if (!existsSync(registryPath)) throw new Error("Wiki Note Registry is missing");
	const registry = JSON.parse(readFileSync(registryPath, "utf-8")) as { entries?: NoteRegistryEntry[] };
	if (!Array.isArray(registry.entries)) throw new Error("Wiki Note Registry entries are invalid");
	const byId = new Map(registry.entries.map((entry) => [entry.id, entry]));
	const goalDir = goalDirectory ? resolve(goalDirectory) : resolve(knowledgeRoot, "..", "..");
	const sources = new Map<string, ReturnType<typeof findLogicalSourceInRun>>();
	return ids.map((id, index) => {
		const entry = byId.get(id);
		if (!entry) throw new Error(`Wiki Evidence Entry is missing: ${id}`);
		const anchors = entry.anchors.map((anchor) => {
			const runId = anchor.sourceRunId ?? entry.sourceRunId;
			const sourceId = anchor.sourceId ?? entry.sourceId;
			const revision = anchor.sourceRevisionSha256 ?? entry.sourceRevisionSha256;
			const sourceKey = `${runId}\0${sourceId}`;
			let source = sources.get(sourceKey);
			if (source === undefined) {
				source = findLogicalSourceInRun(join(goalDir, "wiki", "runs", runId), sourceId);
				sources.set(sourceKey, source);
			}
			if (!source) throw new Error(`Wiki Evidence Source is missing: ${sourceId}`);
			if (revision && source.source.revision_sha256 !== revision) throw new Error(`Wiki Evidence Source revision changed: ${sourceId}`);
			return { ...readSourceEvidenceAnchors(source, [anchor])[0]!, sha256: anchor.sha256,
				...(anchor.sourceRunId && revision ? { source: { id: sourceId, runId, revisionSha256: revision,
					title: anchor.sourceTitle ?? entry.sourceTitle, url: anchor.canonicalLocator ?? entry.canonicalLocator } } : {}) };
		});
		return {
			id: entry.id,
			index: index + 1,
			section: entry.section,
			...(entry.sectionSummary ? { sectionSummary: entry.sectionSummary } : {}),
			cue: entry.cue,
			note: entry.detail,
			source: { id: entry.sourceId, title: entry.sourceTitle, url: entry.canonicalLocator, runId: entry.sourceRunId },
			anchors,
		};
	});
}

export function projectWikiBodyEvidenceLinks(content: string, evidenceCount: number): string {
	if (evidenceCount === 0) return content;
	const body = content.split(/\n## Evidence\s*\n/u, 1)[0]!.trimEnd();
	return `${body.replace(/\[\^(\d+)\]/gu, (match, number: string) => {
		const index = Number(number);
		return index >= 1 && index <= evidenceCount ? `[E${index}](#evidence-${index})` : match;
	})}\n`;
}

/** Take a reader excerpt without cutting an evidence link in half. */
export function wikiSearchExcerpt(content: string, query: string, options: { description?: string; chunk?: string } = {}): string {
	// Complete prose avoids excerpts beginning inside generated metadata or a split Markdown link.
	const body = content.split(/^## (?:Related|Evidence)\s*$/mu, 1)[0] ?? "";
	const paragraphs = body.split(/\n\s*\n/u).filter((part) => part.trim() && !/^#{1,6}[^\n]*$/u.test(part.trim()));
	const terms = query.toLocaleLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? [];
	const matched = paragraphs.find((part) => terms.some((term) => part.toLocaleLowerCase().includes(term)));
	const { chunk } = options;
	const retrieved = chunk && paragraphs.find((part) => chunk.includes(part) || part.includes(chunk));
	const value = matched || retrieved || options.description || paragraphs[0] || body;
	const text = value.split(/(\[E\d+\]\(#evidence-\d+\))/gu).map((part, index) => {
		if (index % 2) return part;
		return `${/^\s/u.test(part) ? " " : ""}${stripMarkdownForPill(part)}${/\s$/u.test(part) ? " " : ""}`;
	}).join("").replace(/\s+/gu, " ").trim();
	const positions = terms.map((term) => text.toLocaleLowerCase().indexOf(term)).filter((index) => index >= 0);
	const match = positions.length ? Math.min(...positions) : 0;
	let start = Math.max(0, match - 80);
	let end = Math.min(text.length, match + 320);
	// A fixed offset lands inside a word as readily as between two, and a cut Latin word can still
	// read as a phrase: "University of Texas at Austin" becomes "as at Austin", which says
	// something else entirely. Han text has no such runs, so each edge only steps off a word.
	while (start > 0 && start < match && WORD.test(text[start - 1]!) && WORD.test(text[start]!)) start += 1;
	while (end < text.length && end > match && WORD.test(text[end - 1]!) && WORD.test(text[end]!)) end -= 1;
	for (const link of text.matchAll(/\[E\d+\]\(#evidence-\d+\)/gu)) {
		const linkEnd = link.index + link[0].length;
		if (link.index < start && linkEnd > start) start = link.index;
		if (link.index < end && linkEnd > end) end = linkEnd;
	}
	// Stopping one character short of a sentence's closing punctuation would drop it and then claim
	// the sentence continues, so the window takes what is left of the sentence instead.
	while (end < text.length && /[\s.。!！?？]/u.test(text[end]!)) end += 1;
	// An excerpt that begins or ends mid-sentence says so, so a fragment is never read as the
	// whole of what the page states.
	const excerpt = text.slice(start, end).trim();
	if (!excerpt) return excerpt;
	return `${start > 0 ? "…" : ""}${excerpt}${end < text.length ? "…" : ""}`;
}

/** Characters that form one written word, so a cut between two of them would split it. */
const WORD = /[\w'-]/u;
