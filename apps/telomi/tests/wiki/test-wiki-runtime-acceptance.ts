import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { AgentSession } from "@earendil-works/pi-coding-agent";
import { freezeModelDefinitions } from "../../server/agent-runtime/model-policy.js";
import { runPiObjectTargetStage, runPiResidualCueStage } from "../../server/wiki/pi-object-stage.js";
import { runWikiStageKind } from "../../server/wiki/wiki-stage.js";
import type { WikiStageInput, WikiStageRequest } from "../../server/wiki/wiki-stage-contract.js";

const root = mkdtempSync(join(tmpdir(), "wiki-runtime-acceptance-"));
const canonical = join(root, "canonical");
mkdirSync(canonical);
const provider = "wiki-fixture", modelId = "selected", selection = `${provider}/${modelId}`;
const model = { id: modelId, name: "Configured Wiki model", api: "openai-completions", provider,
 baseUrl: "http://127.0.0.1:1/v1", reasoning: true, input: ["text"],
 cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 4000 };
writeFileSync(join(canonical, "auth.json"), "{}");
writeFileSync(join(canonical, "models.json"), JSON.stringify({ providers: { [provider]: {
 baseUrl: model.baseUrl, api: model.api, apiKey: "unused-test-key-never-sent", models: [model],
} } }));
writeFileSync(join(canonical, "models-store.json"), JSON.stringify({ [provider]: { models: [model] } }));
const env = freezeModelDefinitions({ ...process.env, PI_CODING_AGENT_DIR: canonical,
 TELOMI_WIKI_COMPILATION_MODEL: selection, TELOMI_WIKI_COMPILATION_THINKING_LEVEL: "high" }, join(root, "frozen"));
const entryId = `entry:${"a".repeat(24)}`;
const base: WikiStageInput = { stage: "objects", key: "note", language: "en", goal: { title: "Acceptance", description: "" },
 entries: [], pages: [], requiredEntries: [], requiredPages: [], previousRelations: [], topics: [], sections: [], instructions: "" };
const input = (detail: string): WikiStageInput => ({ ...base, entries: [{ id: entryId, revisionSha256: "b".repeat(64),
 sourceRunId: "run", sourceId: "source", sourceTitle: "Fixture", canonicalLocator: "", members: [], section: "Mechanism",
 cue: "Supported statement", detail, anchors: [] }], requiredEntries: [entryId] });
const json = (path: string) => JSON.parse(readFileSync(path, "utf8"));
const originalPrompt = AgentSession.prototype.prompt, originalFetch = globalThis.fetch;
const sessions: AgentSession[] = [];
const turns: Array<{ text: string; repair: boolean }> = [];
let scenario = "", networkCalls = 0;
globalThis.fetch = async () => { networkCalls++; throw new Error("Deterministic Wiki tests must never call a model or Provider"); };
AgentSession.prototype.prompt = async function(text, options) {
 assert.equal(`${this.model?.provider}/${this.model?.id}`, selection, "every Wiki file stage uses the configured provider/model");
 assert.equal(this.thinkingLevel, "high", "every Wiki file stage uses the configured thinking depth");
 assert.equal((await this.modelRuntime.getAuth(this.model!))?.auth.apiKey, "unused-test-key-never-sent", "custom connections use the canonical credential, not sanitized snapshot placeholders");
 if (scenario === "ordinary" && turns.length === 0) {
  const file = join(canonical, "models.json"), original = readFileSync(file, "utf8"), rotated = JSON.parse(original);
  rotated.providers[provider].apiKey = "rotated-test-key-never-sent";
  try {
   writeFileSync(file, JSON.stringify(rotated));
   assert.equal((await this.modelRuntime.getAuth(this.model!))?.auth.apiKey, "rotated-test-key-never-sent", "native tool-loop requests resolve rotated credentials without changing the frozen connection");
  } finally { writeFileSync(file, original); }
 }
 sessions.push(this); turns.push({ text, repair: options?.streamingBehavior === "followUp" });
 const work = this.sessionManager.getCwd(), runtime = join(dirname(work), "runtime");
 const request = json(join(runtime, "input.json")) as WikiStageInput;
 if (scenario === "selection-only") throw new Error("Configured Pi selection captured");
 const tools = new Map(this.agent.state.tools.map(tool => [tool.name, tool]));
 assert.deepEqual([...tools.keys()].sort(), ["edit", "read", "write"], "object generation stays in the native Pi file adapter");
 const write = async (path: string, content: string) => { await tools.get("write")!.execute("fixture-write", { path, content }, new AbortController().signal); };
 const response = { role: "assistant" as const, provider, model: modelId, api: "openai-completions" as const,
 content: [{ type: "text" as const, text: "Files written." }], stopReason: "stop" as const, timestamp: Date.now(),
 usage: { input: 1, cacheRead: 0, cacheWrite: 0, output: 1, totalTokens: 2, cost: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, total: 0 } } };
 if (scenario === "provider-error") {
  const failed = { ...response, stopReason: "error" as const, errorMessage: "Controlled model failure" };
  this.agent.state.messages.push(failed); this.sessionManager.appendMessage(failed); return;
 }
 this.agent.state.messages.push(response); this.sessionManager.appendMessage(response);
 if (scenario === "missing-result" && turns.length === 1) return;
 if (request.entries.length) {
  if (turns.length === 1) assert.equal(JSON.parse(text).entries[0].detail, request.entries[0]!.detail, "the complete Note reaches the model without truncation");
  await write("pages/O1.md", '---\ntitle: "Fixture object"\ndescription: "Supported object"\n---\n\n## Mechanism\nSupported statement [[N1]].\n');
  await write("result.json", JSON.stringify({ pages: [{ file: "pages/O1.md" }], deferred_entries: [] }));
 } else await write("result.json", JSON.stringify({ pages: [], deferred_entries: [] }));
};
try {
 // Start with an ordinary Note: this fails before the fix because its model and depth are hardcoded.
 for (const [name, value] of [["ordinary", input("Complete supported fact")], ["empty", base],
  ["oversized", input("complete source detail ".repeat(4000))], ["missing-result", input("Repair the same supported fact")]] as const) {
  scenario = name; turns.length = 0; sessions.length = 0;
  const request: WikiStageRequest = { input: { ...value, key: name }, workRoot: join(root, name), env, signal: new AbortController().signal };
  const outcome = await runWikiStageKind(request);
  assert.equal(outcome.result.kind, "pages");
  assert.equal(turns.length, name === "missing-result" ? 2 : 1);
  assert.equal(new Set(sessions).size, 1, "validation repairs stay in the original native Pi session");
  if (name === "missing-result") { assert.equal(turns[1]!.repair, true); assert.match(turns[1]!.text, /result\.json/); }
  const saved = json(join(request.workRoot, "checkpoint.json")), runtime = join(saved.attemptRoot, "runtime");
  assert.deepEqual(json(join(runtime, "model-metadata.json")), { provider, id: modelId, thinking: "high", tools: ["read", "write", "edit"], executionMode: "pi-file-agent" });
  assert.equal(existsSync(join(runtime, "agent", "auth.json")), false, "credential staging is cleaned after execution");
  const beforeResume = turns.length;
  assert.deepEqual(await runWikiStageKind(request), outcome);
  assert.equal(turns.length, beforeResume, "accepted resume creates no new model turn");
  await assert.rejects(runWikiStageKind({ ...request, env: { ...env, TELOMI_WIKI_COMPILATION_THINKING_LEVEL: "low" } }), /contract changed/);
  writeFileSync(join(saved.attemptRoot, "work", "result.json"), "{}");
  await assert.rejects(runWikiStageKind(request), /output changed/);
 }
 const definitionsFile = join(canonical, "models.json"), originalDefinitions = readFileSync(definitionsFile, "utf8"), drifted = JSON.parse(originalDefinitions);
 drifted.providers[provider].baseUrl = "http://127.0.0.1:2/v1";
 const beforeDrift = turns.length;
 try {
  writeFileSync(definitionsFile, JSON.stringify(drifted));
  await assert.rejects(runWikiStageKind({ input: input("Fact"), workRoot: join(root, "connection-drift"), env, signal: new AbortController().signal }), /connection changed/);
  assert.equal(turns.length, beforeDrift, "a frozen Update cannot silently move to a changed Provider endpoint");
 } finally { writeFileSync(definitionsFile, originalDefinitions); }
 scenario = "provider-error"; turns.length = 0;
 const failedRequest: WikiStageRequest = { input: input("Fact"), workRoot: join(root, "provider-error"), env, signal: new AbortController().signal };
 await assert.rejects(runWikiStageKind(failedRequest), /Controlled model failure/);
 assert.equal(turns.length, 1, "model failures do not become file-repair retries");
 assert.equal(json(join(failedRequest.workRoot, "checkpoint.json")).status, "failed");
 const cancelled = new AbortController(); cancelled.abort();
 const beforeCancel = turns.length;
 await assert.rejects(runWikiStageKind({ input: base, workRoot: join(root, "cancelled"), env, signal: cancelled.signal }), /abort/i);
 assert.equal(turns.length, beforeCancel, "cancelled empty Notes never start a Session or repair turn");
 // Observe the real Session selection at each remaining file-stage boundary without invoking a model.
 scenario = "selection-only";
 const member = { ref: "new-object", previous: false, role: "member" as const,
  page: { id: "entity:fixture", kind: "entity" as const, title: "Fixture", description: "Record", body: `## Mechanism\nFact [[${entryId}]].` } };
 const merge: WikiStageInput = { ...input("Fact"), stage: "merge-objects", pages: [member] };
 for (const phase of ["plan", "write"] as const) {
  const req: WikiStageRequest = { input: merge, workRoot: join(root, `target-${phase}`), env, signal: new AbortController().signal };
  await assert.rejects(runPiObjectTargetStage(req, phase), /Configured Pi selection captured/);
 }
 const residual = { ...merge, pages: [{ ...member, role: "context" as const }], unplacedEntries: [{ entryId, reason: "Not placed" }] };
 await assert.rejects(runPiResidualCueStage({ input: residual, workRoot: join(root, "residual"), env, signal: new AbortController().signal }), /Configured Pi selection captured/);
 for (const stage of ["plan-concepts", "concepts", "audit-concepts", "merge-concepts"] as const) {
  const value: WikiStageInput = { ...merge, stage, conceptTask: { question: "How does it work?", scope: "Mechanism", targetRef: null } };
  await assert.rejects(runWikiStageKind({ input: value, workRoot: join(root, stage), env, signal: new AbortController().signal }), /Configured Pi selection captured/);
 }
 assert.equal(networkCalls, 0);
 console.log("Wiki object Runtime: configured model/depth, empty and oversized Notes, native file tools, repair, resume and tamper rejection passed");
} finally { AgentSession.prototype.prompt = originalPrompt; globalThis.fetch = originalFetch; rmSync(root, { recursive: true, force: true }); }
