import { join } from "node:path";
import { readJsonl, writeFileAtomic, writeJsonAtomic } from "../../lib/fs.js";
import { sha256 } from "../../lib/hash.js";
import { isRecord } from "../../lib/values.js";
import { readReaderFile } from "./reader-delivery.js";

/** Root selects accepted files; Runtime preserves their Cue text and citations together. */
export async function assembleReaderNote(options: { work: string; runtimeRoot: string; signal: AbortSignal }) {
	options.signal.throwIfAborted();
	const plan: unknown = JSON.parse(readReaderFile(join(options.work, "reader-plan.json")));
	const planKeys = ["status", "summary", "gaps", "notes", "excluded", "include_root_note"];
	if (!isRecord(plan) || Object.keys(plan).some(key => !planKeys.includes(key))) {
		throw new Error(`reader-plan.json must contain status, summary, gaps, notes and excluded and optional include_root_note; Cue text belongs in child files`);
	}
	if (!Array.isArray(plan.notes) || !Array.isArray(plan.excluded)) throw new Error("reader-plan.json notes and excluded must be arrays");
	const notePaths = plan.notes;
	const gaps = readGaps(plan.gaps, "reader-plan.json gaps");
	if (plan.include_root_note !== undefined && typeof plan.include_root_note !== "boolean") throw new Error("include_root_note must be boolean");
	const accepted = new Map<string, { sections: unknown[]; sha256: string; status: unknown; summary: unknown; gaps: string[] }>();
	const latest = new Map<string, { revision: number; path: string }>();
	for (const event of readJsonl<unknown>(join(options.runtimeRoot, "reader-delivery.jsonl"))) {
		if (!isRecord(event) || event.type !== "reader_delivery_accepted") continue;
		if (typeof event.child_id !== "string" || !/^sub-[A-Za-z0-9-]+$/u.test(event.child_id)
			|| !Number.isSafeInteger(event.revision) || Number(event.revision) < 1) throw new Error("Invalid accepted Reader identity");
		const path = `inputs/reader-results/${event.child_id}/${event.revision}/note.json`;
		if (event.note_path !== path || accepted.has(path)) throw new Error("Invalid or duplicate accepted Reader path");
		const bytes = readReaderFile(join(options.work, path));
		if (sha256(bytes) !== event.note_sha256) throw new Error(`Accepted Reader file integrity mismatch: ${path}`);
		const draft: unknown = JSON.parse(bytes);
		if (!isRecord(draft) || !Array.isArray(draft.sections)) throw new Error(`Accepted Reader file has no sections: ${path}`);
		accepted.set(path, { sections: draft.sections, sha256: sha256(bytes), status: draft.status, summary: draft.summary,
			gaps: readGaps(draft.gaps, `Accepted Reader gaps: ${path}`) });
		if ((latest.get(event.child_id)?.revision ?? 0) < Number(event.revision)) latest.set(event.child_id, { revision: Number(event.revision), path });
	}
	const latestPaths = new Set([...latest.values()].map(value => value.path));
	const superseded = [...accepted.keys()].filter(path => !latestPaths.has(path));
	for (const path of superseded) accepted.delete(path);
	const used = new Set<string>();
	const take = (path: unknown) => {
		if (typeof path === "string" && superseded.includes(path)) throw new Error(`Superseded Reader note_path; use the latest accepted revision: ${path}`);
		if (typeof path !== "string" || !accepted.has(path)) throw new Error(`Unknown accepted Reader note_path: ${String(path)}`);
		if (used.has(path)) throw new Error(`Duplicate Reader note_path: ${path}`);
		used.add(path);
		return accepted.get(path)!;
	};
	const sections = notePaths.flatMap(path => {
		const note = take(path);
		gaps.push(...note.gaps);
		return note.sections;
	});
	const exclusions = new Map<string, { reason: string; gaps: string[] }>();
	for (const excluded of plan.excluded) {
		if (!isRecord(excluded) || typeof excluded.note_path !== "string" || Object.keys(excluded).some(key => !["note_path", "reason", "gaps"].includes(key))
			|| typeof excluded.reason !== "string" || !excluded.reason.trim()) throw new Error("Each excluded file needs note_path, a nonempty reason and gaps");
		take(excluded.note_path);
		const excludedGaps = readGaps(excluded.gaps, `Excluded Reader gaps: ${String(excluded.note_path)}`);
		exclusions.set(excluded.note_path, { reason: excluded.reason, gaps: excludedGaps });
		gaps.push(...excludedGaps);
	}
	const missing = [...accepted.keys()].filter(path => !used.has(path));
	if (missing.length) throw new Error(`reader-plan.json has unaccounted accepted files; include them in notes or excluded with a reason: ${missing.join(", ")}`);
	let rootNoteSha256: string | undefined;
	let rootNoteBytes: string | undefined;
	const { validateNoteReadingDraftFromCorpus } = await import("../note-reading.js");
	if (plan.include_root_note) {
		const bytes = readReaderFile(join(options.work, "root-note.json"));
		const draft: unknown = JSON.parse(bytes);
		const validated = validateNoteReadingDraftFromCorpus(draft, "Root supplementary reading", "reader-root", join(options.work, "source"));
		sections.push(...(draft as { sections: unknown[] }).sections);
		gaps.push(...validated.gaps);
		rootNoteSha256 = sha256(bytes);
		rootNoteBytes = bytes;
	}
	const note = { status: plan.status, summary: plan.summary, gaps: [...new Set(gaps)], sections };
	validateNoteReadingDraftFromCorpus(note, "Assembled Reader result", "reader-assembly", join(options.work, "source"));
	options.signal.throwIfAborted();
	if (rootNoteBytes !== undefined) writeFileAtomic(join(options.runtimeRoot, "root-note.json"), rootNoteBytes);
	writeJsonAtomic(join(options.work, "note.json"), note);
	writeJsonAtomic(join(options.runtimeRoot, "reader-assembly.json"), { schema_version: 1, plan,
		superseded,
		sources: [...accepted].map(([note_path, value]) => ({ note_path, note_sha256: value.sha256, included: notePaths.includes(note_path),
			status: value.status, summary: value.summary, gaps: value.gaps,
			...(exclusions.has(note_path) ? { exclusion: exclusions.get(note_path) } : {}) })),
		...(rootNoteSha256 ? { root_note_sha256: rootNoteSha256 } : {}), assembled_note_sha256: sha256(`${JSON.stringify(note, null, 2)}\n`) });
}

function readGaps(value: unknown, label: string): string[] {
	if (!Array.isArray(value) || value.some(gap => typeof gap !== "string" || !gap.trim())) {
		throw new Error(`${label} must be an explicit array of nonempty strings; use [] when there is no unresolved point`);
	}
	return value.map(gap => gap.trim());
}
