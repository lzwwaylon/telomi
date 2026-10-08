import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { SourceNotesSnapshot } from "../../server/notes/contracts.js";
import { serverRuntimeDirForGoalDir } from "../../server/workspaces/server-runtime-paths.js";
import { noteWikiEntries } from "../../server/wiki/note-entries.js";
import { pinDeferredWikiEvidence, readDeferredWikiEvidence, validateDeferredWikiEvidence, writeDeferredWikiEvidence, advanceDeferredWikiEvidence } from "../../server/wiki/deferred-evidence.js";

const root = mkdtempSync(join(tmpdir(), "wiki-deferred-evidence-"));
const goalDir = join(root, "goal_deferred");
const controlDirectory = join(serverRuntimeDirForGoalDir(goalDir), "wiki-updates", "first");
const snapshot: SourceNotesSnapshot = {
	schema_version: 1, snapshot_id: "notes", run_id: "research",
	pipeline: { id: "notes", version: "1", sha256: "a".repeat(64) }, source_bundle_refs: [],
	notes: [{
		title: "Mechanisms", canonical_locator: "https://example.test/mechanisms", provider_id: "test", provenance_ref: "source:mechanisms",
		source_revision_sha256: "b".repeat(64), members: [],
		note: { schema_version: 1, source_id: "mechanisms", sections: [{
			section_title: "Evidence", summary: "Two related findings", cue_notes: ["First", "Second"].map((cue) => ({
				cue, note: `${cue} needs more evidence`, evidence: [{ source_path: "source.txt", start_line: 1, end_line: 2, content_sha256: "b".repeat(64) }],
			})),
		}] },
	}],
};
const entries = noteWikiEntries(snapshot);
const pending = { snapshots: [snapshot], entryIds: [entries[1]!.id] };
try {
	assert.deepEqual(readDeferredWikiEvidence(goalDir), { snapshots: [], entryIds: [] });
	const valid = validateDeferredWikiEvidence(pending);
	assert.equal(valid.snapshots[0]!.notes[0]!.note.sections[0]!.cue_notes.length, 2, "the whole Note retains ordinary Cue index identities");
	assert.equal(noteWikiEntries(valid.snapshots[0]!)[1]!.id, pending.entryIds[0]);
	assert.throws(() => validateDeferredWikiEvidence({ ...pending, entryIds: [entries[1]!.id, entries[1]!.id] }), /duplicate/u);
	assert.throws(() => validateDeferredWikiEvidence({ ...pending, entryIds: ["entry:unknown"] }), /unknown entry/u);
	assert.throws(() => validateDeferredWikiEvidence({ ...pending, entryIds: [7] }), /Invalid deferred/u);
	assert.throws(() => validateDeferredWikiEvidence({ snapshots: [{}], entryIds: [] }));
	assert.throws(() => validateDeferredWikiEvidence({ ...pending, extra: true }), /Invalid deferred/u);
	const revised = structuredClone(snapshot);
	revised.notes[0]!.title = "Revised mechanisms";
	assert.throws(() => validateDeferredWikiEvidence({ snapshots: [snapshot, revised], entryIds: pending.entryIds }), /conflicting revision/u);
	assert.doesNotThrow(() => validateDeferredWikiEvidence({ snapshots: [snapshot, revised], entryIds: [] }), "unselected historical Cues do not impose revision constraints");
	const neighborRevision = structuredClone(snapshot);
	neighborRevision.notes[0]!.note.sections[0]!.cue_notes[0]!.evidence[0]!.end_line = 3;
	assert.doesNotThrow(() => validateDeferredWikiEvidence({ snapshots: [snapshot, neighborRevision], entryIds: pending.entryIds }),
		"a conflicting unselected neighbor does not reject the selected stable Cue");
	assert.doesNotThrow(() => validateDeferredWikiEvidence({ snapshots: [snapshot, structuredClone(snapshot)], entryIds: pending.entryIds }), "identical revisions can be shared by snapshots");
	writeDeferredWikiEvidence(goalDir, pending);
	assert.deepEqual(readDeferredWikiEvidence(goalDir), pending);
	assert.deepEqual(pinDeferredWikiEvidence(controlDirectory, goalDir), pending);
	writeDeferredWikiEvidence(goalDir, { snapshots: [snapshot], entryIds: entries.map(entry => entry.id) });
	advanceDeferredWikiEvidence(goalDir, pending.entryIds, { snapshots: [], entryIds: [] });
	assert.deepEqual(readDeferredWikiEvidence(goalDir), { snapshots: [snapshot], entryIds: [entries[0]!.id] },
		'finishing an older frozen Update preserves later pending evidence outside its input');
	advanceDeferredWikiEvidence(goalDir, [entries[0]!.id], pending);
	assert.deepEqual(readDeferredWikiEvidence(goalDir), pending, 'only processed Cues change disposition; new deferrals retain original identities');
	const pendingBytes = readFileSync(join(serverRuntimeDirForGoalDir(goalDir), 'wiki-deferred-evidence.json'), 'utf8');
	assert.throws(() => advanceDeferredWikiEvidence(goalDir, entries.map(entry => entry.id), { snapshots: [], entryIds: ['unknown'] }));
	assert.equal(readFileSync(join(serverRuntimeDirForGoalDir(goalDir), 'wiki-deferred-evidence.json'), 'utf8'), pendingBytes);
	writeDeferredWikiEvidence(goalDir, { snapshots: [], entryIds: [] });
	assert.deepEqual(pinDeferredWikiEvidence(controlDirectory, goalDir), pending, "retry uses its frozen inputs after later publication changes the Goal state");
	const goalPath = join(serverRuntimeDirForGoalDir(goalDir), "wiki-deferred-evidence.json");
	const before = readFileSync(goalPath, "utf8");
	assert.throws(() => writeDeferredWikiEvidence(goalDir, { ...pending, entryIds: ["unknown"] }));
	assert.equal(readFileSync(goalPath, "utf8"), before, "invalid updates preserve the previous state");
	writeFileSync(goalPath, "{broken");
	assert.throws(() => readDeferredWikiEvidence(goalDir), /Invalid JSON/u);
	assert.deepEqual(pinDeferredWikiEvidence(controlDirectory, goalDir), pending, "retry reads only the pinned input, even if current state is corrupt");
	const newControl = join(controlDirectory, "new");
	assert.throws(() => pinDeferredWikiEvidence(newControl, goalDir), /Invalid JSON/u);
	mkdirSync(newControl, { recursive: true });
	writeFileSync(join(newControl, "deferred-evidence-input.json"), JSON.stringify({ snapshots: [], entryIds: [entries[0]!.id] }));
	assert.throws(() => pinDeferredWikiEvidence(newControl, goalDir), /unknown entry/u, "a damaged checkpoint is never silently replaced");
	console.log("Deferred Wiki evidence tests passed");
} finally {
	rmSync(root, { recursive: true, force: true });
}
