import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { captureProviderChildCase, type ProviderChildInput } from "../../server/evaluation/provider-child-case.js";
import { createProviderChildReplayRecipe } from "../../server/evaluation/provider-child-replay.js";
import { NodeBacktestService, type NodeBacktestCaseRef } from "../../server/evaluation/node-backtest.js";
import type { ProviderChildReplayRequest } from "../../server/research/pipeline/provider-child-executor.js";
import { serverRuntimeDirForGoal } from "../../server/workspaces/server-runtime-paths.js";
import { sha256 } from "../../server/lib/hash.js";
import { listFilesRecursive } from "../../server/lib/fs.js";

const root = mkdtempSync(join(tmpdir(), "child-replay-service-"));
const goalId = "goal_child_replay";
const data = join(root, "data");
const task = "Read the assigned official release notes.";
const frozen: ProviderChildInput = { schema_version: 1, goal_id: goalId, provider_id: "browser", child_id: "sub-historical",
	source: { sourceRunId: "unavailable-parent", caseId: "unavailable-case", executionId: "provider-execution:1:browser:sub-historical" },
	model: "fixture/child", thinking: "medium", service_tier: "flex",
	temporal_context: { schemaVersion: 1, currentDate: "2026-01-01", timeZone: "UTC" }, task_sha256: sha256(task) };
const usage = { inputTokens: 4, outputTokens: 3, costUsd: 0.01, calls: 1 };
let mode: "success" | "failed" | "cancelled" = "success";
let calls = 0;
let entered = false;
const write = (path: string, content: string) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, content); };
const recipe = createProviderChildReplayRecipe({ execute: async (request: ProviderChildReplayRequest) => {
	calls += 1; entered = true;
	assert.equal(request.task, task);
	assert.equal(request.model, frozen.model);
	assert.equal(request.thinking, frozen.thinking);
	assert.equal(request.serviceTier, "flex");
	assert.deepEqual(request.temporalContext, frozen.temporal_context);
	assert.deepEqual(listFilesRecursive(request.initialWorkspace), ["work/input.txt"]);
	assert.equal(readFileSync(join(request.initialWorkspace, "work/input.txt"), "utf8"), "frozen dependency");
	assert.equal(readFileSync(join(request.frozenSkillsDirectory, "root-agent/helper/reference.txt"), "utf8"), "Frozen auxiliary reference");
	const skillsDirectory = join(request.recordDirectory, "agent/skills");
	cpSync(request.frozenSkillsDirectory, skillsDirectory, { recursive: true });
	const childId = `sub-replay-${calls}`;
	const workspaceRoot = join(request.recordDirectory, "agent/provider-executions", childId);
	const tracePath = join(request.recordDirectory, "runtime/trace.jsonl");
	const conditionsPath = join(request.recordDirectory, "runtime/execution-conditions.jsonl");
	const providerCallsPath = join(request.recordDirectory, "provider-calls.jsonl");
	const ledgerPath = join(workspaceRoot, "work/browser_candidates.json");
	write(ledgerPath, JSON.stringify({ schema_version: 2, provider_id: "browser", candidates: [] }));
	write(join(workspaceRoot, "work/child-only.txt"), "candidate child material");
	write(tracePath, JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "child evidence" }] } }) + "\n");
	write(conditionsPath, JSON.stringify({ launch_kind: "provider_child", agent_session_id: childId }) + "\n");
	write(providerCallsPath, JSON.stringify({ seq: 1, node_id: "provider-child", attempt_id: childId, sub_execution_id: childId,
		provider: "browser", at: "2026-01-01T00:00:00Z", latency_ms: 1,
		request: { query: "release", purpose: "assigned task", criterion_ids: [], max_results: 1 },
		response: { status: "empty", cache: "miss", doc_ids: [], docs: [], material_sha256: [] } }) + "\n");
	write(join(request.recordDirectory, "parent-secret.txt"), "PARENT SECRET");
	if (mode === "cancelled") {
		await new Promise<void>((resolve) => request.signal.addEventListener("abort", () => resolve(), { once: true }));
		throw new Error("Child cancelled");
	}
	if (mode === "failed") throw new Error("Child provider unavailable");
	return { workspaceRoot, skillsDirectory, childId, tracePath, conditionsPath, providerCallsPath, ledgerPath, usage, toolCalls: 1, durationMs: 2 };
} });
mkdirSync(join(data, goalId), { recursive: true });
const service = new NodeBacktestService({ workspaceDir: data, listGoalIds: () => [goalId], recipes: [recipe] });
let importedService: NodeBacktestService | undefined;
const enqueue = (owner: NodeBacktestService, ref: NodeBacktestCaseRef) => owner.enqueue(goalId, {
	agentId: "provider-child", cases: [ref], candidate: {}, repetitions: 1, rubricId: "provider-child-test-v1",
});
async function waitUntil(predicate: () => boolean) {
	const deadline = Date.now() + 30_000;
	while (!predicate()) {
		assert.ok(Date.now() < deadline, "Child Replay did not settle");
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}
async function settle(owner: NodeBacktestService, runId: string) {
	await waitUntil(() => ["awaiting_evaluation", "completed", "failed", "cancelled"].includes(owner.read(goalId, runId)!.status));
	return owner.read(goalId, runId)!;
}
const candidateCases = (owner: NodeBacktestService, runId: string) => owner.listCases(goalId, "provider-child", 100)
	.filter(({ ref }) => ref.sourceRunId.startsWith(`${runId}::executions::`));
try {
	const observedDirectory = join(serverRuntimeDirForGoal(goalId, data), "evaluation/provider-child-cases/observed");
	const inputDirectory = join(observedDirectory, "frozen");
	write(join(inputDirectory, "task.md"), task);
	write(join(inputDirectory, "request.json"), JSON.stringify(frozen));
	write(join(inputDirectory, "workspace/work/input.txt"), "frozen dependency");
	const evidenceDirectory = join(root, "observed-evidence");
	write(join(evidenceDirectory, "traces/session.jsonl"), '{"type":"session","rlmDepth":1}\n');
	write(join(evidenceDirectory, "workspace/work/historical-output.txt"), "Historical answer must never become input");
	write(join(evidenceDirectory, "result.json"), '{"provider_id":"browser"}');
	const frozenSkillsDirectory = join(root, "frozen-skills");
	write(join(frozenSkillsDirectory, "provider-workers/browser/browser-skill/SKILL.md"), "---\nname: browser-skill\ndescription: Browser\n---\nFrozen browser capability\n");
	write(join(frozenSkillsDirectory, "root-agent/helper/reference.txt"), "Frozen auxiliary reference");
	const observed = captureProviderChildCase({ frozenSkillsDirectory, request: frozen, inputDirectory, evidenceDirectory, recordDirectory: observedDirectory,
		sourceRunId: "observed", capabilitySnapshotId: service.createCapabilitySnapshot(goalId, join(data, goalId)).id,
		usage, toolCalls: 1, durationMs: 2 });
	service.start();
	const success = await settle(service, enqueue(service, observed).id);
	assert.equal(success.status, "awaiting_evaluation", success.error);
	assert.equal(success.executions.length, 1);
	assert.equal(candidateCases(service, success.id).length, 1);
	const candidate = service.readCase(goalId, success.executions[0]!.candidateCaseRef!);
	assert.ok(candidate.observed.providerCalls);
	assert.equal(candidate.observed.trace?.root, "case");
	assert.equal(service.evaluationBatch(goalId, success.id).pairs.length, 1);
	for (const status of ["failed", "cancelled"] as const) {
		mode = status; entered = false;
		const run = enqueue(service, observed);
		if (status === "cancelled") {
			await waitUntil(() => entered);
			service.cancel(goalId, run.id);
		}
		assert.equal((await settle(service, run.id)).status, status);
		await waitUntil(() => candidateCases(service, run.id).length === 1);
		const captured = candidateCases(service, run.id)[0]!;
		assert.equal(captured.value.status, status);
		assert.equal(captured.value.observed.output, undefined);
		assert.ok(captured.value.observed.providerCalls);
		assert.ok(captured.value.observed.trace);
		assert.ok(captured.value.observed.error);
		assert.ok(service.listCaseFilePaths(goalId, captured.ref).every((file) =>
			!readFileSync(file.absolutePath, "utf8").includes("PARENT SECRET")));
		mode = "success";
		const recovered = await settle(service, enqueue(service, captured.ref).id);
		assert.equal(recovered.kind, "recovery");
		assert.equal(recovered.status, "completed", recovered.error);
		assert.equal(recovered.executions.length, 1);
	}
	const bundle = await service.exportCaseBundle(goalId, "Child", observed);
	try {
		const importedData = join(root, "imported");
		mkdirSync(join(importedData, goalId), { recursive: true });
		importedService = new NodeBacktestService({ workspaceDir: importedData, listGoalIds: () => [goalId], recipes: [recipe] });
		const imported = importedService.importBundle(bundle.path, () => undefined);
		rmSync(observedDirectory, { recursive: true, force: true });
		assert.equal(existsSync(observedDirectory), false);
		importedService.start();
		const replay = await settle(importedService, enqueue(importedService, imported.caseRef).id);
		assert.equal(replay.status, "awaiting_evaluation", replay.error);
		assert.equal(candidateCases(importedService, replay.id).length, 1);
		assert.ok(importedService.readCase(goalId, replay.executions[0]!.candidateCaseRef!).observed.providerCalls);
	} finally { bundle.cleanup(); }
	assert.equal(calls, 6, "Each success, failure, cancellation, recovery and imported Replay invokes only one child executor");
	console.log("Provider Child service Replay preserves frozen input, captures scoped recovery and survives standalone Bundle import");
} finally {
	service.stop(); importedService?.stop();
	rmSync(root, { recursive: true, force: true });
}
