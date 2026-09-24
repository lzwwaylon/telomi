/** Configuration API to the Schedule reviewer and Wiki maintainers through native Prime transport, using only local HTTP. */
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startConsumerConfiguration } from "./fixtures/consumer-configuration.js";

const harness = await startConsumerConfiguration();
const { root, env, signal, apply, configure, stopped, selected } = harness;
const { runPrimeScheduleReviewer } = await import("../../server/research/schedules/reviewer.js");
const { curateWikiEdition } = await import("../../server/wiki/wiki-shard-merge.js");
const { runPrimeNoteWikiMaintainer, NOTE_WIKI_MAINTAINER_CONTRACT_VERSION } = await import("../../server/wiki/note-wiki-maintainer.js");
const draftRoot = join(root, "wiki-draft");
mkdirSync(draftRoot);
writeFileSync(join(draftRoot, ".note-registry.json"), JSON.stringify({
	schema_version: 2, contract_version: NOTE_WIKI_MAINTAINER_CONTRACT_VERSION, entries: [],
}));
writeFileSync(join(draftRoot, ".deferred-notes.json"), "[]");
const topicPlan = { schema_version: 1 as const, goal_id: "test", revision: "v1", status: "active" as const,
	topics: [{ id: "topic", title: "Topic", intent: "Knowledge", questions: [], include: [], exclude: [] }] };
try {
	await apply("second", "high");
	await configure({ stageThinkingLevels: { "primeRoot.scheduleReview": "low", "wikiMaintainer.maintenance": "low" },
		taskModels: { primeChild: "consumer-test/child", wikiMaintainer: "consumer-test/first" } });
	await stopped(() => runPrimeScheduleReviewer({ language: "en", goalId: "test", workspaceDir: root, reviewId: "review", root: join(root, "review"),
		schedule: { id: "schedule", question: "Question", monitoringScope: "Scope", reportContext: "Context", runs: [] },
		previousReview: null, answerTool: async () => ({}), signal, env }), "second", "low");
	await stopped(() => curateWikiEdition({ operation: "initialize", goal: "Goal", topicPlan, draftRoots: [draftRoot],
		workRoot: join(root, "wiki-curator"), sessionRoot: join(root, "wiki-sessions"), signal, env }), "first", "low");
	assert.deepEqual(selected("wiki-curator/curator").scoped, [{ model: "first", thinking: "low" }, { model: "child", thinking: "low" }]);
	await stopped(() => runPrimeNoteWikiMaintainer({ goal: "Goal", goalContext: { title: "Goal", description: "Knowledge" }, topicPlan,
		evidence: { schema_version: 1, snapshot_id: "snapshot", run_id: "run", pipeline: { id: "test", version: "1", sha256: "a".repeat(64) },
			source_bundle_refs: [], notes: [] },
		workRoot: join(root, "wiki-shard"), sessionRoot: join(root, "shard-sessions"),
		batch: { id: "batch", index: 0, total: 1, sourceIds: [] }, signal, env }), "first", "low");
	await configure({ taskModels: {} });
	await stopped(() => curateWikiEdition({ operation: "initialize", goal: "Goal", topicPlan, draftRoots: [draftRoot],
		workRoot: join(root, "wiki-inherited"), sessionRoot: join(root, "wiki-inherited-sessions"), signal, env }), "second", "low");
	console.log("Schedule reviewer and Wiki maintainers adopt API task models and stage depths, and reach native local transport");
} finally {
	await harness.close();
}
