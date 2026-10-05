import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { RunArtifactStore } from "../../server/agent-runtime/artifact-store.js";
import { sha256 } from "../../server/lib/hash.js";
import { enrichInvestigationCues } from "../../server/research/investigate.js";
import { materializeOrganizedSources } from "../../server/research/pipeline/organized-sources.js";

import { createInvestigationCitationScope } from "../../server/research/investigation-citations.js";

const refs = createInvestigationCitationScope();
const cue = {
	ref: "deep-search:abc123:cue-1", section_title: "Loss", cue: "Loss normalization",
	note: "Ignored labels are excluded from the mean.",
	evidence: [{ source_path: "src/loss.py", start_line: 7, end_line: 12,
		source_id: "source:long-internal-id", source_run_id: "saved-run", source_revision_sha256: "b".repeat(64),
		content_sha256: "a".repeat(64), excerpt: "ignore_index=-100",
		title: "Saved upstream fork", url: "https://github.com/example/upstream-fork" }],
};
const [first] = refs.projectCues([cue]);
assert.equal(first?.ref, "N1");
assert.equal(refs.projectCues([cue])[0]?.ref, "N1");
assert.equal(refs.projectCues([{ ...cue, ref: "note:run:other-long-id" }])[0]?.ref, "N2");
assert.equal(first?.evidence[0]?.excerpt, "ignore_index=-100");
assert.ok(!JSON.stringify(first).includes("content_sha256"));
assert.ok(!JSON.stringify(first).includes("source:long-internal-id"));
assert.ok(!JSON.stringify(first).includes("source_run_id"));
assert.ok(!JSON.stringify(first).includes("source_revision_sha256"));
assert.equal(first?.evidence[0]?.title, "Saved upstream fork");
assert.equal(first?.evidence[0]?.url, "https://github.com/example/upstream-fork");
refs.allowWikiRef("C1");
assert.equal(refs.resolve("C1"), "C1");
assert.equal(refs.resolve("N1"), cue.ref);
assert.equal(refs.project(cue.ref), "N1");
assert.equal(refs.project("C1"), "C1");
assert.throws(() => refs.project("deep-search:unread:cue-1"), /unknown evidence/u);
assert.deepEqual(refs.restore({ answer: "Evidence <cite>N1</cite> and context <cite>C1</cite>.",
	citation_refs: ["N1", "C1"] }), {
	answer: `Evidence <cite>${cue.ref}</cite> and context <cite>C1</cite>.`,
	citation_refs: [cue.ref, "C1"],
});
assert.throws(() => refs.resolve(cue.ref), /unknown evidence/u);
assert.throws(() => refs.resolve("N3"), /unknown evidence/u);
assert.throws(() => refs.allowWikiRef("C0"), /Invalid Wiki citation/u);

const root = mkdtempSync(join(tmpdir(), "telomi-cue-provenance-"));
try {
	const material = join(root, "input");
	mkdirSync(material, { recursive: true });
	writeFileSync(join(material, "loss.py"), "ignore_index=-100\n");
	const { sources } = materializeOrganizedSources({
		artifactStore: new RunArtifactStore(join(root, "wiki", "runs", "saved-run")), sequence: 1,
		workingDirectory: join(root, "build"),
		members: [{ candidateId: "candidate-code", sourceId: "source-code", providerId: "github",
			title: "Saved upstream fork", url: "https://github.com/example/upstream-fork",
			summary: "Training code", sourceDirectory: material }],
		organization: { groups: [], ungrouped: [{ candidate_id: "candidate-code", reason: "Relevant source" }] },
	});
	const source = sources[0]!;
	const savedCue = { ...cue, question: "How is loss computed?", kind: "read_sources", evidence: [{
		source_run_id: "saved-run", source_id: source.id, source_revision_sha256: source.revisionSha256,
		source_path: `${source.members[0]!.path}/loss.py`, start_line: 1, end_line: 1,
		content_sha256: sha256("ignore_index=-100\n"),
	}] };
	mkdirSync(join(root, "artifacts", "deep-search"), { recursive: true });
	writeFileSync(join(root, "artifacts", "deep-search", "abc123.json"), JSON.stringify({
		schema_version: 1, question: savedCue.question, status: "found", summary: savedCue.note, gaps: [], cues: [savedCue],
	}));
	const [enriched] = enrichInvestigationCues(root, [savedCue]);
	assert.equal(enriched?.question, savedCue.question, "ranking metadata survives provenance resolution");
	assert.equal(enriched?.kind, savedCue.kind);
	assert.deepEqual(enriched?.evidence[0], { ...savedCue.evidence[0], excerpt: "ignore_index=-100",
		title: "Saved upstream fork", url: "https://github.com/example/upstream-fork" },
		"Capture receives original source identities plus verified Source member provenance");
	assert.deepEqual(refs.projectCues(enriched ? [enriched] : [])[0]?.evidence[0], {
		source_path: savedCue.evidence[0]!.source_path, start_line: 1, end_line: 1,
		excerpt: "ignore_index=-100", title: "Saved upstream fork", url: "https://github.com/example/upstream-fork",
	}, "Prime sees source provenance and exact text without internal identities or hashes");
	const historical = { ...cue, ref: "note:run:cue", source_title: "Older Cornell Source",
		canonical_locator: "https://example.org/paper" };
	assert.equal(enrichInvestigationCues(root, [historical])[0], historical, "historical Cornell metadata remains compatible");
	assert.equal(refs.projectCues([historical])[0]?.canonical_locator, historical.canonical_locator);
} finally {
	rmSync(root, { recursive: true, force: true });
}

console.log("Prime investigation short citation scope and Source provenance passed");
