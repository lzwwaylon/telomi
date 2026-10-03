import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { sha256 } from "../../server/lib/hash.js";
import { snapshotInvestigationKnowledge } from "../../server/research/investigate.js";
import { createWikiReferenceAdapterFromRoot } from "../../server/research/pipeline/wiki-report-references.js";
import { listSavedNoteCues } from "../../server/research/note-retrieval.js";
import { resolveWikiEdition } from "../../server/wiki/editions.js";
import { createGoalLlmWikiTools } from "../../server/wiki/tools.js";
import { serverRuntimeDirForGoal } from "../../server/workspaces/server-runtime-paths.js";

const workspace = mkdtempSync(join(tmpdir(), "investigation-knowledge-"));
try {
	const goalId = "goal_cold_start";
	const goalDir = join(workspace, goalId);
	mkdirSync(goalDir);
	const runRoot = join(serverRuntimeDirForGoal(goalId, workspace), "research", "investigations", "cold-start");
	const emptySnapshot = join(runRoot, "input", "wiki");
	assert.throws(() => resolveWikiEdition(workspace, goalId), /Wiki Edition not found/u,
		"the original investigation precondition fails for a Goal without published knowledge");
	const emptyHash = snapshotInvestigationKnowledge(goalDir, goalId, emptySnapshot);
	assert.equal(emptyHash, sha256(""));
	assert.deepEqual(readdirSync(emptySnapshot), [], "the frozen empty state contains no fabricated Wiki Edition");
	assert.deepEqual(listSavedNoteCues(emptySnapshot), []);
	const adapter = createWikiReferenceAdapterFromRoot(emptySnapshot,
		createGoalLlmWikiTools({ goalDir, knowledgeRoot: emptySnapshot }));
	assert.deepEqual(adapter.pageRefs, []);
	const search = adapter.tools.find((tool) => tool.name === "wiki_search");
	assert.ok(search);
	const searched = await search.execute("cold-start-overview", { query: "training loss", top_k: 5 }, new AbortController().signal);
	assert.deepEqual((searched.details as { results: unknown[] }).results, [],
		"the same Wiki Tool used by knowledge_search returns an empty overview instead of failing");
	assert.equal(existsSync(join(goalDir, "wiki", "knowledge")), false, "investigation does not publish fake knowledge");

	const published = join(goalDir, "wiki", "knowledge");
	writeEdition(published);
	assert.equal(snapshotInvestigationKnowledge(goalDir, goalId, emptySnapshot), emptyHash,
		"a resumed investigation retains its empty snapshot after later publication");
	assert.deepEqual(readdirSync(emptySnapshot), []);
	const populatedSnapshot = join(runRoot, "later-input", "wiki");
	const populatedHash = snapshotInvestigationKnowledge(goalDir, goalId, populatedSnapshot);
	assert.notEqual(populatedHash, emptyHash);
	assert.equal(readFileSync(join(populatedSnapshot, "page.md"), "utf-8"), "# Implementation\n\ntraining loss\n");
	writeFileSync(join(published, "page.md"), "# Changed after pinning\n");
	assert.equal(snapshotInvestigationKnowledge(goalDir, goalId, populatedSnapshot), populatedHash);
	assert.equal(readFileSync(join(populatedSnapshot, "page.md"), "utf-8"), "# Implementation\n\ntraining loss\n");

	const corruptGoal = join(workspace, "goal_corrupt");
	mkdirSync(join(corruptGoal, "wiki", "knowledge"), { recursive: true });
	writeFileSync(join(corruptGoal, "wiki", "knowledge", ".topic-plan.json"), "{");
	const corruptSnapshot = join(workspace, "corrupt-snapshot");
	assert.throws(() => snapshotInvestigationKnowledge(corruptGoal, "goal_corrupt", corruptSnapshot), SyntaxError);
	assert.equal(existsSync(corruptSnapshot), false, "a damaged Edition is not converted into empty knowledge");
	const unsafeGoal = join(workspace, "goal_unsafe");
	const resultRoot = join(unsafeGoal, "wiki", "updates", "update-1", "artifacts", "wiki-update");
	mkdirSync(resultRoot, { recursive: true });
	writeFileSync(join(resultRoot, "result.json"), JSON.stringify({ status: "succeeded", compilation_id: "compilation-1",
		knowledge_ref: "../../../../../../outside" }));
	assert.throws(() => snapshotInvestigationKnowledge(unsafeGoal, "goal_unsafe", join(workspace, "unsafe-snapshot")), /escapes its update/u);
	const linkedGoal = join(workspace, "goal_linked");
	writeEdition(join(linkedGoal, "wiki", "knowledge"));
	const outside = join(workspace, "outside.md");
	writeFileSync(outside, "outside material\n");
	symlinkSync(outside, join(linkedGoal, "wiki", "knowledge", "linked.md"));
	assert.throws(() => snapshotInvestigationKnowledge(linkedGoal, "goal_linked", join(workspace, "linked-snapshot")), /contains symlink/u);
} finally {
	rmSync(workspace, { recursive: true, force: true });
}

function writeEdition(root: string): void {
	mkdirSync(root, { recursive: true });
	writeFileSync(join(root, ".topic-plan.json"), JSON.stringify({ revision: "a".repeat(64) }));
	writeFileSync(join(root, "page.md"), "# Implementation\n\ntraining loss\n");
}
