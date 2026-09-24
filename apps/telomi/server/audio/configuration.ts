import { rm } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import type { Express } from "express";
import type { AudioGenerationConfiguration, AudioGenerationConsumer, AudioGenerationResponse, AudioGenerationSelection } from "../../shared/audio-generation.js";
import { loadSettings, saveSettings } from "../config/settings.js";
import { resolveAgentPath } from "../config/agent-directory.js";
import { readStoredCredentials, modifyStoredCredentials } from "../accounts/stored-credentials.js";
import { isProviderCredentialDeleted } from "../config/credential-tombstones.js";
import { anonymousConnectionKeyFor, loadCustomProviders, type CustomProvider } from "../providers/custom-models.js";
import { builtinConnectionEntry, connectionApiKey } from "../providers/builtin-connections.js";
import { readJson, writeJsonAtomic } from "../lib/fs.js";
import { sha256 } from "../lib/hash.js";
import { getAudioLocalRuntimeManager } from "./local-runtime.js";
import { audioServiceHealth, serverAudioModel, serverDefaultAudioModel } from "./providers/health.js";
import { knownTtsModel } from "./registry.js";
import { capabilitiesFor } from "../../shared/model-capabilities.js";
import { isManagedAudioConnection } from "../../shared/connections.js";

const consumerIds = ["playback", "local", "podcast"] as const;
/** What the user selected; nothing is chosen on their behalf, and environment values never participate. */
export function activeAudioGeneration(settings = loadSettings()): AudioGenerationConfiguration { return settings.audioGeneration ?? {}; }

/**
 * A connection as the catalog defines it. Without an entry, the managed connection resolves to the
 * local runtime and a built-in cloud Provider to its own endpoint and discovered models.
 */
export function connectionEntry(id: string): CustomProvider | undefined {
  const entry = loadCustomProviders().providers?.[id];
  if (entry) return entry;
  if (isManagedAudioConnection(id)) return { baseUrl: getAudioLocalRuntimeManager().baseUrl(), api: "openai-completions", models: [] };
  return builtinConnectionEntry(id);
}

function endpoint(value: string): string {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error("Invalid audio connection endpoint");
  return url.toString().replace(/\/+$/, "");
}

export interface AudioGenerationExecution extends AudioGenerationSelection { baseUrl: string }
/** What a consumer speaks with, or `undefined` while the user has not chosen a speech model for it. */
export function resolveAudioGeneration(consumer: AudioGenerationConsumer = "playback", config?: AudioGenerationConfiguration): AudioGenerationExecution | undefined {
  config ??= activeAudioGeneration();
  const selected = config[consumer] ?? config.default;
  if (!selected) return undefined;
  const connection = connectionEntry(selected.connection);
  return { ...selected, baseUrl: connection ? endpoint(connection.baseUrl) : "" };
}

/** For a consumer about to speak: without a chosen model it fails with what the user has to do. */
export function requireAudioGeneration(consumer: AudioGenerationConsumer): AudioGenerationExecution {
  const selected = resolveAudioGeneration(consumer);
  if (!selected) throw new Error("No speech model is chosen; choose one in Settings under Read aloud");
  return selected;
}

/** What a selection runs as on its connection. */
export interface SpeechModel {
  model: string;
  /** Absent when neither the selection nor anything known about the model names one; the server's own default then speaks. */
  voice?: string;
  /** The voices known for the model. Applying accepts a voice outside them only after the server speaks it; empty when nothing is known, and then any typed voice is accepted. */
  voices: string[];
  /** The only `response_format` values the model returns; any when absent. */
  responseFormats?: readonly string[];
  /** The `speed` range the model accepts; any when absent. */
  speed?: { min: number; max: number };
  languageInstruction: boolean;
}

/**
 * Resolve a selection against what its server reports. A selection naming no model runs the one the
 * server serves for speech. The server's listed voices, the voices discovery stored for the
 * connection, and the server's default voice decide what may be spoken; Telomi's table of
 * well-known cloud models is used only where the server reports nothing about the model.
 */
export async function resolveSpeechModel(selection: AudioGenerationExecution, key: string | undefined): Promise<SpeechModel> {
  const model = selection.model || await serverDefaultAudioModel(selection.baseUrl, key, "tts");
  if (!model) throw new Error(`Audio model unavailable on selected connection: none selected and ${selection.baseUrl} reports no speech model`);
  const reported = await serverAudioModel(selection.baseUrl, key, model);
  const discovered = connectionEntry(selection.connection)?.models.find(entry => entry.id === model)?.supportedVoices ?? [];
  const reportedVoices = [...new Set([...(reported?.voices ?? []), ...discovered, ...(reported?.defaultVoice ? [reported.defaultVoice] : [])])];
  const known = knownTtsModel(model);
  const voices = reportedVoices.length ? reportedVoices : known?.supportedVoices ?? [];
  const voice = selection.voice || reported?.defaultVoice || voices[0];
  const responseFormats = reported?.responseFormats ?? known?.responseFormats;
  return { model, voices, languageInstruction: known?.languageInstruction === true, ...(voice ? { voice } : {}), ...(responseFormats ? { responseFormats } : {}), ...(reported?.speed ? { speed: reported.speed } : {}) };
}

/** Match the transport exactly: the connection's API key, or none for a connection declared anonymous. */
export function audioGenerationKey(selection: AudioGenerationExecution): string | undefined {
  let key: string | undefined;
  // Connection activation publishes the catalog and credential under this existing native store lock.
  // A separate voice Worker must not observe the new endpoint paired with the old credential.
  modifyStoredCredentials(resolveAgentPath("auth.json"), credentials => {
    const entry = connectionEntry(selection.connection);
    if (!entry) throw new Error("Audio connection unavailable");
    // The managed local runtime serves both audio capabilities; a pin on its entry never hides generation.
    if (entry.capability && entry.capability !== "audio-generation" && !isManagedAudioConnection(selection.connection)) throw new Error("Only audio generation connections can generate audio");
    if (endpoint(entry.baseUrl) !== selection.baseUrl) throw new Error("Audio connection changed; start a new playback");
    if (isProviderCredentialDeleted(selection.connection)) throw new Error("Audio connection credential was deleted");
    key = connectionApiKey(selection.connection, credentials) ?? entry.apiKey;
    if (credentials[selection.connection] && !key) throw new Error("Audio connections require API key authentication");
    // A connection declared without a credential and without an auth header is anonymous on purpose; anything else must authenticate.
    if (!key && !anonymousConnectionKeyFor(entry)) throw new Error("Audio connection requires an API key");
    return undefined;
  });
  return key;
}

/** One connection, model, voice and rate as a settings request sends it. */
export function parseAudioGenerationSelection(raw: unknown): AudioGenerationSelection {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Invalid audio selection");
  const item = raw as Record<string, unknown>;
  // A provider sent by an older client is ignored: the connection is the target. An empty model or voice asks the server for its default.
  if (typeof item.connection !== "string" || !/^[a-zA-Z0-9_.-]{1,64}$/.test(item.connection) || typeof item.model !== "string" || item.model.length > 300 || typeof item.voice !== "string" || item.voice.length > 100 || typeof item.rate !== "number" || !Number.isFinite(item.rate) || item.rate < 0.25 || item.rate > 4) throw new Error("Invalid audio selection or parameters");
  return { connection: item.connection, model: item.model.trim(), voice: item.voice.trim(), rate: item.rate };
}

function parse(value: unknown): AudioGenerationConfiguration {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid audio configuration");
  const body = value as Record<string, unknown>;
  const result: AudioGenerationConfiguration = {};
  if (body.default != null) result.default = parseAudioGenerationSelection(body.default);
  for (const id of consumerIds) if (body[id] != null) result[id] = parseAudioGenerationSelection(body[id]);
  return result;
}

/** `models` undefined: the model is catalog-known and the connection only has to authenticate. Cloud gateways do not list TTS models. */
export async function validateAudioGenerationConnection(baseUrl: string, key: string | undefined, models: string[] | undefined): Promise<void> {
  const res = await fetch(`${endpoint(baseUrl)}/models`, { headers: key ? { Authorization: `Bearer ${key}` } : {}, redirect: "error", signal: AbortSignal.timeout(45_000) });
  if (!res.ok) throw new Error(`Audio connection validation failed (HTTP ${res.status})`);
  if (models === undefined) return;
  const body = await res.json() as { data?: Array<{ id?: string }> };
  if (!models.length || models.some(id => !body.data?.some(model => model.id === id))) throw new Error("Audio model unavailable on selected connection");
}

async function warmupDetail(response: Response): Promise<string> {
  const body = await response.json().catch(() => undefined) as { detail?: unknown; error?: unknown } | undefined;
  const text = typeof body?.detail === "string" ? body.detail : typeof body?.error === "string" ? body.error : "";
  return text ? `: ${text.slice(0, 300)}` : "";
}

function adoptionPath(id: AudioGenerationConsumer): string { return resolveAgentPath("audio-generation-adoption", `${id}.json`); }
export function noteAudioGeneration(id: AudioGenerationConsumer, selection: AudioGenerationExecution): void { writeJsonAtomic(adoptionPath(id), sha256(JSON.stringify(selection))); }
let phase: AudioGenerationResponse["status"] = "active";
let failure: string | undefined;
function response(): AudioGenerationResponse {
  const settings = loadSettings();
  const active = activeAudioGeneration(settings);
  const effective = {} as AudioGenerationResponse["effective"];
  const sources = {} as AudioGenerationResponse["sources"];
  const consumers = consumerIds.map(id => {
    const selected = active[id] ?? active.default;
    if (!selected) { effective[id] = null; sources[id] = null; return { id, status: "unconfigured" as const }; }
    sources[id] = active[id] ? "override" : "default";
    let status: "active" | "pending" | "unavailable" = "pending";
    try {
      const resolved = resolveAudioGeneration(id)!;
      effective[id] = resolved;
      audioGenerationKey(resolved);
      try { if (readJson(adoptionPath(id)) === sha256(JSON.stringify(resolved))) status = "active"; } catch { /* Not adopted by this consumer yet. */ }
    } catch { effective[id] = { ...selected, baseUrl: "" }; status = "unavailable"; }
    return { id, status };
  });
  return { active, pending: settings.pendingAudioGeneration ?? null, effective, sources, consumers,
    status: phase === "active" ? settings.pendingAudioGeneration ? "saved" : consumers.some(item => item.status !== "active") ? "pending" : "active" : phase, ...(failure ? { error: failure } : {}) };
}

export function mountAudioGenerationApi(app: Express): void {
  app.get("/api/audio-config/generation", (_req, res) => {
    try { res.json(response()); } catch { res.status(500).json({ error: "Could not read audio generation configuration" }); }
  });
  app.post("/api/audio-config/generation/pending", (req, res) => {
    try { const settings = loadSettings(); settings.pendingAudioGeneration = parse(req.body); saveSettings(settings); if (phase !== "validating" && phase !== "applying") { phase = "active"; failure = undefined; } res.json(response()); }
    catch { res.status(400).json({ error: "Invalid audio generation configuration" }); }
  });
  app.delete("/api/audio-config/generation/pending", (_req, res) => {
    try { const settings = loadSettings(); delete settings.pendingAudioGeneration; saveSettings(settings); if (phase === "failed") { phase = "active"; failure = undefined; } res.json(response()); }
    catch { res.status(500).json({ error: "Could not discard the saved audio generation configuration" }); }
  });
  app.post("/api/audio-config/generation/apply", async (req, res) => {
    if (phase === "validating" || phase === "applying") { res.status(409).json({ error: "Audio generation configuration is already applying" }); return; }
    let validating: AudioGenerationConsumer | undefined;
    let draft: AudioGenerationConfiguration | undefined;
    let staged: AudioGenerationConfiguration | undefined;
    try {
      const before = loadSettings();
      const active = activeAudioGeneration(before);
      staged = before.pendingAudioGeneration;
      const parsed = parse(Object.keys(req.body ?? {}).length ? req.body : before.pendingAudioGeneration);
      draft = parsed;
      const catalog = loadCustomProviders();
      const credentials = readStoredCredentials(resolveAgentPath("auth.json"));
      phase = "validating"; failure = undefined;
      const changed = consumerIds.filter(id => !isDeepStrictEqual(parsed[id] ?? parsed.default, active[id] ?? active.default));
      for (const id of changed.length ? changed : consumerIds) {
        validating = id;
        const selected = resolveAudioGeneration(id, parsed);
        if (!selected) throw new Error("choose a speech model");
        const held = active[id] ?? active.default;
        // Only the rate moved: the connection, model and voice were proven when they were applied, so
        // the speed range is all that is left to check, and a rate change saves without a round trip.
        const rateOnly = changed.includes(id) && held?.connection === selected.connection && held.model === selected.model && held.voice === selected.voice;
        await getAudioLocalRuntimeManager().prepare(selected.connection);
        const key = audioGenerationKey(selected);
        const speech = await resolveSpeechModel(selected, key);
        const known = knownTtsModel(speech.model);
        // The managed connection may have no catalog entry to declare a capability in; it serves both.
        // A built-in cloud Provider has none either; its discovered models stand in for one.
        const entry = catalog.providers?.[selected.connection] ?? builtinConnectionEntry(selected.connection, credentials);
        // A connection serving several capabilities declares none itself; discovery classified each of its models instead.
        const discovered = entry && !entry.capability ? entry.models.find(model => model.id === speech.model) : undefined;
        const discoveredSpeech = discovered !== undefined && capabilitiesFor(discovered).includes("tts");
        if (!known && !discoveredSpeech && entry && entry.capability !== "audio-generation" && !isManagedAudioConnection(selected.connection)) throw new Error("Connection must declare audio generation capability for this model");
        if (speech.speed && (selected.rate < speech.speed.min || selected.rate > speech.speed.max)) throw new Error("Unsupported speed for selected audio model");
        if (rateOnly) continue;
        // A listed model must be served by the connection; a catalog-known or discovered gateway speech model only needs an authenticating connection.
        await validateAudioGenerationConnection(selected.baseUrl, key, known || discoveredSpeech ? undefined : [speech.model]);
        // Listed voices are suggestions: a gateway such as OpenRouter lists only part of what its providers speak.
        // A typed voice outside the list is proven by speaking one sentence with it; only the endpoint can refuse it.
        if (selected.voice && speech.voices.length && !speech.voices.includes(selected.voice)) {
          // Imported here: the speech provider itself imports this module.
          const { speak } = await import("./providers/tts.js");
          const spoken = await speak({ text: "Telomi voice check.", format: "mp3", signal: AbortSignal.timeout(60_000), audio: selected });
          if (!spoken.ok) throw new Error(`Unsupported voice for selected audio model: ${spoken.reason}`);
          await rm(spoken.outPath, { force: true }).catch(() => undefined);
        }
        if ((await audioServiceHealth(selected.baseUrl, key)).capabilities.includes("warmup")) {
          phase = "applying";
          const warmed = await fetch(`${selected.baseUrl}/audio/warmup`, { method: "POST", redirect: "error", signal: AbortSignal.timeout(45_000), headers: { "Content-Type": "application/json", ...(key ? { Authorization: `Bearer ${key}` } : {}) }, body: JSON.stringify({ capability: "tts", model: speech.model }) });
          if (!warmed.ok) throw new Error(`TTS model could not be prepared (HTTP ${warmed.status}${await warmupDetail(warmed)})`);
        }
      }
      validating = undefined;
      phase = "applying";
      const current = loadSettings();
      if (!isDeepStrictEqual(current.audioGeneration, before.audioGeneration) || !isDeepStrictEqual(loadCustomProviders(), catalog) || !isDeepStrictEqual(readStoredCredentials(resolveAgentPath("auth.json")), credentials)) throw new Error("Configuration changed during validation");
      current.audioGeneration = parsed;
      if (isDeepStrictEqual(current.pendingAudioGeneration, before.pendingAudioGeneration) && isDeepStrictEqual(current.pendingAudioGeneration, parsed)) delete current.pendingAudioGeneration;
      saveSettings(current); phase = "active";
      res.json(response());
    } catch (error) {
      phase = "failed";
      // Known validation, runtime-startup and preparation reasons are specific by construction; anything else stays generic.
      const detail = error instanceof Error && ["Unsupported voice for selected audio model", "Unsupported speed for selected audio model", "Connection must declare audio generation capability for this model", "Audio model unavailable on selected connection", "Audio connection validation failed", "TTS model could not be prepared", "local audio runtime"].some(prefix => error.message.startsWith(prefix)) ? `${error.message.slice(0, 600)}. ` : "";
      const consumer = validating ? `${validating}: ` : "";
      failure = `${consumer}${detail}Audio validation or service update failed; previous configuration remains active`;
      // The rejected draft is kept for the page to show and retry; the active configuration is untouched.
      try {
        const settings = loadSettings();
        if (draft && isDeepStrictEqual(settings.pendingAudioGeneration, staged)) { settings.pendingAudioGeneration = draft; saveSettings(settings); }
      } catch { /* The answer below still reports the failure. */ }
      res.status(422).json({ ...response(), error: failure });
    }
  });
}
