import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { listWikiEditions, resolveWikiEdition } from "../../server/wiki/editions.js";

const workspaceDir = mkdtempSync(join(tmpdir(), "telomi-wiki-editions-"));
const goalId = "goal-editions";
const currentRevision = "a".repeat(64);
const historicalRevision = "b".repeat(64);

try {
	writeEdition(join(workspaceDir, goalId, "wiki", "knowledge"), currentRevision, "Current page");
	const updateId = "wiki-history";
	const compilationId = "note-wiki-history";
	const resultRoot = join(workspaceDir, goalId, "wiki", "updates", updateId, "artifacts", "wiki-update");
	mkdirSync(resultRoot, { recursive: true });
	writeFileSync(join(resultRoot, "result.json"), `${JSON.stringify({
		status: "succeeded", compilation_id: compilationId, publication_status: "promoted", finished_at: "2026-08-01T00:00:00.000Z",
	}, null, 2)}\n`);
	const historicalRoot = join(workspaceDir, goalId, "wiki", "updates", updateId, "artifacts", "wiki-compilations", compilationId, "knowledge");
	writeEdition(historicalRoot, historicalRevision, "Historical page");

	const editions = listWikiEditions(workspaceDir, goalId);
	assert.deepEqual(editions.map(({ revision, source }) => [revision, source]), [
		[currentRevision, "published"],
		[historicalRevision, "wiki_update"],
	]);
	assert.equal(resolveWikiEdition(workspaceDir, goalId).root, join(workspaceDir, goalId, "wiki", "knowledge"));
	assert.equal(resolveWikiEdition(workspaceDir, goalId, historicalRevision).root, historicalRoot);
	assert.throws(() => resolveWikiEdition(workspaceDir, goalId, "d".repeat(64)), /not found/u);
	console.log("Wiki Edition revision resolver passed");
} finally {
	rmSync(workspaceDir, { recursive: true, force: true });
}

function plan(goalId: string, revision: string) {
	return {
		schema_version: 1 as const,
		goal_id: goalId,
		revision,
		status: "active" as const,
		topics: [{ id: "topic-test", title: "Test", intent: "Test editions.", questions: [], include: [], exclude: [] }],
	};
}

function writeEdition(root: string, revision: string, title: string): void {
	mkdirSync(join(root, "concepts"), { recursive: true });
	writeFileSync(join(root, ".topic-plan.json"), `${JSON.stringify(plan(goalId, revision), null, 2)}\n`);
	writeFileSync(join(root, "concepts", "page.md"), `---\ntype: concept\ntitle: ${title}\nprimary_topic_ref: topic-test\ntopic_refs: [topic-test]\n---\n\n# ${title}\n`);
}
