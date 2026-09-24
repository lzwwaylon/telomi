import { isDeepStrictEqual } from "node:util";
import { isRecord } from "../../lib/values.js";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { type PiSettings } from "../../config/settings.js";
import { resolveAgentPath } from "../../config/agent-directory.js";
import { testCandidateCredential } from "../../agent-runtime/model-connectivity.js";
import { isThinkingLevel, resolveLLMConfig } from "../../agent-runtime/model-config/resolve.js";
import { anonymousConnectionApiKey, loadCustomProviders } from "../../providers/custom-models.js";
import { isProviderCredentialDeleted } from "../../config/credential-tombstones.js";

export const MEMORY_ROLES = ["llm", "retain", "reflect", "consolidation"] as const;
export type MemoryRole = typeof MEMORY_ROLES[number];
export interface MemoryModelOverride { model?: string; reasoningEffort?: string }
export type MemoryModelSettings = Record<MemoryRole, MemoryModelOverride>;
/** Serves until the page saves a selection: every role inherits the global LLM default. */
export const DEFAULT_MEMORY_MODELS: MemoryModelSettings = { llm: {}, retain: {}, reflect: {}, consolidation: {} };
export interface MemoryModelSelection { model: string | null; reasoningEffort: string; source: "override" | "memory" | "settings" }
export type ResolvedMemoryModels = Record<MemoryRole, MemoryModelSelection>;

export function resolveMemoryModels(settings: PiSettings): ResolvedMemoryModels {
	const config = settings.memoryModels ?? DEFAULT_MEMORY_MODELS;
	const inherited = resolveLLMConfig({ settingsOverride: settings });
	const llm: MemoryModelSelection = {
		model: config.llm?.model || inherited.model,
		reasoningEffort: config.llm?.reasoningEffort || inherited.thinkingLevel || "off",
		source: config.llm?.model ? "override" : "settings",
	};
	const result = { llm } as ResolvedMemoryModels;
	for (const role of ["retain", "reflect", "consolidation"] as const) {
		result[role] = { model: config[role]?.model || llm.model, reasoningEffort: config[role]?.reasoningEffort || llm.reasoningEffort, source: config[role]?.model ? "override" : "memory" };
	}
	return result;
}

export function parseMemoryModels(value: unknown): MemoryModelSettings {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Memory settings must be an object");
	const input = value as Record<string, unknown>;
	// The reranker is Hindsight's own default now; a selection saved by an earlier version is dropped.
	if (Object.keys(input).some((key) => ![...MEMORY_ROLES, "reranker"].includes(key))) throw new Error("Unknown Memory setting");
	const result = {} as MemoryModelSettings;
	for (const role of MEMORY_ROLES) {
		const item = input[role] ?? {};
		if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error(`${role} must be an object`);
		const fields = item as Record<string, unknown>;
		// Sampling temperature is the model's own; a value saved by an earlier version is dropped.
		if (Object.keys(fields).some((key) => !["model", "reasoningEffort", "temperature"].includes(key))) throw new Error(`Unsupported ${role} parameter`);
		result[role] = {};
		for (const field of ["model", "reasoningEffort"] as const) {
			const value = fields[field];
			if (value == null || value === "") continue;
			if (typeof value !== "string" || value.length > 512) throw new Error(`Invalid ${role}.${field}`);
			result[role][field] = value.trim();
		}
		if (result[role].model && !/^([^/]+)\/(.+)$/u.test(result[role].model!)) throw new Error(`${role} requires connection/model`);
		if (result[role].reasoningEffort && !isThinkingLevel(result[role].reasoningEffort)) throw new Error(`Invalid ${role} reasoning effort`);
	}
	return result;
}

/** Credential values may rotate; the selected connection definition must remain the same. */
function connectionIdentity(provider: string, modelId: string): unknown {
	let entry;
	try { entry = loadCustomProviders().providers?.[provider]; }
	catch { throw new Error("Unable to read Memory connection configuration"); }
	if (!entry) return null;
	const { apiKey: _key, models, modelOverrides, ...connection } = entry;
	return { connection, model: models?.find((model) => model.id === modelId),
		override: isRecord(modelOverrides) ? modelOverrides[modelId] : undefined };
}

/** Model APIs Hindsight has a native client for, with the path that client appends to its base URL. */
export const MEMORY_API_PATHS: Record<string, string> = {
	"openai-completions": "chat/completions",
	"anthropic-messages": "v1/messages",
	"openai-responses": "responses",
};

function loadModelRuntime(provider: string) {
	return ModelRuntime.create({ authPath: resolveAgentPath("auth.json"), modelsPath: resolveAgentPath("models.json") }).catch(() => { throw new Error(`Unable to load Memory connection '${provider}'`); });
}

/** The Hindsight client matching the model's API; an unresolvable model keeps the OpenAI client and fails per request. */
export async function memoryClientProvider(selection: string): Promise<string> {
	const provider = selection.slice(0, selection.indexOf("/"));
	const api = await loadModelRuntime(provider).then((runtime) => runtime.getModel(provider, selection.slice(provider.length + 1))?.api, () => undefined);
	if (api === "anthropic-messages") return "anthropic";
	if (api === "openai-responses") return "openai-responses";
	return ["deepseek", "groq", "openrouter"].includes(provider) ? provider : "openai";
}

export async function memoryConnection(selection: string, apis: readonly string[] = Object.keys(MEMORY_API_PATHS)) {
	const split = selection.indexOf("/");
	if (split < 1) throw new Error("Memory model must specify connection/model");
	const provider = selection.slice(0, split);
	const modelId = selection.slice(split + 1);
	if (loadCustomProviders().providers?.[provider]?.capability) throw new Error("Audio service connections cannot serve Memory models");
	const identity = connectionIdentity(provider, modelId);
	const assertCurrent = () => {
		if (isProviderCredentialDeleted(provider)) throw new Error(`Memory connection '${provider}' credential was deleted`);
		if (!isDeepStrictEqual(identity, connectionIdentity(provider, modelId))) throw new Error(`Memory connection '${provider}' changed during authorization; retry the request`);
	};
	assertCurrent();
	const runtime = await loadModelRuntime(provider);
	assertCurrent();
	const model = runtime.getModel(provider, modelId);
	if (!model) throw new Error(`Memory model '${selection}' is unavailable`);
	if (!apis.includes(model.api)) throw new Error(`Memory cannot use ${provider} models ('${model.api}' is unsupported); choose a model from a connection using ${apis.join(", ")}`);
	// The gateway resolves its URL and authorization from its own environment, which the transport does not reproduce.
	if (provider === "cloudflare-ai-gateway") throw new Error("Memory cannot use Cloudflare AI Gateway connections");
	const auth = await runtime.getAuth(model).catch(() => { throw new Error(`Unable to authorize Memory connection '${provider}'`); });
	assertCurrent();
	const apiKey = auth?.auth.apiKey || anonymousConnectionApiKey(provider);
	if (!apiKey) throw new Error(`Memory connection '${provider}' has no API key`);
	const anthropic = model.api === "anthropic-messages";
	// Subscription tokens are only accepted for requests that carry Claude Code's identity, which Hindsight does not send.
	if (anthropic && apiKey.includes("sk-ant-oat")) throw new Error("Memory cannot use an Anthropic subscription login; connect with an API key");
	// Match native client header precedence: explicit headers override key auth, null removes.
	const overrides: Record<string, string | null> = {};
	for (const source of [model.headers, auth?.auth.headers]) {
		for (const [name, value] of Object.entries(source ?? {})) overrides[name.toLowerCase()] = value;
	}
	const keyHeader: Record<string, string> = anthropic && provider !== "github-copilot" ? { "x-api-key": apiKey } : { authorization: `Bearer ${apiKey}` };
	const normalizedHeaders = new Headers({ "content-type": "application/json", ...keyHeader });
	for (const [name, value] of Object.entries(overrides)) {
		if (value === null) normalizedHeaders.delete(name);
		else normalizedHeaders.set(name, value);
	}
	const headers: Record<string, string> = {};
	normalizedHeaders.forEach((value, name) => { headers[name] = value; });
	return { model: { ...model, headers: undefined }, apiKey, headers, nativeHeaders: { ...headers, ...overrides }, assertCurrent };
}

/** `active` is what the running service already uses; roles still on the same model skip the connectivity probe. */
export async function validateMemoryModels(settings: PiSettings, connectivity = false, active?: ResolvedMemoryModels | null): Promise<ResolvedMemoryModels> {
	parseMemoryModels(settings.memoryModels ?? DEFAULT_MEMORY_MODELS);
	const resolved = resolveMemoryModels(settings);
	const checked = new Set<string>();
	for (const role of MEMORY_ROLES) {
		const selection = resolved[role];
		if (selection.reasoningEffort === "max") throw new Error(`Memory ${role} does not support max reasoning effort; select a supported override`);
		if (!selection.model) throw new Error(`Configure the Memory ${role} model or global LLM default`);
		const connection = await memoryConnection(selection.model);
		if (connectivity && !checked.has(selection.model) && selection.model !== active?.[role].model) {
			connection.assertCurrent();
			const result = await testCandidateCredential(connection.model, { apiKey: connection.apiKey, headers: connection.nativeHeaders });
			if (!result.ok) throw new Error(`Memory ${role} connection validation failed`);
			connection.assertCurrent();
			checked.add(selection.model);
		}
	}
	return resolved;
}
