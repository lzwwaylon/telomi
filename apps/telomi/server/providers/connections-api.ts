import { readFileSync } from "node:fs";
import type { Express } from "express";
import { getBuiltinProviders, getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import { catalogRuntime } from "./config-api.js";
import { isManagedAudioConnection, type ConnectionCapability, type ConnectionModel, type ConnectionModels, type ConnectionSummary, type ConnectionUsage, type ConnectionsResponse } from "../../shared/connections.js";
import { capabilitiesFor } from "../../shared/model-capabilities.js";
import { pinnedCapability } from "../../shared/types.js";
import { EMBEDDING_CONSUMERS, HINDSIGHT_LOCAL_CONNECTION } from "../../shared/embedding-configuration.js";
import { getRegistryEnvApiKey } from "../agent-runtime/pi-ai.js";
import { readStoredCredentials } from "../accounts/stored-credentials.js";
import { resolveAgentPath } from "../config/agent-directory.js";
import { isProviderCredentialDeleted } from "../config/credential-tombstones.js";
import { loadSettings, TASK_MODEL_ROLES } from "../config/settings.js";
import { testConfiguredModel } from "../agent-runtime/model-connectivity.js";
import { connectionEntry, resolveAudioGeneration } from "../audio/configuration.js";
import { resolveSelfHostedSttEndpoint } from "../audio/providers/self-hosted-stt.js";
import { speak } from "../audio/providers/tts.js";
import { transcribe } from "../audio/providers/stt.js";
import { embedTexts } from "../embedding/client.js";
import { DEFAULT_MEMORY_LOCAL_MODEL, embeddingApiKey, embeddingEndpointFor, resolveEmbedding } from "../embedding/configuration.js";
import { resolveSpeechConfiguration } from "../voice/configuration.js";
import { anonymousConnectionKeyFor, loadCustomProviders, type CustomProvider } from "./custom-models.js";
import { builtinConnectionEntry, refreshBuiltinConnectionModels, servesEveryCapability } from "./builtin-connections.js";

const ALL: ConnectionCapability[] = ["chat", "embedding", "tts", "stt"];

function emptyModels(): ConnectionModels { return { chat: [], embedding: [], tts: [], stt: [] }; }

/**
 * Discovered models grouped by what they serve. A pinned connection lists only its capability's
 * models; a hand-added id without a classification counts as one of them.
 */
function customModels(id: string, entry: CustomProvider): ConnectionModels {
	const out = emptyModels();
	// The managed local runtime serves both audio capabilities, so a pin on its entry never hides
	// the models of the other one; each model is listed where it belongs.
	const managed = isManagedAudioConnection(id);
	const pinned = managed ? undefined : pinnedCapability(entry.capability);
	for (const model of entry.models) {
		const item: ConnectionModel = { id: model.id, ...(model.name ? { name: model.name } : {}), ...(model.supportedVoices ? { supportedVoices: model.supportedVoices } : {}) };
		// A stale id the managed runtime once stored (its aligner) serves no LLM role there.
		const served = capabilitiesFor(model).filter((capability) => !managed || capability === "tts" || capability === "stt");
		if (pinned) { if (!model.capabilities || served.includes(pinned)) out[pinned].push(item); }
		else for (const capability of served) out[capability].push(item);
	}
	return out;
}

/** What a connection can serve: its manual pin, else every capability its models cover, else everything until discovery says otherwise. */
function customCapabilities(id: string, entry: CustomProvider, models: ConnectionModels): ConnectionCapability[] {
	// The managed local runtime always serves both audio capabilities, whatever its saved model list says.
	if (isManagedAudioConnection(id)) return ["tts", "stt"];
	const pinned = pinnedCapability(entry.capability);
	if (pinned) return [pinned];
	const covered = ALL.filter((capability) => models[capability].length > 0);
	return covered.length ? covered : ALL;
}

/** Every active selection across capabilities; the reverse index the connection list shows as "used by". */
export function listSelections(settings = loadSettings()): ConnectionUsage[] {
	const out: ConnectionUsage[] = [];
	const chat = (consumer: string, model: string | undefined) => {
		const slash = model?.indexOf("/") ?? -1;
		if (model && slash > 0) out.push({ capability: "chat", consumer, connection: model.slice(0, slash), model: model.slice(slash + 1) });
	};
	chat("default", settings.defaultProvider && settings.defaultModel ? `${settings.defaultProvider}/${settings.defaultModel}` : undefined);
	for (const role of TASK_MODEL_ROLES) chat(role, settings.taskModels?.[role]);
	for (const id of EMBEDDING_CONSUMERS) {
		const selected = resolveEmbedding(id);
		if (selected) out.push({ capability: "embedding", consumer: id, connection: selected.connection, model: selected.model });
	}
	for (const id of ["playback", "local", "podcast"] as const) {
		const selected = resolveAudioGeneration(id);
		if (selected) out.push({ capability: "tts", consumer: id, connection: selected.connection, model: selected.model });
	}
	const speech = resolveSpeechConfiguration(settings);
	for (const id of ["recognition", "local"] as const) {
		const selected = speech[id];
		if (selected) out.push({ capability: "stt", consumer: id, connection: selected.connection, model: selected.model });
	}
	return out;
}

export async function listConnections(): Promise<ConnectionsResponse> {
	// Built-in providers list pi.dev's catalog on top of the static table, the same listing the
	// provider configuration shows; without it a model shipped after this package was built is absent.
	const catalog = await catalogRuntime().catch(() => undefined);
	const auth = readStoredCredentials(resolveAgentPath("auth.json"));
	const pending = readStoredCredentials(resolveAgentPath("auth-pending.json"));
	const custom = loadCustomProviders().providers ?? {};
	const selections = listSelections();
	const usedBy = (id: string) => selections.filter((item) => item.connection === id);
	const hint = (key: unknown) => typeof key === "string" && key.length >= 8 ? `${key.slice(0, 4)}…${key.slice(-4)}` : null;
	const connections: ConnectionSummary[] = [];
	const builtin = new Set<string>(getBuiltinProviders());
	const registryChat = (id: string): ConnectionModel[] => {
		if (!builtin.has(id)) return [];
		try { return (catalog?.getModels(id as Parameters<typeof getBuiltinModels>[0]) ?? getBuiltinModels(id as Parameters<typeof getBuiltinModels>[0])).map((m) => ({ id: m.id, name: m.name })); } catch { return []; }
	};
	await Promise.all(getBuiltinProviders().map((id) => refreshBuiltinConnectionModels(id, auth)));
	for (const id of getBuiltinProviders()) {
		if (custom[id]) continue;
		const entry = auth[id];
		let envSet = false;
		try { envSet = Boolean(getRegistryEnvApiKey(id as Parameters<typeof getRegistryEnvApiKey>[0])); } catch { /* no env resolver */ }
		const deleted = isProviderCredentialDeleted(id);
		const stored = !deleted && entry ? entry.type === "oauth" ? "oauth" : "api_key" : null;
		const auth_ = stored ?? (envSet ? "env" : null);
		const capabilities: ConnectionCapability[] = ["chat"];
		let models = { ...emptyModels(), chat: registryChat(id) };
		// One key serves every capability; each page lists what discovery found, or takes a typed model until it has.
		if (servesEveryCapability(id, auth)) {
			models = { ...customModels(id, builtinConnectionEntry(id, auth)!), chat: models.chat };
			const listed = ALL.filter((capability) => capability !== "chat" && models[capability].length > 0);
			capabilities.push(...(listed.length ? listed : ALL.filter((capability) => capability !== "chat")));
		}
		connections.push({ id, kind: "cloud", status: auth_ ? "connected" : pending[id] ? "pending" : "unconfigured", auth: auth_,
			keyHint: stored === "api_key" && entry?.type === "api_key" ? hint(entry.key) : null, capabilities, models, usedBy: usedBy(id) });
	}
	for (const [id, entry] of Object.entries(custom)) {
		const deleted = isProviderCredentialDeleted(id);
		const stored = !deleted && auth[id]?.type === "api_key" ? auth[id] : undefined;
		const key = stored?.type === "api_key" ? stored.key : entry.apiKey;
		const anonymous = !stored && !deleted && Boolean(anonymousConnectionKeyFor(entry));
		const models = customModels(id, entry);
		// A custom definition of a builtin Provider chats with what its own discovery listed, which is scoped
		// to the account; the registry's catalog only fills in while nothing has been discovered yet.
		if (models.chat.length === 0 && !entry.capability) models.chat = registryChat(id);
		connections.push({ id, kind: "custom", status: key || anonymous ? "connected" : "unconfigured",
			auth: key ? "api_key" : anonymous ? "anonymous" : null, keyHint: hint(key), capabilities: customCapabilities(id, entry, models), models, usedBy: usedBy(id) });
	}
	connections.push({ id: HINDSIGHT_LOCAL_CONNECTION, kind: "custom", status: "connected", auth: null, keyHint: null, capabilities: ["embedding"],
		models: { ...emptyModels(), embedding: [{ id: DEFAULT_MEMORY_LOCAL_MODEL }] }, usedBy: usedBy(HINDSIGHT_LOCAL_CONNECTION) });
	return { connections, selections };
}

export interface ConnectionProbe { connection: string; capability: ConnectionCapability; model: string; voice?: string }
export type ConnectionProbeResult = { ok: true; durationMs: number; detail: string } | { ok: false; durationMs: number; error: string };

const PROBE_TEXT = "Telomi connection check.";
const PROBE_TIMEOUT_MS = 60_000;
let probeAudio: Buffer | undefined;
/** Three seconds of read English speech; a recognizer that answers with words is reachable and authorized. */
function probeSpeech(): Buffer { return probeAudio ??= readFileSync(new URL("../audio/fixtures/stt-probe.wav", import.meta.url)); }

function parseProbe(value: unknown): ConnectionProbe {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("body must be an object");
	const body = value as Record<string, unknown>;
	if (!ALL.includes(body.capability as ConnectionCapability)) throw new Error("capability must be chat, embedding, tts or stt");
	if (typeof body.model !== "string" || !body.model.trim() || body.model.length > 300) throw new Error("model is required");
	const probe: ConnectionProbe = { connection: "", capability: body.capability as ConnectionCapability, model: body.model.trim() };
	if (body.voice != null) { if (typeof body.voice !== "string" || body.voice.length > 100) throw new Error("voice must be a short string"); probe.voice = body.voice.trim(); }
	return probe;
}

/**
 * Exercise one capability of a connection the way its consumer will: a few chat tokens, one
 * embedding vector, one short utterance, or one three second transcription. The result is what
 * the settings page shows next to the model the user picked.
 */
export async function testConnectionCapability(probe: ConnectionProbe): Promise<ConnectionProbeResult> {
	const start = Date.now();
	const fail = (error: string): ConnectionProbeResult => ({ ok: false, durationMs: Date.now() - start, error });
	const pass = (detail: string): ConnectionProbeResult => ({ ok: true, durationMs: Date.now() - start, detail });
	const signal = AbortSignal.timeout(PROBE_TIMEOUT_MS);
	try {
		switch (probe.capability) {
			case "chat": {
				const result = await testConfiguredModel(probe.connection, probe.model, { authPath: resolveAgentPath("auth.json"), modelsPath: resolveAgentPath("models.json") }, { timeoutMs: PROBE_TIMEOUT_MS });
				return result.ok ? pass(probe.model) : fail(result.error ?? "the connection test failed");
			}
			case "embedding": {
				if (probe.connection === HINDSIGHT_LOCAL_CONNECTION) return fail("the User Memory local model runs inside Hindsight and has no endpoint to probe");
				const baseUrl = embeddingEndpointFor(probe.connection);
				if (!baseUrl) return fail(`embedding connection '${probe.connection}' is unknown`);
				const apiKey = await embeddingApiKey(probe.connection);
				const [vector] = await embedTexts({ baseUrl, apiKey, connection: probe.connection, model: probe.model }, [PROBE_TEXT], "search_query", signal);
				return pass(`${vector!.length} dimensions`);
			}
			case "tts": {
				const entry = connectionEntry(probe.connection);
				if (!entry) return fail(`audio connection '${probe.connection}' is unknown`);
				const baseUrl = new URL(entry.baseUrl).toString().replace(/\/+$/, "");
				// The format playback asks for; gateways accept fewer formats than a local server does.
				const result = await speak({ text: PROBE_TEXT, format: "mp3", signal, audio: { connection: probe.connection, model: probe.model, voice: probe.voice ?? "", rate: 1, baseUrl } });
				if (!result.ok) return fail(result.reason);
				await import("node:fs/promises").then((fs) => fs.rm(result.outPath, { force: true })).catch(() => undefined);
				return pass([result.voice, `${Math.max(1, Math.round(result.bytes / 1024))} KB mp3`].filter(Boolean).join(" · "));
			}
			case "stt": {
				const entry = connectionEntry(probe.connection);
				if (!entry) return fail(`audio connection '${probe.connection}' is unknown`);
				const endpoint = resolveSelfHostedSttEndpoint(entry.baseUrl);
				if (!endpoint.ok) return fail(endpoint.error);
				const result = await transcribe({ selection: { connection: probe.connection, model: probe.model, baseUrl: endpoint.baseUrl }, buffer: probeSpeech(), filename: "stt-probe.wav", mime: "audio/wav", language: "en", responseFormat: "json", signal });
				if (!result.ok) return fail(result.reason);
				return result.text.trim() ? pass(result.text.trim()) : fail("the recognizer returned no text for a spoken sample");
			}
		}
	} catch (error) {
		return fail(error instanceof Error ? error.message : String(error));
	}
}

export function mountConnectionsApi(app: Express): void {
	app.get("/api/connections", async (_req, res) => {
		try { res.json(await listConnections()); } catch (error) { res.status(500).json({ error: error instanceof Error ? error.message : String(error) }); }
	});
	app.post("/api/connections/:id/test", async (req, res) => {
		const id = typeof req.params.id === "string" ? req.params.id : "";
		let probe: ConnectionProbe;
		try {
			if (!/^[a-zA-Z0-9_.-]{1,64}$/.test(id)) throw new Error("invalid connection id");
			probe = { ...parseProbe(req.body), connection: id };
		} catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : String(error) }); return; }
		const result = await testConnectionCapability(probe);
		res.status(result.ok ? 200 : 502).json(result);
	});
}
