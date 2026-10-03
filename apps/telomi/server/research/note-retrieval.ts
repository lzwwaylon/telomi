import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { validateCornellNotesSnapshot } from "../cornell/contracts.js";
import { findLogicalSourceInRun, readSourceEvidenceAnchors } from "../workspaces/source-view.js";
import { noteWikiEntries } from "../wiki/note-entries.js";
import { resolveNoteReadingCue } from "./note-reading.js";

const REF = /^cornell:([A-Za-z0-9._-]{1,200}):([a-f0-9]{24}):([a-f0-9]{12})$/u;

interface RegistryEntry {
	id: string;
	revisionSha256: string;
	sourceRunId: string;
	sourceId: string;
	sourceTitle: string;
	canonicalLocator: string;
	originCueRef?: string;
	section: string;
	sectionSummary?: string;
	cue: string;
	detail: string;
	topicRefs?: string[];
	anchors: Array<{ path: string; startLine: number; endLine: number; sha256: string;
		sourceRunId?: string; sourceId?: string; sourceRevisionSha256?: string; sourceTitle?: string; canonicalLocator?: string }>;
}

export interface SavedNoteCue {
	ref: string;
	kind: "cornell" | "note_reading";
	wiki_entry_id?: string;
	section_title: string;
	cue: string;
	note: string;
	source_run_id: string;
	source_id: string;
	source_title: string;
	canonical_locator: string;
	topic_refs: string[];
	evidence: Array<{ source_path: string; start_line: number; end_line: number; content_sha256: string;
		source_run_id?: string; source_id?: string; source_revision_sha256?: string; title?: string; url?: string }>;
}

/** The frozen Wiki registry retains Cornell Cues even when no Wiki page adopted them. */
export function listSavedNoteCues(knowledgeRoot: string): SavedNoteCue[] {
	const path = join(knowledgeRoot, ".note-registry.json");
	if (!existsSync(path)) return [];
	const registry = JSON.parse(readFileSync(path, "utf-8")) as { entries?: RegistryEntry[] };
	if (!Array.isArray(registry.entries)) throw new Error("Wiki Note Registry entries are invalid");
	return registry.entries.map((entry) => {
		if (!/^entry:[a-f0-9]{24}$/u.test(entry.id) || !/^[a-f0-9]{64}$/u.test(entry.revisionSha256)
			|| !/^[A-Za-z0-9._-]{1,200}$/u.test(entry.sourceRunId)
			|| !entry.sourceId || !entry.cue || !entry.detail || !Array.isArray(entry.anchors)) {
			throw new Error("Wiki Note Registry has an invalid Cornell Cue");
		}
		if (entry.originCueRef && !/^deep-search:[A-Za-z0-9._-]{1,100}:cue-[1-9][0-9]*$/u.test(entry.originCueRef)) {
			throw new Error("Wiki Note Registry has an invalid original Cue ref");
		}
		return {
			ref: entry.originCueRef ?? `cornell:${entry.sourceRunId}:${entry.id.slice(6)}:${entry.revisionSha256.slice(0, 12)}`,
			kind: entry.originCueRef ? "note_reading" as const : "cornell" as const,
			...(entry.originCueRef ? { wiki_entry_id: entry.id } : {}),
			section_title: entry.section,
			cue: entry.cue,
			note: entry.detail,
			source_run_id: entry.sourceRunId,
			source_id: entry.sourceId,
			source_title: entry.sourceTitle,
			canonical_locator: entry.canonicalLocator,
			topic_refs: entry.topicRefs ?? [],
			evidence: entry.anchors.map((anchor) => ({ source_path: anchor.path,
				start_line: anchor.startLine, end_line: anchor.endLine, content_sha256: anchor.sha256,
				...(anchor.sourceRunId ? { source_run_id: anchor.sourceRunId, source_id: anchor.sourceId,
					source_revision_sha256: anchor.sourceRevisionSha256, title: anchor.sourceTitle, url: anchor.canonicalLocator } : {}) })),
		};
	});
}

/** Resolve one durable Cue identity through its original Run, verifying Source revision and line bytes. */
export function resolveSavedNoteCue(goalDir: string, ref: string) {
	if (ref.startsWith("deep-search:")) {
		const cue = resolveNoteReadingCue(goalDir, ref);
		if (!cue) return null;
		const primary = cue.evidence[0]!;
		return { ...cue, source_id: primary.source_id, source_revision_sha256: primary.source_revision_sha256,
			source_title: primary.title, canonical_locator: primary.url };
	}
	const match = REF.exec(ref);
	if (!match) return null;
	const [, runId, entryHash, revisionPrefix] = match;
	const notesRoot = join(goalDir, "wiki", "runs", runId!, "artifacts", "cornell-notes");
	for (const file of snapshotFiles(notesRoot)) {
		const snapshot = validateCornellNotesSnapshot(JSON.parse(readFileSync(join(notesRoot, file), "utf-8")));
		if (snapshot.run_id !== runId) throw new Error("Cornell Snapshot Run identity changed");
		const entry = noteWikiEntries(snapshot).find((item) => item.id === `entry:${entryHash}`
			&& item.revisionSha256.startsWith(revisionPrefix!));
		if (!entry) continue;
		const record = snapshot.notes.find((item) => item.note.source_id === entry.sourceId)!;
		const resolved = findLogicalSourceInRun(join(goalDir, "wiki", "runs", entry.sourceRunId), entry.sourceId);
		if (!resolved || resolved.source.revision_sha256 !== record.source_revision_sha256) {
			throw new Error("Cornell Cue Source revision is unavailable");
		}
		const excerpts = entry.anchors.map((anchor) => {
			const source = anchor.sourceRunId ? findLogicalSourceInRun(join(goalDir, "wiki", "runs", anchor.sourceRunId), anchor.sourceId!) : resolved;
			if (!source || (anchor.sourceRevisionSha256 && source.source.revision_sha256 !== anchor.sourceRevisionSha256)) {
				throw new Error("Cornell Cue Source revision is unavailable");
			}
			return readSourceEvidenceAnchors(source, [anchor])[0]!;
		});
		return { ref, cue: entry.cue, note: entry.detail, source_id: entry.sourceId,
			source_revision_sha256: record.source_revision_sha256, source_title: entry.sourceTitle,
			canonical_locator: entry.canonicalLocator,
			evidence: entry.anchors.map((anchor, index) => ({
				source_run_id: anchor.sourceRunId ?? entry.sourceRunId, source_id: anchor.sourceId ?? entry.sourceId,
				source_revision_sha256: anchor.sourceRevisionSha256 ?? record.source_revision_sha256,
				...(anchor.sourceTitle ? { title: anchor.sourceTitle } : {}), ...(anchor.canonicalLocator ? { url: anchor.canonicalLocator } : {}),
				source_path: anchor.path, start_line: anchor.startLine, end_line: anchor.endLine,
				content_sha256: anchor.sha256, excerpt: excerpts[index]!.content,
			})) };
	}
	return null;
}

/** Rank Cue bodies, not old question text: a query's generic instructions cannot make every new Cue match. */
export function rankSavedNoteCues<T extends { ref: string; cue: string; note: string; section_title?: string; source_title?: string }>(
	cues: readonly T[], query: string, limit: number,
): T[] {
	const words = [...new Set((query.normalize("NFKC").toLocaleLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}._-]*/gu) ?? [])
		.filter((word) => word.length > 1 && !STOP_WORDS.has(word)))];
	const han = [...new Set([...new Intl.Segmenter("zh", { granularity: "word" }).segment(query)]
		.filter((item) => item.isWordLike && /\p{Script=Han}/u.test(item.segment) && item.segment.length > 1)
		.map((item) => item.segment.toLocaleLowerCase()))];
	const terms = [...new Set([...words, ...han])];
	if (!terms.length) return [];
	const documents = cues.map((cue) => ({ cue,
		title: `${cue.source_title ?? ""} ${cue.section_title ?? ""} ${cue.cue}`.normalize("NFKC").toLocaleLowerCase(),
		body: cue.note.normalize("NFKC").toLocaleLowerCase() }));
	const frequency = new Map(terms.map((term) => [term, documents.filter((item) => item.title.includes(term) || item.body.includes(term)).length]));
	return documents.map((item) => ({ cue: item.cue,
		score: terms.reduce((sum, term) => {
			const weight = /\p{Script=Han}/u.test(term) ? 0.25 : 1;
			return sum + weight * Math.log(1 + documents.length / (1 + frequency.get(term)!))
				* (item.title.includes(term) ? 4 : item.body.includes(term) ? 2 : 0);
		}, 0) }))
		.filter((item) => item.score > 0)
		.sort((a, b) => b.score - a.score || a.cue.ref.localeCompare(b.cue.ref))
		.slice(0, limit).map((item) => item.cue);
}

const STOP_WORDS = new Set(["goal", "wiki", "cue", "cues", "note", "notes", "source", "sources", "saved", "local", "search", "read", "only", "please", "the", "and"]);

function snapshotFiles(root: string): string[] {
	try { return readdirSync(root).filter((file) => /^snapshot-\d+\.json$/u.test(file))
		.sort((a, b) => Number(b.slice(9, -5)) - Number(a.slice(9, -5))); }
	catch { return []; }
}
