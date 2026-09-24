import { modelDefinitionHash, pendingTaskModelSelections } from "../agent-runtime/model-policy.js";
import { scrubResearchModelError } from "../agent-runtime/models/error-classifier.js";
import type { Express, Request, Response } from "express";
import { isDeepStrictEqual } from "node:util";
import { getBuiltinModels, getBuiltinProviders } from "@earendil-works/pi-ai/providers/all";
import { capabilitiesFor } from "../../shared/model-capabilities.js";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { anonymousConnectionApiKey, loadCustomProviders } from "./custom-models.js";
import { isProviderCredentialDeleted } from "../config/credential-tombstones.js";
import { resolveRegistryModel } from "../agent-runtime/model-connectivity.js";
import { readStoredCredentials } from "../accounts/stored-credentials.js";
import { resolveAgentPath } from "../config/agent-directory.js";
import {
	TASK_MODEL_ROLES,
	TASK_MODEL_ROLE_INFO,
	loadSettings,
	saveSettings,
	type ModelDefaults,
	type PiSettings,
	type TaskModelRole,
	type TaskModelSettings,
} from "../config/settings.js";
import { taskModelStages } from "../config/settings.js";
import {
	THINKING_LEVELS,
	isThinkingLevel,
	resolveLLMConfig,
	resolveStageThinkingLevel,
	type EffectiveModelSelection,
} from "../agent-runtime/model-config/resolve.js";
import {
	RUN_MODEL_ROLES,
	activeRunModelSelections,
	type RunModelRole,
} from "../research/run-model-selection.js";
import type { MainAgentConfiguration } from "../goals/service.js";
import { toErrorMessage } from "../lib/values.js";

import type { HindsightRuntimeManager } from "../goals/memory/hindsight-runtime.js";
import { parseMemoryModels } from "../goals/memory/model-settings.js";

const AUTH_PATH = resolveAgentPath("auth.json");
const MODELS_PATH = resolveAgentPath("models.json");

/** The consumers whose effective configuration the unified entry point reports. */
export interface ProviderConfigDependencies {
	mainAgent: { describeMainAgentConfiguration(): MainAgentConfiguration };
	memory?: HindsightRuntimeManager;
}

interface ConsumerStatus {
	id: string;
	effectiveModel: string;
	source: EffectiveModelSelection["source"] | "unset";
	thinkingLevel: string;
	/** `failed`: the Provider rejected the effective model on its last use; `error` says why. */
	status: "active" | "pending" | "failed";
	error?: string;
	pendingCount: number;
	/**
	 * The explicit fallback models a failing request may switch to. Roles that execute inside a
	 * Prime Worker only fail over between accounts of the same model, so no chain applies there.
	 */
	fallback: { models: string[]; applies: boolean };
	/**
	 * The reasoning depth of each Run Stage this consumer owns, resolved the same way its model
	 * is: an explicit choice, otherwise the capability default.
	 */
	stages: Array<{
		key: string;
		label: string;
		thinkingLevel: string;
		source: "override" | "settings" | "unset";
	}>;
	overrides: Array<{
		id: string;
		label: string;
		model: string;
		modelOverridden: boolean;
		thinkingLevel: string;
		thinkingLevelOverridden: boolean;
	}>;
}

type ModelDefaultsSource = Partial<Record<keyof ModelDefaults, unknown>>;

function parseModelDefaults(
	body: unknown,
): { ok: true; defaults: ModelDefaults | null } | { ok: false; error: string } {
	if (body === null) return { ok: true, defaults: null };
	if (!body || typeof body !== "object" || Array.isArray(body)) {
		return { ok: false, error: "body must be an object" };
	}
	const source = body as ModelDefaultsSource;
	const defaults: ModelDefaults = {};
	for (const field of ["defaultProvider", "defaultModel"] as const) {
		const value = source[field];
		if (value === undefined || value === null || value === "") continue;
		if (typeof value !== "string") return { ok: false, error: `${field} must be a string or null` };
		defaults[field] = value;
	}
	const level = source.defaultThinkingLevel;
	if (level !== undefined && level !== null && level !== "") {
		if (!isThinkingLevel(level)) {
			return {
				ok: false,
				error: `invalid defaultThinkingLevel '${String(level)}' (allowed: ${THINKING_LEVELS.join(", ")})`,
			};
		}
		defaults.defaultThinkingLevel = level;
	}
	if (defaults.defaultModel && !defaults.defaultProvider) {
		return { ok: false, error: "cannot set defaultModel without defaultProvider" };
	}
	return { ok: true, defaults: Object.keys(defaults).length > 0 ? defaults : null };
}

/**
 * The necessary conditions for a selection to be usable: the model exists in the registry and
 * its provider resolves a credential. Passing establishes compatibility, not future
 * availability, and no request is sent to the Provider.
 */
export async function validateModelDefaults(
	defaults: ModelDefaults,
): Promise<{ ok: true } | { ok: false; error: string }> {
	const provider = defaults.defaultProvider;
	const modelId = defaults.defaultModel;
	if (!provider || !modelId) return { ok: true };
	if (loadCustomProviders().providers?.[provider]?.capability) return { ok: false, error: "an audio service connection cannot serve an LLM role" };
	if (!servesChat(provider, modelId)) return { ok: false, error: `model '${provider}/${modelId}' is not an LLM` };
	const resolved = await resolveRegistryModel(provider, modelId, { authPath: AUTH_PATH, modelsPath: MODELS_PATH });
	if (!resolved.ok) return resolved;
	if (isProviderCredentialDeleted(provider)) return { ok: false, error: `provider '${provider}' credential was deleted` };
	// A Codex account rotates its own credential; require the account, not a live refresh.
	if (provider === "openai-codex") {
		return readStoredCredentials(AUTH_PATH)[provider]
			? { ok: true }
			: { ok: false, error: `provider '${provider}' has no signed-in account` };
	}
	try {
		const auth = await providerAuth(resolved.model);
		if (!auth && !anonymousConnectionApiKey(provider)) return { ok: false, error: `provider '${provider}' is not configured` };
		return { ok: true };
	} catch (error) {
		return { ok: false, error: `provider '${provider}' authorization could not be resolved: ${scrubResearchModelError(error)}` };
	}
}

async function providerAuth(model: Parameters<ModelRuntime["getAuth"]>[0]): Promise<unknown> {
	const runtime = await ModelRuntime.create({ authPath: AUTH_PATH, modelsPath: MODELS_PATH });
	return runtime.getAuth(model);
}

/**
 * The runtime every model listing reads. Built-in providers carry pi.dev's catalog on top of
 * pi-ai's static table, so a model the vendor shipped after this package was built still shows
 * up. The catalog is revalidated at most every four hours; the wait is bounded so a slow catalog
 * host cannot hold a settings request, and a timeout leaves the persisted catalog untouched.
 */
export function catalogRuntime(): Promise<ModelRuntime> {
	return ModelRuntime.create({ authPath: AUTH_PATH, modelsPath: MODELS_PATH, allowModelNetwork: true, modelRefreshTimeoutMs: 4_000 });
}

export interface SelectableModel {
	id: string;
	name: string;
	provider: string;
}

/**
 * Whether a model may serve an LLM role. The runtime lists every model a connection stored, speech
 * and embedding ones included, so a connection's own classification decides; a model it never
 * stored comes from the registry's chat catalog.
 */
function servesChat(provider: string, modelId: string, providers = loadCustomProviders().providers ?? {}): boolean {
	const entry = providers[provider];
	if (!entry) return true;
	if (entry.capability) return false;
	const stored = entry.models?.find((model) => model.id === modelId);
	return !stored || capabilitiesFor(stored).includes("chat");
}

/**
 * Read every provider+model declared in the project agent directory's `models.json` directly.
 * We include these unconditionally (no auth check) because the user already
 * opted them in via SettingsPage — and providers like a local MLX server
 * legitimately need no apiKey, which `ModelRegistry.getAvailable()` would
 * filter out.
 */
function readCustomProviderModelsFromDisk(): SelectableModel[] {
	try {
		const out: SelectableModel[] = [];
		for (const [provider, entry] of Object.entries(loadCustomProviders().providers ?? {})) {
			if (entry.capability) continue;
			for (const m of entry.models ?? []) {
				if (typeof m.id !== "string" || !capabilitiesFor(m).includes("chat")) continue;
				out.push({ id: m.id, name: typeof m.name === "string" && m.name ? m.name : m.id, provider });
			}
		}
		return out;
	} catch {
		return [];
	}
}

/**
 * Build the model list shown in the chat ModelPicker.
 *
 * Merge order:
 * 1. `ModelRegistry.getAvailable()` — built-in providers with auth configured
 *    (auth.json, env var, or models.json apiKey). Avoids dumping all 800+
 *    openrouter/bedrock/vercel-ai-gateway entries when the user has only
 *    their preferred provider authenticated.
 * 2. Every provider+model declared in the project agent directory's `models.json` - covers
 *    auth-less providers like a local MLX server that `getAvailable()`
 *    would filter out.
 *
 * `enabledModels` from settings.json then filters to a curated subset. We
 * honor the field **whenever it is present** (even when empty or stale) so
 * the chat picker matches what the user explicitly opted into in Settings;
 * silently falling back to the full union would re-expose models the user
 * just turned off. If the field is absent (fresh install) we surface every
 * dedup'd model so day-1 users aren't stuck with an empty dropdown.
 *
 * Each entry's `id` is the bare model id; the wire format consumed by
 * `runner.updateConfig` is `<provider>/<id>` so model-id collisions across
 * providers (e.g. openai-codex AND tabcode both expose "gpt-5.4-mini") stay
 * disambiguated.
 */
export async function listSelectableModels(): Promise<SelectableModel[]> {
	const collected: SelectableModel[] = [];
	try {
		const runtime = await catalogRuntime();
		const custom = loadCustomProviders().providers ?? {};
		for (const m of await runtime.getAvailable()) {
			if (!servesChat(m.provider, m.id, custom)) continue;
			collected.push({
				id: m.id,
				name: m.name && m.name.length > 0 ? m.name : m.id,
				provider: m.provider,
			});
		}
	} catch {
		// Last-resort fallback — still include built-ins from pi-ai static.
		for (const provider of getBuiltinProviders()) {
			for (const m of getBuiltinModels(provider)) {
				collected.push({ id: m.id, name: m.name ?? m.id, provider });
			}
		}
	}
	for (const m of readCustomProviderModelsFromDisk()) {
		collected.push(m);
	}

	const seen = new Set<string>();
	const deduped: SelectableModel[] = [];
	for (const m of collected) {
		const key = `${m.provider}/${m.id}`;
		if (seen.has(key)) continue;
		seen.add(key);
		deduped.push(m);
	}

	let enabled: string[] | null = null;
	try {
		const settings = loadSettings();
		if (Array.isArray(settings.enabledModels)) {
			enabled = settings.enabledModels.filter((x): x is string => typeof x === "string");
		}
	} catch {
		// Treat as no filter.
	}

	if (enabled === null) return deduped;
	const enabledSet = new Set(enabled);
	return deduped.filter((m) => enabledSet.has(`${m.provider}/${m.id}`));
}

interface AvailableModel {
	id: string;
	name: string;
}

interface ProviderInfo {
	id: string;
	models: AvailableModel[];
	dynamic?: boolean;
}

async function listAllProviders(enabled: string[] = []): Promise<ProviderInfo[]> {
	const providers = getBuiltinProviders();
	const out: ProviderInfo[] = [];
	const seen = new Set<string>();
	// Every built-in model is a toggle, configured or not; the catalog runtime adds what pi.dev
	// lists beyond the static table. Last resort: the static table alone.
	let runtime: ModelRuntime | undefined;
	try {
		runtime = await catalogRuntime();
	} catch {
		runtime = undefined;
	}
	const custom = loadCustomProviders().providers ?? {};
	for (const provider of providers) {
		seen.add(provider);
		try {
			const models = (runtime?.getModels(provider) ?? getBuiltinModels(provider))
				.filter((m) => servesChat(provider, m.id, custom))
				.map((m) => ({ id: m.id, name: m.name }));
			out.push({ id: provider, models });
		} catch {
			out.push({ id: provider, models: [] });
		}
	}
	// Custom providers from models.json — surface them unconditionally so 默认模型 dropdown can
	// pick them even when none of their models are in `enabledModels` yet.
	const dynamic = new Map<string, Set<string>>();
	for (const m of readCustomProviderModelsFromDisk()) {
		if (seen.has(m.provider)) continue;
		let bag = dynamic.get(m.provider);
		if (!bag) {
			bag = new Set<string>();
			dynamic.set(m.provider, bag);
		}
		bag.add(m.id);
	}
	// Also fold in any enabled-but-otherwise-unseen provider/model (e.g. a stale enabledModels entry
	// from a provider that has since been removed from models.json — keep the toggle reachable so
	// the user can clear it).
	for (const item of enabled) {
		const slash = item.indexOf("/");
		if (slash === -1) continue;
		const provider = item.slice(0, slash);
		if (seen.has(provider)) continue;
		const model = item.slice(slash + 1);
		let bag = dynamic.get(provider);
		if (!bag) {
			bag = new Set<string>();
			dynamic.set(provider, bag);
		}
		bag.add(model);
	}
	for (const [provider, models] of dynamic) {
		out.push({
			id: provider,
			models: Array.from(models).map((id) => ({ id, name: id })),
			dynamic: true,
		});
	}
	return out;
}

/** The capability defaults as the entry point displays them: an absent value reads as null. */
function readModelDefaults(source: ModelDefaultsSource | undefined): {
	defaultProvider: string | null;
	defaultModel: string | null;
	defaultThinkingLevel: string | null;
} {
	return {
		defaultProvider: typeof source?.defaultProvider === "string" ? source.defaultProvider : null,
		defaultModel: typeof source?.defaultModel === "string" ? source.defaultModel : null,
		defaultThinkingLevel: isThinkingLevel(source?.defaultThinkingLevel)
			? source.defaultThinkingLevel
			: null,
	};
}

async function buildResponse(settings: PiSettings, deps: ProviderConfigDependencies) {
	const enabledModels = Array.isArray(settings.enabledModels)
		? settings.enabledModels.filter((x): x is string => typeof x === "string")
		: [];
	const providerFallbackModels = Array.isArray(settings.providerFallbackModels)
		? settings.providerFallbackModels.filter((x): x is string => typeof x === "string")
		: [];
	const providers = await listAllProviders(enabledModels);
	const taskModels = Object.fromEntries(TASK_MODEL_ROLES.flatMap((role) => {
		const model = settings.taskModels?.[role];
		return typeof model === "string" && model.includes("/") ? [[role, model]] : [];
	})) as TaskModelSettings;
	const active = readModelDefaults(settings);
	return {
		...active,
		consumers: describeConsumers(settings, deps),
		memoryConfiguration: deps.memory?.describeConfiguration(),
		enabledModels,
		providerFallbackModels,
		taskModels,
		stageThinkingLevels: Object.fromEntries(taskModelStages().flatMap(({ key }) => {
			const entry = settings.stageThinkingLevels?.[key];
			return entry ? [[key, entry.level]] : [];
		})),
		taskModelRoles: TASK_MODEL_ROLES.map((id) => ({ id, ...TASK_MODEL_ROLE_INFO[id] })),
		providers,
		thinkingLevels: THINKING_LEVELS,
	};
}

/**
 * What each consuming role actually uses right now, as the Runtime resolves it. The frontend
 * displays these facts instead of recomputing precedence, and a consumer that has not adopted
 * the change yet reports `pending` rather than joining a blanket success.
 */
export function describeConsumers(settings: PiSettings, deps: ProviderConfigDependencies): ConsumerStatus[] {
	const mainAgent = deps.mainAgent.describeMainAgentConfiguration();
	const fallbackModels = resolveLLMConfig({ settingsOverride: settings, envOverride: {} }).fallbackChain.slice();
	return [{
		id: "mainAgent",
		effectiveModel: mainAgent.inheritedModel ?? "",
		source: mainAgent.inheritedSource === "missing" ? "unset" : mainAgent.inheritedSource,
		thinkingLevel: mainAgent.inheritedThinkingLevel,
		status: mainAgent.inheritedFailure ? "failed" : mainAgent.pendingGoalIds.length > 0 ? "pending" : "active",
		...(mainAgent.inheritedFailure ? { error: mainAgent.inheritedFailure } : {}),
		pendingCount: mainAgent.pendingGoalIds.length,
		fallback: { models: fallbackModels, applies: true },
		stages: [],
		overrides: mainAgent.overrides.map((entry) => ({
			id: entry.goalId,
			label: entry.title,
			model: entry.effectiveModel ?? "",
			modelOverridden: entry.source === "override",
			thinkingLevel: entry.thinkingLevel,
			thinkingLevelOverridden: entry.thinkingLevelOverridden,
		})),
	}, ...TASK_MODEL_ROLES.map((role) => describeRole(role, settings, fallbackModels))];
}

/** Roles whose requests go through Telomi's stream layer, where the configured chain can run. */
const FALLBACK_CHAIN_ROLES: ReadonlySet<TaskModelRole> = new Set(["browserEvolution"]);

/**
 * A consuming role's effective model as the Runtime resolves it, and whether every Run has
 * adopted it. A Run freezes its selections at the start, so one still executing on a different
 * model is reported as pending rather than folded into a blanket success.
 */
function describeRole(role: TaskModelRole, settings: PiSettings, fallbackModels: string[]): ConsumerStatus {
	const info = TASK_MODEL_ROLE_INFO[role];
	const override = settings.taskModels?.[role]?.trim();
	// The role's own environment variable no longer participates: it was imported at startup.
	const resolved = resolveLLMConfig({ taskModelRole: role, settingsOverride: settings, envOverride: {} });
	const effectiveModel = override || resolved.model || "";
	// Native RLM children use the depth of their Root's current Stage.
	const stages = taskModelStages().filter((entry) => role === "primeChild"
		? entry.info.usesRlmChild === true
		: entry.role === role).map(({ role: thinkingRole, stage, key, info: stageInfo }) => {
		// The Run's own pins are per execution, so the page reads settings, not this process.
		const resolved = resolveStageThinkingLevel(thinkingRole, stage, {}, settings);
		return {
			key,
			label: stageInfo.label,
			thinkingLevel: resolved.thinkingLevel,
			source: resolved.source === "pinned" ? "override" as const : resolved.source,
		};
	});
	const runRole = (RUN_MODEL_ROLES as readonly string[]).includes(role) ? role as RunModelRole : undefined;
	// A Run that started on a different model or a different reasoning depth has not adopted this
	// configuration; both are frozen together, so both count.
	const definitionHash = modelDefinitionHash(effectiveModel);
	const pendingCount = pendingTaskModelSelections(role, effectiveModel, stages, definitionHash) + (runRole
		? activeRunModelSelections().filter((selection) => selection.models[runRole] !== effectiveModel
			|| selection.modelDefinitionHashes[runRole] !== definitionHash
			|| stages.some((entry) => entry.key in selection.stageThinkingLevels && selection.stageThinkingLevels[entry.key] !== entry.thinkingLevel)).length
		: 0);
	return {
		id: role,
		effectiveModel,
		source: override ? "override" : effectiveModel ? "settings" : "unset",
		thinkingLevel: "",
		status: pendingCount > 0 ? "pending" : "active",
		pendingCount,
		fallback: { models: fallbackModels, applies: FALLBACK_CHAIN_ROLES.has(role) },
		stages,
		overrides: override
			? [{
				id: role,
				label: info.label,
				model: override,
				modelOverridden: true,
				thinkingLevel: "",
				thinkingLevelOverridden: false,
			}]
			: [],
	};
}

/**
 * Background Memory replacements run one at a time, each against the settings current when it
 * starts, so a burst of default changes ends on the last one. Failures stay visible through
 * `describeConfiguration`. Resolves once the queued replacement has started or is waiting behind
 * a running one, so the answer already reports the Memory service as busy.
 */
let memoryApplyChain: Promise<void> = Promise.resolve();
function queueMemoryApply(memory: HindsightRuntimeManager): Promise<void> {
	memoryApplyChain = memoryApplyChain
		.then(() => memory.applyConfiguration(loadSettings()))
		.catch(() => undefined);
	return new Promise((resolve) => setImmediate(resolve));
}

export function mountProviderConfigApi(app: Express, deps: ProviderConfigDependencies): void {
	if (deps.memory) {
		const memory = deps.memory;
		app.get("/api/provider-config/memory", (_req, res) => {
			try { res.json(memory.describeConfiguration()); }
			catch { res.status(500).json({ error: "Unable to read Memory configuration" }); }
		});
		app.put("/api/provider-config/memory/pending", (req, res) => {
			try {
				const config = parseMemoryModels(req.body);
				const settings = loadSettings();
				settings.pendingMemoryModels = config;
				saveSettings(settings);
				res.json(memory.describeConfiguration());
			} catch (error) { res.status(400).json({ error: toErrorMessage(error) }); }
		});
		app.delete("/api/provider-config/memory/pending", (_req, res) => {
			try {
				const settings = loadSettings();
				delete settings.pendingMemoryModels;
				saveSettings(settings);
				res.json(memory.describeConfiguration());
			} catch (error) { res.status(500).json({ error: toErrorMessage(error) }); }
		});
		app.post("/api/provider-config/memory/apply", async (req, res) => {
			let candidate: PiSettings["memoryModels"];
			let staged: PiSettings["pendingMemoryModels"];
			try {
				const settings = loadSettings();
				const config = parseMemoryModels(req.body && Object.keys(req.body).length ? req.body : settings.pendingMemoryModels);
				candidate = config;
				const before = settings.memoryModels;
				staged = settings.pendingMemoryModels;
				await memory.applyConfiguration({ ...settings, memoryModels: config }, () => {
					const current = loadSettings();
					if (!isDeepStrictEqual(current.memoryModels, before) || !isDeepStrictEqual(readModelDefaults(current), readModelDefaults(settings))) throw new Error("Memory settings changed while applying");
					current.memoryModels = config;
					if (isDeepStrictEqual(current.pendingMemoryModels, staged)) delete current.pendingMemoryModels;
					saveSettings(current);
				});
				res.json(memory.describeConfiguration());
			} catch (error) {
				const current = loadSettings();
				if (candidate && isDeepStrictEqual(current.pendingMemoryModels, staged)) { current.pendingMemoryModels = candidate; saveSettings(current); }
				res.status(422).json({ ...memory.describeConfiguration(), error: toErrorMessage(error) });
			}
		});
	}

	app.get("/api/provider-config", async (_req: Request, res: Response) => {
		try {
			const settings = loadSettings();
			res.json(await buildResponse(settings, deps));
		} catch (err) {
			res.status(500).json({ error: toErrorMessage(err) });
		}
	});

	/**
	 * Apply: validate, then activate. A rejected selection leaves the active configuration
	 * unchanged, so a typo cannot break a working capability.
	 */
	app.post("/api/provider-config/apply", async (req: Request, res: Response) => {
		let settings: PiSettings;
		try {
			settings = loadSettings();
		} catch (err) {
			res.status(500).json({ error: toErrorMessage(err) });
			return;
		}
		const hasBody = req.body && typeof req.body === "object" && Object.keys(req.body).length > 0;
		// Applying nothing must not be read as "clear the configuration": that would silently
		// deactivate a working default.
		if (!hasBody) {
			res.status(400).json({ status: "failed", error: "no configuration to apply", ...await buildResponse(settings, deps) });
			return;
		}
		const parsed = parseModelDefaults(req.body);
		if (!parsed.ok) {
			res.status(400).json({ status: "failed", error: parsed.error, ...await buildResponse(settings, deps) });
			return;
		}
		const defaults: ModelDefaults = parsed.defaults ?? {};
		const before = readModelDefaults(settings);
		const validation = await validateModelDefaults(defaults);
		// Memory follows the global default but must not veto it: a user whose only connection cannot
		// serve memory (for example openai-codex) still needs a conversation model. The queued memory
		// apply below reports its own failure through `memoryConfiguration`.
		// Re-read after the await so a concurrent edit is not overwritten by a stale snapshot.
		try {
			settings = loadSettings();
		} catch (err) {
			res.status(500).json({ error: toErrorMessage(err) });
			return;
		}
		if (!validation.ok) {
			res.status(422).json({ status: "failed", error: validation.error, ...await buildResponse(settings, deps) });
			return;
		}
		if (!isDeepStrictEqual(readModelDefaults(settings), before)) {
			res.status(409).json({ status: "failed", error: "model defaults changed while this configuration was validated", ...await buildResponse(settings, deps) });
			return;
		}
		for (const field of ["defaultProvider", "defaultModel", "defaultThinkingLevel"] as const) {
			const value = defaults[field];
			if (value) settings[field] = value;
			else delete settings[field];
		}
		try {
			saveSettings(settings);
		} catch (err) {
			res.status(500).json({ error: toErrorMessage(err) });
			return;
		}
		// Memory follows the global default, and replacing its service drains and restarts it, which
		// takes seconds. That runs after this answer; `memoryConfiguration` reports its progress.
		if (deps.memory) await queueMemoryApply(deps.memory);
		const response = await buildResponse(settings, deps);
		const pending = response.consumers.some((consumer) => consumer.status === "pending");
		res.json({ status: pending ? "pending" : "active", ...response });
	});

	app.patch("/api/provider-config", async (req: Request, res: Response) => {
		const body = (req.body || {}) as {
			enabledModels?: unknown;
			providerFallbackModels?: unknown;
			taskModels?: unknown;
			stageThinkingLevels?: unknown;
		};

		const has = (k: keyof typeof body) => Object.prototype.hasOwnProperty.call(body, k);

		if (
			!has("enabledModels") &&
			!has("providerFallbackModels") &&
			!has("taskModels") &&
			!has("stageThinkingLevels")
		) {
			res.status(400).json({ error: "at least one provider setting is required" });
			return;
		}

		let settings: PiSettings;
		try {
			settings = loadSettings();
		} catch (err) {
			res.status(500).json({ error: toErrorMessage(err) });
			return;
		}

		const existingEnabled = Array.isArray(settings.enabledModels)
			? settings.enabledModels.filter((x): x is string => typeof x === "string")
			: [];
		const providers = await listAllProviders(existingEnabled);
		const knownProviders = new Set<string>(getBuiltinProviders());
		const validModelsByProvider = new Map(providers.map((p) => [p.id, new Set(p.models.map((m) => m.id))]));
		// Only the keys this request names are written, and onto the file as it is at write time:
		// the validation below awaits, and another settings save may land meanwhile.
		type PatchKey = "enabledModels" | "providerFallbackModels" | "taskModels" | "stageThinkingLevels";
		const patch: Partial<Pick<PiSettings, PatchKey>> = {};

		if (has("enabledModels")) {
			const v = body.enabledModels;
			if (!Array.isArray(v) || !v.every((x) => typeof x === "string")) {
				res.status(400).json({ error: "enabledModels must be a string[]" });
				return;
			}
			const invalid: string[] = [];
			for (const item of v as string[]) {
				const slashIdx = item.indexOf("/");
				if (slashIdx === -1) {
					invalid.push(item);
					continue;
				}
				const provider = item.slice(0, slashIdx);
				const model = item.slice(slashIdx + 1);
				if (!knownProviders.has(provider)) continue;
				const valid = validModelsByProvider.get(provider);
				if (!valid || !valid.has(model)) invalid.push(item);
			}
			if (invalid.length > 0) {
				res.status(400).json({ error: `unknown enabledModels entries: ${invalid.join(", ")}` });
				return;
			}
			patch.enabledModels = v.length === 0 ? undefined : (v as string[]);
		}

		if (has("providerFallbackModels")) {
			const v = body.providerFallbackModels;
			if (!Array.isArray(v) || !v.every((x) => typeof x === "string")) {
				res.status(400).json({ error: "providerFallbackModels must be a string[]" });
				return;
			}
			const invalid: string[] = [];
			const deduped: string[] = [];
			const seen = new Set<string>();
			for (const item of v as string[]) {
				const slashIdx = item.indexOf("/");
				if (slashIdx === -1) {
					invalid.push(item);
					continue;
				}
				const provider = item.slice(0, slashIdx);
				const model = item.slice(slashIdx + 1);
				const valid = validModelsByProvider.get(provider);
				if (!valid || !valid.has(model)) {
					invalid.push(item);
					continue;
				}
				if (!seen.has(item)) {
					seen.add(item);
					deduped.push(item);
				}
			}
			if (invalid.length > 0) {
				res.status(400).json({ error: `unknown providerFallbackModels entries: ${invalid.join(", ")}` });
				return;
			}
			// A fallback that cannot serve an LLM role would only turn one failure into another.
			for (const entry of deduped) {
				const slash = entry.indexOf("/");
				const usable = await validateModelDefaults({ defaultProvider: entry.slice(0, slash), defaultModel: entry.slice(slash + 1) });
				if (!usable.ok) {
					res.status(422).json({ error: `fallback model '${entry}': ${usable.error}` });
					return;
				}
			}
			patch.providerFallbackModels = deduped.length === 0 ? undefined : deduped;
		}

		if (has("taskModels")) {
			const value = body.taskModels;
			if (!value || typeof value !== "object" || Array.isArray(value)) {
				res.status(400).json({ error: "taskModels must be an object" });
				return;
			}
			const record = value as Record<string, unknown>;
			const unknownRole = Object.keys(record).find((role) =>
				!(TASK_MODEL_ROLES as readonly string[]).includes(role));
			if (unknownRole) {
				res.status(400).json({ error: `unknown taskModels role '${unknownRole}'` });
				return;
			}
			const taskModels: TaskModelSettings = {};
			for (const role of TASK_MODEL_ROLES) {
				const modelRef = record[role];
				if (modelRef === undefined || modelRef === null || modelRef === "") continue;
				if (typeof modelRef !== "string") {
					res.status(400).json({ error: `taskModels.${role} must be a provider/model string` });
					return;
				}
				const slash = modelRef.indexOf("/");
				const provider = modelRef.slice(0, slash);
				const model = modelRef.slice(slash + 1);
				if (slash <= 0 || !model || !validModelsByProvider.get(provider)?.has(model)) {
					res.status(400).json({ error: `unknown taskModels.${role} model '${modelRef}'` });
					return;
				}
				taskModels[role] = modelRef;
			}
			patch.taskModels = Object.keys(taskModels).length === 0 ? undefined : taskModels;
		}

		if (has("stageThinkingLevels")) {
			const value = body.stageThinkingLevels;
			if (!value || typeof value !== "object" || Array.isArray(value)) {
				res.status(400).json({ error: "stageThinkingLevels must be an object" });
				return;
			}
			const record = value as Record<string, unknown>;
			const declared = new Set(taskModelStages().map((entry) => entry.key));
			const unknownStage = Object.keys(record).find((key) => !declared.has(key));
			if (unknownStage) {
				res.status(400).json({ error: `unknown Run Stage '${unknownStage}'` });
				return;
			}
			const levels: NonNullable<PiSettings["stageThinkingLevels"]> = {};
			for (const key of declared) {
				const level = record[key];
				// An absent or cleared entry restores inheritance from the capability default.
				if (level === undefined || level === null || level === "") continue;
				if (!isThinkingLevel(level)) {
					res.status(400).json({
						error: `invalid ${key} reasoning depth '${String(level)}' (allowed: ${THINKING_LEVELS.join(", ")})`,
					});
					return;
				}
				levels[key] = { level };
			}
			patch.stageThinkingLevels = Object.keys(levels).length === 0 ? undefined : levels;
		}

		try {
			settings = loadSettings();
			for (const key of Object.keys(patch) as PatchKey[]) {
				const value = patch[key];
				if (value === undefined) delete settings[key];
				else (settings as Record<PatchKey, unknown>)[key] = value;
			}
			saveSettings(settings);
		} catch (err) {
			res.status(500).json({ error: toErrorMessage(err) });
			return;
		}

		res.json(await buildResponse(settings, deps));
	});
}
