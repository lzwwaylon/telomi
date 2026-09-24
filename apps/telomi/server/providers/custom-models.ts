import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { getBuiltinProviders } from "@earendil-works/pi-ai/providers/all";
import type { ConnectionCapability } from "../../shared/connections.js";
import { pinnedCapability, type CustomProviderApiKind, type CustomProviderCapability, type CustomProviderModel } from "../../shared/types.js";
import { classifyModel } from "../../shared/model-capabilities.js";
import { writeFileAtomic } from "../lib/fs.js";
import { resolveAgentPath } from "../config/agent-directory.js";
import { isProviderCredentialDeleted } from "../config/credential-tombstones.js";
import { readStoredCredentials } from "../accounts/stored-credentials.js";
import { toErrorMessage } from "../lib/values.js";

export type { CustomProviderApiKind, CustomProviderCapability, CustomProviderModel } from "../../shared/types.js";

export const CUSTOM_MODELS_PATH = resolveAgentPath("models.json");
/**
 * Connection definitions saved for later. No consumer reads this file, so preparing a connection
 * cannot change the models or endpoints running work resolves.
 */
export const PENDING_MODELS_PATH = resolveAgentPath("models-pending.json");
const AUTH_PATH = resolveAgentPath("auth.json");

export interface CustomProvider {
	capability?: CustomProviderCapability;
	baseUrl: string;
	api: CustomProviderApiKind;
	apiKey?: string;
	/**
	 * From a hand-authored `models.json`: the connection requires an authorization header. The
	 * settings entry never writes it, and a connection that declares it is not anonymous.
	 */
	authHeader?: boolean;
	compat?: {
		supportsDeveloperRole?: boolean;
		supportsReasoningEffort?: boolean;
		/** How this endpoint takes audio for transcription. Absent: OpenAI-compatible multipart. */
		transcription?: "json" | "multipart";
		[k: string]: unknown;
	};
	models: CustomProviderModel[];
	/**
	 * The model list is the subset the user ticked, as the Ollama form saves it. Discovery still
	 * refreshes what it says about those models but never adds the endpoint's other models.
	 * Absent: the list mirrors the endpoint's listing, and new models there are added.
	 */
	userSelectedModels?: boolean;
	[k: string]: unknown;
}

export interface CustomProvidersFile {
	providers?: Record<string, CustomProvider>;
	[k: string]: unknown;
}

/**
 * A fingerprint of the connection catalog on disk. It changes whenever a definition is activated,
 * including an edit that keeps the same Provider and model ids but points them somewhere else, so
 * a consumer holding a resolved model can tell that its catalog is stale.
 */
export function connectionCatalogRevision(path: string = CUSTOM_MODELS_PATH): string {
	try {
		const stats = statSync(path);
		// ponytail: file identity plus timestamp and size; a rewrite in the same millisecond that
		// keeps the byte count would look unchanged. Hash the contents if that ever matters.
		return `${stats.mtimeMs}:${stats.size}:${stats.ino}`;
	} catch {
		return "absent";
	}
}

/**
 * Whether a `models.json` entry defines a connection. pi also accepts an entry that only adjusts a
 * built-in Provider, such as a base URL without its own model list; that entry belongs to the
 * built-in and is not a connection. Any other entry with an endpoint is one, even before discovery
 * has listed its models.
 */
export function definesConnection(id: string, entry: unknown): entry is CustomProvider {
	const fields = entry && typeof entry === "object" ? entry as Record<string, unknown> : undefined;
	if (typeof fields?.baseUrl !== "string" || typeof fields.api !== "string") return false;
	return Array.isArray(fields.models) || !(getBuiltinProviders() as string[]).includes(id);
}

/** The connections a providers file defines. Writers use `loadModelsFile`, which keeps every other entry. */
export function loadCustomProviders(path: string = CUSTOM_MODELS_PATH): CustomProvidersFile {
	const file = loadModelsFile(path);
	if (!file.providers) return file;
	const connections = Object.entries(file.providers).filter(([id, entry]) => definesConnection(id, entry))
		.map(([id, entry]) => [id, Array.isArray(entry.models) ? entry : { ...entry, models: [] }]);
	return { ...file, providers: Object.fromEntries(connections) };
}

/** The providers file as written, including entries that only adjust built-in Providers. */
export function loadModelsFile(path: string = CUSTOM_MODELS_PATH): CustomProvidersFile {
	if (!existsSync(path)) return {};
	try {
		const raw = readFileSync(path, "utf-8");
		if (!raw.trim()) return {};
		const parsed = JSON.parse(raw) as unknown;
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
		return parsed as CustomProvidersFile;
	} catch (err) {
		throw new Error(`models.json is not valid JSON: ${toErrorMessage(err)}`);
	}
}

/** What pi's own OpenAI client sends when authorization is present but carries no key. */
const ANONYMOUS_CONNECTION_KEY = "unused";

/**
 * The client-side key a connection the user declared without a credential sends.
 *
 * A local service reached through a compatible endpoint legitimately checks nothing, but pi's
 * OpenAI client requires a key and rejects a request without one. The signal is the declaration
 * itself: a Provider whose credential is merely missing, because it was deleted or never
 * configured, is not anonymous and must keep failing as unconfigured.
 */
export function anonymousConnectionKeyFor(entry: CustomProvider | undefined): string | undefined {
	if (!entry?.baseUrl || !["openai-completions", "openai-responses"].includes(entry.api)
		|| entry.apiKey || entry.authHeader === true) return undefined;
	return ANONYMOUS_CONNECTION_KEY;
}

/**
 * The same rule for a Provider the caller knows only by id, plus the part only the Runtime can
 * answer: a Provider that has a managed credential, or one the user deleted, is not anonymous. Its
 * requests must keep failing as unconfigured instead of going out with a placeholder.
 */
export function anonymousConnectionApiKey(providerId: string): string | undefined {
	try {
		if (!anonymousConnectionKeyFor(loadCustomProviders().providers?.[providerId])) return undefined;
		if (isProviderCredentialDeleted(providerId)) return undefined;
		if (readStoredCredentials(AUTH_PATH)[providerId]) return undefined;
		return ANONYMOUS_CONNECTION_KEY;
	} catch {
		return undefined;
	}
}

const anonymousRegistrations = new WeakMap<ModelRuntime, string[]>();

/** Use native Provider auth for both AgentSession preflight and request resolution. */
export async function refreshConnectionRuntime(runtime: ModelRuntime): Promise<void> {
	for (const id of anonymousRegistrations.get(runtime) ?? []) runtime.unregisterProvider(id);
	await runtime.refresh({ allowNetwork: false });
	const registered: string[] = [];
	for (const [id, entry] of Object.entries(loadCustomProviders().providers ?? {})) {
		if (!anonymousConnectionKeyFor(entry)) continue;
		const provider = runtime.getProvider(id);
		if (!provider?.auth.apiKey) continue;
		const inherited = provider.auth.apiKey;
		runtime.registerNativeProvider({
			...provider,
			auth: {
				...provider.auth,
				apiKey: {
					...inherited,
					async check(input) {
						return await inherited.check?.(input) ?? (anonymousConnectionApiKey(id)
							? { type: "api_key", source: "declared anonymous connection" } : undefined);
					},
					async resolve(input) {
						const resolved = await inherited.resolve(input);
						if (resolved) return resolved;
						const apiKey = anonymousConnectionApiKey(id);
						return apiKey ? { auth: { apiKey }, source: "declared anonymous connection" } : undefined;
					},
				},
			},
		});
		registered.push(id);
	}
	anonymousRegistrations.set(runtime, registered);
}

export function saveCustomProviders(file: CustomProvidersFile, path: string = CUSTOM_MODELS_PATH): void {
	const dir = dirname(path);
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
	writeFileAtomic(path, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
}

/** Replace or remove one connection definition in a providers file. */
export function writeCustomProvider(
	id: string,
	entry: CustomProvider | null,
	path: string = CUSTOM_MODELS_PATH,
): void {
	const file = loadModelsFile(path);
	const providers = file.providers ?? {};
	if (entry) providers[id] = entry;
	else delete providers[id];
	if (Object.keys(providers).length === 0) delete file.providers;
	else file.providers = providers;
	saveCustomProviders(file, path);
}

export async function refreshCustomProviders(): Promise<{ ok: boolean; error?: string }> {
	try {
		const runtime = await ModelRuntime.create({
			authPath: AUTH_PATH,
			modelsPath: CUSTOM_MODELS_PATH,
			refreshOnCreate: false,
		});
		const error = runtime.getError();
		return error ? { ok: false, error } : { ok: true };
	} catch (err) {
		return { ok: false, error: toErrorMessage(err) };
	}
}

/**
 * The listings one connection may publish. `/models` is the OpenAI contract; the others are how
 * OpenRouter exposes its speech, transcription and embedding catalogs. Servers that ignore the
 * query return the same list, which deduplicates; a missing path is skipped.
 */
const MODEL_LISTINGS = ["models", "models?output_modalities=speech", "models?output_modalities=transcription", "embeddings/models"] as const;

/** Statuses that mean the endpoint publishes no such listing; any other failure names a real problem. */
const NO_LISTING = new Set([404, 405, 501]);

/**
 * One listing an endpoint may or may not publish. A listing that is simply absent leaves the user
 * typing the model and voice the server does serve; a rejected credential, a failing server and an
 * address nothing answers stay errors, because each names something the user has to fix.
 */
async function listJson(url: string, headers: Record<string, string>): Promise<unknown> {
	const response = await fetch(url, { method: "GET", headers, signal: AbortSignal.timeout(30_000) });
	if (NO_LISTING.has(response.status)) return undefined;
	if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText} from ${url}`);
	try { return (await response.json()) as unknown; } catch { return undefined; }
}

function field(body: unknown, name: string): unknown {
	return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>)[name] : undefined;
}

async function listModels(url: string, headers: Record<string, string>): Promise<unknown[]> {
	const data = field(await listJson(url, headers), "data");
	return Array.isArray(data) ? data : [];
}

/**
 * The voices the whole endpoint speaks, in the Open WebUI `/v1/audio/voices` convention: one list
 * for the endpoint rather than one per model. Servers answer either the named list or a bare array.
 */
async function listVoices(url: string, headers: Record<string, string>): Promise<string[]> {
	const body = await listJson(url, headers);
	const voices = Array.isArray(body) ? body : field(body, "voices");
	if (!Array.isArray(voices)) return [];
	return voices.map((voice) => typeof voice === "string" ? voice
		: typeof field(voice, "id") === "string" ? field(voice, "id") as string
		: "").filter((voice) => voice.trim().length > 0);
}

/**
 * List an endpoint's models and classify each by capability, so every settings page can offer its
 * share. A pinned connection keeps only the models its capability can use.
 */
export async function discoverCustomProviderModels(input: {
	baseUrl: string;
	apiKey?: string;
	capability?: CustomProviderCapability;
}): Promise<CustomProviderModel[]> {
	const only: ConnectionCapability | undefined = pinnedCapability(input.capability);
	const headers: Record<string, string> = { "Content-Type": "application/json" };
	if (input.apiKey) headers.Authorization = `Bearer ${input.apiKey}`;
	const root = input.baseUrl.replace(/\/+$/, "");
	const base = root.endsWith("/v1") ? root : `${root}/v1`;
	// OpenRouter's /models/user lists what this key can route to, with the account's own pricing
	// and limits; anything else answers 401 or 404 and the plain catalog is the listing.
	const [primary, ...extra] = await Promise.all(MODEL_LISTINGS.map((listing, index) =>
		index === 0
			? (input.apiKey ? listModels(`${base}/models/user`, headers).catch(() => [] as unknown[]).then((listed) => listed.length ? listed : listModels(`${base}/${listing}`, headers)) : listModels(`${base}/${listing}`, headers))
			: listModels(`${base}/${listing}`, headers).catch(() => [] as unknown[])));
	const byId = new Map<string, CustomProviderModel>();
	for (const raw of [...primary!, ...extra.flat()]) {
		const model = raw && typeof raw === "object" && !Array.isArray(raw) ? classifyModel(raw as Record<string, unknown>) : undefined;
		if (!model) continue;
		const existing = byId.get(model.id);
		const capabilities = [...new Set([...(existing?.capabilities ?? []), ...model.capabilities])];
		byId.set(model.id, { id: model.id, ...(model.name ?? existing?.name ? { name: model.name ?? existing?.name } : {}), capabilities,
			...(model.supportedVoices ?? existing?.supportedVoices ? { supportedVoices: model.supportedVoices ?? existing?.supportedVoices } : {}) });
	}
	const discovered = [...byId.values()].filter((model) => !only || model.capabilities?.includes(only));
	// Only a TTS model whose own entry names no voices needs the endpoint's voice listing.
	const voiceless = (model: CustomProviderModel) => model.capabilities?.includes("tts") && !model.supportedVoices;
	const voices = discovered.some(voiceless) ? await listVoices(`${base}/audio/voices`, headers).catch(() => []) : [];
	return voices.length ? discovered.map((model) => voiceless(model) ? { ...model, supportedVoices: voices } : model) : discovered;
}

/** Discovered models replace their stored counterparts in place; ids only the user knows about stay. */
export function mergeDiscoveredModels(existing: CustomProviderModel[], discovered: CustomProviderModel[]): CustomProviderModel[] {
	const found = new Map(discovered.map((model) => [model.id, model]));
	const known = new Set(existing.map((model) => model.id));
	return [...existing.map((model) => found.has(model.id) ? { ...model, ...found.get(model.id)! } : model), ...discovered.filter((model) => !known.has(model.id))];
}

export function mergeCustomProvider(
	existing: CustomProvider | undefined,
	next: CustomProvider,
): CustomProvider {
	const existingModels = new Map((existing?.models ?? []).map((model) => [model.id, model]));
	return {
		...existing,
		...next,
		apiKey: next.apiKey ?? existing?.apiKey,
		models: next.models.map((model) => ({ ...existingModels.get(model.id), ...model })),
	};
}
