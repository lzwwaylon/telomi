/**
 * Research Schedule Reviewer 作为被记录的环节。
 *
 * 一次真实执行的每一次桥调用（长期用户记忆与 Goal Wiki）连同答案冻结进 Case，
 * Candidate Replay 用同一份答案回答同名调用，因此不需要任何 live 服务；输出契约
 * 在两侧都 fail closed：缺字段、与当前值相同的 Proposal、cadence 这类未知字段都被拒绝。
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { RunArtifactStore } from "../../server/agent-runtime/artifact-store.js";
import { NodeBacktestService } from "../../server/evaluation/node-backtest.js";
import {
	createScheduleReviewerReplayRecipe,
	runScheduleReviewNodeEvaluation,
} from "../../server/evaluation/schedule-review-replay.js";
import {
	installCaseCapture,
	resetCaseCaptureForTest,
	type CaseCaptureHooks,
} from "../../server/observability/case-capture.js";
import { ResearchScheduleReviewService } from "../../server/research/schedules/review-service.js";
import {
	scheduleReviewRoot,
	scheduleReviewToolLog,
	startScheduleReviewBridge,
	type ScheduleReviewToolAnswer,
	type ScheduleReviewer,
} from "../../server/research/schedules/reviewer.js";
import { ResearchScheduleStore } from "../../server/research/schedules/store.js";

const root = mkdtempSync(join(tmpdir(), "telomi-schedule-review-frozen-"));
const workspaceDir = join(root, "data");
const candidateRoot = join(root, "candidate");
const goalId = "goal_schedule_review_frozen";
process.env.TELOMI_SCHEDULE_REVIEW_THINKING_LEVEL = "low";
process.env.TELOMI_PRIME_AGENT_ROOT_MODEL = "openai-codex/gpt-5.6-luna";

const current = {
	monitoringScope: "Monitor official product releases.",
	reportContext: "Write for the founding team tracking launch risk.",
};
const revised = {
	monitoringScope: "Monitor official releases and their security advisories.",
	reportContext: "Write for the founding team tracking launch and security risk.",
};
const proposal = {
	decision: "propose",
	...revised,
	summary: "Widen the scope to security advisories.",
	rationale: "The user now asks about advisories in every conversation.",
	evidence: ["memory:m-1", "wiki:pages/security.md"],
};

/** What the Reviewer reads, and what the live memory and Wiki answered on the day. */
const CALLS = [
	{ operation: "memory_recall", query: "What does the user care about now?" },
	{ operation: "wiki_search", query: "security advisories", top_k: 5 },
	{ operation: "wiki_read_page", path: "pages/security.md" },
];
const LIVE_ANSWERS: Record<string, unknown> = {
	memory_recall: { entries: [{ id: "m-1", text: "The user now asks about security advisories." }] },
	wiki_search: { hits: [{ path: "pages/security.md", score: 0.9 }] },
	wiki_read_page: { path: "pages/security.md", content: "Advisories are tracked here." },
};
const liveAnswer: ScheduleReviewToolAnswer = async (operation) => LIVE_ANSWERS[operation];

let decision: unknown = { decision: "no_change", rationale: "The scope still matches." };

/**
 * A Reviewer that leaves the same execution trace a real one leaves, and consults memory
 * and the Wiki through the Runtime bridge. During Capture the bridge answers from the live
 * readers; during Replay it answers from the Case.
 */
const reviewer: ScheduleReviewer = async (input) => {
	assert.equal(input.env?.TELOMI_SCHEDULE_REVIEW_THINKING_LEVEL, "low");
	const reviewRoot = input.root ?? scheduleReviewRoot(input.goalId, input.workspaceDir, input.reviewId);
	mkdirSync(join(reviewRoot, "runtime", "session"), { recursive: true });
	mkdirSync(join(reviewRoot, "agent", "review-output"), { recursive: true });
	mkdirSync(join(reviewRoot, "agent", "inputs"), { recursive: true });
	// Runtime writes the Reviewer's inputs as files; they are part of the Case's evidence.
	writeFileSync(join(reviewRoot, "agent", "inputs", "schedule.json"),
		`${JSON.stringify(input.schedule)}\n`);
	writeFileSync(join(reviewRoot, "runtime", "root-events.jsonl"), '{"type":"message"}\n');
	// The Prime Reviewer's own Session file: this is the Trace a Judgment reads.
	writeFileSync(join(reviewRoot, "runtime", "session", "root.jsonl"), '{"type":"session"}\n');
	writeFileSync(join(reviewRoot, "runtime", "result.json"), `${JSON.stringify({
		usage: { input_tokens: 5, output_tokens: 2, cost_usd: 0.01, model_calls: 1 },
	})}\n`);
	const bridge = await startScheduleReviewBridge({
		goalId: input.goalId,
		goalDir: join(input.workspaceDir, input.goalId),
		logPath: scheduleReviewToolLog(reviewRoot),
		signal: input.signal,
		answerTool: input.answerTool ?? liveAnswer,
	});
	try {
		for (const call of CALLS) {
			const response = await fetch(`${bridge.baseUrl}/v1/schedule-review`, {
				method: "POST",
				headers: { authorization: `Bearer ${bridge.token}`, "content-type": "application/json" },
				body: JSON.stringify(call),
			});
			assert.equal(response.status, 200, `bridged ${call.operation} must answer`);
			assert.deepEqual(await response.json(), LIVE_ANSWERS[call.operation],
				"a Replay must see exactly what the Reviewer saw");
		}
	} finally {
		await bridge.close();
	}
	writeFileSync(join(reviewRoot, "agent", "review-output", "decision.json"), `${JSON.stringify(decision)}\n`);
	return decision;
};

mkdirSync(candidateRoot, { recursive: true });
mkdirSync(join(workspaceDir, goalId), { recursive: true });
writeFileSync(join(candidateRoot, "variant.txt"), "candidate\n");

try {
	// -----------------------------------------------------------------------
	// Capture: one recorded execution per Review, Contract fail closed.
	// -----------------------------------------------------------------------
	resetCaseCaptureForTest();
	installCaseCapture({ scheduleReviewer: runScheduleReviewNodeEvaluation } as unknown as CaseCaptureHooks);

	const store = new ResearchScheduleStore(goalId, workspaceDir);
	const schedule = store.create({
		title: "Daily research",
		question: "What changed?",
		...current,
		cron: "0 9 * * *",
		timeZone: "UTC",
		initializedFromRunId: "run-baseline",
		coveredThrough: "2026-01-01T00:00:00.000Z",
		sources: [],
		now: new Date("2026-01-01T00:00:00.000Z"),
	});
	store.close();

	const service = new ResearchScheduleReviewService(workspaceDir, reviewer);
	assert.equal((await service.review(goalId, schedule.id)).status, "no_change");

	decision = proposal;
	const proposed = await service.review(goalId, schedule.id);
	assert.equal(proposed.status, "proposed");

	for (const [label, output, expected] of [
		["missing fields", { ...proposal, summary: undefined }, /summary must be a non-empty string/u],
		["a Proposal identical to the current values", { ...proposal, ...current }, /must change its monitoringScope or its reportContext/u],
		["unknown fields such as cadence", { ...proposal, cron: "0 8 * * *" }, /unknown fields: cron/u],
	] as const) {
		decision = output;
		const rejected = await service.review(goalId, schedule.id);
		assert.equal(rejected.status, "failed", `the recorded stage rejects ${label}`);
		assert.match(rejected.reason ?? "", expected);
	}

	const backtests = new NodeBacktestService({
		workspaceDir,
		listGoalIds: () => [goalId],
		recipes: [createScheduleReviewerReplayRecipe({ execute: reviewer })],
	});
	backtests.start();
	try {
		const cases = backtests.listCases(goalId, "schedule-reviewer", 20);
		assert.equal(cases.length, 5, "every Reviewer execution is captured as a Node Case");
		assert.equal(cases.filter((item) => item.value.status === "succeeded").length, 2);
		const rejections = cases.filter((item) => item.value.status === "failed");
		assert.equal(rejections.length, 3, "a Contract violation is a captured Recovery Case");
		for (const rejection of rejections) {
			assert.equal(rejection.value.observed.output, undefined,
				"a rejected Proposal never becomes an Observed Baseline");
			assert.equal(rejection.value.observed.validationErrors.length, 1);
		}

		const proposeCase = cases.find((item) => item.value.status === "succeeded"
			&& item.value.runId === proposed.id)!;
		assert.ok(proposeCase, "the propose Review is captured");
		const rejectedCase = join(root, "rejected-thinking");
		mkdirSync(join(rejectedCase, "input"), { recursive: true });
		const frozen = JSON.parse(readFileSync(join(backtests.caseRoots(goalId, proposeCase.ref).caseDirectory, "input", "request.json"), "utf-8"));
		assert.equal(typeof frozen.models.thinking, "string", "current Capture freezes thinking");
		for (const thinking of [undefined, "invalid"]) {
			writeFileSync(join(rejectedCase, "input", "request.json"), JSON.stringify({ ...frozen, models: { ...frozen.models, thinking } }));
			await assert.rejects(createScheduleReviewerReplayRecipe().replay({
				casePath: join(rejectedCase, "manifest.json"), value: proposeCase.value,
				sourceRunDirectory: rejectedCase, harnessWorkspaceDirectory: candidateRoot,
				recordDirectory: rejectedCase, workDirectory: rejectedCase, artifactStore: new RunArtifactStore(rejectedCase),
				runner: { async runStage() { throw new Error("invalid Case must not run"); } }, signal: new AbortController().signal,
			}), /requires a valid thinking level/u);
		}

		for (const language of [undefined, "auto", "invalid"]) {
			writeFileSync(join(rejectedCase, "input", "request.json"), JSON.stringify({ ...frozen, language }));
			await assert.rejects(createScheduleReviewerReplayRecipe().replay({
				casePath: join(rejectedCase, "manifest.json"), value: proposeCase.value,
				sourceRunDirectory: rejectedCase, harnessWorkspaceDirectory: candidateRoot,
				recordDirectory: rejectedCase, workDirectory: rejectedCase, artifactStore: new RunArtifactStore(rejectedCase),
				runner: { async runStage() { throw new Error("invalid Case must not run"); } }, signal: new AbortController().signal,
			}), /requires a resolved output language/u);
		}
		assert.ok(proposeCase.value.request.interactions, "the Reviewer's Tool interactions are recorded");
		const interactions = JSON.parse(readFileSync(join(
			backtests.caseRoots(goalId, proposeCase.ref).caseDirectory,
			"interactions.json",
		), "utf-8")) as Array<{ name: string; arguments: unknown; result: unknown }>;
		assert.deepEqual(interactions.map((item) => item.name), CALLS.map((call) => call.operation));
		assert.deepEqual(interactions.map((item) => item.result), CALLS.map((call) => LIVE_ANSWERS[call.operation]));
		const files = backtests.listCaseFiles(goalId, proposeCase.ref);
		for (const kind of ["system_prompt", "user_prompt", "input", "agent_trace", "tool_calls",
			"runtime_result", "agent_input", "agent_file_contract", "observed_output"]) {
			assert.ok(files.some((file) => file.kind === kind), `the Reviewer Case must expose ${kind}`);
		}
		assert.deepEqual(
			files.filter((file) => file.kind === "observed_output").map((file) => file.ref),
			["output:decision.json", "output:rubric.md"],
			"the Observed Baseline carries the decision and the Rubric it is judged by",
		);

		// -------------------------------------------------------------------
		// Candidate Replay: frozen answers, no live memory or Wiki service.
		// -------------------------------------------------------------------
		const snapshot = backtests.createCapabilitySnapshot(goalId, candidateRoot);
		decision = { ...proposal, summary: "A tighter summary of the same idea." };
		const run = backtests.enqueue(goalId, {
			agentId: "schedule-reviewer",
			cases: [proposeCase.ref],
			candidate: { capabilitySnapshotId: snapshot.id },
			repetitions: 1,
			rubricId: "schedule-reviewer-proposal-v1",
		});
		const completed = await waitFor(backtests, run.id);
		assert.equal(completed.status, "awaiting_evaluation", completed.error);
		const execution = completed.executions[0]!;
		assert.deepEqual(
			JSON.parse(readFileSync(backtests.artifactFile(goalId, run.id, execution.id, "decision.json"), "utf-8")),
			decision,
			"the Candidate decision is published as the Replay artifact",
		);
		assert.match(
			readFileSync(backtests.artifactFile(goalId, run.id, execution.id, "rubric.md"), "utf-8"),
			/Research Schedule Reviewer Evaluation Rubric/u,
			"the Rubric travels with the decision a Judgment compares",
		);
		assert.ok(execution.candidateCaseRef, "a Candidate Replay captures its own Case");
		assert.equal(backtests.readCase(goalId, execution.candidateCaseRef).capabilitySnapshotId, snapshot.id);
		assert.equal(backtests.evaluationBatch(goalId, run.id).pairs.length, 1);

		// The Contract also fails closed on the Replay side.
		decision = { ...proposal, cron: "0 8 * * *" };
		const violating = backtests.enqueue(goalId, {
			agentId: "schedule-reviewer",
			cases: [proposeCase.ref],
			candidate: { capabilitySnapshotId: snapshot.id },
			repetitions: 1,
			rubricId: "schedule-reviewer-proposal-v1",
		});
		const failed = await waitFor(backtests, violating.id);
		assert.equal(failed.status, "failed");
		assert.match(failed.error ?? "", /unknown fields: cron/u);
	} finally {
		backtests.stop();
	}

	console.log("Research Schedule Reviews are captured as Cases and replayed from frozen memory and Wiki answers");
} finally {
	resetCaseCaptureForTest();
	rmSync(root, { recursive: true, force: true });
}

async function waitFor(service: NodeBacktestService, runId: string) {
	while (true) {
		const run = service.read(goalId, runId)!;
		if (["awaiting_evaluation", "completed", "failed", "cancelled"].includes(run.status)) return run;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}
