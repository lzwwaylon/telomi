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
	type EvolutionTarget,
} from "../../server/evolution/service.js";

const root = mkdtempSync(join(tmpdir(), "telomi-browser-trigger-"));
const workspaceDir = join(root, "data");
const goalId = "goal_browser";
mkdirSync(join(workspaceDir, goalId, "skills", "prime-search"), { recursive: true });

interface FakeExecution {
	execution_id: string;
	provider_id: string;
	terminal_status: string;
}

interface FakeCase {
	runId: string;
	caseId: string;
	capturedAt: string;
	status: "succeeded" | "failed";
	capabilitySnapshotId?: string;
	executions: FakeExecution[];
}

const cases: FakeCase[] = [];
const incomplete = new Set<string>();
const caseResults = join(root, "case-results");
mkdirSync(caseResults, { recursive: true });

function resultPath(ref: NodeBacktestCaseRef): string {
	return join(caseResults, `${ref.sourceRunId}__${ref.caseId}.json`);
}

/** One captured production Prime Search Case with `count` successful Browser executions. */
function captureCase(input: {
	runId: string;
	caseId: string;
	capturedAt: string;
	browserExecutions: number;
	researchRunStatus?: string;
	status?: "succeeded" | "failed";
	capabilitySnapshotId?: string;
	extra?: FakeExecution[];
}): void {
	const executions: FakeExecution[] = [
		...Array.from({ length: input.browserExecutions }, (_value, index) => ({
			execution_id: `provider-execution:1:browser:sub-${index + 1}`,
			provider_id: "browser",
			terminal_status: "valid_bundle",
		})),
		...(input.extra ?? []),
	];
	const value: FakeCase = {
		runId: input.runId,
		caseId: input.caseId,
		capturedAt: input.capturedAt,
		status: input.status ?? "succeeded",
		executions,
		...(input.capabilitySnapshotId ? { capabilitySnapshotId: input.capabilitySnapshotId } : {}),
	};
	cases.push(value);
	writeFileSync(resultPath({ sourceRunId: value.runId, caseId: value.caseId }),
		`${JSON.stringify({ schema_version: 1, execution_records: executions }, null, 2)}\n`);
	setResearchRunStatus(input.runId, input.researchRunStatus ?? "published");
}

function setResearchRunStatus(runId: string, status: string): void {
	const directory = runRecordDir(workspaceDir, goalId, runId);
	mkdirSync(directory, { recursive: true });
	writeFileSync(join(directory, "run-state.json"), `${JSON.stringify({ status })}\n`);
}

const nodeBacktests = {
	listCases: () => cases.map((value) => ({
		ref: { sourceRunId: value.runId, caseId: value.caseId },
		value,
	})),
	listCaseFilePaths: (_goalId: string, ref: NodeBacktestCaseRef) => {
		const files = replayableChildFiles(`${resultPath(ref)}-files`, resultPath(ref));
		return incomplete.has(ref.caseId) ? files.filter((file) => !file.ref.endsWith(".execution-id")) : files;
	},
	caseFile: (_goalId: string, ref: NodeBacktestCaseRef) => resultPath(ref),
} as unknown as NodeBacktestService;

let releaseEvidence: () => void = () => {};
const gate = () => new Promise<void>((resolve) => { releaseEvidence = resolve; });
let evidenceGate = gate();

const target: EvolutionTarget = {
	id: BROWSER_EVOLUTION_TARGET_ID,
	ownerAgentId: "prime-search",
	version: 2,
	async collectEvidence() {
		await evidenceGate;
		return { manifest: { kind: "browser_provider_executions" }, files: [] };
	},
	async innerLoop() {
		throw new Error("The inner loop is out of scope for the trigger");
	},
};


function createService(): EvolutionService {
	return new EvolutionService({ workspaceDir, listGoalIds: () => [goalId], targets: [target] });
}

function createTrigger(evolution: EvolutionService): BrowserEvolutionTrigger {
	return new BrowserEvolutionTrigger({ workspaceDir, nodeBacktests, evolution });
}

let service = createService();
let trigger = createTrigger(service);

try {
	captureCase({ runId: "run-incomplete", caseId: "case-incomplete", capturedAt: "2026-07-01T00:00:00.000Z", browserExecutions: 3 });
	incomplete.add("case-incomplete");
	assert.deepEqual(trigger.countable(goalId), [], "incomplete historical children do not spend Evolution attempts");
	assert.equal(trigger.observe(goalId), undefined);
	assert.equal(service.list(goalId).length, 0);
	cases.pop();
	// Three executions from one Case are three completed children, but not three independent
	// historical scenarios. A batch waits until it can replay three distinct Cases.
	captureCase({ runId: "run-duplicate", caseId: "case-duplicate", capturedAt: "2026-08-01T00:00:00.000Z",
		browserExecutions: 3 });
	assert.equal(trigger.countable(goalId).length, 3);
	assert.equal(trigger.observe(goalId), undefined, "one Case cannot fill a three-Case Evolution batch by itself");
	cases.pop();
	rmSync(resultPath({ sourceRunId: "run-duplicate", caseId: "case-duplicate" }));

	// A Case whose enclosing Research Run has not settled is not countable yet.
	captureCase({ runId: "run-1", caseId: "case-1", capturedAt: "2026-09-01T00:00:00.000Z",
		browserExecutions: 1, researchRunStatus: "search_batch_running" });
	assert.deepEqual(trigger.countable(goalId), [], "an unsettled Research Run must not release its executions");
	setResearchRunStatus("run-1", "published");
	assert.equal(trigger.countable(goalId).length, 1);
	assert.equal(trigger.observe(goalId), undefined, "one execution must not start an Evolution");

	captureCase({ runId: "run-2", caseId: "case-2", capturedAt: "2026-09-02T00:00:00.000Z", browserExecutions: 1 });
	assert.equal(trigger.observe(goalId), undefined, "two executions must not start an Evolution");

	// Only terminal Browser successes count: a degraded bundle and other Providers are ignored.
	captureCase({ runId: "run-3", caseId: "case-3", capturedAt: "2026-09-03T00:00:00.000Z", browserExecutions: 0, extra: [
		{ execution_id: "provider-execution:1:browser:degraded", provider_id: "browser", terminal_status: "degraded_bundle" },
		{ execution_id: "provider-execution:1:github:sub-1", provider_id: "github", terminal_status: "valid_bundle" },
	] });
	assert.equal(trigger.observe(goalId), undefined, "a degraded Browser execution is not a completion receipt");

	// A Candidate Replay Case must never feed the next batch.
	captureCase({ runId: "run-4", caseId: "case-4", capturedAt: "2026-09-04T00:00:00.000Z",
		browserExecutions: 1, capabilitySnapshotId: "cap-1" });
	assert.equal(trigger.observe(goalId), undefined, "Candidate Replay Cases must not count");

	captureCase({ runId: "run-5", caseId: "case-5", capturedAt: "2026-09-05T00:00:00.000Z", browserExecutions: 1 });
	// Only the current execution_records field supplies Browser completion receipts.
	cases.push({ runId: "run-legacy", caseId: "case-legacy", capturedAt: "2026-08-30T00:00:00.000Z", status: "succeeded",
		executions: [] });
	writeFileSync(resultPath({ sourceRunId: "run-legacy", caseId: "case-legacy" }), `${JSON.stringify({
		schema_version: 2,
		executions: [{ execution_id: "provider-execution:1:browser:legacy", provider_id: "browser", terminal_status: "valid_bundle" }],
	})}\n`);
	setResearchRunStatus("run-legacy", "published");
	assert.deepEqual(trigger.countable(goalId).map((unit) => unit.runId), ["run-1", "run-2", "run-5"]);
	captureCase({ runId: "run-0", caseId: "case-0", capturedAt: "2026-08-31T00:00:00.000Z", browserExecutions: 1 });

	const first = trigger.observe(goalId);
	assert.ok(first, "the third settled execution starts exactly one Evolution");
	assert.equal(first.targetId, BROWSER_EVOLUTION_TARGET_ID);
	assert.deepEqual(first.evidenceRefs, [
		{ kind: "browser_provider_execution", runId: "run-0", caseId: "case-0", executionId: "provider-execution:1:browser:sub-1" },
		{ kind: "browser_provider_execution", runId: "run-1", caseId: "case-1", executionId: "provider-execution:1:browser:sub-1" },
		{ kind: "browser_provider_execution", runId: "run-2", caseId: "case-2", executionId: "provider-execution:1:browser:sub-1" },
	], "batch one consumes the three oldest settled executions");

	// Executions arriving while the batch runs wait for the next batch.
	for (const [index, capturedAt] of ["2026-09-06", "2026-09-07", "2026-09-08"].entries()) {
		captureCase({ runId: `run-${index + 6}`, caseId: `case-${index + 6}`,
			capturedAt: `${capturedAt}T00:00:00.000Z`, browserExecutions: 1 });
	}
	assert.equal(trigger.observe(goalId), undefined, "one Goal runs at most one Browser Evolution at a time");
	assert.equal(trigger.pending(goalId).length, 4, "new executions stay pending while a batch is active");

	// A settled batch releases the Goal, and its executions stay consumed.
	assert.equal(service.cancel(goalId, first.id).status, "cancelled");
	releaseEvidence();
	const second = trigger.observe(goalId);
	assert.ok(second, "a settled batch releases the Goal for the next one");
	assert.deepEqual(second.evidenceRefs.map((ref) => ref.runId), ["run-5", "run-6", "run-7"],
		"batches must not overlap, even after a cancelled batch");
	assert.equal(service.cancel(goalId, second.id).status, "cancelled");

	// Restart: the Evolution Run store is the cursor, so no consumed execution is replayed.
	service.stop();
	service = createService();
	trigger = createTrigger(service);
	assert.deepEqual(trigger.pending(goalId).map((unit) => unit.runId), ["run-8"],
		"a restart must not re-consume a persisted batch, and must keep the unconsumed remainder");
	assert.equal(trigger.observe(goalId), undefined);

	evidenceGate = gate();
	for (const [index, capturedAt] of ["2026-09-09", "2026-09-10", "2026-09-11"].entries()) {
		captureCase({ runId: `run-${index + 9}`, caseId: `case-${index + 9}`,
			capturedAt: `${capturedAt}T00:00:00.000Z`, browserExecutions: 1 });
	}
	const third = trigger.observe(goalId);
	assert.ok(third, "a restarted trigger keeps counting from the persisted cursor");
	assert.deepEqual(third.evidenceRefs.map((ref) => ref.runId), ["run-8", "run-9", "run-10"]);
	assert.equal(new Set(service.list(goalId).flatMap((run) => run.evidenceRefs)
		.map((ref) => `${ref.runId as string} ${ref.executionId as string}`)).size, 9,
		"every consumed execution appears exactly once across all batches");

	console.log("Browser Evolution triggers once per settled batch of three and never reuses an execution");
} finally {
	releaseEvidence();
	service.stop();
	rmSync(root, { recursive: true, force: true });
}
