import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath } from "node:url";

import { agentPythonExecutable } from "./agent-python.js";
import { sha256 } from "../lib/hash.js";
import { resolveAgentDir } from "../config/agent-directory.js";
import { anonymousConnectionKeyFor, type CustomProvider } from "../providers/custom-models.js";
import type { AuthStorage, ModelRegistry } from "prime-agent";

export const PRIME_AUTO_REFINE_ENABLED = false;
export const PRIME_RLM_MAX_DEPTH = 1;
export const PRIME_AUTONOMOUS_CONFIG = Object.freeze({ enabled: false });

export function createPrimeTraceEventFilter(): (event: unknown) => boolean {
	const childStatuses = new Map<string, string>();
	return (event) => {
		if (!event || typeof event !== "object") return false;
		const value = event as {
			type?: string;
			child?: { id?: string; name?: string; sessionName?: string; status?: string };
		};
		if (value.type !== "rlm_child_update") return false;
		const childId = value.child?.id ?? value.child?.sessionName ?? value.child?.name;
		if (!childId) return false;
		const status = value.child?.status ?? "unknown";
		if (childStatuses.get(childId) === status) return false;
		childStatuses.set(childId, status);
		return true;
	};
}

export function projectPrimeChildLifecycleEvent(event: unknown): Record<string, unknown> | undefined {
	if (!event || typeof event !== "object") return undefined;
	const value = event as { type?: string; child?: Record<string, unknown> };
	if (value.type !== "rlm_child_update" || !value.child) return undefined;
	const child = Object.fromEntries([
		"id", "name", "parentId", "activeSessionId", "sessionName", "model", "status", "durationMs",
		"toolUseCount", "tokenCount", "sessionDir", "error",
	].flatMap((key) => value.child?.[key] === undefined ? [] : [[key, value.child[key]]]));
	return Object.keys(child).length > 0 ? { type: "rlm_child_update", child } : undefined;
}

/**
 * Throws the error a Prime session's latest model call ended with. Prime resolves `prompt()`
 * normally when that call fails: the failure exists only as the last assistant message's
 * `stopReason: "error"`. A Worker that goes on to check its output files would then report the
 * file the model never got to write instead of the model error the user must act on. Auto-retry
 * drops a recovered attempt from `session.messages`, so only an unrecovered failure throws, and a
 * model that answered without writing its file still reaches the Worker's own contract check.
 * The error names the model, so the Runtime that launched the Worker knows which one to report.
 */
export function assertPrimeModelAnswered(session: { messages: readonly unknown[] }): void {
	const last = [...session.messages].reverse().find((message) => (message as { role?: unknown } | undefined)?.role === "assistant") as
		{ stopReason?: unknown; errorMessage?: unknown; provider?: unknown; model?: unknown } | undefined;
	if (last?.stopReason !== "error") return;
	throw new Error(primeModelErrorText(last));
}

/** A failed assistant message as `model '<provider>/<model>' failed: <error>`, or the bare error when it names no model. */
export function primeModelErrorText(message: { errorMessage?: unknown; provider?: unknown; model?: unknown }): string {
	const error = typeof message.errorMessage === "string" && message.errorMessage.trim() ? message.errorMessage.trim() : "Model call failed";
	return typeof message.provider === "string" && typeof message.model === "string"
		? `model '${message.provider}/${message.model}' failed: ${error}`
		: error;
}

interface PrimeSettingsManager {
	applyOverrides(overrides: { autoRefine: { enabled: boolean } }): void;
	getAutoRefineSettings(): { enabled: boolean };
}

export function createPrimeSettingsManager<T extends PrimeSettingsManager>(
	factory: { create(cwd: string, agentDir: string): T },
	cwd: string,
	agentDir: string,
): T {
	const settings = factory.create(cwd, agentDir);
	settings.applyOverrides({ autoRefine: { enabled: PRIME_AUTO_REFINE_ENABLED } });
	if (settings.getAutoRefineSettings().enabled !== PRIME_AUTO_REFINE_ENABLED) {
		throw new Error("Telomi Prime Auto Refine setting was not applied");
	}
	return settings;
}

export function primeAgentDir(env: NodeJS.ProcessEnv = process.env): string {
	return env.PRIME_AGENT_CODING_AGENT_DIR?.trim() || env.PI_CODING_AGENT_DIR?.trim() || resolveAgentDir(env.TELOMI_DATA_DIR);
}
/** Canonical credentials are accessible to the host SDK, never mounted into the kernel. */
export const PRIME_CREDENTIAL_SOURCE_ENV = "TELOMI_PRIME_CREDENTIAL_SOURCE";

/**
 * The Provider and model definitions this execution is pinned to, secrets already removed.
 *
 * A Run freezes its connections as well as its models: a later Stage that rebuilt them from the
 * canonical file would silently move an endpoint the earlier Stages had already used. Credentials
 * are deliberately not in it, so no secret is written where a Run's artifacts are collected.
 */
export const PRIME_MODEL_DEFINITIONS_ENV = "TELOMI_PRIME_MODEL_DEFINITIONS";

export function stagePrimeAgentDirectory(target: string, env: NodeJS.ProcessEnv = process.env): string {
	mkdirSync(target, { recursive: true });
	const auth = join(primeAgentDir(env), "auth.json");
	if (!existsSync(auth)) throw new Error(`Prime Agent credential file does not exist: ${auth}`);
	writeFileSync(join(target, "auth.json"), "{}\n", { mode: 0o600 });
	// Definitions come from this execution's frozen copy when it has one, and never carry a key:
	// the host SDK resolves credentials at each request instead.
	const definitions = asRecord(primeModelDefinitions(env)) ?? {};
	// Catalog models of a built-in Provider authenticate like its other models, through its own login.
	const configured = asRecord(asRecord(withoutCatalogModels(definitions))?.providers) ?? {};
	for (const [id, entry] of Object.entries(asRecord(definitions.providers) ?? {})) {
		const provider = asRecord(entry);
		if (provider && Array.isArray(asRecord(configured[id])?.models) && (asRecord(configured[id])!.models as unknown[]).length) {
			provider.apiKey = "telomi-request-auth";
		}
	}
	writeFileSync(join(target, "models.json"), `${JSON.stringify(definitions, null, 2)}\n`);
	writeFileSync(join(target, "settings.json"), `${JSON.stringify({
		autoRefine: { enabled: PRIME_AUTO_REFINE_ENABLED },
		rlmMaxDepth: PRIME_RLM_MAX_DEPTH,
	}, null, 2)}\n`);
	return target;
}

export function removeStagedPrimeCredentials(target: string): void {
	for (const name of ["auth.json", "models.json"] as const) rmSync(join(target, name), { force: true });
}

/**
 * The Provider and model definitions with every credential removed, ready to be frozen with a Run.
 * Keys reach the Agent only as runtime credentials, resolved per request.
 */
export function primeModelDefinitions(env: NodeJS.ProcessEnv = process.env): unknown {
	const frozen = env[PRIME_MODEL_DEFINITIONS_ENV]?.trim();
	const definitions = readJsonFile(frozen || join(primeAgentDir(env), "models.json"));
	if (frozen && definitions === undefined) throw new Error("Frozen Run model definitions are missing");
	const withoutKeys = withoutProviderKeys(definitions ?? { providers: {} }, Boolean(frozen));
	// A frozen copy already carries the catalog models it was frozen with.
	return frozen ? withoutKeys : withCatalogModels(withoutKeys, env);
}

/**
 * Where a definitions file names the models Telomi added from the catalog, as `provider/model`.
 * They are not the user's connections, so the connection affinity check leaves them out.
 */
export const PRIME_CATALOG_MODELS_KEY = "telomiCatalogModels";

// ponytail: Prime 0.9.1 ships a fixed model list and drops Codex models its outdated discovery
// client version cannot see, so a model the pi catalog added since (GPT-6) does not exist for it.
// Telomi hands those definitions to Prime itself. Remove this once Prime fetches its catalog
// (upstream prime-agent #2507) in a release Telomi pins.
const primeBuiltinModelsByPath = new Map<string, Map<string, Set<string>> | undefined>();
function primeBuiltinModels(env: NodeJS.ProcessEnv): Map<string, Set<string>> | undefined {
	let module: string;
	try { module = primeAgentModulePath(env); } catch { return undefined; }
	const table = primePiAiModelsTable(dirname(dirname(module)));
	if (!table) return undefined;
	if (!primeBuiltinModelsByPath.has(table)) {
		let models: Map<string, Set<string>> | undefined;
		try {
			const { MODELS } = createRequire(import.meta.url)(table) as { MODELS: Record<string, Record<string, unknown>> };
			models = new Map(Object.entries(MODELS).map(([provider, byId]) => [provider, new Set(Object.keys(byId))]));
		} catch {
			// Without Prime's own list nothing is known to be missing, so nothing is added.
			models = undefined;
		}
		primeBuiltinModelsByPath.set(table, models);
	}
	return primeBuiltinModelsByPath.get(table);
}

/** Prime's own pi-ai, found the way Node resolves it from Prime, nested or hoisted by the installer. */
function primePiAiModelsTable(primePackageDir: string): string | undefined {
	for (let dir = primePackageDir; ; dir = dirname(dir)) {
		const table = join(dir, "node_modules", "@earendil-works", "pi-ai", "dist", "models.generated.js");
		if (existsSync(table)) return table;
		if (dirname(dir) === dir) return undefined;
	}
}

/** Catalog models of Providers Prime supports that its own list lacks, from pi's cached catalog. */
function withCatalogModels(definitions: unknown, env: NodeJS.ProcessEnv): unknown {
	const root = asRecord(definitions);
	const builtin = primeBuiltinModels(env);
	const catalog = asRecord(readJsonFile(join(primeAgentDir(env), "models-store.json")));
	if (!root || !builtin || !catalog) return definitions;
	const providers = { ...asRecord(root.providers) };
	const added: string[] = [];
	for (const [provider, entry] of Object.entries(catalog)) {
		const known = builtin.get(provider);
		// A Provider Prime cannot speak is not reachable either way; one the user defined keeps its own models.
		if (!known || providers[provider] !== undefined) continue;
		const models = (Array.isArray(asRecord(entry)?.models) ? asRecord(entry)!.models as unknown[] : [])
			.filter((model) => typeof asRecord(model)?.id === "string" && !known.has(asRecord(model)!.id as string));
		if (!models.length) continue;
		providers[provider] = { models };
		for (const model of models) added.push(`${provider}/${asRecord(model)!.id as string}`);
	}
	return added.length ? { ...root, providers, [PRIME_CATALOG_MODELS_KEY]: added } : definitions;
}

/** The definitions as the user configured them, without the catalog models Telomi added. */
function withoutCatalogModels(definitions: unknown): unknown {
	const root = asRecord(definitions);
	const added = new Set(Array.isArray(root?.[PRIME_CATALOG_MODELS_KEY]) ? root[PRIME_CATALOG_MODELS_KEY] as string[] : []);
	if (!root || !added.size) return definitions;
	const { [PRIME_CATALOG_MODELS_KEY]: _added, ...rest } = root;
	const providers = Object.fromEntries(Object.entries(asRecord(rest.providers) ?? {}).flatMap(([id, entry]) => {
		const provider = asRecord(entry);
		const listed = Array.isArray(provider?.models) ? provider.models as unknown[] : undefined;
		const models = listed?.filter((model) => !added.has(`${id}/${asRecord(model)?.id}`));
		if (!provider || !listed || !models || models.length === listed.length) return [[id, entry]];
		const { models: _models, ...connection } = provider;
		return models.length ? [[id, { ...connection, models }]] : Object.keys(connection).length ? [[id, connection]] : [];
	}));
	return { ...rest, providers };
}

/** Preserve identifiers; header configurations become fingerprints, never credential values. */
function withoutProviderKeys(models: unknown, frozen: boolean): unknown {
	const root = asRecord(models);
	const providers = asRecord(root?.providers);
	if (!root || !providers) return models;
	return { ...root, providers: Object.fromEntries(Object.entries(providers).map(([id, entry]) => {
		const provider = asRecord(freezeHeaders(entry, frozen));
		if (!provider) return [id, entry];
		const { apiKey: _key, ...definition } = provider;
		if (Array.isArray(definition.models)) definition.models = definition.models.map((model) => freezeHeaders(model, frozen));
		const overrides = asRecord(definition.modelOverrides);
		if (overrides) definition.modelOverrides = Object.fromEntries(
			Object.entries(overrides).map(([modelId, override]) => [modelId, freezeHeaders(override, frozen)]));
		return [id, definition];
	})) };
}

function headerFingerprints(headers: Record<string, unknown>, frozen: boolean): Record<string, string> {
	return Object.fromEntries(Object.entries(headers).map(([name, value]) => {
		if (typeof value !== "string") throw new Error("Invalid Prime request header configuration");
		return [name, frozen ? value : sha256(value)];
	}));
}

function freezeHeaders(value: unknown, frozen: boolean): unknown {
	const record = asRecord(value);
	if (!record) return value;
	const headers = asRecord(record.headers);
	return { ...record, ...(headers ? { headers: headerFingerprints(headers, frozen) } : {}) };
}

function providerDefinition(models: unknown, provider: string): Record<string, unknown> | undefined {
	return asRecord(asRecord(asRecord(models)?.providers)?.[provider]);
}

function modelDefinition(provider: Record<string, unknown> | undefined, id: string): Record<string, unknown> | undefined {
	return asRecord(Array.isArray(provider?.models) ? provider.models.find((value) => asRecord(value)?.id === id) : undefined)
		?? asRecord(asRecord(provider?.modelOverrides)?.[id]);
}

/** Model ids a Provider declares, through `models` or `modelOverrides`. */
function declaredModelIds(provider: Record<string, unknown> | undefined): string[] {
	return [...new Set([
		...(Array.isArray(provider?.models) ? provider.models.flatMap((value) => {
			const id = asRecord(value)?.id;
			return typeof id === "string" ? [id] : [];
		}) : []),
		...Object.keys(asRecord(provider?.modelOverrides) ?? {}),
	])].sort();
}

/** Authentication values may rotate; destinations, protocols and header layouts may not. */
function connectionIdentity(provider: Record<string, unknown> | undefined, ids: readonly string[], frozen: boolean): unknown {
	const shape = (entry: Record<string, unknown> | undefined) => {
		const headers = asRecord(entry?.headers) ?? {};
		for (const [name, value] of Object.entries(headers)) {
			if (!frozen && /^(host|:authority)$/iu.test(name) && typeof value === "string"
				&& (value.startsWith("!") || process.env[value] !== undefined)) {
				throw new Error("Prime Host/authority headers must be literal; configure destinations through baseUrl");
			}
		}
		return {
			baseUrl: entry?.baseUrl, api: entry?.api, authHeader: entry?.authHeader === true,
			headers: Object.fromEntries(Object.entries(headerFingerprints(headers, frozen))
				.map(([key, value]) => [key.toLowerCase(), value]).sort(([a], [b]) => a!.localeCompare(b!))),
		};
	};
	return { declared: Boolean(provider), provider: shape(provider),
		models: Object.fromEntries(ids.map((id) => {
			const entry = modelDefinition(provider, id);
			return [id, { declared: Boolean(entry), ...shape(entry) }];
		})) };
}

/** Reads JSON without turning corrupt or unreadable configuration into credential deletion. */
function readJsonFile(path: string): unknown {
	try {
		return JSON.parse(readFileSync(path, "utf-8")) as unknown;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

/**
 * Native credential storage remains authoritative, including SDK OAuth refreshes under its lock.
 * The host SDK can read it; the Agent's kernel still only sees its isolated Workspace.
 * A separate native registry resolves live auth without replacing frozen model objects.
 */
export function createPrimeModelRegistry(
	prime: { AuthStorage: typeof AuthStorage; ModelRegistry: typeof ModelRegistry },
	stagedAgentDir: string,
	env: NodeJS.ProcessEnv = process.env,
): { authStorage: AuthStorage; modelRegistry: ModelRegistry } {
	const source = env[PRIME_CREDENTIAL_SOURCE_ENV]?.trim();
	if (!source) throw new Error("Prime credential source is required");
	const authStorage = prime.AuthStorage.create(join(source, "auth.json"), { usePrimeCliConfig: false });
	const modelRegistry = prime.ModelRegistry.create(authStorage, join(stagedAgentDir, "models.json"));
	const staged = readJsonFile(join(stagedAgentDir, "models.json"));
	// The user's connections are compared with the live ones; catalog models are no connection of theirs.
	const frozen = withoutCatalogModels(staged);
	const catalogModels = new Set(Array.isArray(asRecord(staged)?.[PRIME_CATALOG_MODELS_KEY]) ? asRecord(staged)![PRIME_CATALOG_MODELS_KEY] as string[] : []);
	if (catalogModels.size) {
		// Prime 0.9.1 keeps a Codex model for delegation only when its outdated discovery lists it; a
		// catalog model it just learned about stays delegable while its Provider is signed in.
		const executable = modelRegistry.getExecutableModels.bind(modelRegistry);
		modelRegistry.getExecutableModels = async () => {
			const listed = await executable();
			const kept = new Set(listed.map((model) => `${model.provider}/${model.id}`));
			return [...listed, ...modelRegistry.getAvailable().filter((model) => catalogModels.has(`${model.provider}/${model.id}`) && !kept.has(`${model.provider}/${model.id}`))];
		};
	}
	// Register only request auth, through the native API. Unlike file-based custom models, this
	// needs no placeholder key and never reloads or replaces this Run's model definitions.
	const credentials = prime.ModelRegistry.inMemory(authStorage);
	const connection = (provider: string, modelId?: string): Record<string, unknown> | false => {
		const settings = asRecord(readJsonFile(join(source, "settings.json")));
		if (Array.isArray(settings?.deletedProviderCredentials) && settings.deletedProviderCredentials.includes(provider)) return false;
		const live = readJsonFile(join(source, "models.json"));
		const config = asRecord(live);
		if (live !== undefined && (!config || (config.providers !== undefined && !asRecord(config.providers)))) {
			throw new Error("Invalid Prime connection configuration");
		}
		const definition = providerDefinition(live, provider);
		const frozenDefinition = providerDefinition(frozen, provider);
		// A provider-level check covers the models this Run froze. Models a catalog sync appends later
		// are invisible to the Run, so they cannot change any connection it uses.
		const ids = modelId ? [modelId] : declaredModelIds(frozenDefinition);
		if (!isDeepStrictEqual(connectionIdentity(frozenDefinition, ids, true), connectionIdentity(definition, ids, false))) {
			throw new Error(`Provider connection '${provider}' changed; start a new Run to use the activated connection`);
		}
		return definition ?? {};
	};
	const prepare = (provider: string, modelId?: string): boolean => {
		const definition = connection(provider, modelId);
		if (definition === false) return false;
		authStorage.drainErrors();
		authStorage.reload();
		if (authStorage.drainErrors().length) throw new Error("Prime credential storage could not be loaded");
		const headers = { ...asRecord(definition?.headers), ...asRecord(modelId ? modelDefinition(definition, modelId)?.headers : undefined) };
		if (Object.values(headers).some((value) => typeof value !== "string")) throw new Error("Invalid Prime request headers");
		credentials.registerProvider(provider, {
			apiKey: typeof definition?.apiKey === "string" ? definition.apiKey
				: !authStorage.has(provider) ? anonymousConnectionKeyFor(definition as CustomProvider | undefined) ?? "" : "",
			headers: headers as Record<string, string>,
			authHeader: definition?.authHeader === true,
		});
		return true;
	};
	modelRegistry.getApiKeyAndHeaders = async (model) => {
		const deleted = { ok: false as const, error: `Credential deleted for provider '${model.provider}'` };
		if (!prepare(model.provider, model.id)) return deleted;
		const result = await credentials.getApiKeyAndHeaders(model);
		// OAuth resolution can await: verify affinity again before the transport gets a credential.
		return connection(model.provider, model.id) === false ? deleted : result;
	};
	modelRegistry.getApiKeyForProvider = async (provider) => {
		if (!prepare(provider)) return undefined;
		const key = await credentials.getApiKeyForProvider(provider);
		return connection(provider) === false ? undefined : key;
	};
	modelRegistry.hasConfiguredAuth = (model) => prepare(model.provider, model.id) && credentials.hasConfiguredAuth(model);
	modelRegistry.getProviderAuthStatus = (provider) => prepare(provider)
		? credentials.getProviderAuthStatus(provider) : { configured: false };
	// Auth failure recovery must invalidate the same native source used by the request.
	modelRegistry.getCurrentProviderAuthSourceToken = credentials.getCurrentProviderAuthSourceToken.bind(credentials);
	modelRegistry.markProviderAuthStale = credentials.markProviderAuthStale.bind(credentials);
	modelRegistry.markProviderAuthSourceStale = credentials.markProviderAuthSourceStale.bind(credentials);
	modelRegistry.isUsingOAuth = credentials.isUsingOAuth.bind(credentials);
	return { authStorage, modelRegistry };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value)
		? value as Record<string, unknown>
		: undefined;
}

export function primeKernelPython(env: NodeJS.ProcessEnv = process.env): string {
	return agentPythonExecutable(env);
}

export function primeAgentModulePath(env: NodeJS.ProcessEnv = process.env): string {
	const configured = env.TELOMI_PRIME_AGENT_MODULE_PATH?.trim() || env.PRIME_AGENT_MODULE?.trim();
	const candidate = configured?.startsWith("file:") ? fileURLToPath(configured) : configured || fileURLToPath(import.meta.resolve("prime-agent"));
	if (!existsSync(candidate)) throw new Error(`Prime Agent module does not exist: ${candidate}`);
	return realpathSync(candidate);
}
