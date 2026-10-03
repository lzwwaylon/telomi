import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { sha256 } from "../../server/lib/hash.js";
import { noteWikiEntries } from "../../server/wiki/note-entries.js";
import { listSavedNoteCues, rankSavedNoteCues, resolveSavedNoteCue } from "../../server/research/note-retrieval.js";
import { MainWikiCitationSession } from "../../server/main-agent/wiki-citations.js";
import { resolveMessageCitationSourcePreview } from "../../server/citations/preview.js";

const workspace = mkdtempSync(join(tmpdir(), "saved-cornell-cues-"));
try {
	const goalId = "goal-test";
	const goalDir = join(workspace, goalId);
	const runId = "run-001";
	const runRoot = join(goalDir, "wiki", "runs", runId);
	const sequence = join(runRoot, "artifacts", "find-out-sources", "sequence-1");
	const member = "members/browser/candidate-one";
	const source = join(sequence, "sources", "source-one");
	const document = join(source, member, "document.md");
	const knowledgeRoot = join(goalDir, "wiki", "knowledge");
	const notesRoot = join(runRoot, "artifacts", "cornell-notes");
	mkdirSync(join(source, member), { recursive: true });
	mkdirSync(knowledgeRoot, { recursive: true });
	mkdirSync(notesRoot, { recursive: true });
	const sourceText = "Gemini Flash TTS scored 71.4 for voice design and 60.8 for accent modeling.\n";
	writeFileSync(document, sourceText);
	const revision = sha256("source-revision");
	writeFileSync(join(sequence, "manifest.json"), JSON.stringify({ sources: [{
		source_id: "source:one", revision_sha256: revision, title: "Gemini Flash TTS",
		path: "sources/source-one", members: [{ source_id: "source:member", title: "Gemini Flash TTS",
			canonical_locator: "https://example.test/gemini", path: member }],
	}] }));
	const snapshot = {
		schema_version: 1, snapshot_id: "snapshot:test", run_id: runId,
		pipeline: { id: "research", version: "1", sha256: sha256("pipeline") }, source_bundle_refs: [],
		notes: [{ note: { schema_version: 1, source_id: "source:one", sections: [{
			section_title: "Evaluation", summary: "The vendor did not supply a reproducible protocol.",
			cue_notes: [{ cue: "Hume scores", note: "Voice design scored 71.4 and accent modeling scored 60.8; no reproducible protocol was supplied.",
				evidence: [{ source_path: `${member}/document.md`, start_line: 1, end_line: 1,
					content_sha256: sha256(sourceText) }] }],
		}] }, title: "Gemini Flash TTS", canonical_locator: "https://example.test/gemini",
			provider_id: "browser", provenance_ref: "provider:browser:source:one", source_revision_sha256: revision,
			members: [{ source_id: "source:member", provider_id: "browser", title: "Gemini Flash TTS",
				canonical_locator: "https://example.test/gemini" }] }],
	} as const;
	writeFileSync(join(notesRoot, "snapshot-1.json"), JSON.stringify(snapshot));
	const entry = noteWikiEntries(snapshot as never)[0]!;
	writeFileSync(join(knowledgeRoot, ".note-registry.json"), JSON.stringify({ schema_version: 2, entries: [entry] }));
	const [cue] = listSavedNoteCues(knowledgeRoot);
	assert.equal(cue?.kind, "cornell");
	assert.equal(rankSavedNoteCues([cue!, { ref: "irrelevant", cue: "Qwen training", note: "A separate TTS system" }],
		"Gemini Hume voice design accent modeling scores", 2)[0]?.ref, cue!.ref);
	assert.equal(resolveSavedNoteCue(goalDir, cue!.ref)?.evidence[0]?.excerpt, sourceText.trim());

	const session = new MainWikiCitationSession({ goalDir, goalId, workspaceDir: workspace });
	const message = { role: "assistant", timestamp: Date.now(),
		content: [{ type: "text", text: `The vendor reports 71.4 and 60.8. <cite>${cue!.ref}</cite>` }] };
	assert.equal(await session.compileMessage(message), true);
	assert.match(message.content[0]!.text, /\[\[1\]\]/u);
	const preview = resolveMessageCitationSourcePreview(goalDir, (message as typeof message & { citationMessageId: string }).citationMessageId, "", 1);
	assert.equal(preview?.clues[0]?.excerpts[0]?.text, sourceText.trim());
	assert.equal(preview?.clues[0]?.excerpts[0]?.sourceRevisionSha256, revision);
	writeFileSync(document, "The score changed.\n");
	assert.throws(() => resolveSavedNoteCue(goalDir, cue!.ref), /Evidence Source range changed/u);
} finally {
	rmSync(workspace, { recursive: true, force: true });
}
