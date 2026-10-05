/**
 * Cornell Evidence Corpus contract.
 *
 * Research produces Cornell Notes and Wiki curates Editions from them, so the contract
 * belongs to neither: it is owned here and imported directly by both. A Wiki Edition is a
 * derived knowledge product, while this Corpus stays the authority for historical evidence.
 */
import { Type, type Static } from "@sinclair/typebox";

import { validateSchema } from "../agent-runtime/structured-output.js";
import { assertNoDuplicates } from "../lib/values.js";

const NonEmptyString = Type.String({ minLength: 1 });
const Sha256 = Type.String({ pattern: "^[a-f0-9]{64}$" });
const RuntimeId = Type.String({
	minLength: 1,
	maxLength: 200,
	pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]*$",
});

const SourceNoteEvidenceSchema = Type.Object({
	source_run_id: Type.Optional(RuntimeId),
	source_id: Type.Optional(RuntimeId),
	source_revision_sha256: Type.Optional(Sha256),
	source_title: Type.Optional(NonEmptyString),
	canonical_locator: Type.Optional(NonEmptyString),
	source_path: NonEmptyString,
	start_line: Type.Integer({ minimum: 1 }),
	end_line: Type.Integer({ minimum: 1 }),
	content_sha256: Sha256,
}, { additionalProperties: false });

const SourceCueNoteSchema = Type.Object({
	/** Imported question-scoped Cues keep their original durable identity. */
	origin_ref: Type.Optional(Type.String({ pattern: "^deep-search:[A-Za-z0-9._-]{1,100}:cue-[1-9][0-9]*$" })),
	cue: NonEmptyString,
	note: NonEmptyString,
	evidence: Type.Array(SourceNoteEvidenceSchema, { minItems: 1 }),
	topic_refs: Type.Optional(Type.Array(NonEmptyString, { uniqueItems: true })),
	discovery: Type.Optional(Type.Object({
		finding: NonEmptyString,
	}, { additionalProperties: false })),
}, { additionalProperties: false });

const SourceNoteSectionSchema = Type.Object({
	section_title: NonEmptyString,
	summary: NonEmptyString,
	cue_notes: Type.Array(SourceCueNoteSchema, { minItems: 1 }),
}, { additionalProperties: false });

const SourceNoteSchema = Type.Object({
	schema_version: Type.Literal(1),
	source_id: RuntimeId,
	sections: Type.Array(SourceNoteSectionSchema),
}, { additionalProperties: false });

const SourceNoteRecordSchema = Type.Object({
	source_run_id: Type.Optional(RuntimeId),
	note: SourceNoteSchema,
	title: NonEmptyString,
	canonical_locator: NonEmptyString,
	provider_id: RuntimeId,
	provenance_ref: NonEmptyString,
	source_revision_sha256: Sha256,
	members: Type.Array(Type.Object({
		source_id: RuntimeId,
		provider_id: RuntimeId,
		title: NonEmptyString,
		canonical_locator: NonEmptyString,
	}, { additionalProperties: false })),
}, { additionalProperties: false });

const SourceNotesSnapshotSchema = Type.Object({
	schema_version: Type.Literal(1),
	snapshot_id: RuntimeId,
	run_id: RuntimeId,
	pipeline: Type.Object({
		id: RuntimeId,
		version: NonEmptyString,
		sha256: Sha256,
	}, { additionalProperties: false }),
	source_bundle_refs: Type.Array(NonEmptyString, { uniqueItems: true }),
	notes: Type.Array(SourceNoteRecordSchema),
}, { additionalProperties: false });

export type SourceNoteRecord = Static<typeof SourceNoteRecordSchema>;
export type SourceNotesSnapshot = Static<typeof SourceNotesSnapshotSchema>;

export function validateSourceNotesSnapshot(value: unknown): SourceNotesSnapshot {
	const snapshot = validateSchema(SourceNotesSnapshotSchema, value);
	assertNoDuplicates(snapshot.source_bundle_refs, "Cornell Notes source_bundle_refs");
	assertNoDuplicates(snapshot.notes.map((item) => `${item.source_run_id ?? snapshot.run_id}\0${item.note.source_id}`), "Cornell Note source_id");
	assertNoDuplicates(snapshot.notes.flatMap((item) => item.note.sections.flatMap((section) =>
		section.cue_notes.flatMap((cue) => cue.origin_ref ? [cue.origin_ref] : []))), "Cornell Cue origin_ref");
	for (const record of snapshot.notes) {
		if (!record.provenance_ref.includes(":")) {
			throw new Error(`Cornell Note '${record.note.source_id}' has an invalid provenance_ref`);
		}
		for (const cue of record.note.sections.flatMap(section => section.cue_notes)) {
			if (!cue.origin_ref) continue;
			if (!record.source_run_id || cue.evidence.some(anchor => !anchor.source_run_id || !anchor.source_id || !anchor.source_revision_sha256)) {
				throw new Error(`Imported Cornell Cue '${cue.origin_ref}' requires complete original Source identity`);
			}
			const primary = cue.evidence[0]!;
			if (primary.source_run_id !== record.source_run_id || primary.source_id !== record.note.source_id
				|| primary.source_revision_sha256 !== record.source_revision_sha256) {
				throw new Error(`Imported Cornell Cue '${cue.origin_ref}' has an invalid primary Source identity`);
			}
		}
		for (const evidence of record.note.sections.flatMap((section) =>
			section.cue_notes.flatMap((note) => note.evidence))) {
			if (evidence.end_line < evidence.start_line) {
				throw new Error(`Cornell Note '${record.note.source_id}' has an invalid Evidence range`);
			}
			const identity = [evidence.source_run_id, evidence.source_id, evidence.source_revision_sha256];
			if (identity.some((field) => field !== undefined) && identity.some((field) => field === undefined)) {
				throw new Error(`Cornell Note '${record.note.source_id}' has an incomplete Source identity`);
			}
		}
	}
	return snapshot;
}

export function validateSourceNoteArtifact(value: unknown): SourceNoteRecord["note"] {
	const note = validateSchema(SourceNoteSchema, value);
	const originalFields = new Set(["source_path", "start_line", "end_line", "content_sha256"]);
	if (note.sections.some(section => section.cue_notes.some(cue => cue.origin_ref !== undefined
		|| cue.evidence.some(anchor => Object.keys(anchor).some(key => !originalFields.has(key)))))) {
		throw new Error("Cornell Note artifact cannot supply Runtime-owned Cue or Source identities");
	}
	return note;
}
