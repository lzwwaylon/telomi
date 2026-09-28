import assert from "node:assert/strict";
import fs, { linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { AddressInfo } from "node:net";
import express from "express";
import { createOperationsRouter } from "../../server/evaluation/api.js";
import { NodeBacktestService, nodeBacktestRunsDirectory, type NodeBacktestRun } from "../../server/evaluation/node-backtest.js";

const root = realpathSync(mkdtempSync(join(tmpdir(), "replay-read-cache-")));
const workspaceDir = join(root, "data"), applicationDir = join(root, "app"), goalId = "goal-cache";
mkdirSync(join(applicationDir, "agents"), { recursive: true });
writeFileSync(join(applicationDir, "agents/fixture.txt"), "Fixture runtime");
for (const args of [["init", "--quiet"], ["add", "."], ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "commit", "--quiet", "-m", "Fixture"]]) execFileSync("git", args, { cwd: applicationDir });
const service = new NodeBacktestService({ workspaceDir, applicationDir, recipes: [], listGoalIds: () => [goalId], runner: { runStage: async () => { throw new Error("Read-only test must not run an Agent"); } } });
const runs = nodeBacktestRunsDirectory(workspaceDir, goalId);
const metrics = { inputTokens: 0, outputTokens: 0, costUsd: 0, calls: 0, turns: 0, toolCalls: 0, durationMs: 0 };
function fixture(id: string, status: NodeBacktestRun["status"] = "completed") {
 const directory = join(runs, id), caseRef = { sourceRunId: "source", caseId: "case" };
 const run: NodeBacktestRun = { schemaVersion: 4, mode: "candidate-replay", kind: "recovery", id, goalId, status,
  agentId: "wiki-compilation", cases: [caseRef], candidate: { workspaceContentHash: "a".repeat(64), capabilitySnapshotId: `caps_${"b".repeat(64)}`, capabilityBundleHash: "c".repeat(64) },
  observedMetrics: { ...metrics, executions: 0 }, repetitions: 1, rubricId: "fixture", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", pairs: [],
  executions: [{ id: "candidate_case_1", caseRef, repetition: 1, variant: "candidate", status: "completed", metrics,
   artifact: { ref: "unused.json", sha256: "d".repeat(64), byteLength: 0, directory: false } }] };
 const ref = "executions/candidate_case_1/wiki-compilation/control/topic/runtime/result.json";
 mkdirSync(dirname(join(directory, ref)), { recursive: true });
 writeFileSync(join(directory, ref), "{\"value\":1}\n");
 const manifest = join(directory, "run.json");
 const save = () => writeFileSync(manifest, JSON.stringify(run));
 save();
 return { directory, run, ref, manifest, save };
}
const originalReadDir = fs.readdirSync;
let scans = 0;
// Count actual directory enumeration rather than asserting a machine-dependent duration.
fs.readdirSync = new Proxy(originalReadDir, { apply(target, receiver, args) {
 if (String(args[0]).startsWith(runs)) scans++;
 return Reflect.apply(target, receiver, args);
} });
syncBuiltinESMExports();
const app = express();
app.use(createOperationsRouter({ getGoal: id => id === goalId ? { id } as never : undefined, ensureImportedGoal: id => ({ id } as never) }, service, "eval", join(root, "exchange")));
const server = app.listen(0, "127.0.0.1");
await new Promise<void>(resolve => server.once("listening", resolve));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/operations/v1/goals/${goalId}/replays`;
try {
 const settled = fixture("settled");
 const manifestBefore = readFileSync(settled.manifest);
 const firstResponse = await fetch(`${base}/settled`);
 assert.equal(firstResponse.status, 200);
 const first = (await firstResponse.json()).run;
 assert.ok(scans > 0, "A fresh completed Run discovers its recorded refs once");
 const warmScans = scans;
 for (let i = 0; i < 4; i++) {
  const response = await fetch(`${base}/settled/files?ref=${encodeURIComponent(settled.ref)}`);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "{\"value\":1}\n");
 }
 assert.equal(scans, warmScans, "Fetching individual refs must not rescan execution trees");
 assert.deepEqual(service.read(goalId, "settled"), first, "Cached and fresh API projections are equal");
 const mutable = service.read(goalId, "settled")!;
 mutable.executions[0]!.refs!.injected = "private.json";
 mutable.candidate.workspaceContentHash = "mutated";
 mutable.cases.length = 0;
 assert.deepEqual(service.read(goalId, "settled"), first, "A caller cannot poison the cached DTO or allowlist");
 assert.throws(() => service.replayFile(goalId, "settled", "private.json"), /Unknown.*file ref/);
 assert.deepEqual(readFileSync(settled.manifest), manifestBefore);

 const laterRef = settled.ref.replace("result.json", "accepted.json");
 writeFileSync(join(settled.directory, laterRef), "{}");
 assert.throws(() => service.replayFile(goalId, "settled", laterRef), /Unknown.*file ref/, "Settled allowlist stays fixed until its manifest changes");
 settled.run.updatedAt = "2026-01-01T00:00:01Z"; settled.save();
 assert.equal(service.replayFile(goalId, "settled", laterRef), join(settled.directory, laterRef));
 assert.ok(scans > warmScans, "Manifest byte changes invalidate the projection");

 const file = join(settled.directory, settled.ref), backup = `${file}.saved`, outside = join(root, "outside.json");
 writeFileSync(outside, "private");
 renameSync(file, backup); symlinkSync(outside, file);
 assert.throws(() => service.replayFile(goalId, "settled", settled.ref), /safe regular file/);
 rmSync(file); linkSync(outside, file);
 assert.throws(() => service.replayFile(goalId, "settled", settled.ref), /safe regular file/);
 rmSync(file); mkdirSync(file);
 assert.throws(() => service.replayFile(goalId, "settled", settled.ref), /safe regular file/);
 rmSync(file, { recursive: true }); renameSync(backup, file);
 const parent = dirname(file), moved = `${parent}-saved`;
 renameSync(parent, moved); symlinkSync(moved, parent, "dir");
 assert.throws(() => service.replayFile(goalId, "settled", settled.ref), /symbolic link/, "Even an in-root ancestor link is rejected after a cache hit");
 rmSync(parent); renameSync(moved, parent);
 rmSync(file);
 assert.throws(() => service.replayFile(goalId, "settled", settled.ref), /ENOENT/);
 writeFileSync(file, "restored");
 assert.equal(readFileSync(service.replayFile(goalId, "settled", settled.ref), "utf8"), "restored");

 const traversal = fixture("traversal");
 traversal.run.executions[0]!.refs = { outside: "../outside.json" }; traversal.save();
 assert.throws(() => service.replayFile(goalId, "traversal", "../outside.json"), /escapes its run/);

 const active = fixture("active", "running");
 service.read(goalId, "active");
 const freshRef = active.ref.replace("result.json", "checkpoint.json");
 writeFileSync(join(active.directory, freshRef), "{}");
 assert.equal(service.replayFile(goalId, "active", freshRef), join(active.directory, freshRef), "Running refs remain live without a manifest rewrite");
 const activeScans = scans; service.read(goalId, "active");
 assert.ok(scans > activeScans, "Running reads never use the settled cache");
 active.run.status = "queued"; active.save(); service.read(goalId, "active");
 const queuedScans = scans; service.read(goalId, "active"); assert.ok(scans > queuedScans);
 for (const status of ["awaiting_evaluation", "completed", "failed", "cancelled"] as const) {
  const done = fixture(`done-${status}`, status);
  service.read(goalId, done.run.id); const count = scans;
  service.replayFile(goalId, done.run.id, done.ref); assert.equal(scans, count, `${status} with no active worker can be cached`);
 }
 service.read(goalId, "settled"); const beforeEviction = scans;
 service.read(goalId, "done-completed"); service.read(goalId, "settled");
 assert.ok(scans > beforeEviction, "Only the most recently read settled Run remains cached");
 const beforeStop = scans; service.stop(); service.read(goalId, "settled");
 assert.ok(scans > beforeStop, "Stopping the service releases the projection");
 const huge = fixture("too-large"); huge.run.error = "x".repeat(17 * 1024 * 1024); huge.save();
 service.read(goalId, huge.run.id); const hugeScans = scans;
 service.replayFile(goalId, huge.run.id, huge.ref);
 assert.ok(scans > hugeScans, "Run source plus serialized projection over 32 MiB is not cached");
 console.log("Replay read cache: HTTP equivalence, no rescans, immutable copies, live reads, invalidation, bounds and file safety passed");
} finally {
 service.stop();
 await new Promise<void>(resolve => server.close(() => resolve()));
 fs.readdirSync = originalReadDir; syncBuiltinESMExports();
 rmSync(root, { recursive: true, force: true });
}
