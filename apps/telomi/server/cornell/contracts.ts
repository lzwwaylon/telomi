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

const CornellEvidenceSchema = Type.Object({
	source_path: NonEmptyString,
	start_line: Type.Integer({ minimum: 1 }),
	end_line: Type.Integer({ minimum: 1 }),
	content_sha256: Sha256,
}, { additionalProperties: false });

const CornellCueNoteSchema = Type.Object({
	cue: NonEmptyString,
	note: NonEmptyString,
	evidence: Type.Array(CornellEvidenceSchema, { minItems: 1 }),
	topic_refs: Type.Optional(Type.Array(NonEmptyString, { uniqueItems: true })),
	discovery: Type.Optional(Type.Object({
		finding: NonEmptyString,
	}, { additionalProperties: false })),
}, { additionalProperties: false });

const CornellSectionSchema = Type.Object({
	section_title: NonEmptyString,
	summary: NonEmptyString,
	cue_notes: Type.Array(CornellCueNoteSchema, { minItems: 1 }),
}, { additionalProperties: false });

const CornellNoteSchema = Type.Object({
	schema_version: Type.Literal(1),
	source_id: RuntimeId,
	sections: Type.Array(CornellSectionSchema),
}, { additionalProperties: false });

const CornellNoteRecordSchema = Type.Object({
	note: CornellNoteSchema,
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

const CornellNotesSnapshotSchema = Type.Object({
	schema_version: Type.Literal(1),
	snapshot_id: RuntimeId,
	run_id: RuntimeId,
	pipeline: Type.Object({
		id: RuntimeId,
		version: NonEmptyString,
		sha256: Sha256,
	}, { additionalProperties: false }),
	source_bundle_refs: Type.Array(NonEmptyString, { uniqueItems: true }),
	notes: Type.Array(CornellNoteRecordSchema),
}, { additionalProperties: false });

export type CornellNoteRecord = Static<typeof CornellNoteRecordSchema>;
export type CornellNotesSnapshot = Static<typeof CornellNotesSnapshotSchema>;

export function validateCornellNotesSnapshot(value: unknown): CornellNotesSnapshot {
	const snapshot = validateSchema(CornellNotesSnapshotSchema, value);
	assertNoDuplicates(snapshot.source_bundle_refs, "Cornell Notes source_bundle_refs");
	assertNoDuplicates(snapshot.notes.map((item) => item.note.source_id), "Cornell Note source_id");
	for (const record of snapshot.notes) {
		if (!record.provenance_ref.includes(":")) {
			throw new Error(`Cornell Note '${record.note.source_id}' has an invalid provenance_ref`);
		}
		for (const evidence of record.note.sections.flatMap((section) =>
			section.cue_notes.flatMap((note) => note.evidence))) {
			if (evidence.end_line < evidence.start_line) {
				throw new Error(`Cornell Note '${record.note.source_id}' has an invalid Evidence range`);
			}
		}
	}
	return snapshot;
}

export function validateCornellNoteArtifact(value: unknown): CornellNoteRecord["note"] {
	return validateSchema(CornellNoteSchema, value);
}
