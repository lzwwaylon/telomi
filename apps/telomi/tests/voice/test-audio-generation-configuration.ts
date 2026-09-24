import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { execFileSync, spawn } from "node:child_process";
import test from "node:test";
import { once } from "node:events";
import express from "express";
import type { AudioGenerationConfiguration, AudioGenerationResponse } from "../../shared/audio-generation.js";

// Valid silent PCM audio lets the real Podcast encoder, splicer and manifest writer run.
function wave(): Buffer {
  const bytes = Buffer.alloc(4844);
  bytes.write("RIFF"); bytes.writeUInt32LE(4836, 4); bytes.write("WAVEfmt ", 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(24000, 24); bytes.writeUInt32LE(48000, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36); bytes.writeUInt32LE(4800, 40); return bytes;
}

test("configuration reaches playback, Local Worker and Podcast boundaries with safe credential rotation", async () => {
  const home = mkdtempSync(join(tmpdir(), "telomi-tts-config-"));
  process.env.TELOMI_DATA_DIR = home;
  const requests: Array<{ model: string; voice: string; speed: number; authorization?: string }> = [];
  const validationAuth: Array<string | undefined> = [];
  let release: (() => void) | undefined;
  let started: (() => void) | undefined;
  let holdNext = false;
  let rejectValidation = false;
  const upstream = createServer((req, res) => {
    // Declares what telomi-audio declares: one request at a time, wav or streamed PCM out.
    if (req.url?.endsWith("/health")) { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ capabilities: [], max_concurrency: 1 })); return; }
    if (req.url?.endsWith("/models")) {
      validationAuth.push(req.headers.authorization);
      res.writeHead(rejectValidation ? 401 : 200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ data: ["tts-1", "voice-one", "voice-two"].map(id => ({ id, response_formats: ["pcm", "wav"] })) })); return;
    }
    let body = "";
    req.on("data", chunk => { body += chunk; });
    req.on("end", () => {
      requests.push({ ...JSON.parse(body), authorization: req.headers.authorization });
      if (holdNext) { holdNext = false; release = () => res.end(wave()); started?.(); }
      else res.end(wave());
    });
  });
  await new Promise<void>(resolve => upstream.listen(0, "127.0.0.1", resolve));
  const address = upstream.address(); assert.ok(address && typeof address === "object");
  const endpoint = `http://127.0.0.1:${address.port}/v1`;
  const { mountAudioConfigApi } = await import("../../server/voice/config-api.js");
  const { mountCustomProvidersApi } = await import("../../server/providers/api.js");
  const { speak, speakMany, speakPcm16Stream } = await import("../../server/audio/providers/tts.js");
  const { renderPodcastBundle } = await import("../../server/media/podcast/runtime.js");
  const app = express(); app.use(express.json()); mountAudioConfigApi(app); mountCustomProvidersApi(app);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  const apiAddress = server.address(); assert.ok(apiAddress && typeof apiAddress === "object");
  const origin = `http://127.0.0.1:${apiAddress.port}`;
  const url = `${origin}/api/audio-config/generation`;
  const get = async () => await (await fetch(url)).json() as AudioGenerationResponse;
  const post = (mode: string, draft: AudioGenerationConfiguration) => fetch(`${url}/${mode}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(draft) });
  const connection = async (key: string | undefined, baseUrl = endpoint, mode = "apply", id = "telomi-audio") => {
    const res = await fetch(`${origin}/api/custom-providers/${id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ baseUrl, api: "openai-completions", capability: "audio-generation", apiKey: key, models: [{ id: "voice-one" }, { id: "voice-two" }], mode }) });
    assert.equal(res.status, 200, await res.text());
  };
  try {
    // Nothing speaks until the user chooses a connection and model.
    const nothing = await get();
    assert.deepEqual(nothing.active, {});
    assert.deepEqual(nothing.consumers.map((item) => item.status), ["unconfigured", "unconfigured", "unconfigured"]);
    assert.deepEqual(nothing.effective, { playback: null, local: null, podcast: null });
    assert.equal(nothing.sources.playback, null);
    await connection("12345");
    assert.equal((await post("apply", { default: { connection: "telomi-audio", model: "voice-one", voice: "", rate: 1 } })).status, 200);
    assert.equal((await speak({ text: "First operation", format: "wav" })).ok, true);
    assert.equal(requests.at(-1)?.model, "voice-one");
    const { loadCustomProviders, saveCustomProviders } = await import("../../server/providers/custom-models.js");
    const catalog = loadCustomProviders();
    catalog.providers!["requires-auth"] = { baseUrl: endpoint, api: "openai-completions", capability: "audio-generation", authHeader: true, models: [{ id: "voice-one" }] };
    saveCustomProviders(catalog);
    const requiredAuth = await fetch(`${origin}/api/custom-providers/requires-auth`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ baseUrl: endpoint, api: "openai-completions", capability: "audio-generation", models: [{ id: "voice-one" }] }) });
    assert.equal(requiredAuth.status, 422);
    const initial = await get();
    let draft = { ...initial.active, default: { ...initial.active.default, model: "voice-two", voice: "serena", rate: 1.2 } };
    const recognitionOnly = await fetch(`${origin}/api/custom-providers/recognition-only`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ baseUrl: endpoint, api: "openai-completions", capability: "audio-recognition", apiKey: "recognition-test-key", models: [{ id: "tts-1" }] }) });
    assert.equal(recognitionOnly.status, 200);
    assert.equal((await post("apply", { ...draft, local: draft.default, default: { connection: "recognition-only", model: "tts-1", voice: "alloy", rate: 1 } })).status, 422,
      "Known TTS models cannot bypass an explicit recognition-only declaration");
    assert.equal((await post("pending", draft)).status, 200);
    await speak({ text: "Before", format: "wav" }); assert.equal(requests.at(-1)?.model, "voice-one");
    assert.equal((await post("apply", draft)).status, 200);
    assert.equal((await get()).consumers.find(item => item.id === "playback")?.status, "pending");
    process.env.TELOMI_AUDIO_TTS_MODEL = "stale-environment-model";
    await speak({ text: "After", format: "wav" });
    assert.deepEqual([requests.at(-1)?.model, requests.at(-1)?.voice, requests.at(-1)?.speed], ["voice-two", "serena", 1.2]);
    assert.equal((await get()).consumers.find(item => item.id === "playback")?.status, "active");
    assert.ok((await get()).consumers.filter(item => item.id !== "playback").every(item => item.status === "pending"));
    assert.equal((await post("apply", { ...draft, default: { ...draft.default, model: "unavailable" } })).status, 422);
    assert.equal((await get()).active.default.model, "voice-two");
    // The rejected draft is kept; applying with no body retries it, and discarding drops it.
    assert.equal((await get()).pending?.default.model, "unavailable");
    assert.equal((await fetch(`${url}/apply`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).status, 422);
    assert.equal((await get()).pending?.default.model, "unavailable");
    assert.equal((await fetch(`${url}/pending`, { method: "DELETE" })).status, 200);
    assert.equal((await get()).pending, null);
    assert.equal((await get()).active.default.model, "voice-two");
    rejectValidation = true;
    assert.equal((await post("apply", draft)).status, 422);
    assert.equal((await get()).active.default.model, "voice-two"); rejectValidation = false;
    draft = { ...draft, playback: { ...draft.default, model: "voice-one" } };
    assert.equal((await post("apply", draft)).status, 200);
    await speak({ text: "Override", format: "wav" }); assert.equal(requests.at(-1)?.model, "voice-one");
    assert.equal((await get()).sources.playback, "override");
    delete draft.playback;
    assert.equal((await post("apply", draft)).status, 200);
    await speak({ text: "Inherited", format: "wav" }); assert.equal(requests.at(-1)?.model, "voice-two");
    assert.equal((await get()).sources.playback, "default");
    const savedForLater = { ...draft, default: { ...draft.default, model: "voice-one" } };
    assert.equal((await post("pending", savedForLater)).status, 200);
    assert.equal((await post("apply", { ...draft, default: { ...draft.default, voice: "serena" } })).status, 200);
    assert.equal((await get()).pending?.default.model, "voice-one");
    await connection("key-next", endpoint, "pending");
    await speak({ text: "Pending key", format: "wav" }); assert.equal(requests.at(-1)?.authorization, "Bearer 12345");
    holdNext = true;
    const firstStarted = new Promise<void>(resolve => { started = resolve; });
    const batchStart = requests.length;
    const batch = speakMany({ segments: [{ id: "one", text: "Batch one", outPath: join(home, "one.wav") }, { id: "two", text: "Batch two", outPath: join(home, "two.wav") }] });
    await firstStarted;
    await connection("key-next");
    draft = { ...draft, default: { ...draft.default, model: "voice-one" } };
    assert.equal((await post("apply", draft)).status, 200);
    release!(); assert.equal((await batch).ok, true);
    assert.deepEqual(requests.slice(batchStart).map(item => [item.model, item.authorization]), [["voice-two", "Bearer 12345"], ["voice-two", "Bearer key-next"]]);
    assert.equal(validationAuth.at(-1), "Bearer key-next");
    // The long-lived local adapter's actual transport adopts at its next synthesis boundary.
    for await (const _chunk of speakPcm16Stream({ text: "Local" })) { /* drain */ }
    assert.equal(requests.at(-1)?.model, "voice-one");
    assert.equal((await get()).consumers.find(item => item.id === "local")?.status, "active");

    holdNext = true;
    const podcastStarted = new Promise<void>(resolve => { started = resolve; });
    const podcastStart = requests.length;
    const podcast = renderPodcastBundle({ stagingDir: join(home, "podcast"), script: { sections: [{ sectionId: "intro", text: "Narration boundary. ".repeat(70) }] }, sourceSections: [{ sectionId: "intro", title: "Introduction" }], slug: "test", cardId: "card", title: "Test", language: "en", writingMode: "prime-multi-agent" });
    await podcastStarted;
    draft = { ...draft, podcast: { ...draft.default, model: "voice-two", voice: "vivian", rate: 0.9 } };
    assert.equal((await post("apply", draft)).status, 200);
    release!(); const rendered = await podcast;
    assert.ok(rendered.bytes > 0);
    assert.ok(requests.length - podcastStart >= 2);
    assert.ok(requests.slice(podcastStart).every(item => item.model === "voice-one" && item.voice === "serena" && item.speed === 1.2));
    assert.equal(JSON.parse(readFileSync(join(home, "podcast", "manifest.json"), "utf8")).model, "voice-one");
    assert.equal((await get()).consumers.find(item => item.id === "podcast")?.status, "pending");
    await renderPodcastBundle({ stagingDir: join(home, "podcast-next"), script: { sections: [{ sectionId: "intro", text: "Next narration." }] }, sourceSections: [{ sectionId: "intro", title: "Introduction" }], slug: "next", cardId: "card", title: "Next", language: "en", writingMode: "prime-multi-agent" });
    assert.deepEqual([requests.at(-1)?.model, requests.at(-1)?.voice, requests.at(-1)?.speed], ["voice-two", "vivian", 0.9]);
    assert.equal((await get()).consumers.find(item => item.id === "podcast")?.status, "active");

    // Playback last spoke voice-two as serena, so a different voice is a change it has yet to adopt.
    draft = { ...draft, default: { ...draft.default, model: "voice-two", voice: "vivian" } };
    assert.equal((await post("apply", draft)).status, 200);
    assert.equal((await get()).consumers.find(item => item.id === "playback")?.status, "pending");

    // Same-id replacement must never send the new endpoint's key to the captured endpoint.
    holdNext = true;
    const affinityStarted = new Promise<void>(resolve => { started = resolve; });
    const affinityStart = requests.length;
    const affinityBatch = speakMany({ segments: [{ id: "old-one", text: "Old endpoint", outPath: join(home, "old-one.wav") }, { id: "old-two", text: "Must not send", outPath: join(home, "old-two.wav") }] });
    await affinityStarted;
    await connection("key-replacement", endpoint.replace("/v1", "/next/v1"));
    release!();
    await assert.rejects(affinityBatch, /connection changed/);
    assert.equal(requests.length, affinityStart + 1);
    await speak({ text: "New endpoint", format: "wav" }); assert.equal(requests.at(-1)?.authorization, "Bearer key-replacement");

    // A cloud connection uses its own declared endpoint and current credential.
    const localSelection = { ...draft.default };
    await connection("cloud-key", endpoint, "apply", "cloud-audio");
    const cloudSelection = { connection: "cloud-audio", model: "voice-two", voice: "alloy", rate: 1.1 };
    for (const format of ["wav", "mp3"] as const) {
      assert.equal((await post("apply", { ...draft, local: localSelection, default: cloudSelection })).status, 200);
      assert.equal((await speak({ text: "Cloud adapter", format })).ok, true);
      assert.deepEqual([requests.at(-1)?.model, requests.at(-1)?.voice, requests.at(-1)?.speed, requests.at(-1)?.authorization], ["voice-two", "alloy", 1.1, "Bearer cloud-key"]);
    }
    assert.equal((await post("apply", draft)).status, 200);

    // The real-time consumer selects a connection like every other consumer.
    assert.equal((await post("apply", { ...draft, local: cloudSelection })).status, 200);
    assert.deepEqual([(await get()).effective.local.connection, (await get()).effective.local.voice], ["cloud-audio", "alloy"]);
    assert.equal((await post("apply", draft)).status, 200);

    // A catalog-known cloud TTS model is not listed by its gateway; the connection only has to authenticate.
    const knownCloud = { ...draft, local: localSelection, default: { ...cloudSelection, model: "x-ai/grok-voice-tts-1.0", voice: "rex", rate: 1 } };
    assert.equal((await post("apply", knownCloud)).status, 200);
    assert.equal((await get()).active.default.model, "x-ai/grok-voice-tts-1.0");
    // A failure names the consumer whose selection could not be validated.
    rejectValidation = true;
    const named = await post("apply", { ...knownCloud, podcast: { ...draft.default, model: "voice-one" } });
    assert.equal(named.status, 422);
    assert.match(((await named.json()) as { error: string }).error, /^podcast: Audio connection validation failed \(HTTP 401\)/);
    rejectValidation = false;
    assert.equal((await post("apply", draft)).status, 200);

    await connection(undefined, endpoint, "apply", "anonymous-audio");
    const anonymous = { ...draft, local: localSelection, default: { ...draft.default, connection: "anonymous-audio" } };
    assert.equal((await post("apply", anonymous)).status, 200);
    assert.equal(validationAuth.at(-1), undefined);
    assert.equal((await speak({ text: "Anonymous transport", format: "wav" })).ok, true);
    assert.equal(requests.at(-1)?.authorization, undefined);
    // Every consumer, the Local Worker included, may speak through the anonymous connection.
    assert.equal((await post("apply", { ...anonymous, local: anonymous.default })).status, 200);
    assert.equal((await post("apply", draft)).status, 200);

    // Model a separate native connection publisher between its catalog and credential writes.
    // Readers must use the same store lock, including a newly captured endpoint.
    const writer = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
      import { modifyStoredCredential } from './server/accounts/stored-credentials.ts';
      import { resolveAgentPath } from './server/config/agent-directory.ts';
      import { loadCustomProviders, saveCustomProviders } from './server/providers/custom-models.ts';
      modifyStoredCredential(resolveAgentPath('auth.json'), 'telomi-audio', () => {
        const catalog = loadCustomProviders();
        catalog.providers['telomi-audio'].baseUrl = ${JSON.stringify(endpoint + "/coherent")};
        saveCustomProviders(catalog);
        process.stdout.write('catalog-published\\n');
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150);
        return { type: 'api_key', key: 'key-coherent' };
      });
    `], { cwd: join(import.meta.dirname, "../.."), env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    const writerExit = once(writer, "exit");
    await once(writer.stdout!, "data");
    await speak({ text: "Coherent connection pair", format: "wav" });
    assert.equal(requests.at(-1)?.authorization, "Bearer key-coherent");
    assert.equal((await writerExit)[0], 0);

    // A fresh process must see active selections, never the stale environment value.
    const persisted = execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", "import { resolveAudioGeneration } from './server/audio/configuration.ts'; console.log(resolveAudioGeneration().model)"], { cwd: join(import.meta.dirname, "../.."), env: { ...process.env, TELOMI_AUDIO_TTS_MODEL: "stale-environment-model" }, encoding: "utf8" });
    assert.equal(persisted.trim(), "voice-two");
    assert.equal((await fetch(`${origin}/api/custom-providers/telomi-audio`, { method: "DELETE" })).status, 200);
    await assert.rejects(speak({ text: "Deleted connection", format: "wav" }), /unavailable|deleted/);
    assert.ok((await get()).consumers.every(item => item.status === "unavailable"), "every consumer of a deleted connection is unavailable");
    const deleted = execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", "import { speak } from './server/audio/providers/tts.ts'; try { await speak({ text: 'No resurrection' }); process.exitCode = 1; } catch { console.log('unavailable'); }"], { cwd: join(import.meta.dirname, "../.."), env: process.env, encoding: "utf8" });
    assert.equal(deleted.trim(), "unavailable");
  } finally {
    release?.(); server.closeAllConnections(); upstream.closeAllConnections();
    await Promise.all([new Promise<void>(resolve => server.close(() => resolve())), new Promise<void>(resolve => upstream.close(() => resolve()))]);
    rmSync(home, { recursive: true, force: true });
  }
});

test("without an applied configuration no speech model is chosen and environment model values are ignored", () => {
  const home = mkdtempSync(join(tmpdir(), "telomi-tts-default-"));
  try {
    const output = execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
      import { resolveAudioGeneration } from './server/audio/configuration.ts';
      import { speak } from './server/audio/providers/tts.ts';
      import { loadSettings } from './server/config/settings.ts';
      const spoken = await speak({ text: "hello", format: "wav" }).catch((error) => ({ ok: false, reason: error.message }));
      console.log(JSON.stringify({ selected: resolveAudioGeneration() ?? null, spoken, saved: loadSettings().audioGeneration ?? null }));
    `], { cwd: join(import.meta.dirname, "../.."), env: { ...process.env, TELOMI_DATA_DIR: home, TELOMI_AUDIO_TTS_PROVIDER: "openrouter-tts", TELOMI_AUDIO_TTS_MODEL: "env-model", TELOMI_AUDIO_TTS_VOICE: "env-voice", OPENROUTER_API_KEY: "env-key" }, encoding: "utf8" });
    const { selected, spoken, saved } = JSON.parse(output) as { selected: unknown; spoken: { ok: boolean; reason?: string }; saved: unknown };
    assert.equal(selected, null, "nothing is chosen on the user's behalf");
    assert.equal(spoken.ok, false);
    assert.match(spoken.reason ?? "", /No speech model is chosen; choose one in Settings under Read aloud/u);
    assert.equal(saved, null, "resolving never writes settings");
  } finally { rmSync(home, { recursive: true, force: true }); }
});
