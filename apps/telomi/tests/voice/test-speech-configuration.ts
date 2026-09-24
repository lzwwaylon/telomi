import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import test, { after } from "node:test";
import express from "express";

const data = mkdtempSync(join(tmpdir(), "speech-config-"));
process.env.TELOMI_DATA_DIR = data;
after(() => rmSync(data, { recursive: true, force: true }));
const { mountSpeechConfigurationApi } = await import("../../server/voice/configuration.js");
const { mountProviderConfigApi } = await import("../../server/providers/config-api.js");
const { mountCustomProvidersApi } = await import("../../server/providers/api.js");
const { VoiceUtteranceContextStore } = await import("../../server/voice/utterance-context.js");
const { runVoiceTranscriptionPipeline } = await import("../../server/voice/transcription-pipeline.js");
const { transcribe } = await import("../../server/audio/providers/stt.js");
const { pcm16MonoToWav, LocalSnapshotTranscriptionAdapter } = await import("../../server/voice/local-snapshot-transcription.js");

test("pending speech settings do not activate; apply reaches the actual STT transport and failure preserves it", { timeout: 30_000 }, async () => {
  const observed: string[] = [];
  const authorizations: string[] = [];
  let cleanupFails = false;
  let warmupFails = false;
  let hold: { started: () => void; release: Promise<void> } | undefined;
  const upstream = createServer((req, res) => {
    let body = "";
    req.on("data", chunk => { body += chunk; });
    req.on("end", () => {
      res.setHeader("Content-Type", "application/json");
      if (req.url === "/v1/chat/completions") {
        const input = JSON.parse(body); observed.push(body); authorizations.push(req.headers.authorization ?? "");
        if (cleanupFails) { res.statusCode = 503; res.end(JSON.stringify({ error: { message: "cleanup unavailable" } })); return; }
        res.setHeader("Content-Type", "text/event-stream");
        for (const [delta, finish] of [[{ role: "assistant", content: "cleaned transcript" }, null], [{}, "stop"]]) res.write(`data: ${JSON.stringify({ id: "cleanup", object: "chat.completion.chunk", created: 1, model: input.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
        res.end("data: [DONE]\n\n"); return;
      }
      // This endpoint advertises warmup, so applying a selection prepares its model.
      if (req.url === "/health") { res.end(JSON.stringify({ ok: true, capabilities: ["warmup"] })); return; }
      if (req.url === "/v1/audio/warmup") { res.statusCode = warmupFails ? 503 : 200; res.end(JSON.stringify({ ok: !warmupFails, loaded: !warmupFails, model: JSON.parse(body).model })); return; }
      if (req.url === "/v1/models") res.end(JSON.stringify({ data: [{ id: "asr-a" }, { id: "asr-b" }, { id: "cleanup-1" }] }));
      else {
        observed.push(body); authorizations.push(req.headers.authorization ?? "");
        const pending = hold; hold = undefined;
        if (pending) { pending.started(); void pending.release.then(() => res.end(JSON.stringify({ text: "raw transcript" }))); }
        else res.end(JSON.stringify({ text: "raw transcript" }));
      }
    });
  });
  await new Promise<void>(resolve => upstream.listen(0, "127.0.0.1", resolve));
  const address = upstream.address(); assert.ok(address && typeof address === "object");
  const selfHostedEndpoint = `http://127.0.0.1:${address.port}/v1`;
  const app = express(); app.use(express.json()); mountSpeechConfigurationApi(app); mountCustomProvidersApi(app);
  mountProviderConfigApi(app, { mainAgent: { describeMainAgentConfiguration: () => ({ inheritedModel: "", inheritedSource: "settings", inheritedThinkingLevel: "off", overrides: [], pendingGoalIds: [] }) } });
  const server = app.listen(0, "127.0.0.1"); await new Promise<void>(resolve => server.once("listening", resolve));
  const apiAddress = server.address(); assert.ok(apiAddress && typeof apiAddress === "object");
  const url = `http://127.0.0.1:${apiAddress.port}/api/audio-config/recognition`;
  const call = async (path = "", body?: unknown) => {
    const response = await fetch(url + path, body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {});
    return { status: response.status, body: await response.json() };
  };
  try {
    const builtIn = (await call()).body;
    assert.equal(builtIn.active.default, undefined, "no recognition model is preselected");
    assert.deepEqual(builtIn.consumers.map((item: { id: string; status: string }) => [item.id, item.status]).slice(0, 2), [["recognition", "unconfigured"], ["local", "unconfigured"]]);
    assert.equal(builtIn.effective.cleanupModel, null, "no unified default means no cleanup model");
    await (async () => {
      const response = await fetch(`http://127.0.0.1:${apiAddress.port}/api/custom-providers/self-hosted-stt`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ baseUrl: selfHostedEndpoint, api: "openai-completions", capability: "audio-recognition", models: [{ id: "asr-a" }, { id: "asr-b" }], mode: "apply" }) });
      assert.equal(response.status, 200, await response.text());
    })();
    assert.equal((await call("/apply", { ...builtIn.active, default: { connection: "self-hosted-stt", model: "asr-a" } })).status, 200);
    const initial = (await call()).body;
    const draft = { ...initial.active, default: { ...initial.active.default, model: "asr-b" } };
    assert.equal((await call("/pending", draft)).body.status, "saved");
    assert.equal((await call()).body.status, "saved");
    const audio = { buffer: pcm16MonoToWav(Buffer.alloc(32000), 16000), mime: "audio/wav", filename: "voice.wav" };
    assert.equal((await transcribe(audio)).ok, true);
    assert.match(observed.at(-1)!, /name="model"\r\n\r\nasr-a/);
    const context = new VoiceUtteranceContextStore(data).capture();
    const withoutCleanup = await runVoiceTranscriptionPipeline({ ...audio, speech: context.speech, cleanupModelId: context.cleanup.modelId, cleanupRequested: true, glossary: context.glossary });
    assert.equal(withoutCleanup.ok && withoutCleanup.text, "raw transcript");
    assert.equal(withoutCleanup.ok && withoutCleanup.cleanup.applied, false);
    assert.equal(withoutCleanup.ok && withoutCleanup.cleanup.modelId, undefined);
    assert.equal(observed.some(body => body.startsWith("{")), false, "missing cleanup default sends no model request");
    assert.equal((await call("/apply", { ...draft, cleanupEnabled: true })).status, 422);
    // The rejected draft is kept for the page to correct or retry; discarding it leaves the active configuration alone.
    assert.deepEqual((await call()).body.pending, { ...draft, cleanupEnabled: true });
    const discarded = await fetch(`${url}/pending`, { method: "DELETE" });
    assert.equal(discarded.status, 200);
    assert.equal((await discarded.json()).pending, null);
    assert.equal((await call()).body.active.default.model, "asr-a");
    const unknown = await call("/apply", { ...draft, default: { connection: "missing-stt", model: "asr-a" } });
    assert.equal(unknown.status, 422);
    assert.match(unknown.body.error, /missing-stt is not configured/, "a connection that does not exist is named, not reported as changed");

    let previewResolve!: () => void;
    const previewDone = new Promise<void>(resolve => { previewResolve = resolve; });
    const preview = new LocalSnapshotTranscriptionAdapter({ inputSampleRate: 16000, snapshotSeconds: 0.1, callbacks: { onPartial: () => previewResolve() } });
    await preview.connect();
    assert.equal((await call("/apply", draft)).status, 200);
    const pcm = Buffer.alloc(6400); for (let index = 0; index < pcm.length; index += 2) pcm.writeInt16LE(2000, index);
    preview.sendAudio(pcm); await previewDone; preview.close();
    assert.match(observed.at(-1)!, /name="model"\r\n\r\nasr-a/);
    const pinned = await runVoiceTranscriptionPipeline({ ...audio, speech: context.speech, cleanupRequested: false, glossary: context.glossary });
    assert.equal(pinned.ok, true); assert.match(observed.at(-1)!, /name="model"\r\n\r\nasr-a/);
    process.env.TELOMI_AUDIO_SELF_HOSTED_STT_MODEL = "stale-environment";
    process.env.TELOMI_AUDIO_STT_MODEL = "stale-environment";
    assert.equal((await transcribe(audio)).ok, true);
    assert.match(observed.at(-1)!, /name="model"\r\n\r\nasr-b/);
    assert.equal((await call("/apply", { ...draft, default: { ...draft.default, model: "missing" } })).status, 422);
    assert.equal((await transcribe(audio)).ok, true);
    assert.match(observed.at(-1)!, /name="model"\r\n\r\nasr-b/);
    const connection = async (id: string, body: unknown) => {
      const response = await fetch(`http://127.0.0.1:${apiAddress.port}/api/custom-providers/${id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const result = await response.json(); assert.equal(response.status, 200, JSON.stringify(result));
    };
    await connection("self-hosted-stt", { baseUrl: selfHostedEndpoint, api: "openai-completions", capability: "audio-recognition", models: [{ id: "asr-a" }, { id: "asr-b" }], apiKey: "rotated-test-key", mode: "apply" });
    await transcribe(audio); assert.equal(authorizations.at(-1), "Bearer rotated-test-key");
    let requestArrived!: () => void; let releaseRequest!: () => void;
    const arrived = new Promise<void>(resolve => { requestArrived = resolve; });
    const release = new Promise<void>(resolve => { releaseRequest = resolve; });
    hold = { started: requestArrived, release };
    const inFlight = transcribe(audio);
    await arrived;
    assert.equal(authorizations.at(-1), "Bearer rotated-test-key");
    await connection("self-hosted-stt", { baseUrl: selfHostedEndpoint, api: "openai-completions", capability: "audio-recognition", models: [{ id: "asr-a" }, { id: "asr-b" }], apiKey: "second-test-key", mode: "apply" });
    releaseRequest(); assert.equal((await inFlight).ok, true);
    await transcribe(audio); assert.equal(authorizations.at(-1), "Bearer second-test-key");
    const overridden = await call("/apply", { ...draft, recognition: { ...draft.default, model: "asr-a" } });
    assert.equal(overridden.status, 200); assert.equal(overridden.body.sources.recognition, "override");
    await transcribe(audio); assert.match(observed.at(-1)!, /name="model"\r\n\r\nasr-a/);
    const inherited = await call("/apply", draft);
    assert.equal(inherited.status, 200); assert.equal(inherited.body.sources.recognition, "default");
    await transcribe(audio); assert.match(observed.at(-1)!, /name="model"\r\n\r\nasr-b/);
    warmupFails = true;
    // An endpoint advertising warmup is warmed up on apply, and a failed warmup keeps the previous configuration.
    await connection("telomi-audio", { baseUrl: selfHostedEndpoint, api: "openai-completions", capability: "audio-recognition", models: [{ id: "asr-a" }, { id: "asr-b" }], mode: "apply" });
    const failedService = await call("/apply", { ...draft, local: { connection: "telomi-audio", model: "asr-a" } });
    assert.equal(failedService.status, 422);
    await transcribe(audio); assert.match(observed.at(-1)!, /name="model"\r\n\r\nasr-b/);
    warmupFails = false;
    // The managed runtime serves both audio capabilities: a generation pin the TTS page put on its entry must not break recognition.
    await connection("telomi-audio", { baseUrl: selfHostedEndpoint, api: "openai-completions", capability: "audio-generation", models: [{ id: "asr-a" }, { id: "asr-b" }], mode: "apply" });
    const managedPinned = await call("/apply", { ...draft, local: { connection: "telomi-audio", model: "asr-a" } });
    assert.equal(managedPinned.status, 200, JSON.stringify(managedPinned.body));
    assert.notEqual(managedPinned.body.consumers.find((consumer: { id: string }) => consumer.id === "local").status, "unavailable");
    await transcribe({ ...audio, selection: managedPinned.body.effective.local }); assert.match(observed.at(-1)!, /name="model"\r\n\r\nasr-a/);
    assert.equal((await call("/apply", draft)).status, 200);
    await connection("cleanup-test", { baseUrl: selfHostedEndpoint, api: "openai-completions", models: [{ id: "cleanup-1" }], apiKey: "cleanup-key", mode: "apply" });
    const cleanupDraft = { ...draft, cleanupEnabled: true, cleanupModel: "cleanup-test/cleanup-1" };
    assert.equal((await call("/apply", cleanupDraft)).status, 200);
    const cleanContext = new VoiceUtteranceContextStore(data).capture();
    const input = { ...audio, speech: cleanContext.speech, cleanupRequested: true, glossary: cleanContext.glossary };
    const cleaned = await runVoiceTranscriptionPipeline(input);
    assert.equal(cleaned.ok && cleaned.text, "cleaned transcript");
    assert.equal(JSON.parse(observed.at(-1)!).model, "cleanup-1");
    cleanupFails = true;
    const raw = await runVoiceTranscriptionPipeline(input);
    assert.equal(raw.ok && raw.text, "raw transcript");
    assert.equal(raw.ok && raw.cleanup.applied, false);
    assert.equal(raw.ok && raw.cleanup.modelId, "cleanup-test/cleanup-1");
    const applyDefault = async (body: unknown) => {
      const response = await fetch(`http://127.0.0.1:${apiAddress.port}/api/provider-config/apply`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      assert.equal(response.status, 200, JSON.stringify(await response.json()));
    };
    await applyDefault({ defaultProvider: "cleanup-test", defaultModel: "cleanup-1" });
    assert.equal((await call("/apply", { ...cleanupDraft, cleanupModel: null })).status, 200);
    await applyDefault({ defaultProvider: null, defaultModel: null });
    const unavailable = (await call()).body;
    assert.equal(unavailable.effective.cleanupModel, null);
    assert.equal(unavailable.consumers.find((consumer: { id: string }) => consumer.id === "cleanupModel").status, "unavailable");
    const deleted = new VoiceUtteranceContextStore(data).capture();
    const modelRequests = observed.filter(body => body.startsWith("{")).length;
    const preserved = await runVoiceTranscriptionPipeline({ ...audio, speech: deleted.speech, cleanupModelId: deleted.cleanup.modelId, cleanupRequested: true, glossary: deleted.glossary });
    assert.equal(preserved.ok && preserved.text, "raw transcript");
    assert.equal(preserved.ok && preserved.cleanup.applied, false);
    assert.equal(preserved.ok && preserved.cleanup.modelId, undefined);
    assert.equal(observed.filter(body => body.startsWith("{")).length, modelRequests);


  } finally {
    server.closeAllConnections(); upstream.closeAllConnections();
    await Promise.all([new Promise<void>(resolve => server.close(() => resolve())), new Promise<void>(resolve => upstream.close(() => resolve()))]);
  }
});

test("without an applied configuration no recognition model is chosen and environment model values are ignored", () => {
  const home = mkdtempSync(join(tmpdir(), "speech-default-"));
  try {
    const output = execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
      import { resolveSpeechConfiguration } from './server/voice/configuration.ts';
      import { loadSettings } from './server/config/settings.ts';
      import { transcribe } from './server/audio/providers/stt.ts';
      const speech = resolveSpeechConfiguration();
      const heard = await transcribe({ buffer: Buffer.alloc(8), mime: "audio/wav", filename: "voice.wav" });
      console.log(JSON.stringify({ speech, heard, saved: loadSettings().speechRecognition ?? null }));
    `], { cwd: join(import.meta.dirname, "../.."), env: { ...process.env, TELOMI_DATA_DIR: home, TELOMI_AUDIO_STT_PROVIDER: "openai-whisper", TELOMI_AUDIO_STT_MODEL: "env-model", TELOMI_AUDIO_SELF_HOSTED_STT_MODEL: "env-model", TELOMI_CLEANUP_MODEL: "env/cleanup", TELOMI_VOICE_LOCAL_STREAM_MODEL: "env-stream", OPENAI_API_KEY: "env-key" }, encoding: "utf8" });
    const { speech, heard, saved } = JSON.parse(output) as { speech: Record<string, unknown>; heard: { ok: boolean; reason?: string }; saved: unknown };
    assert.equal(speech.recognition, undefined, "nothing is chosen on the user's behalf");
    assert.equal(speech.local, undefined);
    assert.equal(speech.fallback, undefined);
    assert.deepEqual([heard.ok, heard.reason], [false, "No recognition model is chosen; choose one in Settings under Recognition"]);
    assert.equal(speech.cleanupEnabled, false);
    assert.equal(speech.cleanupModel, null);
    assert.equal(saved, null, "resolving the default never writes settings");
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("recording credentials rotate only within the captured endpoint", { timeout: 30_000 }, async () => {
  const seen: Array<{ upstream: number; authorization: string }> = [];
  const cleanupRequests: Array<{ upstream: number; authorization: string }> = [];
  const upstreams = [0, 1].map(upstream => createServer((req, res) => {
    let body = "";
    req.on("data", chunk => { body += chunk; });
    req.on("end", () => {
      res.setHeader("Content-Type", "application/json");
      if (req.url === "/v1/chat/completions") {
        cleanupRequests.push({ upstream, authorization: req.headers.authorization ?? "" });
        res.setHeader("Content-Type", "text/event-stream");
        for (const [delta, finish] of [[{ role: "assistant", content: "affinity cleanup" }, null], [{}, "stop"]]) res.write(`data: ${JSON.stringify({ id: "cleanup", object: "chat.completion.chunk", created: 1, model: "cleanup-affinity", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
        res.end("data: [DONE]\n\n"); return;
      }
      if (req.url === "/v1/models") res.end(JSON.stringify({ data: [{ id: "asr-affinity" }, { id: "cleanup-affinity" }] }));
      else if (req.url === "/v1/audio/warmup") res.end(JSON.stringify({ ok: true, loaded: true, model: JSON.parse(body).model }));
      else { seen.push({ upstream, authorization: req.headers.authorization ?? "" }); res.end(JSON.stringify({ text: "affinity transcript" })); }
    });
  }));
  const endpoints: string[] = [];
  for (const server of upstreams) {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address(); assert.ok(address && typeof address === "object");
    endpoints.push(`http://127.0.0.1:${address.port}/v1`);
  }
  const app = express(); app.use(express.json()); mountSpeechConfigurationApi(app); mountCustomProvidersApi(app);
  const server = app.listen(0, "127.0.0.1"); await new Promise<void>(resolve => server.once("listening", resolve));
  const address = server.address(); assert.ok(address && typeof address === "object");
  const api = `http://127.0.0.1:${address.port}`;
  const audio = { buffer: pcm16MonoToWav(Buffer.alloc(32000), 16000), mime: "audio/wav", filename: "voice.wav" };
  try {
    for (const provider of ["self-hosted-stt", "telomi-audio", "openai-whisper", "openrouter-stt"] as const) {
      const replace = async (endpoint: string, key: string) => {
        const response = await fetch(`${api}/api/custom-providers/affinity-test`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ baseUrl: endpoint, api: "openai-completions", capability: "audio-recognition", models: [{ id: "asr-affinity" }], apiKey: key, mode: "apply" }) });
        assert.equal(response.status, 200, JSON.stringify(await response.json()));
      };
      await replace(endpoints[0]!, "first-test-key");
      const selection = { provider, connection: "affinity-test", model: "asr-affinity" };
      const applied = await fetch(`${api}/api/audio-config/recognition/apply`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ default: selection, local: { ...selection, provider: "self-hosted-stt" }, cleanupEnabled: false, cleanupInstructions: "" }) });
      assert.equal(applied.status, 200, JSON.stringify(await applied.json()));
      const captured = new VoiceUtteranceContextStore(data).capture();
      await replace(endpoints[0]!, "rotated-same-endpoint");
      assert.equal((await transcribe({ ...audio, selection: captured.speech!.recognition })).ok, true);
      assert.deepEqual(seen.at(-1), { upstream: 0, authorization: "Bearer rotated-same-endpoint" });
      await replace(endpoints[1]!, "new-endpoint-key");
      const before = seen.length;
      const oldRecording = await transcribe({ ...audio, selection: captured.speech!.recognition });
      assert.equal(oldRecording.ok, false, `${provider}: endpoint replacement cannot reuse a captured connection`);
      assert.equal(seen.length, before, `${provider}: neither endpoint receives a misbound request`);
      assert.equal((await transcribe(audio)).ok, true);
      assert.deepEqual(seen.at(-1), { upstream: 1, authorization: "Bearer new-endpoint-key" });
    }
    // A separate publisher exposes the new catalog while the old key is still on disk.
    const writer = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
      import { modifyStoredCredential } from './server/accounts/stored-credentials.ts';
      import { resolveAgentPath } from './server/config/agent-directory.ts';
      import { loadCustomProviders, saveCustomProviders } from './server/providers/custom-models.ts';
      modifyStoredCredential(resolveAgentPath('auth.json'), 'affinity-test', () => {
        const catalog = loadCustomProviders();
        catalog.providers['affinity-test'].baseUrl = ${JSON.stringify(endpoints[0])};
        saveCustomProviders(catalog);
        process.stdout.write('catalog-published\\n');
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150);
        return { type: 'api_key', key: 'coherent-recording-key' };
      });
    `], { cwd: join(import.meta.dirname, "../.."), env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    const writerExit = once(writer, "exit");
    await once(writer.stdout!, "data");
    const fresh = new VoiceUtteranceContextStore(data).capture();
    const coherent = await transcribe({ ...audio, selection: fresh.speech!.recognition });
    assert.equal((await writerExit)[0], 0);
    assert.equal(coherent.ok, true);
    assert.ok(seen.at(-1)?.upstream === 0 && seen.at(-1)?.authorization === "Bearer coherent-recording-key",
      "A fresh recording must use the committed endpoint/key pair across processes");
    const generationOnly = await fetch(`${api}/api/custom-providers/generation-only`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ baseUrl: endpoints[0], api: "openai-completions", capability: "audio-generation", apiKey: "generation-test-key", models: [{ id: "asr-affinity" }] }) });
    assert.equal(generationOnly.status, 200);
    const activeSpeech = await (await fetch(`${api}/api/audio-config/recognition`)).json();
    assert.equal((await fetch(`${api}/api/audio-config/recognition/apply`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...activeSpeech.active, default: { ...activeSpeech.active.default, connection: "generation-only" } }) })).status, 422,
      "Recognition cannot bypass an explicit generation-only declaration");
    const replaceCleanup = async (baseUrl: string, apiKey: string) => {
      const response = await fetch(`${api}/api/custom-providers/affinity-cleanup`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ baseUrl, api: "openai-completions", models: [{ id: "cleanup-affinity" }], apiKey, mode: "apply" }) });
      assert.equal(response.status, 200, JSON.stringify(await response.json()));
    };
    await replaceCleanup(endpoints[0]!, "cleanup-first-key");
    const current = await (await fetch(`${api}/api/audio-config/recognition`)).json();
    const applied = await fetch(`${api}/api/audio-config/recognition/apply`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...current.active, cleanupEnabled: true, cleanupModel: "affinity-cleanup/cleanup-affinity" }) });
    assert.equal(applied.status, 200, JSON.stringify(await applied.json()));
    const captured = new VoiceUtteranceContextStore(data).capture();
    const input = { ...audio, speech: captured.speech, cleanupModelId: captured.cleanup.modelId, cleanupRequested: true, glossary: captured.glossary };
    await replaceCleanup(endpoints[0]!, "cleanup-rotated-key");
    const cleaned = await runVoiceTranscriptionPipeline(input);
    assert.equal(cleaned.ok && cleaned.text, "affinity cleanup");
    assert.deepEqual(cleanupRequests.at(-1), { upstream: 0, authorization: "Bearer cleanup-rotated-key" });
    await replaceCleanup(endpoints[1]!, "cleanup-new-endpoint-key");
    const before = cleanupRequests.length;
    const unchanged = await runVoiceTranscriptionPipeline(input);
    assert.equal(unchanged.ok && unchanged.text, "affinity transcript");
    assert.equal(unchanged.ok && unchanged.cleanup.applied, false);
    assert.equal(cleanupRequests.length, before, "changed cleanup connection sends no new request for the old recording");
  } finally {
    for (const item of [server, ...upstreams]) item.closeAllConnections();
    await Promise.all([server, ...upstreams].map(item => new Promise<void>(resolve => item.close(() => resolve()))));
  }
});
