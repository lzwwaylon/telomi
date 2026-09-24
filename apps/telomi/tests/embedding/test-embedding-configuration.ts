import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import * as lancedb from "@lancedb/lancedb";
import express from "express";
import type { EmbeddingConfiguration, EmbeddingResponse } from "../../shared/embedding-configuration.js";

/** A fake OpenAI-compatible embeddings service: records requests, can hold document batches, can reject a model. */
function upstream() {
  const requests: Array<{ model: string; input: string[]; input_type: string; authorization?: string }> = [];
  let held: Array<() => void> = [];
  let holding = false;
  const rejected = new Set<string>();
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      const request = { ...JSON.parse(body), authorization: req.headers.authorization } as typeof requests[number];
      requests.push(request);
      const answer = () => {
        if (rejected.has(request.model)) { res.writeHead(500); res.end("boom"); return; }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ data: request.input.map((value, index) => ({ index, embedding: /distinctive-write-during-rebuild/iu.test(value) ? [0, 1] : [1, 0] })) }));
      };
      if (holding && request.input_type === "search_document") held.push(answer); else answer();
    });
  });
  return {
    requests, rejected,
    listen: () => new Promise<string>((resolve) => server.listen(0, "127.0.0.1", () => { const address = server.address() as { port: number }; resolve(`http://127.0.0.1:${address.port}/v1`); })),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    hold: () => { holding = true; },
    release: () => { holding = false; for (const answer of held) answer(); held = []; },
    heldCount: () => held.length,
  };
}

function goal(root: string, name: string, model: string): string {
  const directory = join(root, name);
  mkdirSync(join(directory, "wiki", "knowledge", "models"), { recursive: true });
  mkdirSync(join(directory, "wiki", "knowledge", "topics"), { recursive: true });
  writeFileSync(join(directory, "wiki", "knowledge", "models", `${model.toLowerCase()}.md`), `---\ntitle: ${model}\ntype: Model\ntags: [asr]\nprimary_topic_ref: topic-asr\ntopic_refs: [topic-asr]\n---\n\n# ${model}\n\nLinked to [Automatic Speech Recognition](../topics/asr.md).\n`);
  writeFileSync(join(directory, "wiki", "knowledge", "topics", "asr.md"), "---\nprimary_topic_ref: topic-asr\ntopic_refs: [topic-asr]\n---\n\n# Automatic Speech Recognition\n");
  return directory;
}

async function tables(indexPath: string): Promise<Array<{ name: string; identity: string; rows: number }>> {
  const db = await lancedb.connect(indexPath);
  const result = [];
  for (const name of await db.tableNames()) {
    const table = await db.openTable(name);
    const rows = await table.query().select(["model"]).toArray() as Array<{ model: string }>;
    result.push({ name, identity: rows[0]?.model ?? "", rows: rows.length });
  }
  return result.sort((left, right) => left.name.localeCompare(right.name));
}

async function until(check: () => Promise<boolean> | boolean, what: string): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

test("embedding configuration reaches Wiki search and User Memory through a safe rebuild", async () => {
  const home = mkdtempSync(join(tmpdir(), "telomi-embedding-config-"));
  process.env.TELOMI_DATA_DIR = home;
  process.env.TELOMI_WIKI_EMBEDDING_MODEL = "legacy/model";
  process.env.HINDSIGHT_API_EMBEDDINGS_PROVIDER = "openai";
  delete process.env.OPENROUTER_API_KEY;
  const fake = upstream();
  const baseUrl = await fake.listen();
  const agentDir = join(home, ".pi", "agent");
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: { vec: { api: "openai-completions", baseUrl, models: [{ id: "m1" }, { id: "m2" }] } } }));
  const { writeStoredCredential } = await import("../../server/accounts/stored-credentials.js");
  writeStoredCredential(join(agentDir, "auth.json"), "vec", { type: "api_key", key: "vec-key" });
  const goalA = goal(home, "goal-a", "FireRedASR2S");
  const goalB = goal(home, "goal-b", "Voxtral");
  const { mountEmbeddingApi, resumeEmbeddingMigration, settleEmbeddingMigration, stopEmbeddingMigration } = await import("../../server/embedding/configuration.js");
  const { GoalWikiSearch, wikiIndexPath } = await import("../../server/wiki/local-search.js");
  const { loadSettings } = await import("../../server/config/settings.js");
  const memoryCalls: string[] = [];
  let failMemoryPrepare = false;
  let committedBeforeRestart: EmbeddingConfiguration | undefined;
  const memory = {
    estimate: async () => { memoryCalls.push("estimate"); return { units: 7, characters: 700 }; },
    prepare: async (_target: unknown, onProgress: (progress: { done: number; total: number }) => void) => { memoryCalls.push("prepare"); onProgress({ done: 7, total: 7 }); if (failMemoryPrepare) throw new Error("model could not be loaded"); },
    cutover: async (_target: unknown, commit: () => void) => { memoryCalls.push("cutover"); commit(); committedBeforeRestart = loadSettings().embedding; memoryCalls.push("restart"); },
    abort: async () => { memoryCalls.push("abort"); },
  };
  const deps = { wikiGoalDirs: () => [goalA, goalB], memory };
  const app = express();
  app.use(express.json());
  mountEmbeddingApi(app, deps);
  const api = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => api.once("listening", resolve));
  const port = (api.address() as { port: number }).port;
  const call = async (path: string, body?: unknown, method = body ? "POST" : "GET") => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, body ? { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : { method });
    return { status: response.status, body: await response.json() as EmbeddingResponse & { error?: string } };
  };
  const search = (goalDir: string, query: string) => new GoalWikiSearch(join(goalDir, "wiki", "knowledge"), { goalDir }).search(query, 3);
  const memorySelection = { connection: "hindsight-local", model: "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2" };
  try {
    // No saved selection: nothing is chosen on the user's behalf, legacy environment values are ignored and nothing is written.
    let view = (await call("/api/embedding-config")).body;
    assert.deepEqual(view.active, {});
    assert.equal(loadSettings().embedding, undefined);
    assert.deepEqual(view.consumers.map((item) => [item.id, item.status, item.serving]), [["wiki", "unconfigured", null], ["memory", "unconfigured", null]]);
    assert.deepEqual(view.effective, { wiki: null, memory: null });
    assert.equal((await search(goalA, "FireRedASR2S")).mode, "keyword_graph", "without an embedding model search degrades instead of failing");

    // Save for later: nothing embeds, nothing rebuilds.
    const first: EmbeddingConfiguration = { default: { connection: "vec", model: "m1" }, memory: memorySelection };
    view = (await call("/api/embedding-config/pending", first)).body;
    assert.equal(view.status, "saved");
    assert.deepEqual(view.pending, first);
    assert.equal(fake.requests.length, 0);
    assert.equal(existsSync(wikiIndexPath(goalA)), false);

    // Apply the staged selection: validation probes the connection, then the Wiki indexes build in the background.
    const applied = await call("/api/embedding-config/apply", {});
    assert.equal(applied.status, 200, JSON.stringify(applied.body));
    assert.equal(fake.requests[0]?.input_type, "search_query");
    assert.equal(fake.requests[0]?.authorization, "Bearer vec-key");
    await settleEmbeddingMigration();
    view = (await call("/api/embedding-config")).body;
    assert.equal(view.status, "active", JSON.stringify(view));
    assert.deepEqual(view.active, first);
    assert.equal(view.pending, null);
    assert.deepEqual((await tables(wikiIndexPath(goalA))).map((table) => table.identity), ["m1"]);
    assert.deepEqual((await tables(wikiIndexPath(goalB))).map((table) => table.identity), ["m1"]);
    assert.deepEqual(memoryCalls, ["estimate", "prepare", "cutover", "restart"], "choosing a Memory model for the first time migrates whatever the store holds");
    memoryCalls.length = 0;
    const dropped = await call("/api/embedding-config/apply", { memory: memorySelection });
    assert.equal(dropped.status, 422, "dropping a chosen index is rejected rather than leaving it without a model");
    assert.match(dropped.body.error ?? "", /^wiki: choose an embedding model/u);
    await call("/api/embedding-config/pending", undefined, "DELETE");
    const embeddedUnderM1 = fake.requests.filter((request) => request.model === "m1" && request.input_type === "search_document").length;
    assert.ok(embeddedUnderM1 >= 2);

    // A same-dimension replacement is still a migration: the old index serves while the new one builds.
    fake.hold();
    const second: EmbeddingConfiguration = { default: { connection: "vec", model: "m2" }, memory: memorySelection };
    assert.equal((await call("/api/embedding-config/apply", second)).status, 200);
    await until(() => fake.heldCount() > 0, "the rebuild to reach the embedding service");
    view = (await call("/api/embedding-config")).body;
    assert.equal(view.status, "rebuilding");
    const wiki = view.consumers.find((item) => item.id === "wiki")!;
    assert.equal(wiki.status, "rebuilding");
    assert.deepEqual(wiki.serving, { connection: "vec", model: "m1" }, "the page names the selection still serving");
    assert.ok(wiki.estimate && wiki.estimate.units >= 2 && wiki.estimate.characters > 0, "the cost hint counts chunks and characters");
    assert.ok(wiki.progress && wiki.progress.total === wiki.estimate.units);
    assert.deepEqual(view.active, first, "the file still names the active selection, not the target");
    assert.deepEqual(view.target, second);
    assert.equal((await call("/api/embedding-config/apply", second)).status, 409);
    const during = await search(goalA, "FireRedASR2S");
    assert.equal(during.mode, "hybrid");
    assert.equal(fake.requests.at(-1)?.model, "m1", "queries during the rebuild embed with the serving model");
    writeFileSync(join(goalA, "wiki", "knowledge", "topics", "late.md"), "---\nprimary_topic_ref: topic-asr\ntopic_refs: [topic-asr]\n---\n\n# Late page\n\nDISTINCTIVE-WRITE-DURING-REBUILD arrived while the index was rebuilding.\n");
    fake.release();
    await settleEmbeddingMigration();
    view = (await call("/api/embedding-config")).body;
    assert.equal(view.status, "active", JSON.stringify(view));
    assert.deepEqual(view.active, second);
    assert.deepEqual((await tables(wikiIndexPath(goalA))).map((table) => table.identity), ["m2"], "the old index is pruned after the switch");
    assert.ok(fake.requests.some((request) => request.model === "m2" && request.input.some((text) => /DISTINCTIVE-WRITE-DURING-REBUILD/u.test(text))), "a page published during the rebuild joins the replacement index");
    const after = await search(goalA, "DISTINCTIVE-WRITE-DURING-REBUILD");
    assert.equal(after.results[0]?.path, "wiki/topics/late.md");
    assert.equal(fake.requests.at(-1)?.model, "m2");

    // Validation failure: the connection rejects the model, nothing changes.
    fake.rejected.add("m3");
    const rejectedDraft: EmbeddingConfiguration = { default: { connection: "vec", model: "m3" }, memory: memorySelection };
    const invalid = await call("/api/embedding-config/apply", rejectedDraft);
    assert.equal(invalid.status, 422);
    assert.match(invalid.body.error ?? "", /^wiki: Embedding connection validation failed/u);
    assert.deepEqual((await call("/api/embedding-config")).body.active, second);
    assert.deepEqual(invalid.body.pending, rejectedDraft, "the rejected selection stays on the page to retry or discard");
    view = (await call("/api/embedding-config/pending", undefined, "DELETE")).body;
    assert.equal(view.status, "active");
    assert.equal(view.pending, null);
    assert.equal(view.error, undefined, "discarding the draft dismisses its failure");
    assert.deepEqual(view.active, second);
    assert.equal((await call("/api/embedding-config/apply", { default: { connection: "hindsight-local", model: "x" }, memory: memorySelection })).status, 422, "Wiki cannot use the Memory-only local model");
    assert.equal((await call("/api/embedding-config/apply", { default: { connection: "vec", model: "m2" }, memory: { connection: "vec", model: "m2", dimensions: 3000 } })).status, 422, "memory dimensions above the index limit are rejected before any rebuild");

    for (const connection of ["hindsight-environment", "unknown-connection"]) {
      const unknown = await call("/api/embedding-config/apply", { ...second, memory: { connection, model: "old-model" } });
      assert.equal(unknown.status, 422);
      assert.match(unknown.body.error ?? "", /embedding connection .* is unknown/u);
      assert.deepEqual(unknown.body.active, second);
    }

    // Rebuild failure: the document embedding breaks after validation passed; the old index keeps serving.
    const probeOnly = fake.requests.length;
    const failing = await call("/api/embedding-config/apply", { default: { connection: "vec", model: "m4" }, memory: memorySelection });
    assert.equal(failing.status, 200);
    fake.rejected.add("m4");
    await settleEmbeddingMigration();
    view = (await call("/api/embedding-config")).body;
    assert.equal(view.status, "failed");
    assert.match(view.error ?? "", /^wiki: .*previous embedding configuration remains active$/u);
    assert.equal(view.consumers.find((item) => item.id === "wiki")?.status, "failed");
    assert.deepEqual(view.active, second);
    assert.deepEqual(view.pending, { default: { connection: "vec", model: "m4" }, memory: memorySelection }, "a failed rebuild keeps the selection the user asked for");
    assert.ok(fake.requests.length > probeOnly);
    assert.equal((await search(goalB, "Voxtral")).mode, "hybrid");
    assert.equal(fake.requests.at(-1)?.model, "m2");
    fake.rejected.delete("m4");

    // Restart during a rebuild: the persisted state resumes and the old index served throughout.
    fake.hold();
    const fourth: EmbeddingConfiguration = { default: { connection: "vec", model: "m4" }, memory: memorySelection };
    assert.equal((await call("/api/embedding-config/apply", fourth)).status, 200);
    await until(() => fake.heldCount() > 0, "the rebuild to reach the embedding service again");
    await stopEmbeddingMigration();
    fake.release();
    assert.ok(existsSync(join(agentDir, "embedding-migration.json")), "the rebuild state survives shutdown");
    assert.deepEqual(loadSettings().embedding, second);
    resumeEmbeddingMigration(deps);
    await settleEmbeddingMigration();
    view = (await call("/api/embedding-config")).body;
    assert.equal(view.status, "active", JSON.stringify(view));
    assert.deepEqual(view.active, fourth);
    assert.equal(view.pending, null, "an activated selection is no longer a draft");
    assert.deepEqual((await tables(wikiIndexPath(goalB))).map((table) => table.identity), ["m4"]);

    // User Memory: the migrator prepares beside the running service and commits before the restart.
    const fifth: EmbeddingConfiguration = { default: { connection: "vec", model: "m4" }, memory: { connection: "vec", model: "m5", dimensions: 2 } };
    assert.equal((await call("/api/embedding-config/apply", fifth)).status, 200);
    await settleEmbeddingMigration();
    view = (await call("/api/embedding-config")).body;
    assert.equal(view.status, "active", JSON.stringify(view));
    assert.deepEqual(memoryCalls, ["estimate", "prepare", "cutover", "restart"]);
    assert.deepEqual(committedBeforeRestart, fifth, "settings name the new selection before the service restarts with it");
    assert.deepEqual(view.active, fifth);
    memoryCalls.length = 0;
    failMemoryPrepare = true;
    // Wiki changes too, so its rebuild completes before the memory step fails.
    assert.equal((await call("/api/embedding-config/apply", { default: { connection: "vec", model: "m7" }, memory: { connection: "vec", model: "m6", dimensions: 2 } })).status, 200);
    await settleEmbeddingMigration();
    view = (await call("/api/embedding-config")).body;
    assert.equal(view.status, "failed");
    assert.match(view.error ?? "", /^memory: model could not be loaded/u);
    assert.equal(view.consumers.find((item) => item.id === "wiki")?.status, "failed", "a consumer whose rebuild finished must not stay busy once the migration failed");
    assert.deepEqual(memoryCalls, ["estimate", "prepare", "abort"]);
    assert.deepEqual(view.active, fifth);
    assert.equal(readFileSync(join(agentDir, "settings.json"), "utf8").includes("vec-key"), false);
  } finally {
    delete process.env.TELOMI_WIKI_EMBEDDING_MODEL;
    delete process.env.HINDSIGHT_API_EMBEDDINGS_PROVIDER;
    await stopEmbeddingMigration();
    api.close();
    await fake.close();
    rmSync(home, { recursive: true, force: true });
  }
});
