import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GoalSnapshot } from "../../shared/types.js";
import type { GoalSession } from "../../server/goals/execution.js";
import { GoalService } from "../../server/goals/service.js";
import { GoalTopicPlanStore } from "../../server/goals/topic-plan/index.js";
import { TopicPlanActivityProjection } from "../../server/goals/topic-plan/activity-projection.js";
import { serverRuntimeDirForGoal } from "../../server/workspaces/server-runtime-paths.js";
import { saveSettings } from "../../server/config/settings.js";
import { unusedGoalExecution } from "./unused-execution.js";

const root = mkdtempSync(join(tmpdir(), "telomi-topic-outcome-"));
saveSettings({ defaultProvider: "test", defaultModel: "main" });
try {
	let sequence = 0;
	async function fixture(lifecycle = true) {
		const goalId = `goal_topic_outcome_${++sequence}`;
		const snapshot: GoalSnapshot = { goalId, title: "Topic outcome", description: "", messages: [],
			isStreaming: false, pendingToolCalls: [], stopState: "idle" };
		let onSnapshot!: (snapshot: GoalSnapshot) => void;
		const session: GoalSession = {
			getSnapshot: () => snapshot, getPreview: () => "", isRunning: () => snapshot.isStreaming,
			start() { snapshot.isStreaming = true; onSnapshot(snapshot); },
			async steer() {}, abort() {}, dispose() {}, updateConfig() {}, async refreshModelCatalog() {},
			setTitle() {}, setDescription() {}, async appendExternalAssistantMessage() {},
			async recordEvent() { return true; }, subscribe: () => () => {}, async projectUserMemory() {},
		};
		const service = new GoalService(root, { ...unusedGoalExecution,
			async createRunner(input) { onSnapshot = input.onSnapshot; return session; } });
		service.ensureImportedGoal(goalId, "Topic outcome");
		await service.startRun(goalId, lifecycle ? "[EVENT:GOAL_CREATED]\nPrepare the Topic Plan" : "ordinary question");
		const store = new GoalTopicPlanStore(goalId, root);
		return { goalId, service, snapshot, store,
			finish() { snapshot.isStreaming = false; onSnapshot(snapshot); },
			propose() { return store.proposePatch({ source: "main_agent", patch: {
				schema_version: 1, base_revision: null, summary: "Initial Topics",
				operations: [{ op: "add", topic: { title: "Speech", intent: "Track speech models",
					questions: ["Which models are available?"], include: [], exclude: [] } }],
			} }); } };
	}

	const missing = await fixture();
	missing.finish();
	const failed = missing.service.getTopicPlanGeneration(missing.goalId);
	assert.ok(failed?.failedAt, "A normal stop without a draft must remain visible as failed");
	assert.match(failed.error ?? "", /did not produce.*Topic Plan/u);
	const projection = new TopicPlanActivityProjection({ workspaceDir: root,
		readTopicPlanGeneration: id => missing.service.getTopicPlanGeneration(id) });
	assert.equal(projection.project(missing.goalId)[0]!.items[0]!.outcome, "failed");
	missing.finish();
	assert.deepEqual(missing.service.getTopicPlanGeneration(missing.goalId), failed,
		"Repeated idle snapshots preserve the original failure and its timestamp");
	await missing.service.startRun(missing.goalId, "ordinary follow-up");
	missing.snapshot.errorMessage = "Unrelated chat Provider failure";
	missing.finish();
	assert.deepEqual(missing.service.getTopicPlanGeneration(missing.goalId), failed,
		"An ordinary chat failure cannot replace the earlier generation failure");
	missing.snapshot.errorMessage = undefined;
	await missing.service.startRun(missing.goalId, "Please prepare the missing draft");
	missing.propose();
	missing.finish();
	assert.equal(missing.service.getTopicPlanGeneration(missing.goalId), undefined,
		"A later ordinary chat can clear the failure by producing a valid draft");

	const pending = await fixture();
	pending.propose();
	pending.finish();
	assert.equal(pending.service.getTopicPlanGeneration(pending.goalId), undefined, "A validated pending Proposal completes generation");
	const active = await fixture();
	active.store.activate(active.propose().proposal_id);
	active.finish();
	assert.equal(active.service.getTopicPlanGeneration(active.goalId), undefined, "An active Plan completes generation");

	const invalid = await fixture();
	const proposalDir = join(serverRuntimeDirForGoal(invalid.goalId, root), "topic-plan", "proposals");
	mkdirSync(proposalDir, { recursive: true });
	writeFileSync(join(proposalDir, "invalid.json"), "{}");
	assert.doesNotThrow(() => invalid.finish(), "Invalid output must not escape the snapshot callback");
	assert.ok(invalid.service.getTopicPlanGeneration(invalid.goalId)?.failedAt, "An invalid Proposal cannot count as a draft");
	const invalidFailure = invalid.service.getTopicPlanGeneration(invalid.goalId);
	writeFileSync(join(proposalDir, "invalid.json"), "not JSON");
	invalid.finish();
	assert.deepEqual(invalid.service.getTopicPlanGeneration(invalid.goalId), invalidFailure,
		"Repeated idle snapshots with broken output preserve the first failure reason and timestamp");
	rmSync(proposalDir, { recursive: true });

	const rejected = await fixture();
	rejected.store.activate(rejected.propose().proposal_id);
	rejected.snapshot.errorMessage = "Provider rejected request: exhausted balance";
	rejected.finish();
	assert.equal(rejected.service.getTopicPlanGeneration(rejected.goalId)?.error, rejected.snapshot.errorMessage,
		"The original Provider error takes precedence even when a Plan exists");
	const renewed = await fixture();
	renewed.finish();
	await renewed.service.startRun(renewed.goalId, "[EVENT:GOAL_UPDATED]\nRevise the Topic Plan");
	renewed.snapshot.errorMessage = "New generation Provider failure";
	renewed.finish();
	assert.equal(renewed.service.getTopicPlanGeneration(renewed.goalId)?.error, renewed.snapshot.errorMessage,
		"A new lifecycle generation records its own failure instead of retaining the previous one");

	const ordinary = await fixture(false);
	ordinary.finish();
	assert.equal(ordinary.service.getTopicPlanGeneration(ordinary.goalId), undefined, "Ordinary chat never creates generation failure");
	const cancelled = await fixture();
	await cancelled.service.abort(cancelled.goalId);
	cancelled.finish();
	assert.equal(cancelled.service.getTopicPlanGeneration(cancelled.goalId), undefined, "An explicit cancellation is not a failed generation");
} finally {
	rmSync(root, { recursive: true, force: true });
}
console.log("Topic Plan generation outcome tests passed");
