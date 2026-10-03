import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { join } from "node:path";

import { validateCornellNotesSnapshot, type CornellNoteRecord, type CornellNotesSnapshot } from "../cornell/contracts.js";
import { hashJson, sha256 } from "../lib/hash.js";
import { assertInsideRoot } from "../lib/paths.js";
import { findLogicalSourceInRun, readSourceEvidenceAnchors } from "../workspaces/source-view.js";
import { resolveNoteReadingCue, type NoteReadingResult } from "./note-reading.js";

/** Import validated saved Cues without rerunning a Reader or creating a Research Run. */
export function createCueCornellSnapshot(input: {
	goalDir: string;
	artifactRefs: readonly { path: string; sha256: string }[];
	snapshotId: string;
}): CornellNotesSnapshot {
	const notes = new Map<string, CornellNoteRecord>();
	const origins = new Map<string, string>();
	for (const ref of [...input.artifactRefs].sort((a, b) => a.path.localeCompare(b.path))) {
		const match = /^artifacts\/deep-search\/([A-Za-z0-9._-]{1,100})\.json$/u.exec(ref.path);
		if (!match || !/^[a-f0-9]{64}$/u.test(ref.sha256)) throw new Error("Cue Wiki input artifact ref is invalid");
		const path = assertInsideRoot(realpathSync(input.goalDir), realpathSync(join(input.goalDir, ref.path)), "Cue Wiki input");
		const bytes = readFileSync(path);
		if (sha256(bytes) !== ref.sha256) throw new Error(`Cue Wiki input changed: ${ref.path}`);
		const result = JSON.parse(bytes.toString("utf8")) as NoteReadingResult;
		if (result.schema_version !== 1 || !["found", "partial", "not_found"].includes(result.status)
			|| !Array.isArray(result.cues) || !Array.isArray(result.gaps)
			|| typeof result.summary !== "string" || !result.summary.trim()) throw new Error("Cue Wiki input is invalid");
		for (const [index, cue] of result.cues.entries()) {
			if (cue.ref !== `deep-search:${match[1]}:cue-${index + 1}` || !Array.isArray(cue.evidence) || !cue.evidence.length) {
				throw new Error("Cue Wiki input has an invalid Cue identity or evidence");
			}
			const digest = hashJson(cue);
			if (origins.has(cue.ref)) {
				if (origins.get(cue.ref) !== digest) throw new Error(`Cue Wiki origin changed: ${cue.ref}`);
				continue;
			}
			origins.set(cue.ref, digest);
			// Resolve every original Source and line hash, including Cues comparing several Runs.
			const resolvedCue = resolveNoteReadingCue(input.goalDir, cue.ref);
			if (!resolvedCue) throw new Error(`Cue Wiki origin is unavailable: ${cue.ref}`);
			const primary = resolvedCue.evidence[0]!;
			const key = `${primary.source_run_id}\0${primary.source_id}`;
			let record = notes.get(key);
			if (!record) {
				const source = findLogicalSourceInRun(join(input.goalDir, "wiki", "runs", primary.source_run_id), primary.source_id)!;
				const members = (source.source.members ?? []).map((member) => {
					const provider = member as typeof member & { provider_id?: unknown };
					return { source_id: String(member.source_id), provider_id: String(provider.provider_id ?? "source"),
						title: String(member.title ?? primary.title), canonical_locator: String(member.canonical_locator || `source:${primary.source_id}`) };
				});
				record = { source_run_id: primary.source_run_id,
					note: { schema_version: 1, source_id: primary.source_id, sections: [] },
					title: String(source.source.title || primary.title || primary.source_id),
					canonical_locator: primary.url || `source:${primary.source_id}`,
					provider_id: members[0]?.provider_id ?? "source", provenance_ref: `deep-search:${match[1]}`,
					source_revision_sha256: primary.source_revision_sha256, members };
				notes.set(key, record);
			} else if (record.source_revision_sha256 !== primary.source_revision_sha256) {
				throw new Error(`Cue Wiki Source revision conflict: ${primary.source_id}`);
			}
			record.note.sections.push({ section_title: cue.section_title, summary: cue.note, cue_notes: [{
				origin_ref: cue.ref, cue: cue.cue, note: cue.note,
				evidence: resolvedCue.evidence.map((anchor) => ({ source_run_id: anchor.source_run_id,
					source_id: anchor.source_id, source_revision_sha256: anchor.source_revision_sha256,
					source_title: anchor.title || anchor.source_id, canonical_locator: anchor.url || `source:${anchor.source_id}`,
					source_path: anchor.source_path, start_line: anchor.start_line, end_line: anchor.end_line,
					content_sha256: anchor.content_sha256 })),
			}] });
		}
	}
	return validateCornellNotesSnapshot({ schema_version: 1, snapshot_id: input.snapshotId, run_id: input.snapshotId,
		pipeline: { id: "cue-wiki-import", version: "1", sha256: hashJson({ contract: "cue-wiki-import", version: 1 }) },
		source_bundle_refs: [], notes: [...notes.values()] });
}

/** Rebuild from the whole durable Cornell corpus, including Cues never adopted by a Wiki page. */
export function createGoalCornellSnapshot(input: { goalDir: string; snapshotId: string }): CornellNotesSnapshot {
	const runsRoot = join(input.goalDir, "wiki", "runs");
	const records = new Map<string, CornellNoteRecord>();
	for (const run of existsSync(runsRoot) ? readdirSync(runsRoot, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)) : []) {
		if (!run.isDirectory() || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(run.name)) continue;
		const notesRoot = join(runsRoot, run.name, "artifacts", "cornell-notes");
		if (!existsSync(notesRoot)) continue;
		const file = readdirSync(notesRoot).filter(name => /^snapshot-\d+\.json$/u.test(name))
			.sort((a, b) => Number(b.slice(9, -5)) - Number(a.slice(9, -5)))[0];
		if (!file) continue;
		const snapshot = validateCornellNotesSnapshot(JSON.parse(readFileSync(join(notesRoot, file), "utf8")));
		if (snapshot.run_id !== run.name) throw new Error("Cornell Snapshot Run identity changed");
		for (const record of snapshot.notes) {
			const sourceRunId = record.source_run_id ?? snapshot.run_id;
			for (const section of record.note.sections) for (const cue of section.cue_notes) for (const anchor of cue.evidence) {
				const source = findLogicalSourceInRun(join(runsRoot, anchor.source_run_id ?? sourceRunId), anchor.source_id ?? record.note.source_id);
				if (!source || source.source.revision_sha256 !== (anchor.source_revision_sha256 ?? record.source_revision_sha256)) {
					throw new Error(`Cornell Source revision is unavailable: ${record.note.source_id}`);
				}
				readSourceEvidenceAnchors(source, [{ path: anchor.source_path, startLine: anchor.start_line,
					endLine: anchor.end_line, sha256: anchor.content_sha256 }]);
			}
			records.set(`${sourceRunId}\0${record.note.source_id}`, { ...record, source_run_id: sourceRunId });
		}
	}
	const deepRoot = join(input.goalDir, "artifacts", "deep-search");
	const artifactRefs = (existsSync(deepRoot) ? readdirSync(deepRoot) : [])
		.filter(name => /^[A-Za-z0-9._-]{1,100}\.json$/u.test(name))
		.map(name => ({ path: `artifacts/deep-search/${name}`, sha256: sha256(readFileSync(join(deepRoot, name))) }));
	const imported = createCueCornellSnapshot({ ...input, artifactRefs });
	for (const record of imported.notes) {
		const key = `${record.source_run_id}\0${record.note.source_id}`;
		const previous = records.get(key);
		if (!previous) { records.set(key, record); continue; }
		if (previous.source_revision_sha256 !== record.source_revision_sha256) throw new Error(`Cornell Source revision conflict: ${record.note.source_id}`);
		const known = new Set(previous.note.sections.flatMap(section => section.cue_notes.flatMap(cue => cue.origin_ref ? [cue.origin_ref] : [])));
		previous.note.sections.push(...record.note.sections.flatMap(section => {
			const cues = section.cue_notes.filter(cue => !cue.origin_ref || !known.has(cue.origin_ref));
			return cues.length ? [{ ...section, cue_notes: cues }] : [];
		}));
	}
	return validateCornellNotesSnapshot({ ...imported,
		pipeline: { id: "goal-cornell-corpus", version: "1", sha256: hashJson({ contract: "goal-cornell-corpus", version: 1 }) },
		notes: [...records.values()] });
}
