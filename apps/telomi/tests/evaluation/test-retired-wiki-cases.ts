import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { RunArtifactStore } from "../../server/agent-runtime/artifact-store.js";
import type { NodeEvaluationCase } from "../../server/agent-runtime/node-evaluation.js";
import { NodeBacktestService, nodeBacktestRunsDirectory, type NodeBacktestRun } from "../../server/evaluation/node-backtest.js";
import { serverRuntimeDirForGoal } from "../../server/workspaces/server-runtime-paths.js";

const root = mkdtempSync(join(tmpdir(), "retired-wiki-cases-"));
try {
	const applicationDir = join(root, "application");
	mkdirSync(join(applicationDir, "agents"), { recursive: true });
	writeFileSync(join(applicationDir, "agents", "fixture.txt"), "Read-only historical fixture\n");
	for (const args of [["init", "--quiet"], ["add", "agents"], ["-c", "user.name=Test", "-c", "user.email=test@example.invalid",
		"-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "commit", "--quiet", "-m", "Fixture Runtime"]]) {
		execFileSync("git", args, { cwd: applicationDir, stdio: "pipe" });
	}
	const workspaceDir = join(root, "data"), goalId = "goal_history";
	mkdirSync(join(workspaceDir, goalId), { recursive: true });
	const service = (dataDir: string) => new NodeBacktestService({ workspaceDir: dataDir, applicationDir,
		listGoalIds: () => [goalId], recipes: [],
		runner: { async runStage() { throw new Error("Historical evidence must not execute any Agent"); } },
	});
	const native = service(workspaceDir);
	const importedWorkspace = join(root, "imported");
	const imported = service(importedWorkspace);
	for (const agentId of ["wiki-shard-builder", "wiki-curator"]) {
		const sourceRunId = `history-${agentId}`, caseId = `case-${agentId}`;
		const caseDirectory = join(serverRuntimeDirForGoal(goalId, workspaceDir), "wiki-updates", sourceRunId,
			"node-evaluation", "cases", caseId);
		mkdirSync(caseDirectory, { recursive: true });
		const store = new RunArtifactStore(caseDirectory);
		const fileRef = (path: string, text: string) => {
			const file = store.publishText(text, path);
			return { ref: file.relativePath, sha256: file.sha256, byteLength: file.byteLength };
		};
		fileRef("input/request.json", JSON.stringify({ historical: true }));
		const input = store.describeDirectory("input");
		const systemPrompt = fileRef("system-prompt.txt", "Historical system\n");
		const userPrompt = fileRef("user-prompt.txt", "Historical Wiki task\n");
		const trace = fileRef("agent-trace.jsonl", '{"type":"message","message":{"role":"assistant","content":"Historical trace"}}\n');
		fileRef("observed-output/page.md", "# Preserved Wiki Page\n");
		const output = store.describeDirectory("observed-output");
		const value: NodeEvaluationCase = {
			schemaVersion: 1, caseId, runId: sourceRunId, nodeId: agentId, attemptId: "1", agentId,
			role: agentId, status: "succeeded", capturedAt: "2026-09-02T00:00:00Z",
			recipe: { id: agentId, version: 1 }, recipeInput: {},
			input: { ref: input.relativePath, sha256: input.sha256, byteLength: input.byteLength,
				fileCount: input.files.length, root: "case" },
			request: { promptConfig: { domain: "wiki", id: agentId, sandboxRole: `wiki.${agentId}` },
				systemPrompt, composedSystemPrompt: systemPrompt, userPrompt, session: { key: agentId, policy: "fresh" },
				actualModel: "historical/model", outputContract: { kind: "chapter", publishRelativePath: "knowledge" } },
			mounts: [], liveExternalState: false, observed: { output: {
				ref: output.relativePath, sha256: output.sha256, byteLength: output.byteLength, directory: true,
			}, trace: { ...trace, root: "case" }, validationErrors: [] },
		};
		const manifest = join(caseDirectory, "manifest.json");
		const manifestBytes = `${JSON.stringify(value, null, 2)}\n`;
		writeFileSync(manifest, manifestBytes);
		const ref = { sourceRunId, caseId };
		assert.deepEqual(native.listCases(goalId, agentId).map(item => item.ref), [ref],
			"a retired recipe does not hide its historical Cases");
		assert.deepEqual(native.readCase(goalId, ref), value);
		const traceFile = native.listCaseFiles(goalId, ref).find(file => file.kind === "agent_trace");
		assert.ok(traceFile);
		assert.match(readFileSync(native.caseFile(goalId, ref, traceFile.ref), "utf8"), /Historical trace/u);
		assert.throws(() => native.enqueue(goalId, { agentId, cases: [ref], candidate: {}, repetitions: 1,
			rubricId: "historical-wiki" }), /retired and unsupported/u,
			"an old Case cannot be redirected into current Wiki Compilation");
		const bundle = await native.exportCaseBundle(goalId, "History", ref);
		try {
			assert.equal(bundle.manifest.agent_id, agentId);
			assert.ok(bundle.manifest.files.some(file => file.path === "case/agent-trace.jsonl"));
			imported.importBundle(bundle.path, id => mkdirSync(join(importedWorkspace, id), { recursive: true }));
			assert.deepEqual(imported.listCases(goalId, agentId).map(item => item.ref), [ref]);
			assert.deepEqual(imported.readCase(goalId, ref), value, "Bundle import preserves old recipe and evidence");
		} finally {
			bundle.cleanup();
		}
		assert.equal(readFileSync(manifest, "utf8"), manifestBytes, "reads, export and rejected execution preserve history");

		const replayId = `recorded-${agentId}`, replayDirectory = join(nodeBacktestRunsDirectory(workspaceDir, goalId), replayId);
		mkdirSync(replayDirectory, { recursive: true });
		const metrics = { inputTokens: 0, outputTokens: 0, costUsd: 0, calls: 0, turns: 0, toolCalls: 0, durationMs: 0 };
		const replay: NodeBacktestRun = { schemaVersion: 4, mode: "candidate-replay", kind: "quality", id: replayId,
			goalId, agentId, status: "completed", cases: [ref], candidate: { workspaceContentHash: "a".repeat(64),
				capabilitySnapshotId: `caps_${"b".repeat(64)}`, capabilityBundleHash: "c".repeat(64) },
			observedMetrics: { ...metrics, executions: 0 }, repetitions: 1, rubricId: "historical-wiki",
			createdAt: "2026-09-02T00:00:00Z", updatedAt: "2026-09-02T00:00:00Z", pairs: [], executions: [] };
		const replayManifest = join(replayDirectory, "run.json"), replayBytes = JSON.stringify(replay);
		writeFileSync(replayManifest, replayBytes);
		assert.equal(native.read(goalId, replayId)?.status, "completed", "existing Replay status remains readable");
		assert.equal(readFileSync(replayManifest, "utf8"), replayBytes);
		for (const status of ["queued", "running"] as const) {
			const interruptedReplay = { ...replay, status }, bytes = JSON.stringify(interruptedReplay);
			writeFileSync(replayManifest, bytes);
			native.start();
			assert.equal(native.status().queued, 0, "a retired historical Replay is not requeued into a new execution");
			assert.equal(native.status().active, 0);
			assert.equal(native.read(goalId, replayId)?.status, status);
			assert.equal(readFileSync(replayManifest, "utf8"), bytes, "startup preserves interrupted historical Replay records");
			native.stop();
		}
	}
	assert.deepEqual(native.status().recipes, [], "history does not add an executable Recipe");
	console.log("Retired Wiki Cases remain listable, readable and exportable; Replay execution is unsupported");
} finally {
	rmSync(root, { recursive: true, force: true });
}
