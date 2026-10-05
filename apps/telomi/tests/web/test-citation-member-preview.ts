import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";

import { GoalService } from "../../server/goals/service.js";
import { sha256 } from "../../server/lib/hash.js";
import { createArtifactsRouter } from "../../server/media/artifacts-api.js";
import { unusedGoalExecution } from "../goals/unused-execution.js";

const root = mkdtempSync(join(tmpdir(), "citation-member-preview-"));
const goals = new GoalService(root, unusedGoalExecution);
const goalId = "goal_members";
goals.ensureImportedGoal(goalId, "Member citation contract");
const run = join(root, goalId, "wiki/runs/member-report");
const source = join(run, "artifacts/find-out-sources/sequence-1/sources/group");
const snapshot = join(run, "artifacts/report-flow/notes-snapshot");
const urls = ["https://example.test/a", "https://example.test/b", "https://example.test/c"];
const paths = ["members/arxiv/a", "members/github/b", "members/arxiv/c"];
const facts = ["Uncited A finding.", "Cited B finding.", "Uncited C finding."];
const put = (path: string, value: unknown) => {
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value));
};
const members = paths.map((path, index) => ({ source_id: `source:${String.fromCharCode(97 + index)}`,
	path, title: `Member ${index + 1}`, canonical_locator: urls[index] }));
for (const [index, path] of paths.entries()) put(join(source, path, "snippet.txt"), `${facts[index]}\n`);
put(join(run, "artifacts/find-out-sources/sequence-1/manifest.json"), {
	sources: [{ source_id: "source:group", title: "Grouped Source", path: "sources/group", members }],
});
const note = { schema_version: 1, source_id: "source:group", sections: [{
	section_title: "Findings", summary: "Three independent findings.",
	cue_notes: paths.map((path, index) => ({ cue: `Member ${index + 1} cue`, note: facts[index],
		evidence: [{ source_path: `${path}/snippet.txt`, start_line: 1, end_line: 1,
			content_sha256: sha256(`${facts[index]}\n`) }],
	})),
}] };
put(join(snapshot, "notes/one.json"), note);
put(join(snapshot, "index.json"), { schema_version: 1, notes: [{ handle: "@1", source_id: note.source_id,
	title: "Grouped Source", metadata_path: "notes/one.json", source_urls: urls }] });
put(join(run, "artifacts/notes/sequence-1/source.json"), note);
put(join(run, "report/final.md"), "# Grouped Source Report\n");
const citation = { number: 1, title: "Grouped Source", url: urls[0], evidenceId: "source:group" };
const report = (refs?: string[]) => put(join(run, "report/final.json"), {
	citations: [{ ...citation, ...(refs ? { refs } : {}) }],
});
const app = express();
app.use(createArtifactsRouter(root, goals));
const server = app.listen(0, "127.0.0.1");
await once(server, "listening");
const preview = async () => {
	const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/goals/${goalId}/artifacts/citations/preview?name=${encodeURIComponent("wiki/runs/member-report/report/final.md")}&url=${encodeURIComponent(urls[0]!)}&number=1`);
	return { status: response.status, value: await response.json() };
};
try {
	report(["N2"]);
	const exact = await preview();
	assert.equal(exact.status, 200);
	assert.deepEqual(exact.value.clues.map((clue: { note: string }) => clue.note), [facts[1]],
		"a canonical member URL must not hide another member's explicitly cited Note");
	assert.deepEqual(exact.value.clues[0].excerpts, [{ path: "snippet.txt", startLine: 1, endLine: 1,
		text: facts[1], sourceId: "source:b", sourceTitle: "Member 2", sourceUrl: urls[1] }],
		"cross-member evidence carries its actual member identity and member-relative path");
	report(["N1", "N2"]);
	assert.deepEqual((await preview()).value.clues.map((clue: { note: string }) => clue.note), facts.slice(0, 2),
		"only the explicit Note refs are shown, never uncited Notes from the same Source");
	report();
	assert.deepEqual((await preview()).value.clues.map((clue: { note: string }) => clue.note), [facts[0]],
		"Source-only citations remain scoped to the requested member");
	report(["N2"]);
	const index = { schema_version: 1, notes: [{ handle: "@1", source_id: note.source_id,
		title: "Grouped Source", metadata_path: "notes/one.json", source_urls: urls }] };
	const foreign = structuredClone(note);
	foreign.source_id = "source:foreign";
	put(join(snapshot, "notes/one.json"), foreign);
	put(join(snapshot, "index.json"), { ...index, notes: [{ ...index.notes[0], source_id: foreign.source_id }] });
	assert.equal((await preview()).status, 404, "exact Note refs cannot cross Logical Source ownership");
	put(join(snapshot, "notes/one.json"), note);
	put(join(snapshot, "index.json"), index);
	report(["N9"]);
	assert.equal((await preview()).status, 404, "unknown Note refs never borrow the Source-only fallback");
	report(["N2"]);
	writeFileSync(join(source, paths[1]!, "snippet.txt"), "Changed evidence.\n");
	assert.equal((await preview()).status, 400, "cited evidence still verifies its immutable range hash");
	writeFileSync(join(source, paths[1]!, "snippet.txt"), `${facts[1]}\n`);
	note.sections[0]!.cue_notes[1]!.evidence[0]!.source_path = "unlisted/snippet.txt";
	put(join(source, "unlisted/snippet.txt"), `${facts[1]}\n`);
	put(join(snapshot, "notes/one.json"), note);
	assert.equal((await preview()).status, 404, "an unlisted member cannot supply cited Source evidence");
	note.sections[0]!.cue_notes[1]!.evidence[0]!.source_path = `${paths[1]}/../../../../private.txt`;
	put(join(run, "private.txt"), `${facts[1]}\n`);
	put(join(snapshot, "notes/one.json"), note);
	assert.equal((await preview()).status, 400, "member-prefixed traversal cannot escape the Logical Source root");
	console.log("Current citation HTTP keeps exact cross-member Notes, Source-only scope, and hash/member boundaries");
} finally {
	await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
	rmSync(root, { recursive: true, force: true });
}
