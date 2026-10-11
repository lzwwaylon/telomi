/** Public Pi Stage transport regression; all requests terminate on local HTTP. */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { Type } from "@sinclair/typebox";

const root = mkdtempSync(join(tmpdir(), "stage-connection-"));
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
mkdirSync(process.env.PI_CODING_AGENT_DIR);
const { mountCustomProvidersApi } = await import("../../server/providers/api.js");
const { mountAuthApi } = await import("../../server/accounts/auth-api.js");
const { SrtStageRuntime } = await import("../../server/agent-runtime/agent-stage-runtime.js");
const { RunArtifactStore } = await import("../../server/agent-runtime/artifact-store.js");
const app = express(); app.use(express.json()); mountCustomProvidersApi(app); mountAuthApi(app);
const apiServer = app.listen(0, "127.0.0.1");
await new Promise<void>(done => apiServer.once("listening", done));
const api = `http://127.0.0.1:${(apiServer.address() as AddressInfo).port}`;
const serverErrors: unknown[] = [];
let probing = false;
let failPrimary = false;
let submitOutput = false;
let change: (() => Promise<void>) | undefined;
const expectedTools = ["read", "write", "edit", "bash", "ls", "find", "grep", "submit_stage_output"].sort();
const requests: Array<{ path: string; model: string; key: string | undefined; tools: string[]; messages: unknown[] }> = [];
const upstream = createServer((req, res) => {
  let body = ""; req.on("data", chunk => { body += String(chunk); }); req.on("end", () => { void (async () => {
    if (!probing) {
      const payload = JSON.parse(body);
      requests.push({ path: req.url!, model: payload.model, key: req.headers.authorization,
        tools: (payload.tools ?? []).map((tool: { function: { name: string } }) => tool.function.name).sort(), messages: payload.messages });
      const action = change; change = undefined; await action?.();
      if (failPrimary && JSON.parse(body).model === "stage") { res.writeHead(401, { "content-type": "application/json" }); res.end(JSON.stringify({ error: { message: `controlled unauthorized for ${req.headers.authorization}` } })); return; }
    }
    const content = probing ? "OK" : requests.length === 1 ? "invalid output" : '{"ok":true}';
    const chunk = (delta: unknown, finish_reason: string | null) => `data: ${JSON.stringify({ id: "local", object: "chat.completion.chunk", created: 1, model: "stage", choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(!probing && submitOutput
      ? chunk({ role: "assistant", tool_calls: [{ index: 0, id: "submit-local", type: "function", function: { name: "submit_stage_output", arguments: '{"ok":true}' } }] }, null) + chunk({}, "tool_calls") + "data: [DONE]\n\n"
      : chunk({ role: "assistant", content }, null) + chunk({}, "stop") + "data: [DONE]\n\n");
  })().catch(error => { serverErrors.push(error); res.writeHead(500); res.end(); }); });
});
await new Promise<void>(done => upstream.listen(0, "127.0.0.1", done));
const baseUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}/v1`;
async function configure(endpoint: string, apiKey: string) {
  probing = true;
  try {
    const result = await fetch(`${api}/api/custom-providers/stage-local`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ baseUrl: endpoint, apiKey, api: "openai-completions", models: ["stage", "approved", "unapproved"].map(id => ({ id })) }) });
    assert.equal(result.status, 200);
  } finally { probing = false; }
}
const activity: string[] = [];
async function runStage(name: string, fallback: string[] = [], policy: "fresh" | "continue" = "fresh", attemptId = "1") {
  return new SrtStageRuntime().runStage({
    onActivity: item => { if (item.kind === "status" && item.text) activity.push(item.text); },
    runId: "boundary", stageId: "boundary", attemptId, role: "report_writer", recordKind: "evaluation",
    session: { key: "boundary", policy }, modelPolicy: { preferred: ["stage-local/stage"], fallback, reasoning: "off", maxRetries: 0 },
    systemPrompt: "Return JSON", userPrompt: `Return output ${attemptId}`, workDirectory: join(root, name, "work"), readonlyMounts: [],
    controlDirectory: join(root, name, "control"), artifactStore: new RunArtifactStore(join(root, name, "artifacts")),
    output: { kind: "json_candidate", publishRelativePath: `${attemptId}-result.json`, validate: ({ entryPath }) => JSON.parse(readFileSync(entryPath, "utf8")),
      ...(submitOutput ? { toolSubmission: { parameters: Type.Object({ ok: Type.Boolean() }), description: "Submit the output", instructions: "Call submit_stage_output with ok=true.",
        materialize: (input: Record<string, unknown>, entryPath: string) => writeFileSync(entryPath, JSON.stringify(input)) } } : {}) },
    signal: new AbortController().signal,
  });
}
try {
  await configure(baseUrl, "first-local-key");
  change = () => configure(`${baseUrl}/replacement`, "replacement-local-key");
  await assert.rejects(() => runStage("replacement"));
  assert.deepEqual(serverErrors, []);
  assert.equal(requests.length, 1, "An executing Stage must reject a replaced connection before sending its new credential to the old endpoint");
  assert.deepEqual(requests[0].tools, expectedTools, "The first fresh Stage request must declare its complete allowed loadout");
  requests.length = 0;
  await configure(baseUrl, "first-local-key");
  change = () => configure(baseUrl, "rotated-local-key");
  await runStage("rotation");
  assert.equal(requests.length, 2);
  assert.ok(requests.every(request => JSON.stringify(request.tools) === JSON.stringify(expectedTools)), "Fresh and repair requests retain every Tool declaration");
  assert.ok(requests[0].key === "Bearer first-local-key" && requests[1].key === "Bearer rotated-local-key",
    "Already-sent request keeps its credential and the repair uses the activated credential");
  requests.length = 0;
  change = async () => { assert.equal((await fetch(`${api}/api/auth/stage-local`, { method: "DELETE" })).status, 200); };
  await assert.rejects(() => runStage("deletion"));
  assert.deepEqual(serverErrors, []);
  assert.equal(requests.length, 1, "Deleted credentials cannot be reused by an active Stage");
  await configure(baseUrl, "fallback-local-key");
  requests.length = 0;
  const started = await runStage("continued", [], "continue");
  assert.equal(started.session.mode, "fresh");
  rmSync(join(root, "continued", "work", "candidate.json"));
  requests.length = 0;
  const continued = await runStage("continued", [], "continue", "2");
  assert.equal(continued.session.mode, "continued");
  assert.equal(continued.session.id, started.session.id);
  assert.deepEqual(requests[0].tools, expectedTools, "A restored Stage declares all allowed Tools on its first request");
  assert.match(JSON.stringify(requests[0].messages), /Return output 1/u, "Continuation retains the previous turn");
  assert.match(JSON.stringify(requests[0].messages), /Return output 2/u, "Continuation appends the current turn");
  requests.length = 0;
  submitOutput = true;
  const submitted = await runStage("submitted");
  submitOutput = false;
  assert.deepEqual(submitted.value, { ok: true });
  assert.equal(submitted.toolCounts.submit_stage_output, 1, "A first-turn Tool call executes through the real Stage submission path");
  assert.deepEqual(requests[0].tools, expectedTools);
  const { loadSettings, saveSettings } = await import("../../server/config/settings.js");
  saveSettings({ ...loadSettings(), providerFallbackModels: ["stage-local/unapproved"] });
  requests.length = 0; failPrimary = true;
  activity.length = 0;
  await runStage("approved-fallback", [" stage-local/approved "]);
  assert.deepEqual(requests.map(request => request.model), ["stage", "approved"]);
  assert.ok(requests.every(request => JSON.stringify(request.tools) === JSON.stringify(expectedTools)), "Both primary and configured fallback receive the complete Tool declaration");
  const records = readFileSync(join(root, "approved-fallback", "control", "runtime--evaluation.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
  const switched = records.find(record => record.type === "runtime.model_switched");
  assert.deepEqual({ kind: switched.kind, from: switched.from, to: switched.to }, { kind: "model", from: "stage-local/stage", to: "stage-local/approved" });
  assert.match(switched.reason, /controlled unauthorized/, "The switch reason is the upstream failure");
  assert.ok(!JSON.stringify(records).includes("fallback-local-key"), "Activity records never carry the credential");
  const node = records.find(record => record.type === "node_execution");
  assert.equal(node.output.model, "stage-local/approved", "The node record names the model that actually served");
  assert.equal(node.output.model_switches.length, 1);
  assert.ok(activity.some(text => text.includes("stage-local/approved")), "The live Activity reports the switch");
  requests.length = 0;
  await assert.rejects(() => runStage("replay-no-fallback"));
  assert.ok(requests.length > 0 && requests.every(request => request.model === "stage"), "Explicit Replay policy must not inherit a global fallback");
  assert.deepEqual(serverErrors, []);
} finally {
  apiServer.closeAllConnections(); upstream.closeAllConnections();
  await Promise.all([new Promise<void>(done => apiServer.close(() => done())), new Promise<void>(done => upstream.close(() => done()))]);
  rmSync(root, { recursive: true, force: true });
}
