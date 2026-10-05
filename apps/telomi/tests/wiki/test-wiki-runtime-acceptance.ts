import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ResearchNodeError } from "../../server/agent-runtime/retry-policy.js";
import { runWikiStageKind, wikiStageOutputHash } from "../../server/wiki/wiki-stage.js";
import { wikiPageSections } from "../../server/wiki/wiki-page-contract.js";
import type { WikiStageInput } from "../../server/wiki/wiki-stage-contract.js";

const root = mkdtempSync(join(tmpdir(), "wiki-runtime-acceptance-"));
try {
 const auth = join(root, "auth");
 mkdirSync(auth);
 writeFileSync(join(auth, "auth.json"), "{}");
 writeFileSync(join(auth, "settings.json"), "{}");
 writeFileSync(join(auth, "models.json"), JSON.stringify({ providers: { "wiki-fixture": {
  baseUrl: "http://127.0.0.1:1/v1", api: "openai-completions", apiKey: "unused-test-key",
  models: [{ id: "fixture", name: "Fixture", reasoning: true, contextWindow: 200000 }],
 } } }));
 const base: WikiStageInput = { stage: "objects", key: "empty-note", language: "en", goal: { title: "Acceptance", description: "" },
  entries: [], pages: [], requiredEntries: [], requiredPages: [], previousRelations: [], topics: [], sections: [], instructions: "" };
 const entryId = `entry:${"a".repeat(24)}`;
 const oversized: WikiStageInput = { ...base, key: "oversized-note", entries: [{ id: entryId, revisionSha256: "b".repeat(64),
  sourceRunId: "run", sourceId: "source", sourceTitle: "Fixture", canonicalLocator: "", members: [], section: "Mechanism",
  cue: "Supported statement", detail: "complete source detail ".repeat(4000), anchors: [] }], requiredEntries: [entryId] };
 const page = { id: "entity:fixture", kind: "entity" as const, title: "Fixture", description: "Reading fixture",
  body: `## Mechanism\nComplete supported section [[${entryId}]].` };
 const topic: WikiStageInput = { ...base, stage: "topic", key: "topic", entries: oversized.entries,
  pages: [{ ref: page.id, page, previous: false, role: "context" }], sections: wikiPageSections([page]),
  topics: [{ id: "topic-fixture", title: "Mechanism", intent: "Understand the mechanism", questions: [], include: [], exclude: [] }] };
 const rows = (path: string) => readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
 for (const [scenario, input, success, expectedTurns] of [
  ["empty-note", base, true, 1], ["missing-result", base, true, 2], ["invalid-result", base, true, 2],
  ["missing-page", oversized, true, 2], ["always-invalid", base, false, 3], ["provider-error", base, false, 1],
  ["topic-missed-event", topic, true, 1], ["topic-read-repair", topic, true, 2],
 ] as const) {
  const workRoot = join(root, scenario);
  let attemptRoot = "";
  const request = { input: { ...input, instructions: scenario }, workRoot, env: { ...process.env, PRIME_AGENT_CODING_AGENT_DIR: auth,
   PRIME_AGENT_MODULE: new URL("./fixtures/prime-wiki-output-session.ts", import.meta.url).href,
   TELOMI_WIKI_COMPILATION_MODEL: "wiki-fixture/fixture" },
   signal: new AbortController().signal, onAttemptStarted: (path: string) => { attemptRoot = path; } };
  if (success) await runWikiStageKind(request);
  else await assert.rejects(runWikiStageKind(request), error => {
   assert.ok(error instanceof ResearchNodeError);
   assert.equal(error.failureClass, scenario === "provider-error" ? "provider" : "validation");
   assert.match(error.message, scenario === "provider-error"
    ? /model 'wiki-fixture\/fixture' failed: controlled provider failure/u : /invalid after 3 attempts/u);
   return true;
  });
  const runtime = join(attemptRoot, "runtime"), work = join(attemptRoot, "work");
  const prompts = rows(join(runtime, "fixture-prompts.jsonl"));
  assert.equal(prompts.length, expectedTurns, `${scenario} uses exactly the expected model turns`);
  assert.ok(rows(join(runtime, "fixture-quiescence.jsonl")).length >= expectedTurns, "each turn waits for descendants before acceptance");
  assert.ok(existsSync(join(runtime, "sessions/fixture.jsonl")), "finally retains the Session on success and failure");
  assert.equal(JSON.parse(readFileSync(join(runtime, "result.json"), "utf8")).accepted, success);
  const rejects = existsSync(join(runtime, "output-validation.jsonl")) ? rows(join(runtime, "output-validation.jsonl")) : [];
  assert.equal(rejects.length, success ? expectedTurns - 1 : scenario === "provider-error" ? 0 : expectedTurns);
  for (let index = 1; index < prompts.length; index++) {
   assert.ok(prompts[index].text.includes(rejects[index - 1].error), "same-session repair receives the exact preceding validation error");
   assert.equal(prompts[index].promptOptions.streamingBehavior, "followUp");
  }
  if (success) {
   const accepted = JSON.parse(readFileSync(join(runtime, "accepted.json"), "utf8"));
   assert.equal(accepted.outputHash, wikiStageOutputHash(work), "accepted output binds the written manifest and Page bytes");
  } else assert.equal(existsSync(join(runtime, "accepted.json")), false);
  if (input.stage === "topic") {
   const observations = JSON.parse(readFileSync(join(runtime, "native-read-observations.json"), "utf8"));
   assert.deepEqual(observations, [{ toolCallId: `printed-section-${expectedTurns}`, sectionRef: "S1" }],
    "all-session IPython result scanning recovers missed events and excludes failed results");
   assert.deepEqual(JSON.parse(readFileSync(join(runtime, "receipts.json"), "utf8")).sections, ["S1"]);
  } else if (input.entries.length) {
   assert.deepEqual(JSON.parse(readFileSync(join(runtime, "receipts.json"), "utf8")).entries, ["N1"]);
   assert.ok(rows(join(runtime, "reads.jsonl")).some(row => row.tool === "read_wiki"), "oversized Note preserves progressive native reads");
  }
 }
 for (const scenario of ["receipt-error", "tamper-after-acceptance"]) {
  const workRoot = join(root, scenario);
  let attemptRoot = "";
  await assert.rejects(runWikiStageKind({ input: { ...base, instructions: scenario }, workRoot,
   env: { ...process.env, PRIME_AGENT_CODING_AGENT_DIR: auth,
    PRIME_AGENT_MODULE: new URL("./fixtures/prime-wiki-output-session.ts", import.meta.url).href,
    TELOMI_WIKI_COMPILATION_MODEL: "wiki-fixture/fixture" }, signal: new AbortController().signal,
   onAttemptStarted: path => { attemptRoot = path; } }), error => {
    assert.ok(error instanceof Error);
    if (scenario === "receipt-error") {
     assert.ok(error instanceof ResearchNodeError);
     assert.equal(error.failureClass, "validation", "receipt persistence failures are not Provider failures");
    } else {
     assert.match(error.message, /Accepted Wiki compilation artifacts changed/u);
     assert.ok(!(error instanceof ResearchNodeError) || error.failureClass !== "provider");
    }
    return true;
   });
  assert.equal(rows(join(attemptRoot, "runtime/fixture-prompts.jsonl")).length, 1);
  assert.equal(JSON.parse(readFileSync(join(workRoot, "checkpoint.json"), "utf8")).status, "failed");
  assert.ok(existsSync(join(attemptRoot, "runtime/sessions/fixture.jsonl")), "artifact rejection preserves Session evidence");
 }
 console.log("Wiki Runtime acceptance validates files, repairs in-session, preserves receipts and does not retry model errors");
} finally { rmSync(root, { recursive: true, force: true }); }
