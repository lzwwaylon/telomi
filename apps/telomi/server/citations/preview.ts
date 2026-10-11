import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";

import { findLogicalSourceInRun, findLogicalSourceMember, readSourceEvidenceAnchors } from "../workspaces/source-view.js";
import { loadReportNoteWorkspace, type NoteWorkspaceItem } from "../research/notes/workspace.js";
import { readWikiMessageCitations } from "./wiki-message-store.js";
import { readJson } from "../lib/fs.js";
import { resolveNoteReadingCue } from "../research/note-reading.js";
import { resolveSavedNoteCue } from "../research/note-retrieval.js";
import { citationSourceUrl } from "./cue-sources.js";

interface CitationRecord {
	number?: unknown;
	title?: unknown;
	url?: unknown;
	evidenceId?: unknown;
	/** Every ref cited under one Source number in the current compiled citation record. */
	refs?: unknown;
	wiki?: unknown;
	/** Verified Cue and original Source excerpts frozen by investigation publication. */
	cue?: unknown;
	cues?: unknown;
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

interface SourceNote {
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
		excerpts: Array<{ path: string; startLine: number; endLine: number; text: string;
			sourceId?: string; sourceRunId?: string; sourceTitle?: string; sourceUrl?: string; sourceRevisionSha256?: string; contentSha256?: string }>;
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

/** Resolve a report citation by URL or its exact numbered, URL-less Evidence. */
export function resolveCitationSourcePreview(
	reportMarkdownPath: string,
	requestedUrl: string,
	requestedNumber?: number,
): CitationSourcePreview | null {
	const reportUrl = requestedUrl ? normalizeUrl(requestedUrl) : null;
	if ((requestedUrl && !reportUrl) || (!reportUrl && requestedNumber === undefined)) return null;
	const reportJsonPath = reportMarkdownPath.replace(/\.[^.]+$/u, ".json");
	if (!existsSync(reportJsonPath)) return null;
	const report = readJson<{ citations?: CitationRecord[] }>(reportJsonPath);
	const citation = report.citations?.find((item) =>
		(requestedNumber === undefined || item.number === requestedNumber)
		&& (reportUrl ? typeof item.url === "string" && normalizeUrl(item.url) === reportUrl : !item.url));
	if (!citation || !isCurrentCitationRecord(citation)) return null;
	if (citation.cue !== undefined || citation.cues !== undefined) return frozenCuePreview(citation);
	const wiki = wikiCitationPreview(citation, reportUrl ?? "");
	if (wiki) return wiki;
	if (!reportUrl) return null;
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
	const note = exactNotes ? null : findSourceNote(runRoot, sourceId);
	if (!exactNotes && !note) return null;

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
		.filter(({ anchor }) => typeof anchor.source_path === "string" && (exactNotes !== undefined || findLogicalSourceMember(found.source, anchor.source_path)?.path === member.path));

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
		const anchorMember = findLogicalSourceMember(found.source, sourcePath);
		if (!anchorMember || typeof anchorMember.path !== "string" || typeof anchorMember.source_id !== "string") return null;
		const anchorPrefix = `${anchorMember.path.replace(/\/+$/u, "")}/`;
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
			path: sourcePath.slice(anchorPrefix.length),
			...(anchorMember.source_id !== member.source_id ? {
				sourceId: anchorMember.source_id,
				...(typeof anchorMember.title === "string" ? { sourceTitle: anchorMember.title } : {}),
				...(typeof anchorMember.canonical_locator === "string" && normalizeUrl(anchorMember.canonical_locator)
					? { sourceUrl: anchorMember.canonical_locator } : {}),
			} : {}),
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
	const record = readWikiMessageCitations(goalDir, messageId);
	const url = requestedUrl ? normalizeUrl(requestedUrl) : null;
	if (requestedUrl && !url) return null;
	const matches = record?.citations.filter((item) =>
		(requestedNumber === undefined || item.number === requestedNumber)
		&& (url ? typeof item.url === "string" && normalizeUrl(item.url) === url : requestedNumber !== undefined || !item.url)) ?? [];
	if (requestedNumber !== undefined && matches.length !== 1) return null;
	const citation = matches[0];
	if (!citation || !isCurrentCitationRecord(citation)) return null;
	if (!url && requestedNumber === undefined) return null;
	const wikiRefs = new Set((Array.isArray(citation.wiki) ? citation.wiki : []).map(item => item?.ref));
	const refs = citationRefs(citation).filter(ref => !wikiRefs.has(ref));
	if (!refs.length) return wikiCitationPreview(citation, url ?? (typeof citation.url === "string" ? citationSourceUrl(citation.url) : ""));
	const cues = refs.map(ref => ref.startsWith("note:") ? resolveSavedNoteCue(goalDir, ref) : resolveNoteReadingCue(goalDir, ref));
	if (cues.some(cue => !cue)) return null;
	return frozenCuePreview({ ...citation, cues });
}

/** Published Cue excerpts remain readable without consulting a newer Wiki or live Cue store. */
function frozenCuePreview(citation: CitationRecord): CitationSourcePreview | null {
	const refs = citationRefs(citation);
	if (citation.cue !== undefined && citation.cues !== undefined) return null;
	const values = citation.cues !== undefined ? citation.cues : [citation.cue];
	if (!Array.isArray(values) || !values.length) return null;
	const url = typeof citation.url === "string" ? citationSourceUrl(citation.url) : "";
	const wiki = Array.isArray(citation.wiki) && citation.wiki.length ? wikiCitationPreview(citation, url) : undefined;
	if (citation.wiki !== undefined && (!Array.isArray(citation.wiki) || citation.wiki.length && !wiki)) return null;
	const wikiRefs = (Array.isArray(citation.wiki) ? citation.wiki : []).map(item => item?.ref);
	if (wikiRefs.some(ref => typeof ref !== "string" || !refs.includes(ref)) || new Set(wikiRefs).size !== wikiRefs.length) return null;
	const covered = new Set(wikiRefs);
	const previews: CitationSourcePreview[] = [];
	for (const value of values) {
		if (!value || typeof value !== "object" || Array.isArray(value)) return null;
		const cue = value as Record<string, unknown>;
		if (typeof cue.ref !== "string" || !refs.includes(cue.ref) || covered.has(cue.ref)) return null;
		const preview = frozenSingleCuePreview(cue, url, citation.cue !== undefined);
		if (!preview) return null;
		previews.push(preview);
		covered.add(cue.ref);
	}
	if (refs.some(ref => !covered.has(ref))) return null;
	const first = wiki ?? previews[0]!;
	return { ...first, title: typeof citation.title === "string" ? citation.title : first.title,
		clues: [...(wiki?.clues ?? []), ...previews.flatMap(preview => preview.clues)] };
}

function frozenSingleCuePreview(cue: Record<string, unknown>, reportUrl: string, legacy: boolean): CitationSourcePreview | null {
	if (typeof cue.cue !== "string" || typeof cue.note !== "string" || !Array.isArray(cue.evidence)
		|| cue.evidence.length === 0) return null;
	const excerpts: CitationSourcePreview["clues"][number]["excerpts"] = [];
	for (const anchor of cue.evidence) {
		if (!anchor || typeof anchor !== "object" || Array.isArray(anchor)) return null;
		const item = anchor as Record<string, unknown>;
		const startLine = positiveInteger(item.start_line);
		const endLine = positiveInteger(item.end_line);
		if (!strings(item, ["source_path", "source_id", "source_revision_sha256"])
			|| !startLine || !endLine || endLine < startLine || typeof item.excerpt !== "string"
			|| (item.content_sha256 !== undefined && (typeof item.content_sha256 !== "string"
				|| !/^[a-f0-9]{64}$/u.test(item.content_sha256)))) return null;
		// Cornell display excerpts omit Markdown assets; the retained hash names the verified original line bytes.
		const sourceUrl = typeof item.url === "string" ? citationSourceUrl(item.url) : "";
		excerpts.push({
			path: item.source_path as string, startLine, endLine, text: item.excerpt,
			sourceId: item.source_id as string,
			sourceRevisionSha256: item.source_revision_sha256 as string,
			...(typeof item.source_run_id === "string" ? { sourceRunId: item.source_run_id } : {}),
			...(typeof item.content_sha256 === "string" ? { contentSha256: item.content_sha256 } : {}),
			...(sourceUrl && sourceUrl !== reportUrl
				? { sourceUrl, ...(typeof item.title === "string" ? { sourceTitle: item.title } : {}) } : {}),
		});
	}
	const matched = cue.evidence.find(item => citationSourceUrl(item.url ?? cue.canonical_locator) === reportUrl);
	// Older single-Cue reports used the Logical Source's primary locator for cross-member evidence.
	if (reportUrl && !matched && !legacy) return null;
	const first = (matched
		?? cue.evidence[0]) as Record<string, unknown>;
	return {
		title: typeof cue.source_title === "string" ? cue.source_title
			: typeof first.title === "string" ? first.title : cue.cue,
		url: reportUrl || (typeof cue.canonical_locator === "string" ? cue.canonical_locator
			: typeof first.url === "string" ? first.url : ""),
		sourceId: first.source_id as string,
		clues: [{ cue: cue.cue, note: cue.note, excerpts, assets: [] }],
	};
}

const CITATION_FIELDS = new Set(["number", "title", "url", "evidenceId", "provenance", "refs", "wiki", "cue", "cues"]);

function isCurrentCitationRecord(citation: CitationRecord): boolean {
	return Object.keys(citation).every((field) => CITATION_FIELDS.has(field))
		&& (citation.refs === undefined || (Array.isArray(citation.refs) && citation.refs.every((ref) => typeof ref === "string")))
		&& (citation.wiki === undefined || Array.isArray(citation.wiki));
}

function citationRefs(citation: CitationRecord): string[] {
	return (Array.isArray(citation.refs) ? citation.refs : [])
		.filter((ref): ref is string => typeof ref === "string");
}

/** Every cited Wiki Evidence of one Source number becomes one clue carrying its own Page. */
function wikiCitationPreview(citation: { wiki?: unknown }, reportUrl: string): CitationSourcePreview | null {
	const values = Array.isArray(citation.wiki) ? citation.wiki : [];
	const cited = values.flatMap((value) => {
		if (!value || typeof value !== "object" || Array.isArray(value)) return [];
		const record = value as Record<string, unknown>;
		const page = record.page as Record<string, unknown> | undefined;
		const entry = record.entry as Record<string, unknown> | undefined;
		const source = entry?.source as Record<string, unknown> | undefined;
		return page && entry && source
			&& strings(page, ["ref", "path", "title", "type", "content"])
			&& strings(entry, ["cue", "note"])
			&& strings(source, ["id", "title"])
			&& typeof source.url === "string"
			&& (reportUrl ? normalizeUrl(source.url) === reportUrl : !normalizeUrl(source.url))
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
				const source = item.source && typeof item.source === "object" ? item.source as Record<string, unknown> : null;
				return typeof item.path === "string" && typeof item.startLine === "number"
					&& typeof item.endLine === "number" && typeof item.content === "string"
					? [{ path: item.path, startLine: item.startLine, endLine: item.endLine, text: item.content,
						...(source && typeof source.id === "string" ? { sourceId: source.id } : {}),
						...(source && typeof source.runId === "string" ? { sourceRunId: source.runId } : {}),
						...(source && typeof source.title === "string" ? { sourceTitle: source.title } : {}),
						...(source && typeof source.url === "string" ? { sourceUrl: source.url } : {}),
						...(source && typeof source.revisionSha256 === "string" ? { sourceRevisionSha256: source.revisionSha256 } : {}),
						...(typeof item.sha256 === "string" ? { contentSha256: item.sha256 } : {}) }]
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

function findSourceNote(runRoot: string, sourceId: string): SourceNote | null {
	const root = join(runRoot, "artifacts", "notes");
	for (const sequence of sequenceDirectories(root)) {
		// ponytail: linear scan is tiny for current runs; add an index only if Note counts make preview latency measurable.
		for (const filename of safeDirectoryEntries(join(root, sequence)).filter((name) => name.endsWith(".json"))) {
			const note = readJson<SourceNote>(join(root, sequence, filename));
			if (note.source_id === sourceId) return note;
		}
	}
	return null;
}

/** All cited Notes, or null when any ref is missing from the Run's frozen Notes snapshot. */
function findReportNotes(runRoot: string, refs: readonly string[]): NoteWorkspaceItem[] | null {
	try {
		const workspace = loadReportNoteWorkspace(join(runRoot, "artifacts", "report-flow", "notes-snapshot"));
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
	return citationSourceUrl(value) || null;
}

function positiveInteger(value: unknown): number | null {
	return Number.isInteger(value) && (value as number) > 0 ? value as number : null;
}
