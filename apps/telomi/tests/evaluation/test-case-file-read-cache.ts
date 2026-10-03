import assert from "node:assert/strict";
import fs, { mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, linkSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { AddressInfo } from "node:net";
import express from "express";

import type { NodeEvaluationCase } from "../../server/agent-runtime/node-evaluation.js";
import { RunArtifactStore } from "../../server/agent-runtime/artifact-store.js";
import { NodeBacktestService } from "../../server/evaluation/node-backtest.js";
import { createOperationsRouter } from "../../server/evaluation/api.js";
import { serverRuntimeDirForGoal } from "../../server/workspaces/server-runtime-paths.js";

const root = realpathSync(mkdtempSync(join(tmpdir(), "case-file-cache-")));
const workspaceDir = join(root, "data"), goalId = "goal-cache", sourceRunId = "wiki-large", caseId = "case-many-stages";
const control = join(serverRuntimeDirForGoal(goalId, workspaceDir), "wiki-updates", sourceRunId);
const caseDirectory = join(control, "node-evaluation", "cases", caseId);
const ref = { sourceRunId, caseId };
mkdirSync(join(workspaceDir, goalId), { recursive: true });
const caseStore = new RunArtifactStore(caseDirectory), runStore = new RunArtifactStore(control);
const prompt = caseStore.publishText("Frozen prompt", "system.txt");
caseStore.publishText("Frozen business input", "input/question.txt");
const toRef = (file: { relativePath: string; sha256: string; byteLength: number }) => ({ ref: file.relativePath, sha256: file.sha256, byteLength: file.byteLength });
for (let index = 0; index < 48; index++) runStore.publishText(`${JSON.stringify({ stage: index })}\n`, `evidence/stages/stage-${index}/session/native.jsonl`);
const lifecycle = runStore.publishText("{}\n", "evidence/lifecycle.jsonl");
const traces = runStore.describeDirectory("evidence"), input = caseStore.describeDirectory("input");
const value: NodeEvaluationCase = { schemaVersion: 1, caseId, runId: sourceRunId, nodeId: "wiki-compilation", attemptId: "1", agentId: "wiki-compilation",
	role: "wiki", status: "succeeded", capturedAt: "2026-01-01T00:00:00Z", recipe: { id: "wiki-compilation", version: 1 }, recipeInput: {},
	input: { ...toRef(input), root: "case", fileCount: input.files.length }, request: {
		promptConfig: { domain: "wiki", id: "wiki-compilation", sandboxRole: "wiki" }, systemPrompt: toRef(prompt), composedSystemPrompt: toRef(prompt), userPrompt: toRef(prompt),
		session: { key: "wiki", policy: "fresh" }, actualModel: "test/model", outputContract: { kind: "stage_report", publishRelativePath: "output" } },
	mounts: [], liveExternalState: false, observed: { validationErrors: [], trace: { ...toRef(lifecycle), root: "run" },
		traceDirectories: [{ ...toRef(traces), fileCount: traces.files.length, root: "run" }] } };
const manifest = join(caseDirectory, "manifest.json");
writeFileSync(manifest, JSON.stringify(value));
const service = new NodeBacktestService({ workspaceDir, applicationDir: process.cwd(), recipes: [], listGoalIds: () => [goalId], runner: {
	runStage: async () => { throw new Error("File download test must not execute an Agent"); } } });
const originalReadDir = fs.readdirSync;
let scans = 0;
fs.readdirSync = new Proxy(originalReadDir, { apply(target, receiver, args) {
	if (String(args[0]).startsWith(join(control, "evidence")) || String(args[0]).startsWith(caseDirectory)) scans++;
	return Reflect.apply(target, receiver, args);
} });
syncBuiltinESMExports();
const app = express();
app.use(createOperationsRouter({ getGoal: id => id === goalId ? { id } as never : undefined, ensureImportedGoal: id => ({ id } as never) }, service, "eval", join(root, "exchange")));
const server = app.listen(0, "127.0.0.1");
await new Promise<void>(resolve => server.once("listening", resolve));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/operations/v1/goals/${goalId}/cases/${sourceRunId}/${caseId}`;
try {
	const listed = await fetch(`${base}/files`);
	assert.equal(listed.status, 200);
	const files = (await listed.json()).files as Array<{ ref: string; kind: string }>;
	const native = files.filter(file => file.kind === "agent_trace");
	assert.equal(native.length, 48);
	assert.ok(scans > 0);
	const warmed = scans;
	for (const file of native.slice(0, 4)) {
		const response = await fetch(`${base}/file?ref=${encodeURIComponent(file.ref)}`);
		assert.equal(response.status, 200);
		assert.match(await response.text(), /stage/u);
	}
	assert.equal(scans, warmed, "Downloading individual Case refs must not repeatedly traverse and hash every captured Agent stage");
	const nativeRef = native[0]!.ref, target = service.caseFile(goalId, ref, nativeRef), bytes = readFileSync(target);
	writeFileSync(target, "tampered");
	assert.throws(() => service.caseFile(goalId, ref, nativeRef), /changed/u, "Cached downloads still verify exact requested bytes");
	writeFileSync(target, bytes);
	const backup = `${target}.saved`;
	renameSync(target, backup); symlinkSync(backup, target);
	assert.throws(() => service.caseFile(goalId, ref, nativeRef), /safe regular file/u);
	rmSync(target); linkSync(backup, target);
	assert.throws(() => service.caseFile(goalId, ref, nativeRef), /safe regular file/u);
	rmSync(target); renameSync(backup, target);
	const parent = dirname(target), moved = `${parent}-saved`;
	renameSync(parent, moved); symlinkSync(moved, parent, "dir");
	assert.throws(() => service.caseFile(goalId, ref, nativeRef), /symbolic link/u, "Ancestor links are rejected on cache hits");
	rmSync(parent); renameSync(moved, parent);
	assert.throws(() => service.caseFile(goalId, ref, "run:evidence/private.json"), /Unknown.*file ref/u);
	value.capturedAt = "2026-01-01T00:00:01Z";
	writeFileSync(manifest, JSON.stringify(value));
	service.caseFile(goalId, ref, nativeRef);
	assert.ok(scans > warmed, "Changed manifest bytes invalidate the file allowlist");
	const afterRefresh = scans;
	service.stop(); service.caseFile(goalId, ref, nativeRef);
	assert.ok(scans > afterRefresh, "Stopping releases the Case file index");
	console.log("Case downloads: HTTP no-rescan, requested-byte verification, links, allowlist and manifest invalidation passed");
} finally {
	service.stop(); await new Promise<void>(resolve => server.close(() => resolve()));
	fs.readdirSync = originalReadDir; syncBuiltinESMExports(); rmSync(root, { recursive: true, force: true });
}
