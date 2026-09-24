import { sha256 } from "../lib/hash.js";
import { existsSync } from "node:fs";
import type { Express } from "express";
import { isDeepStrictEqual } from "node:util";
import { loadSettings, saveSettings, type PiSettings } from "../config/settings.js";
import { resolveAgentPath } from "../config/agent-directory.js";
import { sttProtocolForConnection } from "../audio/registry.js";
import { isManagedAudioConnection } from "../../shared/connections.js";
import { resolveSelfHostedSttEndpoint } from "../audio/providers/self-hosted-stt.js";
import { readStoredCredentials, modifyStoredCredentials } from "../accounts/stored-credentials.js";
import { anonymousConnectionKeyFor, loadCustomProviders } from "../providers/custom-models.js";
import { connectionEntry } from "../audio/configuration.js";
import { connectionApiKey } from "../providers/builtin-connections.js";
import { isProviderCredentialDeleted } from "../config/credential-tombstones.js";
import { writeJsonAtomic, readJson } from "../lib/fs.js";
import { MAX_VOICE_CLEANUP_INSTRUCTIONS_CHARS, normalizeVoiceCleanupInstructions } from "../../shared/voice-cleanup.js";
import { resolveLLMConfig } from "../agent-runtime/model-config/resolve.js";
import type { SpeechConfiguration, SpeechSelection, SpeechExecutionConfiguration, SpeechConfigurationResponse } from "../../shared/speech-configuration.js";

/** What the user selected; nothing is chosen on their behalf, and environment values never participate. */
const NOTHING_CHOSEN: SpeechConfiguration = { cleanupEnabled: false, cleanupInstructions: "" };
export function activeSpeechConfiguration(settings = loadSettings()): SpeechConfiguration { return settings.speechRecognition ?? NOTHING_CHOSEN; }
export const SPEECH_RECOGNITION_UNSET = "No recognition model is chosen; choose one in Settings under Recognition";

export function assertSpeechConnectionAffinity(connection: string, expectedBaseUrl: string | null, transcription = false): void {
  const current = connectionEntry(connection)?.baseUrl;
  if (expectedBaseUrl === null) {
    if (current !== undefined) throw new Error("Speech connection changed since this recording started; start a new recording");
    if (isProviderCredentialDeleted(connection)) throw new Error("Speech connection credential was deleted");
    return;
  }
  // A connection that is not in the catalog, or whose endpoint cannot be used, is its own error;
  // "changed" is reserved for an endpoint that moved after the caller resolved it.
  if (current === undefined) throw new Error(`Speech connection ${connection} is not configured`);
  const normalize = (value: string | undefined): string | undefined => {
    if (!value) return undefined;
    if (transcription) {
      const endpoint = resolveSelfHostedSttEndpoint(value);
      return endpoint.ok ? endpoint.baseUrl : undefined;
    }
    try {
      const url = new URL(value);
      url.pathname = url.pathname.replace(/\/+$/, "");
      return url.toString();
    } catch { return undefined; }
  };
  if (!normalize(current)) throw new Error(`Speech connection ${connection} has an invalid endpoint`);
  if (normalize(current) !== normalize(expectedBaseUrl)) {
    throw new Error("Speech connection changed since this recording started; start a new recording");
  }
  if (isProviderCredentialDeleted(connection)) throw new Error("Speech connection credential was deleted");
}

export function speechConnectionKey(connection: string, expectedBaseUrl: string): string | undefined {
  let key: string | undefined;
  modifyStoredCredentials(resolveAgentPath("auth.json"), credentials => {
    assertSpeechConnectionAffinity(connection, expectedBaseUrl, true);
    const entry = connectionEntry(connection);
    // The managed local runtime serves both audio capabilities; a pin on its entry never hides recognition.
    if (entry?.capability && entry.capability !== "audio-recognition" && !isManagedAudioConnection(connection)) throw new Error("Speech configuration requires a recognition-compatible connection");
    // Read the endpoint and key under the same native lock used by connection publication.
    key = connectionApiKey(connection, credentials) ?? (typeof entry?.apiKey === "string" ? entry.apiKey : undefined);
    return undefined;
  });
  return key;
}

export function resolveSpeechConfiguration(settings: PiSettings = loadSettings()): SpeechExecutionConfiguration {
  const config = activeSpeechConfiguration(settings);
  const catalog = loadCustomProviders().providers;
  const resolve = (selection: SpeechSelection | undefined) => {
    if (!selection) return undefined;
    const entry = connectionEntry(selection.connection);
    const endpoint = resolveSelfHostedSttEndpoint(entry?.baseUrl ?? "");
    // Missing or invalid connections fail at their consumer, not unrelated audio/LLM roles.
    return { ...selection, baseUrl: endpoint.ok ? endpoint.baseUrl : "" };
  };
  const cleanupModel = config.cleanupModel || resolveLLMConfig({ settingsOverride: settings }).model;
  const cleanupBaseUrl = cleanupModel ? catalog?.[cleanupModel.split("/")[0]!]?.baseUrl : undefined;
  return {
    recognition: resolve(config.recognition ?? config.default),
    local: resolve(config.local ?? config.default),
    ...(config.fallback ? { fallback: resolve(config.fallback) } : {}),
    cleanupEnabled: config.cleanupEnabled,
    cleanupInstructions: config.cleanupInstructions,
    cleanupModel,
    cleanupBaseUrl: cleanupBaseUrl ?? null,
  };
}

function parse(value: unknown): SpeechConfiguration {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("speech configuration must be an object");
  const body = value as Record<string, unknown>;
  const selection = (raw: unknown): SpeechSelection => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("selection must include connection and model");
    const item = raw as Record<string, unknown>;
    // A provider sent by an older client is ignored: the connection is the target.
    if (typeof item.connection !== "string" || !/^[a-zA-Z0-9_.-]+$/.test(item.connection) || typeof item.model !== "string" || !item.model.trim() || item.model.length > 300) throw new Error("invalid speech selection");
    return { connection: item.connection, model: item.model.trim() };
  };
  if (typeof body.cleanupEnabled !== "boolean" || typeof body.cleanupInstructions !== "string" || Array.from(body.cleanupInstructions).length > MAX_VOICE_CLEANUP_INSTRUCTIONS_CHARS) throw new Error("invalid cleanup parameters");
  const result: SpeechConfiguration = { cleanupEnabled: body.cleanupEnabled, cleanupInstructions: normalizeVoiceCleanupInstructions(body.cleanupInstructions) };
  for (const key of ["default", "recognition", "local", "fallback"] as const) if (body[key] != null) result[key] = selection(body[key]);
  if (body.cleanupModel != null && body.cleanupModel !== "") {
    if (typeof body.cleanupModel !== "string" || !/^[^/]+\/.+$/.test(body.cleanupModel) || body.cleanupModel.length > 300) throw new Error("cleanupModel must use provider/model format");
    result.cleanupModel = body.cleanupModel;
  }
  const local = result.local ?? result.default;
  // The local streaming adapter speaks multipart transcription only; the JSON contract cannot stream snapshots.
  if (local && sttProtocolForConnection(local.connection) === "openrouter-transcription") throw new Error("local recognition requires a local or self-hosted selection override");
  if (result.fallback && isManagedAudioConnection(result.fallback.connection)) throw new Error("recognition backup must be an explicit supported cloud selection");
  return result;
}

type SpeechConsumer = "recognition" | "local" | "cleanupModel";
function adoptionPath(id: SpeechConsumer): string { return resolveAgentPath("speech-adoption", `${id}.json`); }
function consumerRevision(id: SpeechConsumer, config: SpeechExecutionConfiguration): string {
  const value = id === "local" ? [config.local]
    : id === "cleanupModel" ? [config.cleanupModel, config.cleanupBaseUrl, config.cleanupEnabled, config.cleanupInstructions] : [config.recognition, config.fallback];
  return sha256(JSON.stringify(value));
}
/** Shared with the LiveKit worker. Only the configuration fingerprint is persisted, never credentials. */
export function noteSpeechConfiguration(id: SpeechConsumer, config: SpeechExecutionConfiguration): void {
  writeJsonAtomic(adoptionPath(id), consumerRevision(id, config));
}
function hasAdopted(id: SpeechConsumer, config: SpeechExecutionConfiguration): boolean {
  try { return existsSync(adoptionPath(id)) && readJson(adoptionPath(id)) === consumerRevision(id, config); } catch { return false; }
}

/** Why the next recording could not use this selection as saved; undefined when the static checks pass. */
function selectionUnavailable(selection: SpeechExecutionConfiguration["recognition"]): string | undefined {
  if (!selection) return undefined;
  try { speechConnectionKey(selection.connection, selection.baseUrl); return undefined; }
  catch (error) { return error instanceof Error ? error.message : String(error); }
}

let phase: SpeechConfigurationResponse["status"] = "active";
let failure: string | undefined;
function response(): SpeechConfigurationResponse {
  const settings = loadSettings();
  const active = activeSpeechConfiguration(settings);
  const effective = resolveSpeechConfiguration(settings);
  const cleanupUnavailable = !effective.cleanupModel || isProviderCredentialDeleted(effective.cleanupModel.split("/")[0]!);
  // An adopted selection the next recording still cannot use (connection gone, credential deleted, endpoint unusable) is unavailable, not active.
  const unavailable = { recognition: selectionUnavailable(effective.recognition), local: selectionUnavailable(effective.local), cleanupModel: cleanupUnavailable ? "Cleanup model is not configured or its credential was deleted" : undefined };
  const consumers = (["recognition", "local", "cleanupModel"] as const).map(id => ({ id, status: id !== "cleanupModel" && !effective[id] ? "unconfigured" as const : unavailable[id] ? "unavailable" as const : hasAdopted(id, effective) ? "active" as const : "pending" as const, boundary: "next-recording" as const }));
  const broken = unavailable.recognition ?? unavailable.local ?? (active.cleanupEnabled ? unavailable.cleanupModel : undefined);
  return { active, pending: settings.pendingSpeechRecognition ?? null, effective, consumers, sources: { recognition: active.recognition ? "override" : "default", local: active.local ? "override" : "default", cleanupModel: active.cleanupModel ? "override" : "default" }, status: phase === "active" ? broken ? "failed" : settings.pendingSpeechRecognition ? "saved" : consumers.some(consumer => consumer.status === "pending") ? "pending" : "active" : phase, ...(failure || broken ? { error: failure ?? broken } : {}), boundary: "next-recording" };
}

export async function validateSpeechConnection(baseUrl: string, key: string | undefined, modelIds: string[]): Promise<void> {
  const endpoint = resolveSelfHostedSttEndpoint(baseUrl);
  if (!endpoint.ok) throw new Error(endpoint.error);
  const list = async (url: string) => {
    const res = await fetch(url, { headers: key ? { Authorization: `Bearer ${key}` } : {}, redirect: "error", signal: AbortSignal.timeout(45_000) });
    if (!res.ok) throw new Error(`Model validation failed: HTTP ${res.status}`);
    const models = await res.json() as { data?: Array<{ id?: string }> };
    return new Set(models.data?.map(model => model.id));
  };
  let listed = await list(endpoint.modelsEndpoint);
  // A gateway such as OpenRouter lists its transcription models apart from /models; servers that ignore the query answer /models again.
  if (modelIds.some(id => !listed.has(id))) listed = new Set([...listed, ...await list(`${endpoint.modelsEndpoint}?output_modalities=transcription`).catch(() => new Set<string | undefined>())]);
  if (!modelIds.length || modelIds.some(id => !listed.has(id))) throw new Error("Model unavailable on the selected connection");
}

async function validate(config: SpeechConfiguration): Promise<void> {
  const effective = resolveSpeechConfiguration({ ...loadSettings(), speechRecognition: config });
  const { getAudioLocalRuntimeManager } = await import("../audio/local-runtime.js");
  for (const selection of [effective.recognition, effective.local, effective.fallback]) {
    if (!selection) continue;
    await getAudioLocalRuntimeManager().prepare(selection.connection);
    if (isProviderCredentialDeleted(selection.connection)) throw new Error(`Credential deleted for ${selection.connection}`);
    const key = speechConnectionKey(selection.connection, selection.baseUrl);
    // A connection declared without a credential and without an auth header is anonymous on purpose; a
    // connection that is missing entirely fails below, where the endpoint says so.
    const entry = connectionEntry(selection.connection);
    if (!key && entry && !anonymousConnectionKeyFor(entry)) throw new Error(`Missing API key for ${selection.connection}`);
    await validateSpeechConnection(selection.baseUrl, key, [selection.model]);
  }
  if (config.cleanupEnabled) {
    const { validateModelDefaults } = await import("../providers/config-api.js");
    if (!effective.cleanupModel) throw new Error("Speech configuration cleanup model is not configured");
    const slash = effective.cleanupModel.indexOf("/");
    const result = await validateModelDefaults({ defaultProvider: effective.cleanupModel.slice(0, slash), defaultModel: effective.cleanupModel.slice(slash + 1) });
    if (!result.ok) throw new Error("Speech configuration cleanup model or authorization is unavailable");
  }
  phase = "applying";
  // Warmup runs where the endpoint advertises it; elsewhere the first transcription loads the model.
  for (const selection of [effective.recognition, effective.local]) {
    if (!selection) continue;
    const { warmupStt } = await import("../audio/providers/stt.js");
    const result = await warmupStt({ model: selection.model, baseUrl: selection.baseUrl, connection: selection.connection, signal: AbortSignal.timeout(45_000) });
    if (!result.ok) throw new Error("Recognition model could not be prepared");
  }
}

export function mountSpeechConfigurationApi(app: Express): void {
  app.get("/api/audio-config/recognition", (_req, res) => {
    try { res.json(response()); } catch { res.status(500).json({ error: "Could not read speech configuration" }); }
  });
  app.post("/api/audio-config/recognition/pending", (req, res) => {
    try { const settings = loadSettings(); settings.pendingSpeechRecognition = parse(req.body); saveSettings(settings); if (phase !== "validating" && phase !== "applying") { phase = "active"; failure = undefined; } res.json(response()); }
    catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : "Invalid speech configuration" }); }
  });
  app.delete("/api/audio-config/recognition/pending", (_req, res) => {
    try { const settings = loadSettings(); delete settings.pendingSpeechRecognition; saveSettings(settings); if (phase === "failed") { phase = "active"; failure = undefined; } res.json(response()); }
    catch { res.status(500).json({ error: "Could not discard the saved speech configuration" }); }
  });
  app.post("/api/audio-config/recognition/apply", async (req, res) => {
    if (phase === "validating" || phase === "applying") { res.status(409).json({ error: "Speech configuration is already applying" }); return; }
    let draft: SpeechConfiguration | undefined;
    let staged: SpeechConfiguration | undefined;
    try {
      const before = loadSettings();
      staged = before.pendingSpeechRecognition;
      draft = parse(Object.keys(req.body ?? {}).length ? req.body : before.pendingSpeechRecognition);
      const catalogBefore = loadCustomProviders();
      const credentialsBefore = readStoredCredentials(resolveAgentPath("auth.json"));
      phase = "validating"; failure = undefined;
      await validate(draft);
      const current = loadSettings();
      if (!isDeepStrictEqual(current.speechRecognition, before.speechRecognition)) throw new Error("Speech configuration changed during validation");
      if (!isDeepStrictEqual(loadCustomProviders(), catalogBefore) || !isDeepStrictEqual(readStoredCredentials(resolveAgentPath("auth.json")), credentialsBefore)) throw new Error("Speech configuration connections changed during validation");
      current.speechRecognition = draft;
      if (isDeepStrictEqual(current.pendingSpeechRecognition, before.pendingSpeechRecognition)) delete current.pendingSpeechRecognition;
      saveSettings(current); phase = "active";
      res.json(response());
    } catch (error) {
      phase = "failed";
      // Transport errors can contain URLs or credentials; expose only our bounded validation errors.
      failure = error instanceof Error && /^(invalid|selection|speech|cleanupModel|local recognition|recognition backup|Model unavailable|Model validation|Missing API|Credential deleted|Recognition model|Speech configuration)/i.test(error.message) ? error.message : "Speech validation or service update failed; previous configuration remains active";
      try {
        const settings = loadSettings();
        if (draft && isDeepStrictEqual(settings.pendingSpeechRecognition, staged)) {
          settings.pendingSpeechRecognition = draft;
          saveSettings(settings);
        }
        res.status(422).json({ ...response(), error: failure });
      } catch { res.status(500).json({ status: "failed", error: "Speech configuration could not be read or saved" }); }
    }
  });
}
