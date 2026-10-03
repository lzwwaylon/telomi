import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { createDiscoveryProjection } from "../../server/goals/topic-plan/discovery-projection.js";
import type { DiscoveryCandidate } from "../../server/goals/topic-plan/contracts.js";

const goalDirectory = mkdtempSync(join(tmpdir(), "telomi-discovery-projection-"));
const sourceId = "logical-group";
const candidate: DiscoveryCandidate = {
	schema_version: 1,
	id: "discovery-projection",
	goal_id: "goal-projection",
	topic_plan_revision: "revision-frozen",
	finding: "A finding from selected grouped material",
	run_id: "run-frozen",
	source_id: sourceId,
	section_index: 0,
	cue_index: 0,
	cue: "Evidence provenance",
	note: "The specific material supports this finding.",
	evidence: [
		"members/paper/content.md",
		"members/paper/appendix.md",
		"members/repo/README.md",
		"members/repo/package/readme.md",
		"members/local/content.md",
		"members/unsafe/content.md",
		"members/broken/content.md",
		"members/untitled/content.md",
		"members/absent/content.md",
		"members/paper-other/content.md",
	].map((source_path) => ({ source_path, start_line: 1, end_line: 1, content_sha256: "a".repeat(64) })),
	status: "open",
	created_at: "2026-01-01T00:00:00.000Z",
};
const members = [
	{ source_id: "paper", path: "members/paper", title: "Paper title", canonical_locator: "https://papers.example/paper" },
	{ source_id: "repo", path: "members/repo", title: "Repository", canonical_locator: "http://code.example/repo" },
	{ source_id: "package", path: "members/repo/package", title: "Package", canonical_locator: "https://code.example/package" },
	{ source_id: "local", path: "members/local", title: "Uploaded research notes", canonical_locator: "file:///private/notes.pdf" },
	{ source_id: "unsafe", path: "members/unsafe", title: "Unsafe locator", canonical_locator: "javascript:alert(1)" },
	{ source_id: "broken", path: "members/broken", title: "Malformed locator", canonical_locator: "https://" },
	{ source_id: "untitled", path: "members/untitled", canonical_locator: "https://papers.example/untitled" },
	{ source_id: "unrelated", path: "members/unrelated", title: "Uncited sibling", canonical_locator: "https://papers.example/unrelated" },
];

try {
	const manifest = manifestPath(candidate.run_id);
	put(manifest, JSON.stringify({ sources: [{ source_id: sourceId, path: "sources/group", title: "Grouped research", members }] }));
	const before = JSON.stringify(candidate);
	const project = createDiscoveryProjection(goalDirectory);
	const view = project(candidate);
	assert.deepEqual(view.sources, [
		{ id: "paper", title: "Paper title", url: "https://papers.example/paper" },
		{ id: "repo", title: "Repository", url: "http://code.example/repo" },
		{ id: "package", title: "Package", url: "https://code.example/package" },
		{ id: "local", title: "Uploaded research notes" },
		{ id: "unsafe", title: "Unsafe locator" },
		{ id: "broken", title: "Malformed locator" },
		{ id: "untitled", title: "Grouped research", url: "https://papers.example/untitled" },
	], "Only cited members, longest matching member and first-evidence order belong in the projection");
	assert.equal(JSON.stringify(candidate), before, "API metadata must not mutate the persisted Candidate");
	assert.deepEqual({ ...view, sources: undefined }, { ...candidate, sources: undefined });

	// Reading the same Run/Source again reuses its metadata for the rest of this request.
	put(manifest, JSON.stringify({ sources: [{ source_id: sourceId, path: "sources/group", members: [{
		...members[0], title: "Fresh request metadata",
	}] }] }));
	assert.deepEqual(project({ ...candidate, id: "another-candidate" }).sources, view.sources);
	assert.equal(createDiscoveryProjection(goalDirectory)(candidate).sources[0]?.title, "Fresh request metadata");

	const missingRun = { ...candidate, run_id: "missing-run" };
	assert.deepEqual(project(missingRun).sources, []);
	put(manifestPath(missingRun.run_id), JSON.stringify({ sources: [{ source_id: sourceId, path: "sources/group", title: "Grouped research", members }] }));
	assert.deepEqual(project(missingRun).sources, [], "Missing Source lookups are cached within the request too");
	assert.deepEqual(createDiscoveryProjection(goalDirectory)(missingRun).sources, view.sources);

	const corrupt = { ...candidate, run_id: "corrupt-run" };
	put(manifestPath(corrupt.run_id), "{not-json");
	assert.deepEqual(project(corrupt).sources, []);
	assert.deepEqual(project(candidate).sources, view.sources, "Missing historical metadata cannot hide healthy Inbox items");
	assert.deepEqual(project({ ...candidate, source_id: "unknown-source" }).sources, []);
	assert.deepEqual(project({ ...candidate, run_id: "../../outside" }).sources, []);

	put(manifestPath("malformed-members"), JSON.stringify({ sources: [{
		source_id: sourceId, path: "sources/group", members: [null, {}, members[0]],
	}] }));
	assert.equal(project({ ...candidate, run_id: "malformed-members" }).sources[0]?.id, "paper");
	put(manifestPath("absent-members"), JSON.stringify({ sources: [{
		source_id: sourceId, path: "sources/group", members: {},
	}] }));
	assert.deepEqual(project({ ...candidate, run_id: "absent-members" }).sources, []);

	// Matching can anchor the member itself, and another Run never replaces the pinned provenance.
	put(manifestPath("run-new"), JSON.stringify({ sources: [{ source_id: sourceId, path: "sources/group", members: [{
		...members[0], title: "New Run title",
	}] }] }));
	assert.equal(project({ ...candidate, run_id: "run-new" }).sources[0]?.title, "New Run title");
	assert.equal(project(candidate).sources[0]?.title, "Paper title");
	assert.equal(project({ ...candidate, evidence: [{ ...candidate.evidence[0]!, source_path: "members/paper" }] }).sources[0]?.id, "paper");
	console.log("Discovery source projection preserves pinned evidence, safe links, immutable records and request isolation");
} finally {
	rmSync(goalDirectory, { recursive: true, force: true });
}

function manifestPath(runId: string): string {
	return join(goalDirectory, "wiki", "runs", runId, "artifacts", "find-out-sources", "sequence-1", "manifest.json");
}

function put(path: string, contents: string): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, contents);
}
