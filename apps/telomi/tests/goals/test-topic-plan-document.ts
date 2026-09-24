import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	GoalTopicPlanStore,
	GoalTopicPlanHistory,
	parseGoalTopicDocument,
	TOPIC_PLAN_DOCUMENT_PATH,
	type GoalTopicDocument,
} from "../../server/goals/topic-plan/index.js";
import { ensureGoalWorkspace } from "../../server/workspaces/goal-project.js";
import { serverRuntimeDirForGoal } from "../../server/workspaces/server-runtime-paths.js";

const root = mkdtempSync(join(tmpdir(), "pi-topic-document-"));
const goalId = "goal-topic-document";
const goalDir = join(root, goalId);

try {
	ensureGoalWorkspace({ goalDir, goalId, title: "Topic document test" });
	const store = new GoalTopicPlanStore(goalId, root);
	const initial: GoalTopicDocument = { topics: [
		{ title: "模型与训练", intent: "关注模型和训练方法。" },
		{ title: "部署与应用", intent: "关注部署和产品应用。" },
	] };
	const proposed = store.syncDocument({ document: initial, source: "main_agent", summary: "建立 Topic" }).proposal!;
	assert.equal(store.readHistory().length, 0, "saving a draft appended confirmed history");
	assert.equal(existsSync(join(goalDir, TOPIC_PLAN_DOCUMENT_PATH)), false,
		"saving a draft replaced the confirmed snapshot");
	const active = store.activate(proposed.proposal_id);
	assert.match(active.revision, /^[a-f0-9]{64}$/u);
	assert.equal(store.readHistory().length, 1);
	assert.deepEqual(
		store.readHistory()[0]!.plan.topics.map((topic) => (topic as { id?: string }).id),
		active.topics.map((topic) => topic.id),
		"confirmed Topic IDs were not written to History",
	);
	const confirmedInitial = readCurrent();
	assert.deepEqual(withoutIds(confirmedInitial), initial);

	const revised: GoalTopicDocument = { topics: [confirmedInitial.topics[1]!] };
	const revision = store.syncDocument({ document: revised, source: "main_agent", summary: "移除基础 Topic" }).proposal!;
	assert.equal(store.readHistory().length, 1, "editing the draft appended confirmed history");
	assert.deepEqual(readCurrent(), confirmedInitial, "editing the draft replaced the confirmed snapshot");
	const next = store.activate(revision.proposal_id);
	assert.equal(store.readHistory().length, 2);
	assert.deepEqual(readCurrent(), revised);
	assert.equal(next.topics[0]!.id, active.topics[1]!.id, "editing a Topic replaced its Runtime-owned ID");
	assert.equal(next.topics.length, 1, "full snapshot activation retained a removed Topic");
	assert.equal(store.activate(revision.proposal_id).revision, next.revision);
	assert.equal(store.readHistory().length, 2, "idempotent activation appended duplicate history");

	const history = new GoalTopicPlanHistory(goalId, root);
	appendFileSync(history.path, "{torn-tail");
	const restoredDocument: GoalTopicDocument = { topics: [confirmedInitial.topics[0]!, revised.topics[0]!] };
	const restored = store.syncDocument({ document: restoredDocument, source: "main_agent", summary: "恢复初始 Topic" }).proposal!;
	const restoredPlan = store.activate(restored.proposal_id);
	assert.equal(store.readHistory().length, 3, "confirmation did not repair a torn final JSONL record");
	assert.deepEqual(readCurrent(), restoredDocument, "restoring a prior snapshot did not append it as the new current version");
	rmSync(join(goalDir, TOPIC_PLAN_DOCUMENT_PATH));
	rmSync(join(serverRuntimeDirForGoal(goalId, root), "topic-plan", "active.json"));
	const recovered = new GoalTopicPlanStore(goalId, root).readActive()!;
	assert.deepEqual(recovered.topics.map((topic) => topic.id), restoredPlan.topics.map((topic) => topic.id),
		"History recovery changed Topic IDs within one revision");
	assert.deepEqual(readCurrent(), restoredDocument, "current Topic snapshot was not recovered from JSONL history");

	assert.equal(parseGoalTopicDocument(JSON.stringify({
		topics: [{ id: "topic_valid", title: "Valid", intent: "Valid" }],
	})).topics[0]!.id, "topic_valid");
	assert.throws(() => parseGoalTopicDocument(JSON.stringify({
		topics: [{ id: "Bad ID", title: "Bad", intent: "Bad" }],
	})), /invalid/u);
	assert.throws(() => parseGoalTopicDocument(JSON.stringify({
		topics: [{ title: "Bad", intent: "Bad" }], redirects: {},
	})), /unknown field/u);
	assert.throws(() => store.syncDocument({
		document: { topics: [{ id: "topic_invented", title: "Invented", intent: "Invented" }] },
		source: "main_agent",
		summary: "Invent an ID",
	}), /unknown Topic ID/u);
	console.log("Append-only Topic Plan history passed");
} finally {
	rmSync(root, { recursive: true, force: true });
}

function readCurrent(): GoalTopicDocument {
	return parseGoalTopicDocument(readFileSync(join(goalDir, TOPIC_PLAN_DOCUMENT_PATH), "utf-8"));
}

function withoutIds(document: GoalTopicDocument): GoalTopicDocument {
	return { topics: document.topics.map(({ id: _id, ...topic }) => topic) };
}
