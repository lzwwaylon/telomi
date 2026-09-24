import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import express from "express";

import type { AppEvent } from "../../shared/events/app-events.js";
import { subscribe } from "../../server/events/event-bus.js";
import { buildTopicPlanConfirmedEvent } from "../../server/main-agent/topic-readiness-guard.js";
import { TopicPlanActivityProjection } from "../../server/goals/topic-plan/activity-projection.js";
import {
	GoalTopicPlanActivation,
	GoalTopicPlanStore,
	createTopicPlanRouter,
	type GoalTopicPatch,
} from "../../server/goals/topic-plan/index.js";

const root = mkdtempSync(join(tmpdir(), "telomi-topic-plan-activation-"));
const goalId = "goal-activation";
const goal = { id: goalId, title: "Speech generation", description: "Track speech generation" };
const store = new GoalTopicPlanStore(goalId, root);
const events: AppEvent[] = [];
const unsubscribe = subscribe((event) => events.push(event));
try {
	// 一次成功的 Topic Plan Confirmation：确认落盘、事件按顺序发布、User Memory 投影和 Wiki reframe 都由完整激活操作驱动。
	const confirmations: Array<{ goalId: string; revision: string; proposalId: string }> = [];
	const projections: string[] = [];
	const reframes: Array<{ proposalId: string; revision: string; env: Record<string, string | undefined> }> = [];
	const activation = new GoalTopicPlanActivation({
		workspaceDir: root,
		recordConfirmation: async (input) => { confirmations.push(input); return "recorded" as const; },
		projectUserMemory: async (id) => { projections.push(id); },
		goalEnv: () => ({ TELOMI_TEST_GOAL_ENV: "1" }),
		reframe: async (input) => {
			reframes.push({
				proposalId: input.proposal.proposal_id,
				revision: input.proposal.candidate_plan.revision,
				env: input.env,
			});
			return recordedReframe(input.proposal.proposal_id, "succeeded");
		},
	});

	const proposal = store.proposePatch({ source: "main_agent", patch: patch(null, "Initial Topics") });
	assert.equal(store.readActive(), undefined, "an unconfirmed Proposal must not activate itself");
	const accepted = await activation.activate(goal, proposal.proposal_id);
	assert.deepEqual(
		{ goalId: accepted.goalId, proposalId: accepted.proposalId },
		{ goalId, proposalId: proposal.proposal_id },
	);
	const revision = store.readActive()?.revision;
	assert.ok(revision, "confirmation must persist an active Topic Plan revision");
	assert.deepEqual(confirmations, [{ goalId, revision, proposalId: proposal.proposal_id }]);
	await accepted.reframe;
	assert.deepEqual(reframes, [{ proposalId: proposal.proposal_id, revision, env: { TELOMI_TEST_GOAL_ENV: "1" } }]);
	assert.equal(store.readProposal(proposal.proposal_id).reframe?.status, "succeeded",
		"the reframe records its own outcome on the Proposal");
	assert.deepEqual(
		events.filter((event) => event.type === "topic-plan:changed").map((event) => event.status),
		["activated", "reframed"],
	);
	assert.deepEqual(projections, [goalId], "confirmation must reproject User Memory exactly once");

	// 确认覆盖 Discovery Candidate 时，Discovery Resolution 与关闭事件来自同一次激活。
	const candidate = store.submitDiscovery({
		schema_version: 1,
		id: "discovery-covered",
		goal_id: goalId,
		topic_plan_revision: revision,
		finding: "Streaming latency is a separate concern",
		run_id: "run-1",
		source_id: "source:logical-1",
		section_index: 0,
		cue_index: 0,
		cue: "latency",
		note: "首包延迟单独跟踪",
		evidence: [{ source_path: "sources/0001/document.md", start_line: 1, end_line: 2, content_sha256: "a".repeat(64) }],
		status: "open",
		created_at: new Date().toISOString(),
	});
	const covering = store.proposePatch({
		source: "main_agent",
		patch: patch(revision, "Discovery coverage"),
		sourceDiscoveryIds: [candidate.id],
	});
	await (await activation.activate(goal, covering.proposal_id)).reframe;
	assert.deepEqual(
		events.filter((event) => event.type === "discovery:changed").map((event) => [event.candidateId, event.status]),
		[[candidate.id, "closed"]],
	);
	assert.equal(store.readDiscovery(candidate.id).resolution?.kind, "covered_by_topic");

	// 已激活且 reframe 未失败的 Proposal 不能重复确认，被取代的 Proposal 同样拒绝。
	await assert.rejects(activation.activate(goal, proposal.proposal_id), /already active/u);
	const covered = store.readActive()?.revision;
	const superseded = store.proposePatch({ source: "main_agent", patch: patch(covered, "Superseded") });
	const successor = store.proposePatch({ source: "main_agent", patch: patch(covered, "Successor") });
	store.activate(successor.proposal_id);
	assert.equal(store.readProposal(superseded.proposal_id).status, "superseded");
	await assert.rejects(activation.activate(goal, superseded.proposal_id), /superseded/u);
	await assert.rejects(activation.activate(goal, "missing-proposal"), /Missing Goal Topic Plan record/u);

	// 后续处理失败时确认好的 revision 不回滚，重试只重跑 reframe。
	const activeRevision = store.readActive()?.revision;
	let reframeAttempts = 0;
	// 与真实记录器同一契约：同一个已通知的确认返回 "duplicate"。
	const failingConfirmations = new Set<string>();
	const failing = new GoalTopicPlanActivation({
		workspaceDir: root,
		recordConfirmation: async ({ revision, proposalId }) => {
			const key = `${proposalId}:${revision}`;
			if (failingConfirmations.has(key)) return "duplicate" as const;
			failingConfirmations.add(key);
			return "recorded" as const;
		},
		projectUserMemory: async () => {},
		goalEnv: () => ({}),
		reframe: async (input) => {
			reframeAttempts += 1;
			recordedReframe(input.proposal.proposal_id, "failed");
			throw new Error("Wiki Curator failed");
		},
	});
	const failed = store.proposePatch({ source: "main_agent", patch: patch(activeRevision, "Reframe failure") });
	const failedRun = await failing.activate(goal, failed.proposal_id);
	await failedRun.reframe;
	assert.equal(reframeAttempts, 1);
	const confirmedRevision = store.readActive()?.revision;
	assert.notEqual(confirmedRevision, activeRevision, "the confirmed revision must survive a failed reframe");
	assert.equal(store.readProposal(failed.proposal_id).status, "activated");
	assert.deepEqual(
		events.filter((event) => event.type === "topic-plan:changed").slice(-2).map((event) => event.status),
		["activated", "failed"],
	);
	const retried = await failing.activate(goal, failed.proposal_id);
	await retried.reframe;
	assert.equal(reframeAttempts, 2, "a failed reframe stays retryable");
	assert.equal(store.readActive()?.revision, confirmedRevision, "a retry must not confirm the Proposal twice");
	assert.equal(failingConfirmations.size, 1, "a retry after a recorded reframe must not repeat the confirmation");

	// 同一 Proposal 的并发请求只有一个进入激活流程。
	let releaseReframe = () => {};
	const gated = new GoalTopicPlanActivation({
		workspaceDir: root,
		recordConfirmation: async () => "recorded" as const,
		projectUserMemory: async () => {},
		goalEnv: () => ({}),
		reframe: (input) => new Promise((resolve) => {
			releaseReframe = () => resolve(recordedReframe(input.proposal.proposal_id, "succeeded"));
		}),
	});
	const concurrent = store.proposePatch({ source: "main_agent", patch: patch(confirmedRevision, "Concurrent") });
	const first = gated.activate(goal, concurrent.proposal_id);
	await assert.rejects(gated.activate(goal, concurrent.proposal_id), /already running/u,
		"a second request must not enter the activation while the first one runs");
	const started = await first;
	releaseReframe();
	await started.reframe;
	assert.equal(store.readProposal(concurrent.proposal_id).status, "activated");

	// HTTP Adapter 只做请求与响应映射。
	const app = express();
	app.use(createTopicPlanRouter({
		getGoal: (id) => id === goalId ? goal : undefined,
		activation,
	}));
	const server = app.listen(0);
	await new Promise<void>((resolve) => server.once("listening", () => resolve()));
	const port = (server.address() as AddressInfo).port;
	try {
		const missingGoal = await fetch(`http://127.0.0.1:${port}/api/goals/other/topic-plans/p1/activate`, { method: "POST" });
		assert.equal(missingGoal.status, 404);
		assert.deepEqual(await missingGoal.json(), { error: "Unknown goal" });
		const conflict = await fetch(`http://127.0.0.1:${port}/api/goals/${goalId}/topic-plans/${proposal.proposal_id}/activate`, { method: "POST" });
		assert.equal(conflict.status, 409);
		assert.match(String(((await conflict.json()) as { error: string }).error), /already active/u);
		const pending = store.proposePatch({ source: "main_agent", patch: patch(store.readActive()?.revision, "HTTP entry") });
		const response = await fetch(`http://127.0.0.1:${port}/api/goals/${goalId}/topic-plans/${pending.proposal_id}/activate`, { method: "POST" });
		assert.equal(response.status, 202);
		assert.deepEqual(await response.json(), { accepted: true, goalId, proposalId: pending.proposal_id });
		assert.equal(store.readProposal(pending.proposal_id).status, "activated",
			"the HTTP entry must run the same confirmation as the activation Interface");
	} finally {
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}

	// 确认已落盘但后续处理失败时，用户能从 Activity 上既有的重试入口完成恢复，且不会被重复通知。
	// 记录器遵循 GoalSession.recordEvent 的约定：事件文本是它的标识，已记录的事件返回 duplicate；
	// 失败模拟 Goal Session 不可用时它真实会抛的错。
	const confirmationEvents: string[] = [];
	let breakConfirmation = false;
	const recoveryReframes: string[] = [];
	let recoveryProjections = 0;
	let breakReframe = false;
	const recovering = new GoalTopicPlanActivation({
		workspaceDir: root,
		recordConfirmation: async ({ revision, proposalId }) => {
			if (breakConfirmation) throw new Error("Goal is currently running or being deleted");
			const text = buildTopicPlanConfirmedEvent(revision, proposalId);
			if (confirmationEvents.includes(text)) return "duplicate";
			confirmationEvents.push(text);
			return "recorded";
		},
		projectUserMemory: async () => { recoveryProjections += 1; },
		goalEnv: () => ({}),
		reframe: async (input) => {
			recoveryReframes.push(input.proposal.proposal_id);
			// 崩溃窗口：reframe 在写下第一条记录之前就结束。
			if (breakReframe) throw new Error("Wiki Curator died before recording");
			return recordedReframe(input.proposal.proposal_id, "succeeded");
		},
	});
	const projectionOf = (proposalId: string) => new TopicPlanActivityProjection({ workspaceDir: root })
		.project(goalId).flatMap((contribution) => contribution.items)
		.find((item) => item.sourceRef === `topic-plan:${proposalId}`);
	const recoveryApp = express();
	recoveryApp.use(createTopicPlanRouter({ getGoal: (id) => id === goalId ? goal : undefined, activation: recovering }));
	const recoveryServer = recoveryApp.listen(0);
	await new Promise<void>((resolve) => recoveryServer.once("listening", () => resolve()));
	const recoveryPort = (recoveryServer.address() as AddressInfo).port;
	const post = (href: string) => fetch(`http://127.0.0.1:${recoveryPort}${href}`, { method: "POST" });
	try {
		const interrupted = store.proposePatch({ source: "main_agent", patch: patch(store.readActive()?.revision, "Interrupted follow-up") });
		const href = `/api/goals/${goalId}/topic-plans/${interrupted.proposal_id}/activate`;
		breakConfirmation = true;
		const failure = await post(href);
		assert.equal(failure.status, 409, "a failed follow-up must not report success");
		const confirmed = store.readActive()?.revision;
		assert.equal(store.readProposal(interrupted.proposal_id).candidate_plan.revision, confirmed,
			"the confirmed revision must survive a failed follow-up");
		assert.deepEqual(recoveryReframes, [], "the follow-up failure must stop before the Wiki reframe");

		// 未完成的激活必须出现在 Activity 上，并带既有的重试动作，指回同一个确认请求。
		const stalled = projectionOf(interrupted.proposal_id);
		assert.equal(stalled?.outcome, "failed");
		assert.equal(stalled?.lifecycle, "finished", "an interrupted activation must not stay running forever");
		assert.ok(events.some((event) => event.type === "topic-plan:changed"
			&& event.proposalId === interrupted.proposal_id && event.status === "failed"),
			"a failed confirmation follow-up must notify the UI");
		const retryAction = stalled?.attention?.actions.find((action) => action.kind === "retry");
		assert.ok(retryAction, "an interrupted activation must offer the existing retry action");
		assert.equal(retryAction.actionId, `retry-wiki-reframe:${interrupted.proposal_id}`);
		assert.equal(retryAction.enabled, true);
		assert.equal(retryAction.href, href, "the retry action must point at the same user confirmation entry");

		breakConfirmation = false;
		const retry = await post(retryAction.href!);
		assert.equal(retry.status, 202, "the retry action must complete the interrupted activation");
		assert.equal(confirmationEvents.length, 1, "the retry must record the confirmation notification once");
		assert.deepEqual(recoveryReframes, [interrupted.proposal_id]);
		assert.equal(recoveryProjections, 1, "a newly recorded confirmation projects User Memory once");
		assert.equal(store.readActive()?.revision, confirmed, "the retry must not confirm a second revision");
		// 真实 reframe 把 publication 状态记成 message，投影据此给出 no-change 结果。
		assert.equal(projectionOf(interrupted.proposal_id)?.outcome, "no-change");
		assert.equal(projectionOf(interrupted.proposal_id)?.lifecycle, "finished");

		const settled = await post(href);
		assert.equal(settled.status, 409, "a settled activation stays rejected");
		assert.match(String(((await settled.json()) as { error: string }).error), /already active/u);

		// 通知写下之后、reframe 记下第一条记录之前中断：重试补跑 reframe，不重复通知。
		breakReframe = true;
		const crashed = store.proposePatch({ source: "main_agent", patch: patch(store.readActive()?.revision, "Crash window") });
		const crashedHref = `/api/goals/${goalId}/topic-plans/${crashed.proposal_id}/activate`;
		assert.equal((await post(crashedHref)).status, 202);
		assert.equal(confirmationEvents.length, 2, "the crashed activation still notified the user once");
		assert.equal(store.readProposal(crashed.proposal_id).reframe?.status, "failed",
			"a caught reframe failure must become retryable without restarting the server");
		assert.ok(events.some((event) => event.type === "topic-plan:changed"
			&& event.proposalId === crashed.proposal_id && event.status === "failed"),
			"the failure must notify the UI after persisting its retryable state");
		assert.equal(store.readProposal(crashed.proposal_id).reframe?.status, "failed");
		assert.equal(projectionOf(crashed.proposal_id)?.attention?.actions.some(
			(action) => action.href === crashedHref), true);

		breakReframe = false;
		const projectionsBefore = recoveryProjections;
		assert.equal((await post(crashedHref)).status, 202);
		assert.equal(confirmationEvents.length, 2, "the retry must not notify the user a second time");
		assert.equal(recoveryProjections, projectionsBefore + 1, "a retry must refresh idempotent User Memory even when the confirmation notification already exists");
		assert.equal(store.readProposal(crashed.proposal_id).reframe?.status, "succeeded");
		assert.equal(store.readActive()?.revision, store.readProposal(crashed.proposal_id).candidate_plan.revision,
			"the retry must keep the confirmed revision");

		// 真正的进程中断没有机会运行异常处理，启动恢复仍需识别已确认但尚未开始后续处理的状态。
		const unstarted = store.proposePatch({ source: "main_agent", patch: patch(store.readActive()?.revision, "Stopped before follow-up") });
		store.activate(unstarted.proposal_id);
		assert.equal(new GoalTopicPlanStore(goalId, root).markInterruptedActivities()
			.reframes.includes(unstarted.proposal_id), true);
		assert.equal(projectionOf(unstarted.proposal_id)?.outcome, "failed");
		assert.ok(projectionOf(unstarted.proposal_id)?.attention?.actions.some((action) => action.kind === "retry"));
	} finally {
		await new Promise<void>((resolve) => recoveryServer.close(() => resolve()));
	}
	console.log("Topic Plan activation passed");
} finally {
	unsubscribe();
	rmSync(root, { recursive: true, force: true });
}

/** 真实的 reframe 总会把结果记在 Proposal 上；测试替身保持同一契约。 */
function recordedReframe(proposalId: string, status: "succeeded" | "failed") {
	new GoalTopicPlanStore(goalId, root).recordReframe(proposalId, {
		status, updated_at: new Date().toISOString(), message: "no_change",
	});
	return {
		status: "no_change" as const,
		pageCount: 0,
		usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, calls: 0 },
		changedPaths: [],
	};
}

function patch(baseRevision: string | null | undefined, summary: string): GoalTopicPatch {
	return {
		schema_version: 1,
		base_revision: baseRevision ?? null,
		summary,
		operations: [{
			op: "add",
			topic: { id: summary.toLowerCase().replace(/[^a-z0-9]+/gu, "-"), title: summary, intent: summary, questions: [], include: [], exclude: [] },
		}],
	};
}
