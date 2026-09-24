/**
 * Who owns a batch of Browser Provider executions once its Evolution Run has settled.
 *
 * A Run that never reached a Candidate Replay tested nothing the batch could have shown, so it
 * must not consume it. Production Run evo_1789919931532_76673d18 settled exactly that way: three
 * rounds, each blocked before its replay could start, and three executions burned for nothing.
 */
import { replayableChildFiles } from "./provider-child-fixture.js";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { NodeBacktestCaseRef, NodeBacktestService } from "../../server/evaluation/node-backtest.js";
import { runRecordDir } from "../../server/observability/run-records.js";
import { BrowserEvolutionTrigger } from "../../server/evolution/browser-trigger.js";
import { BROWSER_EVOLUTION_TARGET_ID } from "../../server/evolution/targets.js";
import {
	EvolutionService,
	type EvolutionInnerLoopResult,
	type EvolutionRun,
	type EvolutionTarget,
} from "../../server/evolution/service.js";

const root = mkdtempSync(join(tmpdir(), "telomi-browser-trigger-unreplayed-"));
const workspaceDir = join(root, "data");
const goalId = "goal_browser";
mkdirSync(join(workspaceDir, goalId, "skills", "prime-search"), { recursive: true });

const caseResults = join(root, "case-results");
mkdirSync(caseResults, { recursive: true });
const cases: Array<{ runId: string; caseId: string; capturedAt: string; status: string }> = [];

function resultPath(ref: NodeBacktestCaseRef): string {
	return join(caseResults, `${ref.sourceRunId}__${ref.caseId}.json`);
}

/** One captured production Prime Search Case holding a single successful Browser execution. */
function captureCase(index: number): void {
	const runId = `run-${index}`;
	const caseId = `case-${index}`;
	const executions = [{
		execution_id: "provider-execution:1:browser:sub-1",
		provider_id: "browser",
		terminal_status: "valid_bundle",
	}];
	cases.push({ runId, caseId, capturedAt: `2026-09-${String(index).padStart(2, "0")}T00:00:00.000Z`, status: "succeeded" });
	writeFileSync(resultPath({ sourceRunId: runId, caseId }),
		`${JSON.stringify({ schema_version: 1, execution_records: executions })}\n`);
	const directory = runRecordDir(workspaceDir, goalId, runId);
	mkdirSync(directory, { recursive: true });
	writeFileSync(join(directory, "run-state.json"), `${JSON.stringify({ status: "published" })}\n`);
}

const nodeBacktests = {
	listCases: () => cases.map((value) => ({ ref: { sourceRunId: value.runId, caseId: value.caseId }, value })),
	listCaseFilePaths: (_goalId: string, ref: NodeBacktestCaseRef) => replayableChildFiles(`${resultPath(ref)}-files`, resultPath(ref)),
	caseFile: (_goalId: string, ref: NodeBacktestCaseRef) => resultPath(ref),
} as unknown as NodeBacktestService;

/** What the next settled inner loop returns. Every Run here settles immediately. */
let innerLoopResult: EvolutionInnerLoopResult = { outcome: "no_change", summary: "", rounds: [] };

const target: EvolutionTarget = {
	id: BROWSER_EVOLUTION_TARGET_ID,
	ownerAgentId: "prime-search",
	version: 2,
	async collectEvidence() {
		return { manifest: { kind: "browser_provider_executions" }, files: [] };
	},
	async innerLoop() {
		return innerLoopResult;
	},
};

const service = new EvolutionService({ workspaceDir, listGoalIds: () => [goalId], targets: [target] });
const trigger = new BrowserEvolutionTrigger({ workspaceDir, nodeBacktests, evolution: service });

/** Starts one batch and waits for its Run to reach a terminal status. */
async function settledBatch(): Promise<EvolutionRun> {
	const started = trigger.observe(goalId);
	assert.ok(started, "a full batch must start an Evolution Run");
	for (let attempt = 0; attempt < 400; attempt += 1) {
		const run = service.list(goalId).find((item) => item.id === started.id);
		if (run && !["queued", "collecting_evidence", "authoring", "replaying"].includes(run.status)) return run;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error("Evolution Run never settled");
}

/** Rounds that record no replay id, exactly as a round Runtime could not start does. */
function unreplayedRounds(): EvolutionInnerLoopResult {
	return {
		outcome: "no_change",
		summary: "The repository was dirty, so no Candidate Replay could start.",
		rounds: [1, 2, 3].map((round) => ({
			round, replayRunId: "", passed: false, recordRelativePath: `rounds/${round}/round.json`,
		})),
	};
}

try {
	for (const index of [1, 2, 3]) captureCase(index);

	// A Run whose every round was blocked before its replay returns the batch to the pool.
	innerLoopResult = unreplayedRounds();
	const blocked = await settledBatch();
	assert.equal(blocked.status, "no_change");
	assert.deepEqual(blocked.evidenceRefs.map((ref) => ref.runId), ["run-1", "run-2", "run-3"]);
	assert.deepEqual(trigger.pending(goalId).map((unit) => unit.runId), ["run-1", "run-2", "run-3"],
		"evidence no Candidate Replay ever saw stays available");

	// The retry picks up that same batch, and is the last attempt it gets: a permanently broken
	// environment must not hand the same three executions to a new Run forever.
	const retry = await settledBatch();
	assert.deepEqual(retry.evidenceRefs.map((ref) => ref.runId), ["run-1", "run-2", "run-3"],
		"the released batch is the one the retry picks up");
	assert.deepEqual(trigger.pending(goalId), [],
		"a batch two Runs could not replay stops coming back");

	// A Run that did replay owns its batch, whatever it concluded about the Skill.
	innerLoopResult = {
		outcome: "no_change",
		summary: "Replayed, and the evidence did not support a change.",
		rounds: [{ round: 1, replayRunId: "nodebt-1", passed: true, recordRelativePath: "rounds/1/round.json" }],
	};
	for (const index of [4, 5, 6]) captureCase(index);
	const replayed = await settledBatch();
	assert.deepEqual(replayed.evidenceRefs.map((ref) => ref.runId), ["run-4", "run-5", "run-6"]);
	assert.deepEqual(trigger.pending(goalId), [],
		"a Run that replayed keeps its batch consumed even when it changed nothing");

	// Cancelling is a decision about the batch, not a failure to test it.
	innerLoopResult = unreplayedRounds();
	for (const index of [7, 8, 9]) captureCase(index);
	const cancelled = trigger.observe(goalId);
	assert.ok(cancelled);
	assert.equal(service.cancel(goalId, cancelled.id).status, "cancelled");
	assert.deepEqual(trigger.pending(goalId), [], "a cancelled batch stays consumed");

	console.log("Browser Evolution returns a batch no Candidate Replay ever saw, at most once");
} finally {
	service.stop();
	rmSync(root, { recursive: true, force: true });
}
