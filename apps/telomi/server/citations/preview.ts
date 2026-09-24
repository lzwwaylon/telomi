import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";

import { findLogicalSourceInRun, readSourceEvidenceAnchors } from "../workspaces/source-view.js";
import { loadReportNoteWorkspace, type NoteWorkspaceItem } from "../research/notes/workspace.js";
import { readWikiMessageCitations } from "./wiki-message-store.js";
import { readJson } from "../lib/fs.js";

interface CitationRecord {
	number?: unknown;
	title?: unknown;
	url?: unknown;
	evidenceId?: unknown;
	/** Current records list every ref cited under one Source number; older reports hold one `ref` and one `wiki`. */
	refs?: unknown;
	ref?: unknown;
	wiki?: unknown;
}

type WikiPagePreview = { ref: string; path: string; title: string; type: string; content: string };

interface EvidenceAnchor {
	source_path?: unknown;
	start_line?: unknown;
	end_line?: unknown;
	content_sha256?: unknown;
}

interface CueNote {
	cue?: unknown;
	note?: unknown;
	evidence?: unknown;
}

interface CornellNote {
	source_id?: unknown;
	sections?: Array<{ summary?: unknown; cue_notes?: CueNote[] }>;
}

export interface CitationSourcePreview {
	title: string;
	url: string;
	sourceId: string;
	clues: Array<{
		page?: WikiPagePreview;
		cue: string;
		note: string;
		excerpts: Array<{ path: string; startLine: number; endLine: number; text: string }>;
		assets: Array<{ sourceId: string; path: string; alt: string; width?: number; height?: number }>;
	}>;
}

export interface ReportCoverAsset {
	sourceId: string;
	path: string;
}

/**
 * Pick a card cover for a report: from the first citation that has evidence images, the one
 * closest to the card's 4:3 thumbnail. Unmeasured formats (gif/webp) are treated as 4:3.
 */
export function resolveReportCoverAsset(reportMarkdownPath: string): ReportCoverAsset | null {
	const reportJsonPath = reportMarkdownPath.replace(/\.[^.]+$/u, ".json");
	if (!existsSync(reportJsonPath)) return null;
	const citations = readJson<{ citations?: CitationRecord[] }>(reportJsonPath).citations ?? [];
	for (const citation of citations) {
		if (typeof citation.url !== "string") continue;
		let preview: CitationSourcePreview | null = null;
		try {
			preview = resolveCitationSourcePreview(reportMarkdownPath, citation.url,
				typeof citation.number === "number" ? citation.number : undefined);
		} catch {
			continue;
		}
		// ponytail: within one citation rank by closeness to the 4:3 card thumbnail; ranking by content needs a model call.
		const ranked = (preview?.clues ?? []).flatMap((clue) => clue.assets)
			.map((asset) => ({ asset, ratio: asset.width && asset.height ? asset.width / asset.height : 4 / 3 }))
			.filter(({ ratio }) => ratio >= 0.5 && ratio <= 2.4)
			.sort((left, right) => Math.abs(Math.log(left.ratio / (4 / 3))) - Math.abs(Math.log(right.ratio / (4 / 3))));
		if (ranked[0]) return { sourceId: ranked[0].asset.sourceId, path: ranked[0].asset.path };
	}
	return null;
}

/** Resolve a report URL citation back to its immutable Source and Cornell Evidence. */
export function resolveCitationSourcePreview(
	reportMarkdownPath: string,
	requestedUrl: string,
	requestedNumber?: number,
): CitationSourcePreview | null {
	const reportUrl = normalizeUrl(requestedUrl);
	if (!reportUrl) return null;
	const reportJsonPath = reportMarkdownPath.replace(/\.[^.]+$/u, ".json");
	if (!existsSync(reportJsonPath)) return null;
	const report = readJson<{ citations?: CitationRecord[] }>(reportJsonPath);
	const citation = report.citations?.find((item) => typeof item.url === "string"
		&& normalizeUrl(item.url) === reportUrl
		&& (requestedNumber === undefined || item.number === requestedNumber));
	if (!citation) return null;
	const wiki = wikiCitationPreview(citation, reportUrl);
	if (wiki) return wiki;
	const sourceId = typeof citation.evidenceId === "string" && /^source:[a-z0-9_-]+$/iu.test(citation.evidenceId)
		? citation.evidenceId
		: null;
	if (!sourceId) return null;

	const runRoot = dirname(dirname(reportMarkdownPath));
	const found = findLogicalSourceInRun(runRoot, sourceId);
	if (!found) return null;
	const member = found.source.members?.find((item) =>
		typeof item.canonical_locator === "string" && normalizeUrl(item.canonical_locator) === reportUrl);
	if (!member || typeof member.path !== "string" || typeof member.source_id !== "string") return null;
	const noteRefs = citationRefs(citation).filter((ref) => /^N[1-9][0-9]*$/u.test(ref));
	const exactNotes = noteRefs.length > 0 ? findReportNotes(runRoot, noteRefs) : undefined;
	if (exactNotes === null || exactNotes?.some((exactNote) => exactNote.source_id !== sourceId
		|| !exactNote.source_urls.some((url) => normalizeUrl(url) === reportUrl))) return null;
	const note = exactNotes ? null : findCornellNote(runRoot, sourceId);
	if (!exactNotes && !note) return null;

	const prefix = `${member.path.replace(/\/+$/u, "")}/`;
	const matched = (exactNotes
		? exactNotes.flatMap((exactNote) => exactNote.evidence.map((anchor) => ({
			anchor: anchor as EvidenceAnchor,
			key: exactNote.ref,
			cue: exactNote.cue,
			note: exactNote.note,
		})))
		: (note!.sections ?? []).flatMap((section, sectionIndex) => (section.cue_notes ?? []).flatMap((cue, cueIndex) =>
			Array.isArray(cue.evidence) ? cue.evidence.map((anchor) => ({
			anchor: anchor as EvidenceAnchor,
			key: `${sectionIndex}:${cueIndex}`,
			cue: typeof cue.cue === "string" ? cue.cue : "原文证据",
			note: typeof cue.note === "string" ? cue.note : "",
			})) : [])))
		.filter(({ anchor }) => typeof anchor.source_path === "string" && anchor.source_path.startsWith(prefix));

	const clues = new Map<string, {
		cue: string;
		note: string;
		excerpts: CitationSourcePreview["clues"][number]["excerpts"];
		assets: Map<string, CitationSourcePreview["clues"][number]["assets"][number]>;
	}>();
	for (const item of matched) {
		let clue = clues.get(item.key);
		if (!clue) {
			clue = { cue: item.cue, note: item.note, excerpts: [], assets: new Map() };
			clues.set(item.key, clue);
		}
		const sourcePath = typeof item.anchor.source_path === "string" ? item.anchor.source_path : "";
		const startLine = positiveInteger(item.anchor.start_line);
		const endLine = positiveInteger(item.anchor.end_line);
		if (!startLine || !endLine || endLine < startLine) continue;
		const [excerpt] = readSourceEvidenceAnchors(found, [{
			path: sourcePath,
			startLine,
			endLine,
			...(typeof item.anchor.content_sha256 === "string" ? { sha256: item.anchor.content_sha256 } : {}),
		}]);
		if (!excerpt) continue;
		if (excerpt.content) clue.excerpts.push({
			path: sourcePath.slice(prefix.length),
			startLine,
			endLine,
			text: excerpt.content,
		});
		for (const asset of excerpt.assets) {
			clue.assets.set(`${asset.sourceId}:${asset.path}`, { ...asset, alt: item.cue });
		}
	}

	return {
		title: typeof member.title === "string" ? member.title
			: typeof citation.title === "string" ? citation.title
				: typeof found.source.title === "string" ? found.source.title : reportUrl,
		url: reportUrl,
		sourceId,
		clues: [...clues.values()].map((clue) => ({
			cue: clue.cue,
			note: clue.note,
			excerpts: clue.excerpts,
			assets: [...clue.assets.values()],
		})),
	};
}

/** Resolve a Main Agent chat citation from its message-scoped Wiki lineage. */
export function resolveMessageCitationSourcePreview(
	goalDir: string,
	messageId: string,
	requestedUrl: string,
	requestedNumber?: number,
): CitationSourcePreview | null {
	const url = normalizeUrl(requestedUrl);
	if (!url) return null;
	const record = readWikiMessageCitations(goalDir, messageId);
	const citation = record?.citations.find((item) => typeof item.url === "string"
		&& normalizeUrl(item.url) === url
		&& (requestedNumber === undefined || item.number === requestedNumber));
	return citation ? wikiCitationPreview(citation, url) : null;
}

function citationRefs(citation: CitationRecord): string[] {
	return (Array.isArray(citation.refs) ? citation.refs : [citation.ref])
		.filter((ref): ref is string => typeof ref === "string");
}

/** Every cited Wiki Evidence of one Source number becomes one clue carrying its own Page. */
function wikiCitationPreview(citation: { wiki?: unknown }, reportUrl: string): CitationSourcePreview | null {
	const values = Array.isArray(citation.wiki) ? citation.wiki : [citation.wiki];
	const cited = values.flatMap((value) => {
		if (!value || typeof value !== "object" || Array.isArray(value)) return [];
		const record = value as Record<string, unknown>;
		const page = record.page as Record<string, unknown> | undefined;
		const entry = record.entry as Record<string, unknown> | undefined;
		const source = entry?.source as Record<string, unknown> | undefined;
		return page && entry && source
			&& strings(page, ["ref", "path", "title", "type", "content"])
			&& strings(entry, ["cue", "note"])
			&& strings(source, ["id", "title", "url"])
			&& normalizeUrl(source.url as string) === reportUrl
			&& Array.isArray(entry.anchors)
			? [{ page: page as WikiPagePreview, entry, source }]
			: [];
	});
	const first = cited[0];
	if (!first || cited.length !== values.length) return null;
	return {
		title: first.source.title as string,
		url: reportUrl,
		sourceId: first.source.id as string,
		clues: cited.flatMap(({ page, entry }) => wikiClue(entry).map((clue) => ({ page, ...clue }))),
	};
}

function wikiClue(value: unknown): CitationSourcePreview["clues"] {
	if (!value || typeof value !== "object" || Array.isArray(value)) return [];
	const entry = value as Record<string, unknown>;
	if (!strings(entry, ["cue", "note"]) || !Array.isArray(entry.anchors)) return [];
	const cue = entry.cue as string;
	return [{
		cue,
		note: entry.note as string,
		excerpts: entry.anchors.flatMap((anchor) => {
				if (!anchor || typeof anchor !== "object" || Array.isArray(anchor)) return [];
				const item = anchor as Record<string, unknown>;
				return typeof item.path === "string" && typeof item.startLine === "number"
					&& typeof item.endLine === "number" && typeof item.content === "string"
					? [{ path: item.path, startLine: item.startLine, endLine: item.endLine, text: item.content }]
					: [];
		}),
		assets: entry.anchors.flatMap((anchor) => {
				if (!anchor || typeof anchor !== "object" || Array.isArray(anchor)) return [];
				const assets = (anchor as Record<string, unknown>).assets;
				return Array.isArray(assets) ? assets.flatMap((asset) => {
					if (!asset || typeof asset !== "object" || Array.isArray(asset)) return [];
					const item = asset as Record<string, unknown>;
					return typeof item.sourceId === "string" && typeof item.path === "string"
						? [{ sourceId: item.sourceId, path: item.path, alt: cue }]
						: [];
				}) : [];
		}),
	}];
}

function strings(value: Record<string, unknown>, keys: readonly string[]): boolean {
	return keys.every((key) => typeof value[key] === "string" && Boolean((value[key] as string).trim()));
}

function findCornellNote(runRoot: string, sourceId: string): CornellNote | null {
	const root = join(runRoot, "artifacts", "cornell-notes");
	for (const sequence of sequenceDirectories(root)) {
		// ponytail: linear scan is tiny for current runs; add an index only if Note counts make preview latency measurable.
		for (const filename of safeDirectoryEntries(join(root, sequence)).filter((name) => name.endsWith(".json"))) {
			const note = readJson<CornellNote>(join(root, sequence, filename));
			if (note.source_id === sourceId) return note;
		}
	}
	return null;
}

/** All cited Notes, or null when any ref is missing from the Run's frozen Find Out snapshot. */
function findReportNotes(runRoot: string, refs: readonly string[]): NoteWorkspaceItem[] | null {
	try {
		const workspace = loadReportNoteWorkspace(join(runRoot, "artifacts", "report-flow", "findout-snapshot"));
		const notes = refs.map((ref) => workspace.citation(ref));
		return notes.every((note) => note !== undefined) ? notes as NoteWorkspaceItem[] : null;
	} catch {
		return null;
	}
}

function sequenceDirectories(root: string): string[] {
	return safeDirectoryEntries(root)
		.filter((name) => /^sequence-\d+$/u.test(name))
		.sort((left, right) => Number(right.slice(9)) - Number(left.slice(9)));
}

function safeDirectoryEntries(path: string): string[] {
	try {
		return readdirSync(path, { withFileTypes: true }).filter((entry) => entry.isDirectory() || entry.isFile()).map((entry) => entry.name);
	} catch {
		return [];
	}
}


function normalizeUrl(value: string): string | null {
	try {
		const url = new URL(value);
		if (url.protocol !== "http:" && url.protocol !== "https:") return null;
		url.hash = "";
		return url.href;
	} catch {
		return null;
	}
}

function positiveInteger(value: unknown): number | null {
	return Number.isInteger(value) && (value as number) > 0 ? value as number : null;
}
