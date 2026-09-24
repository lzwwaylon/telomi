import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	GoalTopicPlanStore,
	reframeActivatedGoalWiki,
	resolveGoalTopicRefs,
	validateGoalTopicPatch,
	validateGoalTopicPlan,
	type GoalTopicPatch,
} from "../../server/goals/topic-plan/index.js";
import { ensureGoalWorkspace } from "../../server/workspaces/goal-project.js";
import { serverRuntimeDirForGoal } from "../../server/workspaces/server-runtime-paths.js";
import { executeResearchRun } from "../../server/research/execute-run.js";
import { RunStateStore } from "../../server/research/run-state.js";
import { createResearchScheduleFromRun } from "../../server/research/schedules/create-from-run.js";

const root = mkdtempSync(join(tmpdir(), "pi-goal-topic-plan-"));
const goalId = "goal-topic-test";
const goalDir = join(root, goalId);
const store = new GoalTopicPlanStore(goalId, root);
try {
	assert.throws(() => validateGoalTopicPlan({
		schema_version: 1,
		goal_id: goalId,
		revision: "legacy-exploration",
		status: "active",
		topics: [{ ...add("legacy", "Legacy", "Legacy Topic").topic }],
		exploration: { enabled: true, intensity: "medium" },
	} as never), /unknown field 'exploration'/u);
	assert.throws(() => validateGoalTopicPlan({
		schema_version: 1,
		goal_id: goalId,
		revision: "legacy",
		status: "active",
		topics: [{ ...add("legacy", "Legacy", "Legacy Topic").topic, priority: "normal", status: "active" }],
	} as never), /unknown field/u);
	assert.throws(() => validateGoalTopicPatch({
		schema_version: 1,
		base_revision: null,
		summary: "Legacy Topic fields",
		operations: [{ op: "add", topic: { ...add("legacy", "Legacy", "Legacy Topic").topic, priority: "normal" } }],
	} as never), /unknown field/u);
	const initial = store.proposePatch({
		source: "main_agent",
		patch: {
			schema_version: 1,
			base_revision: null,
			summary: "Initial speech generation Topics",
			operations: [
				add("multilingual", "中文、英文与多语言能力", "跟踪中文、英文和跨语言生成能力"),
				add("realtime", "实时生成与低延迟", "跟踪流式生成、首包延迟和实时系数"),
				add("open-source-license", "开源协议", "研究模型开放协议和具体条款"),
				add("model-availability", "模型可用性", "跟踪模型获取和使用条件"),
				add("safety", "安全与治理", "跟踪冒用、溯源和安全治理"),
			],
		},
	});
	const initialPath = join(serverRuntimeDirForGoal(goalId, root), "topic-plan", "proposals", `${initial.proposal_id}.json`);
	writeFileSync(initialPath, `${JSON.stringify({ ...initial, preference: "legacy" }, null, 2)}\n`);
	assert.throws(() => store.readProposal(initial.proposal_id), /unknown field 'preference'/u);
	writeFileSync(initialPath, `${JSON.stringify(initial, null, 2)}\n`);
	const renamedPath = join(serverRuntimeDirForGoal(goalId, root), "topic-plan", "proposals", "renamed.json");
	writeFileSync(renamedPath, JSON.stringify(initial));
	assert.throws(() => store.listProposals(), /Proposal is invalid/u, "listing must validate the filename against proposal_id");
	rmSync(renamedPath);
	assert.deepEqual(store.listProposals(), [initial]);
	assert.equal(store.readActive(), undefined, "Proposal must not activate itself");
	ensureGoalWorkspace({ goalDir, goalId, title: "Topic gated research" });
	await assert.rejects(executeResearchRun({
		goalDir,
		goalId,
		workspaceDir: root,
		taskSource: "main_agent",
		reason: "Verify Topic confirmation gate",
		question: "Research speech generation",
		reportContext: "Speech generation landscape for a product brief",
	}), /Topic Plan must be confirmed before research or scheduling/u);
	assert.throws(() => createResearchScheduleFromRun({
		workspaceDir: root,
		goalId,
		title: "Blocked schedule",
		monitoringScope: "Track speech generation",
		sourceRunId: "missing-run",
		cron: "0 9 * * 1",
		timeZone: "Asia/Singapore",
	}), /Topic Plan must be confirmed before research or scheduling/u);
	const v1 = store.activate(initial.proposal_id);
	const multilingualId = topicId(v1, "中文、英文与多语言能力");
	const realtimeId = topicId(v1, "实时生成与低延迟");
	const licenseId = topicId(v1, "开源协议");
	const availabilityId = topicId(v1, "模型可用性");
	const safetyId = topicId(v1, "安全与治理");
	assert.notEqual(multilingualId, "multilingual", "Main Agent draft ID became a durable Topic ID");
	assert.deepEqual(store.readHistory()[0]!.plan.topics.map((topic) => topic.id), v1.topics.map((topic) => topic.id));
	assert.equal(store.readActive()?.revision, v1.revision);
	store.recordReframe(initial.proposal_id, { status: "running", updated_at: new Date().toISOString() });
	assert.deepEqual(store.markInterruptedActivities(), {
		reframes: [initial.proposal_id],
	});
	assert.equal(store.readProposal(initial.proposal_id).reframe?.status, "failed");
	const knowledgeRoot = join(goalDir, "wiki", "knowledge");
	mkdirSync(knowledgeRoot, { recursive: true });
	writeFileSync(join(knowledgeRoot, ".note-registry.json"), JSON.stringify({ schema_version: 2, contract_version: 25, entries: [] }));
	let observedReframe = false;
	const reframed = await reframeActivatedGoalWiki({
		goalId,
		goalDir,
		workspaceDir: root,
		goal: "Topic gated research",
		proposal: store.readProposal(initial.proposal_id),
		env: {},
		signal: new AbortController().signal,
		curate: async (input) => {
			observedReframe = input.operation === "reframe"
				&& input.previousEditionRoot === knowledgeRoot
				&& input.draftRoots.length === 0
				&& input.topicPlan.revision === v1.revision;
			return { knowledgeRoot, pageCount: 0, usage: { inputTokens: 1, outputTokens: 1, costUsd: 0, calls: 1 }, sessionPaths: [] };
		},
		publish: async () => ({
			status: "no_change",
			compilationId: `wiki-curator-${v1.revision}`,
			baseContentHash: "0".repeat(64),
			publishedContentHash: "0".repeat(64),
			changedPaths: [],
		}),
	});
	assert.equal(observedReframe, true, "Topic activation must run the same Wiki Curator in reframe mode");
	assert.equal(reframed.status, "no_change");
	assert.equal(store.readProposal(initial.proposal_id).reframe?.status, "succeeded");

	const preferencePatch: GoalTopicPatch = {
		schema_version: 1,
		base_revision: v1.revision,
		summary: "Focus multilingual and realtime; treat license as availability criteria",
		operations: [
			{ op: "update", topic_id: multilingualId, set: { questions: ["中英文质量如何比较？"] } },
			{ op: "update", topic_id: realtimeId, set: { include: ["首包延迟"] } },
			{ op: "update", topic_id: availabilityId, set: {
				include: ["模型权重可以下载", "允许个人非商业使用"],
				exclude: ["开源协议具体条款分析"],
			} },
			{ op: "remove", topic_id: licenseId },
		],
	};
	const preference = store.proposePatch({ source: "main_agent", patch: preferencePatch });
	assert.equal(store.readActive()?.revision, v1.revision, "Unconfirmed Patch changed the active Plan");
	assert.throws(() => store.requireResearchReady(), /user-requested Topic Plan revision must be confirmed/u);
	assert.deepEqual(preference.diff.map((line) => line.split("：", 1)[0]), ["更新 Topic", "更新 Topic", "更新 Topic", "移除 Topic"]);
	const v2 = store.activate(preference.proposal_id);
	assert.equal(v2.topics.some((topic) => topic.id === licenseId), false);
	assert.deepEqual(v2.topics.find((topic) => topic.id === availabilityId)?.include, ["模型权重可以下载", "允许个人非商业使用"]);
	assert.deepEqual(v2.topics.slice(0, 2).map((topic) => topic.id), [multilingualId, realtimeId]);
	assert.throws(() => store.proposePatch({ source: "main_agent", patch: preferencePatch }), /base revision is stale/u);
	assert.equal(store.activate(preference.proposal_id).revision, v2.revision, "Activation must be idempotent");
	assert.deepEqual(resolveGoalTopicRefs(v2, [multilingualId, licenseId, "missing"]), [
		{ input_ref: multilingualId, status: "exact", canonical_refs: [multilingualId] },
		{ input_ref: licenseId, status: "unresolved", canonical_refs: [] },
		{ input_ref: "missing", status: "unresolved", canonical_refs: [] },
	]);
	const discovery = store.submitDiscovery({
		schema_version: 1,
		id: "discovery_test",
		goal_id: "goal-topic-test",
		topic_plan_revision: v2.revision,
		finding: "A frozen Run found a direction outside its Topic Plan",
		run_id: "run-test",
		source_id: "source-test",
		section_index: 0,
		cue_index: 0,
		cue: "New direction",
		note: "The Source supports a new direction.",
		evidence: [{ source_path: "paper.md", start_line: 1, end_line: 2, content_sha256: "a".repeat(64) }],
		status: "open",
		created_at: new Date().toISOString(),
	});
	assert.equal(store.submitDiscovery(discovery).id, discovery.id, "Discovery submission must be idempotent");
	assert.equal(store.readDiscoveryInbox()[0]?.finding, discovery.finding);
	assert.equal(store.ignoreDiscovery(discovery.id).resolution?.kind, "ignored");
	assert.equal(store.readDiscoveryInbox().length, 0);
	assert.equal(store.submitDiscovery({ ...discovery, id: "discovery_duplicate" }).id, discovery.id,
		"an exactly ignored Candidate must not be emitted again");
	assert.equal(store.reopenDiscovery(discovery.id).status, "open");
	const draft = store.proposePatch({ source: "main_agent", sourceDiscoveryIds: [discovery.id], patch: {
		schema_version: 1,
		base_revision: v2.revision,
		summary: "Narrow one Topic",
		operations: [{ op: "update", topic_id: safetyId, set: { include: ["provenance"] } }],
	} });
	const refined = store.reviseProposal(draft.proposal_id, { source: "main_agent", patch: {
		schema_version: 1,
		base_revision: draft.candidate_plan.revision,
		summary: "Lower and narrow one Topic",
		operations: [{ op: "update", topic_id: safetyId, set: { exclude: ["unrelated regulation"] } }],
	} });
	assert.equal(store.readProposal(draft.proposal_id).status, "superseded");
	assert.deepEqual(refined.source_discovery_ids, [discovery.id]);
	assert.throws(() => store.activate(draft.proposal_id), /not activatable/u);
	assert.equal(store.readActive()?.revision, v2.revision, "Refining a Proposal changed the active Plan");
	const competing = store.proposePatch({ source: "main_agent", patch: {
		schema_version: 1,
		base_revision: v2.revision,
		summary: "Competing change",
		operations: [{ op: "update", topic_id: realtimeId, set: { exclude: ["offline only"] } }],
	} });
	const v3 = store.activate(refined.proposal_id);
	assert.equal(store.readProposal(competing.proposal_id).status, "superseded");
	assert.deepEqual(store.readDiscovery(discovery.id).resolution, {
		kind: "covered_by_topic",
		resolved_by: "runtime",
		resolved_at: store.readDiscovery(discovery.id).resolution?.resolved_at,
		proposal_id: refined.proposal_id,
		topic_plan_revision: v3.revision,
	});
	assert.deepEqual(v3.topics.find((topic) => topic.id === safetyId)?.include, ["provenance"]);
	assert.deepEqual(v3.topics.find((topic) => topic.id === safetyId)?.exclude, ["unrelated regulation"]);
	const runState = new RunStateStore(join(root, "run-control")).create({
		runId: "run-topic-plan",
		goalId: "goal-topic-test",
		question: "Research using a frozen Topic Plan",
		language: "en",
		pins: {
			harness_snapshot: "harness", workspace_content_hash: "a".repeat(64), knowledge_memory_hash: "knowledge",
			run_context_snapshot: "a".repeat(64), pipeline: "pipeline", prompt_bundle: "prompt",
			schema_bundle: "schema", model_policy: "model", skill_bundle: "skill", tool_schema: "tools",
		},
		topicPlan: {
			revision: v3.revision,
			snapshot: { relative_path: "artifacts/input/topic-plan.json", sha256: "b".repeat(64), byte_length: 123 },
		},
	});
	assert.equal(runState.topic_plan?.revision, v3.revision);
	const proposalsRoot = join(serverRuntimeDirForGoal("goal-topic-test", root), "topic-plan", "proposals");
	mkdirSync(proposalsRoot, { recursive: true });
	writeFileSync(join(proposalsRoot, "corrupt.json"), "{not-json\n");
	assert.throws(() => store.listProposals(), /JSON/u, "corrupt Topic Proposal must not disappear silently");
	console.log("Goal Topic Plan Interface passed");
} finally {
	rmSync(root, { recursive: true, force: true });
}

function add(id: string, title: string, intent: string): GoalTopicPatch["operations"][number] {
	return { op: "add", topic: topic(id, title, intent) };
}

function topic(id: string, title = id, intent = id) {
	return { id, title, intent, questions: [], include: [], exclude: [] };
}

function topicId(plan: { topics: Array<{ id: string; title: string }> }, title: string): string {
	const id = plan.topics.find((topic) => topic.title === title)?.id;
	assert.ok(id, `Missing Topic '${title}'`);
	return id;
}
