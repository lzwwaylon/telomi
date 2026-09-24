/**
 * Phase 3 的 Case 生命周期检查（计划 §9）。
 *
 * 覆盖：保留期上限、容量上限的最旧优先删除、只清理正式 Capture 拥有的 Case、
 * 未进入终态的 Run 不被触碰，以及失败 Capture 作为 Recovery Case 的可回放性和
 * 缺证据时的 fail-closed 拒绝。
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { serverRuntimeDirForGoal } from "../../server/workspaces/server-runtime-paths.js";
import {
	capturedCaseRunRoots,
	NodeBacktestService,
	type NodeBacktestRun,
} from "../../server/evaluation/node-backtest.js";
import {
	caseRetentionStatus,
	productionRunActive,
	resetCaseRetentionForTest,
	startCaseRetention,
	sweepCapturedCases,
} from "../../server/evaluation/case-retention.js";
import { withCaseExport } from "../../server/evaluation/case-export-lock.js";
import { classifyResearchError, ResearchNodeError } from "../../server/agent-runtime/retry-policy.js";
import {
	beginNodeEvaluationCase,
	failedNodeEvaluationStatus,
	finishNodeEvaluationCase,
	type NodeEvaluationCaseDraft,
	type NodeReplayRecipe,
} from "../../server/agent-runtime/node-evaluation.js";
import { RunArtifactStore } from "../../server/agent-runtime/artifact-store.js";
import { type AgentStageRequest } from "../../server/agent-runtime/agent-stage-runtime.js";

const root = mkdtempSync(join(tmpdir(), "telomi-case-lifecycle-"));
const workspaceDir = join(root, "data");
const goalId = "goal_lifecycle";
const goalDirectory = join(workspaceDir, goalId);
const runtimeDir = serverRuntimeDirForGoal(goalId, workspaceDir);
const runsRoot = join(runtimeDir, "runs");
mkdirSync(goalDirectory, { recursive: true });

const DAY = 24 * 60 * 60 * 1000;
const now = Date.parse("2026-09-08T00:00:00.000Z");
/** 保留期和容量之外的第三个边界：静默期内的 Case 任何情况下都不删。 */
const policy = { maxAgeMs: 30 * DAY, maxBytes: 50 * 1024 ** 3, minAgeMs: 60 * 60 * 1000 };

// ---------------------------------------------------------------------------
// 保留期上限：超过 30 天的 Case 删除，其余保留。
// ---------------------------------------------------------------------------

writeCapturedCase("run-age", "case-40d", now - 40 * DAY, 200);
writeCapturedCase("run-age", "case-10d", now - 10 * DAY, 200);
writeCapturedCase("run-age", "case-1h", now - 90 * 60 * 1000, 200);

const dryRun = sweep({ dryRun: true });
assert.equal(dryRun.deletedByAge, 1, "dry run reports the same age deletion");
assert.ok(caseExists("run-age", "case-40d"), "dry run must not touch the disk");

const byAge = sweep();
assert.equal(byAge.scanned, 3);
assert.equal(byAge.deletedByAge, 1);
assert.equal(byAge.deletedBySize, 0);
assert.equal(byAge.retained, 2);
assert.equal(caseExists("run-age", "case-40d"), false, "Cases past the retention window are deleted");
assert.ok(caseExists("run-age", "case-10d"));
assert.ok(caseExists("run-age", "case-1h"), "Cases inside the retention window survive");
assert.equal(sweep().deletedByAge, 0, "a second sweep over the same disk deletes nothing new");

// ---------------------------------------------------------------------------
// 容量上限：从最旧开始删，直到回到上限之内。
// ---------------------------------------------------------------------------

rmSync(runsRoot, { recursive: true, force: true });
for (const [caseId, ageDays] of [["case-a", 8], ["case-b", 6], ["case-c", 4], ["case-d", 2]] as const) {
	writeCapturedCase("run-size", caseId, now - ageDays * DAY, 1_000);
}
const bytesEach = sweep({ policy: { maxBytes: 1024 ** 3 } }).retainedBytes / 4;
const bySize = sweep({ policy: { maxBytes: Math.floor(bytesEach * 2.5) } });
assert.equal(bySize.deletedByAge, 0);
assert.equal(bySize.deletedBySize, 2, "the size cap deletes until the total is back inside the cap");
assert.equal(caseExists("run-size", "case-a"), false, "the size cap deletes oldest first");
assert.equal(caseExists("run-size", "case-b"), false);
assert.ok(caseExists("run-size", "case-c"));
assert.ok(caseExists("run-size", "case-d"));
assert.ok(bySize.retainedBytes <= Math.floor(bytesEach * 2.5));

// ---------------------------------------------------------------------------
// 所有权：只删正式 Capture 的 Case 目录，别的东西一概不碰。
// ---------------------------------------------------------------------------

rmSync(runsRoot, { recursive: true, force: true });
writeCapturedCase("run-owned", "case-owned", now - 90 * DAY, 100);
writeFileSync(join(runsRoot, "run-owned", "session.jsonl"), "{}\n");
mkdirSync(join(runsRoot, "run-owned", "artifacts"), { recursive: true });
writeFileSync(join(runsRoot, "run-owned", "artifacts", "report.md"), "# report\n");

const foreign = [
	// Candidate Replay 自己捕获的 Case。
	join(runtimeDir, "evaluation", "node-backtests", "nodebt_1", "executions", "candidate_1",
		"node-evaluation", "cases", "candidate-case", "manifest.json"),
	// 评估环境导入的 Bundle。
	join(runtimeDir, "evaluation", "imported-cases", "bundle-1",
		"node-evaluation", "cases", "imported-case", "manifest.json"),
	// Capability Snapshot 与 Material Cache。
	join(runtimeDir, "evaluation", "capability-snapshots", "caps_1", "manifest.json"),
	join(workspaceDir, ".material-cache", "objects", "blob"),
];
for (const path of foreign) {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify({ capturedAt: new Date(now - 400 * DAY).toISOString() })}\n`);
}

const owned = sweep({ policy: { maxAgeMs: 0 } });
assert.equal(owned.scanned, 1, "only production captured Cases are scanned");
assert.equal(owned.deletedByAge, 1);
assert.equal(caseExists("run-owned", "case-owned"), false);
assert.ok(existsSync(join(runsRoot, "run-owned", "session.jsonl")), "the product Run itself is never deleted");
assert.ok(existsSync(join(runsRoot, "run-owned", "artifacts", "report.md")), "product Artifacts are never deleted");
for (const path of foreign) assert.ok(existsSync(path), `retention must not touch ${path}`);
assert.deepEqual(
	capturedCaseRunRoots(workspaceDir, goalId).filter((path) => path.includes(`${"evaluation"}/`)),
	[],
	"Case ownership never reaches into the evaluation/ tree",
);

// A Bundle export owns the Case until its tar is complete, even when the Case is otherwise expired.
writeCapturedCase("run-exporting", "case-exporting", now - 90 * DAY, 100);
const exportingDirectory = join(runsRoot, "run-exporting", "node-evaluation", "cases", "case-exporting");
let finishExport!: () => void;
const exporting = withCaseExport(exportingDirectory,
	() => new Promise<void>((resolve) => { finishExport = resolve; }));
await Promise.resolve();
const duringExport = sweep({ policy: { maxAgeMs: 0 } });
assert.equal(duringExport.protectedExporting, 1);
assert.ok(existsSync(exportingDirectory), "retention must not move a Case while Bundle export reads it");
finishExport();
await exporting;
assert.equal(sweep({ policy: { maxAgeMs: 0 } }).deletedByAge, 1);
assert.equal(existsSync(exportingDirectory), false, "the Case becomes sweepable after export finishes");

// ---------------------------------------------------------------------------
// 活跃 Run：未进入终态的 Run 和仍在写的 Capture 一律跳过。
// ---------------------------------------------------------------------------

rmSync(runsRoot, { recursive: true, force: true });
writeCapturedCase("run-writing", "case-active", now - 90 * DAY, 100);
writeFileSync(join(runsRoot, "run-writing", "run-state.json"), `${JSON.stringify({ status: "chapters_writing" })}\n`);
writeCapturedCase("run-published", "case-settled", now - 90 * DAY, 100);
writeFileSync(join(runsRoot, "run-published", "run-state.json"), `${JSON.stringify({ status: "published" })}\n`);
writeCapturedCase("run-wiki", "case-wiki", now - 90 * DAY, 100);
writeFileSync(join(runsRoot, "run-wiki", "wiki-update-job.json"), `${JSON.stringify({ status: "running" })}\n`);
writeCapturedCase("run-corrupt", "case-corrupt", now - 90 * DAY, 100);
writeFileSync(join(runsRoot, "run-corrupt", "run-state.json"), "{ truncated\n");
// Capture 还没写出 Manifest：目录存在但不是可回放 Case。
const inFlight = join(runsRoot, "run-published", "node-evaluation", "cases", "case-in-flight");
mkdirSync(inFlight, { recursive: true });
writeFileSync(join(inFlight, "user-prompt.txt"), "in flight\n");
// 上一次删除被进程退出打断后留下的暂存目录。
const leftover = join(runsRoot, "run-published", "node-evaluation", ".trash", "case-old.abcdef");
mkdirSync(leftover, { recursive: true });
writeFileSync(join(leftover, "manifest.json"), "{}\n");

assert.equal(productionRunActive(join(runsRoot, "run-writing")), true);
assert.equal(productionRunActive(join(runsRoot, "run-published")), false);
assert.equal(productionRunActive(join(runsRoot, "run-wiki")), true);
assert.equal(productionRunActive(join(runsRoot, "run-corrupt")), true, "an unreadable Run state stays protected");
assert.equal(productionRunActive(join(runsRoot, "run-owned")), false, "a Run with no state file is not active by itself");

const active = sweep({ policy: { maxAgeMs: 0 } });
assert.equal(active.protectedActive, 3, "Cases of Runs that have not settled are skipped");
assert.equal(active.protectedRecent, 1, "the Case still being written is inside the quiet period");
assert.equal(active.deletedByAge, 1);
assert.ok(caseExists("run-writing", "case-active"));
assert.ok(caseExists("run-wiki", "case-wiki"));
assert.ok(caseExists("run-corrupt", "case-corrupt"));
assert.ok(existsSync(inFlight), "an unfinished Capture directory is never deleted");
assert.equal(caseExists("run-published", "case-settled"), false);
assert.equal(existsSync(leftover), false, "an interrupted deletion is finished by the next sweep");
assert.equal(existsSync(join(runsRoot, "run-published", "node-evaluation", ".trash")), false);

// ---------------------------------------------------------------------------
// 容量上限到不了时是健康告警，不是完成。
// ---------------------------------------------------------------------------

const shortfall = sweep({ policy: { maxAgeMs: 30 * DAY, maxBytes: 1 } });
assert.ok(shortfall.retainedBytes > 1, "protected Cases keep the store above the cap");
assert.equal(shortfall.deletedBySize, 0);
assert.ok(
	shortfall.warnings.some((warning) =>
		warning.startsWith(`size cap not reached: ${shortfall.retainedBytes - 1} bytes above the 1 byte cap`)),
	`the remaining bytes above the cap must be reported: ${JSON.stringify(shortfall.warnings)}`,
);

// ---------------------------------------------------------------------------
// Settled Evolution Runs shrink to their record after the retention period.
// ---------------------------------------------------------------------------

{
	const evolutionRuns = join(runtimeDir, "evolution", "runs");
	const backtests = join(runtimeDir, "evaluation", "node-backtests");
	const writeBacktest = (id: string, status: string) => {
		mkdirSync(join(backtests, id, "executions"), { recursive: true });
		writeFileSync(join(backtests, id, "run.json"), `${JSON.stringify({ id, status })}\n`);
		writeFileSync(join(backtests, id, "executions", "payload.bin"), "x".repeat(1_000));
	};
	const writeEvolutionRun = (id: string, status: string, updatedAtMs: number, replayRunIds: string[]) => {
		const directory = join(evolutionRuns, id);
		for (const bulky of ["evidence", "replay-evidence", "rounds"]) {
			mkdirSync(join(directory, bulky), { recursive: true });
			writeFileSync(join(directory, bulky, "payload.bin"), "x".repeat(1_000));
		}
		writeFileSync(join(directory, "current.json"), `${JSON.stringify({
			id, status, updatedAt: new Date(updatedAtMs).toISOString(),
			innerLoop: { rounds: replayRunIds.map((replayRunId, index) => ({ round: index + 1, replayRunId })) },
		})}\n`);
		writeFileSync(join(directory, "request.json"), "{}\n");
		writeFileSync(join(directory, "apply-receipt.json"), "{}\n");
		return directory;
	};
	writeBacktest("nodebt_old", "awaiting_evaluation");
	writeBacktest("nodebt_running", "running");
	const old = writeEvolutionRun("evo-old", "applied", now - 40 * DAY, ["nodebt_old", "nodebt_running", ""]);
	const recent = writeEvolutionRun("evo-recent", "no_change", now - 5 * DAY, []);
	const inFlight = writeEvolutionRun("evo-in-flight", "replaying", now - 40 * DAY, []);
	const withCase = writeEvolutionRun("evo-with-case", "failed", now - 40 * DAY, []);
	const evolutionCase = join(withCase, "node-evaluation", "cases", "evolution-case");
	mkdirSync(evolutionCase, { recursive: true });
	writeFileSync(join(evolutionCase, "manifest.json"), `${JSON.stringify({ capturedAt: new Date(now - DAY).toISOString() })}\n`);

	const preview = sweep({ dryRun: true });
	assert.equal(preview.compactedEvolutionRuns, 1);
	assert.ok(existsSync(join(old, "evidence")), "a dry run deletes nothing");

	const compacted = sweep();
	assert.equal(compacted.compactedEvolutionRuns, 1, "only the settled, expired Run without a retained Case is compacted");
	assert.deepEqual(readdirSync(old).sort(), ["apply-receipt.json", "current.json", "request.json"],
		"the record that keeps the Browser trigger cursor survives");
	assert.equal(existsSync(join(backtests, "nodebt_old")), false, "its finished Replay goes with it");
	assert.ok(existsSync(join(backtests, "nodebt_running")), "a Replay still running is never deleted");
	for (const kept of [recent, inFlight, withCase]) assert.ok(existsSync(join(kept, "evidence")), `${kept} must be kept whole`);
	assert.equal(sweep().compactedEvolutionRuns, 0, "compaction is idempotent");
	rmSync(join(runtimeDir, "evolution"), { recursive: true, force: true });
	rmSync(join(backtests, "nodebt_running"), { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// 首次 Sweep 不在启动关键路径上，由 idle() 确定性等待。
// ---------------------------------------------------------------------------

resetCaseRetentionForTest();
const sweeper = startCaseRetention({
	workspaceDir,
	listGoalIds: () => [goalId],
	policy: { maxAgeMs: 0, minAgeMs: 0 },
	intervalMs: 60 * 60 * 1000,
});
assert.equal(caseRetentionStatus().lastSweepAt, undefined,
	"startCaseRetention must return before the first recursive scan runs");
assert.ok(existsSync(join(runsRoot, "run-corrupt", "node-evaluation", "cases", "case-corrupt")),
	"no Case may be swept on the startup critical path");
await sweeper.idle();
sweeper.stop();
const scheduled = caseRetentionStatus();
assert.ok(scheduled.enabled);
assert.ok(scheduled.lastSweepAt, "the scheduled sweep records its health after it settles");
assert.equal(scheduled.protectedActive, 3, "the scheduled sweep applies the same protections");
assert.ok(scheduled.cases >= 3);
resetCaseRetentionForTest();

// ---------------------------------------------------------------------------
// Recovery Case：失败 Capture 仍可回放，缺证据的 Case 在排队时就被拒绝。
// ---------------------------------------------------------------------------

rmSync(runsRoot, { recursive: true, force: true });
const recoveryRunId = "recovery-source-run";
const recoveryRun = join(runsRoot, recoveryRunId);
mkdirSync(recoveryRun, { recursive: true });

const failedCaseId = captureCase("failed-node", {
	status: "failed",
	error: "Prime Search child never submitted a Candidate Ledger",
	terminalFiles: { "work/notes.md": "partial work\n" },
});
const evidencelessCaseId = captureCase("evidenceless-node", { status: "failed" });
const succeededWithoutOutputCaseId = captureCase("no-output-node", {
	status: "succeeded",
	terminalFiles: { "work/notes.md": "ignored\n" },
});

const recipe: NodeReplayRecipe = {
	identity: { id: "recovery-fixture", version: 1 },
	replay: async (input) => ({
		caseId: input.value.caseId,
		agentId: "recovery-fixture",
		artifact: input.artifactStore.publishText('{"recovered":true}\n', "artifacts/recovered.json"),
		usage: { inputTokens: 1, outputTokens: 1, costUsd: 0, calls: 1 },
		turns: 1,
		toolCalls: 1,
	}),
};
const service = new NodeBacktestService({ workspaceDir, listGoalIds: () => [goalId], recipes: [recipe] });

try {
	service.start();
	const files = service.listCaseFiles(goalId, { sourceRunId: recoveryRunId, caseId: failedCaseId });
	assert.ok(files.some((file) => file.ref === "input:request.json" && file.kind === "input"),
		"a Recovery Case keeps its frozen input");
	assert.ok(files.some((file) => file.ref === "terminal:work/notes.md" && file.kind === "terminal_workspace"),
		"a Recovery Case exposes its terminal workspace as Evidence");
	assert.equal(files.some((file) => file.kind === "observed_output"), false);
	assert.match(service.readCase(goalId, { sourceRunId: recoveryRunId, caseId: failedCaseId }).observed.error ?? "",
		/Candidate Ledger/u, "a Recovery Case keeps its terminal error");

	const request = {
		agentId: "recovery-fixture",
		candidate: {},
		repetitions: 1,
		rubricId: "recovery-fixture",
	};
	const recovery = await waitForRun(service.enqueue(goalId, {
		...request,
		cases: [{ sourceRunId: recoveryRunId, caseId: failedCaseId }],
	}));
	assert.equal(recovery.kind, "recovery");
	assert.equal(recovery.status, "completed", "a Recovery Replay settles without a human Judgment");
	assert.equal(recovery.executions.length, 1);
	assert.equal(recovery.executions[0]?.status, "completed");
	assert.deepEqual(recovery.pairs, [], "a Recovery Replay must not fabricate an A/B pair");
	assert.throws(() => service.evaluationBatch(goalId, recovery.id), /Recovery Replay/u);

	assert.throws(() => service.enqueue(goalId, {
		...request,
		cases: [{ sourceRunId: recoveryRunId, caseId: evidencelessCaseId }],
	}), /missing terminal error evidence, a terminal workspace or trace/u,
	"a Case with neither output nor terminal Evidence is rejected before any Candidate runs");

	assert.throws(() => service.enqueue(goalId, {
		...request,
		cases: [{ sourceRunId: recoveryRunId, caseId: succeededWithoutOutputCaseId }],
	}), /missing a terminal failure status/u);

	assert.throws(() => service.enqueue(goalId, {
		...request,
		cases: [
			{ sourceRunId: recoveryRunId, caseId: failedCaseId },
			{ sourceRunId: recoveryRunId, caseId: captureCase("quality-node", { status: "succeeded", output: true }) },
		],
	}), /cannot mix Quality Cases and Recovery Cases/u);

	// ---------------------------------------------------------------------------
	// 终态失败分类：provider、timeout、rate_limit 和 cancelled 都留成 Recovery Case。
	// ---------------------------------------------------------------------------

	for (const [failureClass, error] of [
		["provider", new Error("Browser Provider child never submitted a Candidate Ledger")],
		["timeout", new Error("Prime Search worker timed out after 900s")],
		["rate_limit", new Error("upstream returned 429 too many requests")],
		["permanent", new ResearchNodeError("Skill contract rejected the output", "permanent", false)],
		["cancelled", new Error("the stage was aborted before it finished")],
	] as const) {
		assert.equal(classifyResearchError(error), failureClass,
			`${failureClass} fixture must classify as the failure class the Stage Runtime records`);
		const status = failedNodeEvaluationStatus(failureClass);
		assert.equal(status, failureClass === "cancelled" ? "cancelled" : "failed");
		const caseId = captureCase(`${failureClass}-node`, {
			status,
			error: error.message,
			terminalFiles: { "work/partial.json": '{"incomplete":true}\n' },
		});
		const captured = service.readCase(goalId, { sourceRunId: recoveryRunId, caseId });
		assert.equal(captured.status, status, `${failureClass} must keep its terminal status`);
		assert.equal(captured.observed.output, undefined);
		assert.ok(captured.observed.terminalWorkspace, `${failureClass} must keep its terminal workspace`);
		assert.equal(captured.observed.error, error.message);
		const run = await waitForRun(service.enqueue(goalId, {
			...request,
			cases: [{ sourceRunId: recoveryRunId, caseId }],
		}));
		assert.equal(run.kind, "recovery", `${failureClass} failures must replay as Recovery Cases`);
		assert.equal(run.status, "completed");
		assert.deepEqual(run.pairs, []);
	}

	// 产品结果不变：Capture 收尾永远 fail-open，Stage Runtime 抛出的仍是原始失败。
	const brokenDraft = draftFor("fail-open-node");
	rmSync(brokenDraft.caseDirectory, { recursive: true, force: true });
	writeFileSync(brokenDraft.caseDirectory, "not a directory\n");
	const brokenCapture = finishNodeEvaluationCase(brokenDraft, {
		status: failedNodeEvaluationStatus("provider"),
		workDirectory: join(root, "work", "fail-open-node"),
		validationErrors: [],
		error: "Browser Provider child never submitted a Candidate Ledger",
	});
	assert.equal(brokenCapture.status, "capture_failed",
		"an unwritable Case is reported, never thrown into the product failure path");

	console.log("Case retention caps, ownership isolation, active-Run protection and Recovery Case replay checks passed");
} finally {
	service.stop();
	rmSync(root, { recursive: true, force: true });
}

function sweep(options: { dryRun?: boolean; policy?: Partial<typeof policy> } = {}) {
	return sweepCapturedCases({
		workspaceDir,
		goalIds: [goalId],
		now,
		policy: { ...policy, ...options.policy },
		...(options.dryRun ? { dryRun: true } : {}),
	});
}

function caseDirectory(runId: string, caseId: string): string {
	return join(runsRoot, runId, "node-evaluation", "cases", caseId);
}

function caseExists(runId: string, caseId: string): boolean {
	return existsSync(join(caseDirectory(runId, caseId), "manifest.json"));
}

function writeCapturedCase(runId: string, caseId: string, capturedAtMs: number, payloadBytes: number): void {
	const directory = caseDirectory(runId, caseId);
	mkdirSync(directory, { recursive: true });
	writeFileSync(join(directory, "manifest.json"),
		`${JSON.stringify({ caseId, capturedAt: new Date(capturedAtMs).toISOString() })}\n`);
	writeFileSync(join(directory, "payload.bin"), "x".repeat(payloadBytes));
}

/** Captures one real Case through the production capture seam and returns its Case id. */
function captureCase(nodeId: string, input: {
	status: "succeeded" | "failed" | "cancelled";
	error?: string;
	terminalFiles?: Record<string, string>;
	output?: true;
}): string {
	const draft = draftFor(nodeId);
	const workDirectory = join(root, "work", nodeId);
	for (const [relativePath, content] of Object.entries(input.terminalFiles ?? {})) {
		const path = join(workDirectory, relativePath);
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, content);
	}
	const entry = join(workDirectory, "observed.json");
	if (input.output) writeFileSync(entry, "{}\n");
	const capture = finishNodeEvaluationCase(draft, {
		status: input.status,
		workDirectory,
		validationErrors: [],
		...(input.error ? { error: input.error } : {}),
		...(input.output ? {
			result: {
				value: {},
				artifact: new RunArtifactStore(recoveryRun).publishFile(entry, `observed/${nodeId}.json`),
				submissionCount: 1,
				validationErrors: [],
				session: { id: nodeId, mode: "fresh" },
				turns: 1,
				toolCalls: 1,
				toolCounts: {},
				usage: { inputTokens: 1, outputTokens: 1, costUsd: 0, calls: 1 },
				sessionPath: join(recoveryRun, ".missing-session.jsonl"),
			},
		} : {}),
	});
	assert.equal(capture.status, "captured", `${nodeId} capture failed`);
	return capture.status === "captured" ? capture.caseId : "";
}

/** The frozen Case draft a Stage Runtime opens before it executes the node. */
function draftFor(nodeId: string): NodeEvaluationCaseDraft {
	const workDirectory = join(root, "work", nodeId);
	mkdirSync(workDirectory, { recursive: true });
	const inputDirectory = join(recoveryRun, "inputs", nodeId);
	mkdirSync(inputDirectory, { recursive: true });
	writeFileSync(join(inputDirectory, "request.json"), `${JSON.stringify({ nodeId })}\n`);
	const draft = beginNodeEvaluationCase({
		request: {
			runId: recoveryRunId,
			stageId: nodeId,
			attemptId: "1",
			role: "cornell_note",
			recordKind: "research",
			promptConfig: { domain: "research", id: "recovery-fixture", sandboxRole: "research.cornell-note" },
			evaluation: {
				agentId: "recovery-fixture",
				recipe: { id: "recovery-fixture", version: 1 },
				recipeInput: {},
				inputRelativePath: `inputs/${nodeId}`,
				harnessMounts: [],
				liveExternalState: false,
			},
			session: { key: nodeId, policy: "fresh" },
			modelPolicy: { preferred: ["openai-codex/gpt-5.4-mini"] },
			systemPrompt: "system",
			userPrompt: "user",
			workDirectory,
			readonlyMounts: [],
			controlDirectory: recoveryRun,
			recordDirectory: recoveryRun,
			artifactStore: new RunArtifactStore(recoveryRun),
			output: { kind: "cornell_note", publishRelativePath: `replays/${nodeId}.json`, validate: () => ({}) },
			signal: new AbortController().signal,
		} as unknown as AgentStageRequest<unknown>,
		recordDirectory: recoveryRun,
		promptConfig: { domain: "research", id: "recovery-fixture", sandboxRole: "research.cornell-note" },
		sessionContextFile: join(recoveryRun, ".missing-session.jsonl"),
		composedSystemPrompt: "system",
		actualModel: "openai-codex/gpt-5.4-mini",
	});
	assert.ok(draft);
	return draft;
}

async function waitForRun(queued: NodeBacktestRun): Promise<NodeBacktestRun> {
	for (let attempt = 0; attempt < 300; attempt += 1) {
		const run = service.read(goalId, queued.id)!;
		if (["awaiting_evaluation", "completed", "failed", "cancelled"].includes(run.status)) return run;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(`Node Backtest '${queued.id}' did not finish`);
}
