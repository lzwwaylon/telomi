import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { prepareMainAgentReplayGoalWorkspace } from "../../server/evaluation/main-agent-replay.js";
import {
	goalTopicDocumentFromPlan,
	GoalTopicPlanStore,
	stringifyGoalTopicDocument,
	TOPIC_PLAN_DOCUMENT_PATH,
} from "../../server/goals/topic-plan/index.js";
import type { NodeEvaluationCase } from "../../server/agent-runtime/node-evaluation.js";

const root = mkdtempSync(join(tmpdir(), "telomi-replay-topic-plan-"));
try {
	// A Main Agent Case freezes the Goal directory plus the logical workspace the Agent saw.
	// The confirmed Topic Plan itself lives in the server Runtime store, outside both.
	const observedDir = join(root, "observed");
	const observedGoalId = "goal_observed";
	mkdirSync(join(observedDir, observedGoalId, "artifacts", "main"), { recursive: true });
	const observedStore = new GoalTopicPlanStore(observedGoalId, observedDir);
	const proposal = observedStore.proposePatch({
		source: "main_agent",
		patch: {
			schema_version: 1,
			base_revision: null,
			summary: "Confirm the observed Topic Plan",
			operations: [{
				op: "add",
				topic: {
					id: "official-tts",
					title: "官方 TTS 技术路线",
					intent: "追踪官方博客中的实质变化",
					questions: [],
					include: ["模型架构"],
					exclude: [],
				},
			}],
		},
	});
	const confirmed = observedStore.activate(proposal.proposal_id);
	const confirmedDocument = stringifyGoalTopicDocument(goalTopicDocumentFromPlan(confirmed));

	// Freeze the Case exactly as capture does: the Goal directory tree, and the logical workspace
	// mounts /work and /history that MainWorkspaceRuntime materializes for the turn.
	const sourceRunDirectory = join(root, "case-run");
	const frozenGoalTree = join(sourceRunDirectory, "workspace", "input");
	mkdirSync(join(frozenGoalTree, "artifacts", "main"), { recursive: true });
	writeFileSync(join(frozenGoalTree, TOPIC_PLAN_DOCUMENT_PATH), confirmedDocument, "utf-8");
	const caseDirectory = join(root, "case");
	const caseInput = join(caseDirectory, "input");
	mkdirSync(join(caseInput, "work"), { recursive: true });
	mkdirSync(join(caseInput, "history"), { recursive: true });
	writeFileSync(join(caseInput, "work", "topic-plan.json"), confirmedDocument, "utf-8");
	observedStore.writeHistorySnapshot(join(caseInput, "history", "topic-plan.jsonl"));
	const casePath = join(caseDirectory, "manifest.json");
	writeFileSync(casePath, "{}\n", "utf-8");
	const harnessWorkspaceDirectory = join(root, "harness");
	mkdirSync(harnessWorkspaceDirectory, { recursive: true });

	const value = { agentId: "main-agent" } as NodeEvaluationCase;
	const replayGoalId = "main-agent-backtest";
	const workspaceDirectory = join(root, "replay");
	// Without restoration the Replay Runtime store is empty, which is the defect: the Main Agent
	// then sees an unconfirmed Topic Plan and asks the user to confirm it again.
	assert.equal(
		new GoalTopicPlanStore(replayGoalId, workspaceDirectory).readActive(),
		undefined,
		"the frozen Goal directory alone leaves the Replay Topic Plan store empty",
	);

	const goalDirectory = await prepareMainAgentReplayGoalWorkspace({
		value,
		casePath,
		sourceRunDirectory,
		harnessWorkspaceDirectory,
		workspaceDirectory,
		goalId: replayGoalId,
	});

	const replayStore = new GoalTopicPlanStore(replayGoalId, workspaceDirectory);
	const active = replayStore.requireResearchReady();
	assert.equal(active.revision, confirmed.revision, "Replay must keep the confirmed Topic Plan revision");
	assert.equal(active.goal_id, replayGoalId, "the restored Topic Plan belongs to the Replay Goal");
	assert.deepEqual(active.topics.map((topic) => topic.id), confirmed.topics.map((topic) => topic.id));
	assert.equal(replayStore.hasPendingRequiredConfirmation(), false, "restoration must not invent a pending Proposal");
	assert.equal(
		stringifyGoalTopicDocument(goalTopicDocumentFromPlan(active)),
		confirmedDocument,
		"the Replay reproduces the Topic Plan document the Case froze",
	);
	assert.equal(readFileSync(join(goalDirectory, TOPIC_PLAN_DOCUMENT_PATH), "utf-8"), confirmedDocument);
	const restoredHistory = replayStore.readHistory();
	assert.equal(restoredHistory.length, 1);
	assert.equal(restoredHistory[0]!.version, confirmed.revision);
	assert.equal(restoredHistory[0]!.goal_id, replayGoalId);

	// A historical Case that froze a Topic Plan without its history cannot be restored, and must
	// fail rather than replay against an invented empty plan.
	const legacyCase = join(root, "legacy-case");
	mkdirSync(join(legacyCase, "input", "work"), { recursive: true });
	writeFileSync(join(legacyCase, "input", "work", "topic-plan.json"), confirmedDocument, "utf-8");
	writeFileSync(join(legacyCase, "manifest.json"), "{}\n", "utf-8");
	await assert.rejects(prepareMainAgentReplayGoalWorkspace({
		value,
		casePath: join(legacyCase, "manifest.json"),
		sourceRunDirectory,
		harnessWorkspaceDirectory,
		workspaceDirectory: join(root, "replay-legacy"),
		goalId: replayGoalId,
	}), /without the Topic Plan history/u);

	// A Case whose frozen plan the restored history cannot reproduce, such as an unconfirmed draft
	// the Case never captured, also fails instead of silently replacing it.
	const draftCase = join(root, "draft-case");
	mkdirSync(join(draftCase, "input", "work"), { recursive: true });
	mkdirSync(join(draftCase, "input", "history"), { recursive: true });
	writeFileSync(join(draftCase, "input", "work", "topic-plan.json"),
		stringifyGoalTopicDocument({ topics: [{ title: "未确认草稿", intent: "尚未确认" }] }), "utf-8");
	observedStore.writeHistorySnapshot(join(draftCase, "input", "history", "topic-plan.jsonl"));
	writeFileSync(join(draftCase, "manifest.json"), "{}\n", "utf-8");
	await assert.rejects(prepareMainAgentReplayGoalWorkspace({
		value,
		casePath: join(draftCase, "manifest.json"),
		sourceRunDirectory,
		harnessWorkspaceDirectory,
		workspaceDirectory: join(root, "replay-draft"),
		goalId: replayGoalId,
	}), /cannot reproduce/u);

	// A Case without any Topic Plan context stays replayable and keeps an unconfirmed plan.
	const plainRun = join(root, "plain-run");
	mkdirSync(join(plainRun, "workspace", "input"), { recursive: true });
	const plainCase = join(root, "plain-case");
	mkdirSync(plainCase, { recursive: true });
	writeFileSync(join(plainCase, "manifest.json"), "{}\n", "utf-8");
	const plainWorkspace = join(root, "replay-plain");
	const plainGoalDirectory = await prepareMainAgentReplayGoalWorkspace({
		value,
		casePath: join(plainCase, "manifest.json"),
		sourceRunDirectory: plainRun,
		harnessWorkspaceDirectory,
		workspaceDirectory: plainWorkspace,
		goalId: replayGoalId,
	});
	assert.equal(existsSync(join(plainGoalDirectory, TOPIC_PLAN_DOCUMENT_PATH)), false);
	assert.equal(new GoalTopicPlanStore(replayGoalId, plainWorkspace).readActive(), undefined);

	// A captured new Goal has a valid empty document and an empty history, not missing confirmation evidence.
	mkdirSync(join(plainCase, "input", "work"), { recursive: true });
	mkdirSync(join(plainCase, "input", "history"), { recursive: true });
	writeFileSync(join(plainCase, "input", "work", "topic-plan.json"), stringifyGoalTopicDocument({ topics: [] }));
	writeFileSync(join(plainCase, "input", "history", "topic-plan.jsonl"), "");
	const emptyWorkspace = join(root, "replay-empty");
	await prepareMainAgentReplayGoalWorkspace({
		value, casePath: join(plainCase, "manifest.json"), sourceRunDirectory: plainRun,
		harnessWorkspaceDirectory, workspaceDirectory: emptyWorkspace, goalId: replayGoalId,
	});
	const emptyStore = new GoalTopicPlanStore(replayGoalId, emptyWorkspace);
	assert.equal(emptyStore.readActive(), undefined, "Replay must not confirm an empty Topic Plan");
	assert.throws(() => emptyStore.requireResearchReady(), /confirm|Topic Plan/i);

	// A fresh Goal whose Agent drafted a plan the user has not confirmed yet freezes that draft with an
	// empty history. The Replay restores it as the same pending Proposal instead of failing.
	const pendingCase = join(root, "pending-case");
	mkdirSync(join(pendingCase, "input", "work"), { recursive: true });
	mkdirSync(join(pendingCase, "input", "history"), { recursive: true });
	const pendingDraft = { topics: [{ title: "未确认草稿", intent: "尚未确认", include: ["范围"] }] };
	writeFileSync(join(pendingCase, "input", "work", "topic-plan.json"), stringifyGoalTopicDocument(pendingDraft));
	writeFileSync(join(pendingCase, "input", "history", "topic-plan.jsonl"), "");
	writeFileSync(join(pendingCase, "manifest.json"), "{}\n", "utf-8");
	const pendingWorkspace = join(root, "replay-pending");
	await prepareMainAgentReplayGoalWorkspace({
		value, casePath: join(pendingCase, "manifest.json"), sourceRunDirectory: plainRun,
		harnessWorkspaceDirectory, workspaceDirectory: pendingWorkspace, goalId: replayGoalId,
	});
	const pendingStore = new GoalTopicPlanStore(replayGoalId, pendingWorkspace);
	assert.equal(pendingStore.readActive(), undefined, "a pending draft must not be confirmed by the Replay");
	const restoredPending = pendingStore.listProposals().filter((proposal) => proposal.status === "proposed");
	assert.equal(restoredPending.length, 1, "the Replay restores exactly one pending Proposal");
	assert.deepEqual(restoredPending[0]!.candidate_plan.topics.map((topic) => topic.title), ["未确认草稿"]);

	console.log("Main Agent Replay restores the Case's confirmed Topic Plan");
} finally {
	rmSync(root, { recursive: true, force: true });
}
