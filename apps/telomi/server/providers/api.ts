import { validateAudioGenerationConnection } from "../audio/configuration.js";
import { capabilitiesFor } from "../../shared/model-capabilities.js";
import { validateSpeechConnection } from "../voice/configuration.js";
import { pinnedCapability } from "../../shared/types.js";
import { testConnectionCapability } from "./connections-api.js";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";

import type { Express, Request, Response } from "express";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { InMemoryCredentialStore, type Credential } from "@earendil-works/pi-ai";
import { resolveAgentPath } from "../config/agent-directory.js";
import { loadSettings } from "../config/settings.js";
import { modifyStoredCredential, readStoredCredentials, writeStoredCredential } from "../accounts/stored-credentials.js";
import { clearProviderCredentialTombstone, isProviderCredentialDeleted, markProviderCredentialDeleted } from "../config/credential-tombstones.js";
import {
	CUSTOM_MODELS_PATH,
	PENDING_MODELS_PATH,
	anonymousConnectionKeyFor,
	definesConnection,
	discoverCustomProviderModels,
	loadCustomProviders,
	loadModelsFile,
	mergeCustomProvider,
	refreshCustomProviders,
	saveCustomProviders,
	writeCustomProvider,
	type CustomProvider as ProviderEntry,
	type CustomProviderApiKind as ApiKind,
	type CustomProviderModel as ProviderModelEntry,
	type CustomProvidersFile as ModelsFile,
} from "./custom-models.js";
import {
	testCandidateCredential,
	redactSecret,
	testConfiguredModel,
} from "../agent-runtime/model-connectivity.js";
import { cleanupProviderSettings } from "./settings-cleanup.js";
import { toErrorMessage } from "../lib/values.js";

const AUTH_PATH = resolveAgentPath("auth.json");

const VALID_APIS: ApiKind[] = ["openai-completions", "openai-responses"];

function maskedKey(value: unknown): string | null {
	if (typeof value !== "string" || value.length === 0) return null;
	if (value.length <= 8) return "•".repeat(Math.max(value.length, 4));
	return `${value.slice(0, 4)}…${value.slice(-4)}`;
}

function summarizeProvider(id: string, entry: ProviderEntry, pending = false) {
	const stored = readStoredCredentials(AUTH_PATH)[id];
	const storedKey = stored?.type === "api_key" ? stored.key : undefined;
	const key = pending ? entry.apiKey ?? storedKey : stored ? storedKey : entry.apiKey;
	return {
		id,
		baseUrl: entry.baseUrl,
		api: entry.api,
		...(entry.capability ? { capability: entry.capability } : {}),
		apiKeyHint: maskedKey(key),
		hasApiKey: Boolean(key),
		compat: entry.compat ?? null,
		models: Array.isArray(entry.models)
			? entry.models.map((m) => ({ id: m.id, name: typeof m.name === "string" ? m.name : undefined, capabilities: capabilitiesFor(m), ...(m.supportedVoices ? { supportedVoices: m.supportedVoices } : {}) }))
			: [],
	};
}

function buildProvidersList(file: ModelsFile, pending = false) {
	const providers = file.providers ?? {};
	return Object.entries(providers)
		.map(([id, entry]) => summarizeProvider(id, entry, pending))
		.sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Check a candidate connection definition against its own endpoint without touching the active
 * `models.json`. The candidate lives in a throwaway registry for the duration of the probe, so no
 * consumer can resolve it and a rejected definition changes nothing.
 */
async function validateCandidateConnection(
	id: string,
	entry: ProviderEntry,
	credential: Credential | undefined,
	requestedModelId?: string,
): Promise<{ ok: true; credential: Credential | undefined } | { ok: false; error: string }> {
	// Probe with a model this connection chats through: the one the user named, else one a role
	// already uses. Nobody picks a model for the user: without one, the listing is the check.
	const settings = loadSettings();
	const inUse = [settings.defaultProvider === id ? settings.defaultModel : undefined, ...Object.values(settings.taskModels ?? {}).map((m) => m?.startsWith(`${id}/`) ? m.slice(id.length + 1) : undefined)]
		.find((m): m is string => Boolean(m) && entry.models.some((model) => model.id === m));
	// A pinned connection never chats; its listing is the check, the way audio pins are checked.
	const modelId = entry.capability ? undefined : requestedModelId?.trim() || inUse;
	if (entry.capability === "audio-generation") {
		try {
			if (credential && credential.type !== "api_key") return { ok: false, error: "Audio connections require API key authentication" };
			const key = credential?.key ?? entry.apiKey;
			if (!key && entry.authHeader) return { ok: false, error: "Audio connection requires an API key" };
			await validateAudioGenerationConnection(entry.baseUrl, key, entry.models.map(model => model.id));
			return { ok: true, credential };
		} catch { return { ok: false, error: "Audio connection validation failed; previous connection remains active" }; }
	}
	if (entry.capability === "audio-recognition") {
		try {
			if (credential && credential.type !== "api_key") return { ok: false, error: "Speech connections require API key authentication" };
			await validateSpeechConnection(entry.baseUrl, credential?.key, entry.models.map(model => model.id));
			return { ok: true, credential };
		} catch { return { ok: false, error: "Speech connection validation failed; previous connection remains active" }; }
	}
	if (!entry.models.length) return { ok: false, error: "the connection declares no model to validate with" };
	if (!modelId) {
		// Nothing here chats (an embedding or speech listing without a pin): the listing itself is the check.
		try {
			const key = credential?.type === "api_key" ? credential.key : credential ? undefined : anonymousConnectionKeyFor(entry);
			const response = await fetch(`${entry.baseUrl.replace(/\/+$/, "")}/models`, { headers: key ? { Authorization: `Bearer ${key}` } : {}, redirect: "error", signal: AbortSignal.timeout(45_000) });
			if (!response.ok) return { ok: false, error: `the endpoint rejected the credential (HTTP ${response.status})` };
			return { ok: true, credential };
		} catch (error) { return { ok: false, error: toErrorMessage(error) }; }
	}
	// The candidate carries a credential, so it stays inside the Agent directory's private tree
	// rather than a world-readable temporary directory.
	const directory = mkdtempSync(join(dirname(CUSTOM_MODELS_PATH), "connection-candidate-"));
	const candidatePath = join(directory, "models.json");
	try {
		saveCustomProviders({ providers: { [id]: entry } }, candidatePath);
		const credentials = new InMemoryCredentialStore();
		if (credential) await credentials.modify(id, async () => structuredClone(credential));
		const runtime = await ModelRuntime.create({ credentials, modelsPath: candidatePath });
		if (runtime.getError()) return { ok: false, error: "the connection definition is invalid" };
		const model = runtime.getModel(id, modelId);
		if (!model) return { ok: false, error: `model '${id}/${modelId}' is not available` };
		// A local endpoint legitimately declares no credential; one that does need an
		// authorization header cannot be validated, or used, without one.
		const authorization = await runtime.getAuth(model);
		// This is an explicit replacement candidate. Serving keeps respecting a deletion until
		// validation and the activation CAS succeed, including when recreating a local connection.
		const anonymous = !credential ? anonymousConnectionKeyFor(entry) : undefined;
		if (!authorization && !anonymous) {
			return { ok: false, error: `connection '${id}' needs a credential` };
		}
		// The probe authenticates the way the serving path will, so a check that passes describes
		// a connection that actually runs.
		const result = await testCandidateCredential(model, authorization
			? { apiKey: authorization.auth.apiKey, headers: authorization.auth.headers as Record<string, string> | undefined }
			: { apiKey: anonymous });
		return result.ok ? { ok: true, credential: await credentials.read(id) } : { ok: false, error: result.error ?? "the connection test failed" };
	} catch (error) {
		const secrets = credential?.type === "oauth" ? [credential.access, credential.refresh] : [credential?.key ?? ""];
		return { ok: false, error: secrets.reduce((message, secret) => redactSecret(message, secret), toErrorMessage(error)) };
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}

function isValidApi(value: unknown): value is ApiKind {
	return typeof value === "string" && (VALID_APIS as readonly string[]).includes(value);
}

function isValidProviderId(value: unknown): value is string {
	return typeof value === "string" && /^[a-zA-Z0-9._-]{1,64}$/.test(value);
}

function normalizeBaseUrl(input: unknown): string | null {
	if (typeof input !== "string") return null;
	const trimmed = input.trim().replace(/\/$/, "");
	if (!trimmed) return null;
	try {
		const url = new URL(trimmed);
		if (url.protocol !== "http:" && url.protocol !== "https:") return null;
		return trimmed;
	} catch {
		return null;
	}
}

function normalizeProviderEntry(body: unknown): { ok: true; entry: ProviderEntry } | { ok: false; error: string } {
	if (!body || typeof body !== "object" || Array.isArray(body)) {
		return { ok: false, error: "body must be an object" };
	}
	const b = body as Record<string, unknown>;
	const baseUrl = normalizeBaseUrl(b.baseUrl);
	if (!baseUrl) return { ok: false, error: "baseUrl must be a valid http(s) URL" };
	if (!isValidApi(b.api)) return { ok: false, error: `api must be one of ${VALID_APIS.join(", ")}` };
	// Each save states whether its model list is a ticked selection, so a form that lists every
	// discovered model clears the mark a selecting form left.
	const entry: ProviderEntry = { baseUrl, api: b.api, models: [], capability: undefined, userSelectedModels: b.userSelectedModels === true || undefined };
	if (b.capability !== undefined && b.capability !== "audio-generation" && b.capability !== "audio-recognition" && b.capability !== "embedding") return { ok: false, error: "unsupported connection capability" };
	if (b.capability) entry.capability = b.capability;

	if (b.apiKey !== undefined && b.apiKey !== null && b.apiKey !== "") {
		if (typeof b.apiKey !== "string") return { ok: false, error: "apiKey must be a string" };
		entry.apiKey = b.apiKey;
	}

	if (b.compat !== undefined && b.compat !== null) {
		if (typeof b.compat !== "object" || Array.isArray(b.compat)) {
			return { ok: false, error: "compat must be an object" };
		}
		entry.compat = b.compat as ProviderEntry["compat"];
	}

	if (b.models !== undefined) {
		if (!Array.isArray(b.models)) return { ok: false, error: "models must be an array" };
		const seen = new Set<string>();
		const models: ProviderModelEntry[] = [];
		for (const m of b.models as unknown[]) {
			if (!m || typeof m !== "object" || Array.isArray(m)) {
				return { ok: false, error: "each model must be an object with id" };
			}
			const obj = m as Record<string, unknown>;
			const id = typeof obj.id === "string" ? obj.id.trim() : "";
			if (!id) return { ok: false, error: "each model requires non-empty id" };
			if (seen.has(id)) continue;
			seen.add(id);
			const result: ProviderModelEntry = { id };
			if (typeof obj.name === "string" && obj.name) result.name = obj.name;
			result.capabilities = capabilitiesFor({ id, capabilities: obj.capabilities });
			const voices = Array.isArray(obj.supportedVoices) ? obj.supportedVoices.filter((v): v is string => typeof v === "string" && v.trim().length > 0) : [];
			if (voices.length) result.supportedVoices = voices;
			models.push(result);
		}
		entry.models = models;
	}

	return { ok: true, entry };
}

async function testWithModel(provider: string, modelId: string): Promise<{ ok: boolean; error?: string; durationMs: number }> {
	// A pinned connection is checked the way its capability runs: one embedding, one utterance, one transcript.
	const pinned = pinnedCapability(loadCustomProviders().providers?.[provider]?.capability);
	if (pinned) {
		const result = await testConnectionCapability({ capability: pinned, connection: provider, model: modelId });
		return result.ok ? { ok: true, durationMs: result.durationMs } : { ok: false, error: result.error, durationMs: result.durationMs };
	}
	return testConfiguredModel(provider, modelId, { authPath: AUTH_PATH, modelsPath: CUSTOM_MODELS_PATH });
}

export function mountCustomProvidersApi(app: Express): void {
	app.get("/api/custom-providers", (_req: Request, res: Response) => {
		try {
			res.json({
				providers: buildProvidersList(loadCustomProviders()),
				pending: buildProvidersList(loadCustomProviders(PENDING_MODELS_PATH), true),
			});
		} catch (err) {
			res.status(500).json({ error: toErrorMessage(err) });
		}
	});

	app.put("/api/custom-providers/:id", async (req: Request, res: Response) => {
		const id = typeof req.params.id === "string" ? req.params.id : "";
		if (!isValidProviderId(id)) {
			res.status(400).json({ error: "invalid provider id (use letters, digits, dot, dash, underscore; max 64)" });
			return;
		}
		const body = (req.body || {}) as Record<string, unknown>;
		const mode = body.mode === "pending" ? "pending" : "apply";
		const definitionFields = ["baseUrl", "api", "models", "apiKey", "compat", "capability"];
		const hasDefinition = definitionFields.some((field) => field in body);
		try {
			const staged = loadCustomProviders(PENDING_MODELS_PATH).providers?.[id];
			const active = loadCustomProviders().providers?.[id];
			const beforeCredential = readStoredCredentials(AUTH_PATH)[id];
			const deletedBefore = isProviderCredentialDeleted(id);
			// Both actions edit the same connection, so both start from what it is today plus
			// anything already prepared for it. A form that cannot show the stored key must not
			// drop it just because the user prepared the edit first.
			const effectiveActive = active && beforeCredential
				? { ...active, apiKey: beforeCredential.type === "api_key" ? beforeCredential.key : undefined } : active;
			const base = staged ? mergeCustomProvider(effectiveActive, staged) : effectiveActive;
			if (mode === "pending") {
				const normalized = normalizeProviderEntry(req.body);
				if (!normalized.ok) {
					res.status(400).json({ error: normalized.error });
					return;
				}
				// Save for later: prepared, and invisible to every consumer until it is applied.
				const prepared = mergeCustomProvider(base, normalized.entry);
				writeCustomProvider(id, prepared, PENDING_MODELS_PATH);
				res.json({ ok: true, provider: summarizeProvider(id, prepared, true), pending: true });
				return;
			}
			let candidate: ProviderEntry;
			if (hasDefinition) {
				const normalized = normalizeProviderEntry(req.body);
				if (!normalized.ok) {
					res.status(400).json({ error: normalized.error });
					return;
				}
				candidate = mergeCustomProvider(base, normalized.entry);
			} else if (staged) {
				candidate = structuredClone(staged);
			} else {
				res.status(400).json({ error: "no prepared connection to apply" });
				return;
			}
			const modelId = typeof body.modelId === "string" ? body.modelId : undefined;
			// Active secrets have one native authority. The definition carries only connection data.
			const credential = candidate.apiKey ? { type: "api_key" as const, key: candidate.apiKey } : beforeCredential;
			delete candidate.apiKey;
			const validation = await validateCandidateConnection(id, candidate, credential, modelId);
			if (!validation.ok) {
				// Nothing was published, so the connection in use is exactly what it was.
				res.status(422).json({ error: validation.error });
				return;
			}
			// Activate exactly the definition the endpoint accepted; merging again here could
			// reintroduce a key or a model the check never saw.
			const file = loadModelsFile();
			const providers = file.providers ?? {};
			const current = definesConnection(id, providers[id]) ? providers[id] : undefined;
			if (!isDeepStrictEqual(current, active) || isProviderCredentialDeleted(id) !== deletedBefore) {
				res.status(409).json({ error: `connection '${id}' changed while its replacement was validated` });
				return;
			}
			const previousFile = structuredClone(file);
			let published = false;
			let replaced: boolean;
			try {
				replaced = modifyStoredCredential(AUTH_PATH, id, (current) => {
					if (!isDeepStrictEqual(current, beforeCredential)) return undefined;
					providers[id] = candidate;
					file.providers = providers;
					saveCustomProviders(file);
					published = true;
					return validation.credential ?? null;
				});
			} catch (error) {
				if (published) saveCustomProviders(previousFile);
				throw error;
			}
			if (!replaced) {
				res.status(409).json({ error: `credential '${id}' changed while the connection was validated` });
				return;
			}
			clearProviderCredentialTombstone(id);
			// Drop only the prepared definition this request consumed.
			if (staged && isDeepStrictEqual(loadCustomProviders(PENDING_MODELS_PATH).providers?.[id], staged)) {
				writeCustomProvider(id, null, PENDING_MODELS_PATH);
			}
			const refresh = await refreshCustomProviders();
			res.json({ ok: true, provider: summarizeProvider(id, providers[id]), refresh });
		} catch (err) {
			res.status(500).json({ error: toErrorMessage(err) });
		}
	});

	app.delete("/api/custom-providers/:id", async (req: Request, res: Response) => {
		const id = typeof req.params.id === "string" ? req.params.id : "";
		if (!id) {
			res.status(400).json({ error: "id is required" });
			return;
		}
		try {
			const file = loadModelsFile();
			if (file.providers && definesConnection(id, file.providers[id])) {
				delete file.providers[id];
				if (Object.keys(file.providers).length === 0) delete file.providers;
				saveCustomProviders(file);
			}
			writeCustomProvider(id, null, PENDING_MODELS_PATH);
			writeStoredCredential(AUTH_PATH, id, null);
			writeStoredCredential(resolveAgentPath("auth-pending.json"), id, null);
			markProviderCredentialDeleted(id);
			const cleanup = cleanupProviderSettings(id);
			const refresh = await refreshCustomProviders();
			res.json({ ok: true, refresh, cleanup });
		} catch (err) {
			res.status(500).json({ error: toErrorMessage(err) });
		}
	});

	/** Discard a prepared definition. The connection in use is untouched. */
	app.delete("/api/custom-providers/:id/pending", (req: Request, res: Response) => {
		const id = typeof req.params.id === "string" ? req.params.id : "";
		if (!id) {
			res.status(400).json({ error: "id is required" });
			return;
		}
		try {
			writeCustomProvider(id, null, PENDING_MODELS_PATH);
			res.json({ ok: true });
		} catch (err) {
			res.status(500).json({ error: toErrorMessage(err) });
		}
	});

	app.post("/api/custom-providers/discover", async (req: Request, res: Response) => {
		const body = (req.body || {}) as { baseUrl?: unknown; apiKey?: unknown; id?: unknown; capability?: unknown };
		const capability = body.capability === "audio-generation" || body.capability === "audio-recognition" || body.capability === "embedding" ? body.capability : undefined;
		const baseUrl = normalizeBaseUrl(body.baseUrl);
		if (!baseUrl) {
			res.status(400).json({ error: "baseUrl must be a valid http(s) URL" });
			return;
		}
		// Editing an existing connection cannot show its stored key; discovery still authenticates with it.
		const id = typeof body.id === "string" && isValidProviderId(body.id) ? body.id : undefined;
		const stored = id ? readStoredCredentials(AUTH_PATH)[id] : undefined;
		const entry = id ? loadCustomProviders().providers?.[id] : undefined;
		const apiKey = typeof body.apiKey === "string" && body.apiKey ? body.apiKey
			: id && !isProviderCredentialDeleted(id) && entry?.baseUrl === baseUrl ? stored?.type === "api_key" ? stored.key : entry?.apiKey : undefined;
		try {
			const models = await discoverCustomProviderModels({ baseUrl, apiKey, capability });
			res.json({ models });
		} catch (err) {
			res.status(502).json({ error: toErrorMessage(err) });
		}
	});

	app.post("/api/custom-providers/:id/test", async (req: Request, res: Response) => {
		const id = typeof req.params.id === "string" ? req.params.id : "";
		if (!id) {
			res.status(400).json({ error: "id is required" });
			return;
		}
		const body = (req.body || {}) as { modelId?: unknown };
		const modelId = typeof body.modelId === "string" ? body.modelId : "";
		if (!modelId) {
			res.status(400).json({ error: "modelId is required" });
			return;
		}
		const result = await testWithModel(id, modelId);
		res.status(result.ok ? 200 : 502).json(result);
	});

	app.post("/api/custom-providers/refresh", async (_req: Request, res: Response) => {
		const refresh = await refreshCustomProviders();
		res.status(refresh.ok ? 200 : 500).json(refresh);
	});
}
