import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type {
	Api,
	AssistantMessageEventStream,
	Credential,
	Context,
	Model,
	ProviderHeaders,
	SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import {
	ModelRegistry,
	ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import { streamRegistryModel } from "../agent-runtime/pi-ai.js";
import { anonymousConnectionApiKey } from "../providers/custom-models.js";
import { classifyProviderError } from "./error-classify.js";
import { accountManagerFor, hasAccountChain, type ProviderAccountManager } from "./manager.js";
import type { AccountCredential, ProviderErrorClass } from "./types.js";
import { toErrorMessage } from "../lib/values.js";
import { scrubResearchModelError } from "../agent-runtime/models/error-classifier.js";
import { redactSecret } from "../agent-runtime/model-connectivity.js";
import type { ModelSwitch } from "../../shared/model-switch.js";

export type { ModelSwitch };

type FallbackModelRegistry = Pick<ModelRegistry, "find" | "getApiKeyAndHeaders">;

export interface StreamWithAccountFallbackArgs<TApi extends Api> {
	model: Model<TApi>;
	context: Context;
	options?: SimpleStreamOptions;
	modelRegistry: FallbackModelRegistry;
	/** Disable the settings-level provider chain when the caller owns model fallback policy. */
	providerFallback?: boolean;
	/** The execution-owned chain, frozen by the caller for its turn or Run; an empty chain means explicit failure. */
	providerFallbackModels?: readonly string[];
	/** Called for every account failover or model fallback, in order, before the next attempt. */
	onSwitch?: (event: ModelSwitch) => void;
}

const DEFAULT_TRANSIENT_RETRIES = 1;

/**
 * Wraps streamSimple with per-provider multi-account fallback.
 *
 * - Providers without an account chain go through unchanged.
 * - Providers with a chain: starts at the chain head, resolves each account in a
 *   request-local ModelRuntime, classifies errors, and rotates to the next
 *   chain entry on auth/quota errors.
 * - Per-request sticky: rotation state lives in the local `tried` set; the
 *   manager's activeId is only changed when a successful account differs from
 *   one in cooldown — every request restarts from the chain head otherwise.
 * - Once any output token has been yielded, we no longer fall back (stream is
 *   committed; switching account would re-emit duplicate prefix). Caller sees
 *   the error event mid-stream.
 *
 * Returns the same `AssistantMessageEventStream` type as `streamSimple`, so
 * pi-agent-core's Agent consumes it transparently.
 */
export function streamWithAccountFallback<TApi extends Api>(
	args: StreamWithAccountFallbackArgs<TApi>,
): AssistantMessageEventStream {
	const { model, context, options, modelRegistry, onSwitch } = args;
	const providerFallbackChain = args.providerFallback === false
		? [model as unknown as Model<Api>]
		: resolveProviderFallbackChain(model, modelRegistry, args.providerFallbackModels);

	if (providerFallbackChain.length > 1) {
		return runProviderFallbackStream({
			models: providerFallbackChain,
			context,
			options,
			modelRegistry,
			onSwitch,
		});
	}

	if (!hasAccountChain(model.provider)) {
		return runVanillaStream(model, context, options, modelRegistry);
	}

	const out = createAssistantMessageEventStream();
	void runAccountFallbackLoop({ model, context, options, out, onSwitch }).catch((err) => {
		// Defensive: any uncaught rejection above this point shouldn't strand the
		// consumer; propagate as a synthetic error event.
		const message = toErrorMessage(err);
		out.push({
			type: "error",
			reason: "error",
			error: {
				role: "assistant",
				content: [],
				api: model.api,
				provider: model.provider,
				model: model.id,
				usage: emptyUsage(),
				stopReason: "error",
				errorMessage: message,
				timestamp: Date.now(),
			} as never,
		});
		out.end();
	});
	return out;
}

function resolveProviderFallbackChain<TApi extends Api>(
	model: Model<TApi>,
	modelRegistry: FallbackModelRegistry,
	explicitFallbacks?: readonly string[],
): Model<Api>[] {
	const chain: Model<Api>[] = [model as unknown as Model<Api>];
	const rawFallbacks: readonly string[] = explicitFallbacks ?? [];
	const seen = new Set(chain.map((m) => `${m.provider}/${m.id}`));
	for (const entry of rawFallbacks) {
		const reference = entry.trim();
		const slash = reference.indexOf("/");
		const provider = reference.slice(0, slash);
		const modelId = reference.slice(slash + 1);
		const key = `${provider}/${modelId}`;
		if (seen.has(key)) continue;
		const resolved = modelRegistry.find(provider, modelId);
		if (!resolved) continue;
		seen.add(key);
		chain.push(resolved as unknown as Model<Api>);
	}
	return chain;
}

interface ProviderFallbackStreamArgs {
	models: Model<Api>[];
	context: Context;
	options?: SimpleStreamOptions;
	modelRegistry: FallbackModelRegistry;
	onSwitch?: (event: ModelSwitch) => void;
}

function runProviderFallbackStream(args: ProviderFallbackStreamArgs): AssistantMessageEventStream {
	const out = createAssistantMessageEventStream();
	void runProviderFallbackLoop({ ...args, out }).catch((err) => {
		const message = toErrorMessage(err);
		emitErrorAndEnd(out, args.models[0], message);
	});
	return out;
}

interface ProviderFallbackLoopArgs extends ProviderFallbackStreamArgs {
	out: AssistantMessageEventStream;
}

async function runProviderFallbackLoop(args: ProviderFallbackLoopArgs): Promise<void> {
	const { models, context, options, modelRegistry, out, onSwitch } = args;
	let lastRetryableError: { model: Model<Api>; message: string } | null = null;

	for (const candidate of models) {
		if (lastRetryableError) {
			onSwitch?.({ kind: "model", from: modelRef(lastRetryableError.model), to: modelRef(candidate), reason: scrubResearchModelError(lastRetryableError.message) });
		}
		const outcome =
			hasAccountChain(candidate.provider)
				? await pumpAccountProviderAttempt(candidate, context, options, out, onSwitch)
				: await pumpVanillaProviderAttempt(candidate, context, options, modelRegistry, out);

		switch (outcome.kind) {
			case "ok":
				out.end();
				return;
			case "auth-or-quota":
			case "transient":
				lastRetryableError = { model: candidate, message: outcome.message };
				continue;
			case "permanent":
				emitErrorAndEnd(out, candidate, outcome.message);
				return;
			case "committed-error":
				out.end();
				return;
		}
	}

	const last = lastRetryableError;
	const message = last
		? `All configured provider fallback models failed; last error from ${last.model.provider}/${last.model.id}: ${last.message}`
		: "All configured provider fallback models failed";
	emitErrorAndEnd(out, models[0], message);
}

interface LoopArgs<TApi extends Api> {
	model: Model<TApi>;
	context: Context;
	options?: SimpleStreamOptions;
	out: AssistantMessageEventStream;
	onSwitch?: (event: ModelSwitch) => void;
}

function modelRef(model: Model<Api>): string {
	return `${model.provider}/${model.id}`;
}

/** Reports a move to another account of the same model once the previous account has failed. */
function accountSwitchReporter(model: Model<Api>, onSwitch: ((event: ModelSwitch) => void) | undefined) {
	let failed: { accountId: string; message: string } | null = null;
	return {
		failed(accountId: string, message: string) { failed = { accountId, message }; },
		trying(accountId: string) {
			if (failed && failed.accountId !== accountId) {
				onSwitch?.({ kind: "account", from: `${modelRef(model)} (account ${failed.accountId})`, to: `${modelRef(model)} (account ${accountId})`, reason: scrubResearchModelError(failed.message) });
			}
			failed = null;
		},
	};
}

async function runAccountFallbackLoop<TApi extends Api>(args: LoopArgs<TApi>): Promise<void> {
	const { model, context, options, out, onSwitch } = args;
	const manager = accountManagerFor(model.provider);
	await manager.load();
	const tried = new Set<string>();
	let lastError: { class: ProviderErrorClass; message: string } | null = null;
	let transientRetriesLeft = transientRetryLimit(options);
	const switches = accountSwitchReporter(model as unknown as Model<Api>, onSwitch);

	while (true) {
		const candidate = manager.pickFallbackCandidate(tried);
		if (!candidate) {
			const errMsg = lastError
				? `所有 ${model.provider} 账号都不可用 (最后错误: ${lastError.message})`
				: manager.hasAnyAccount()
					? `所有 ${model.provider} 账号都在冷却或已尝试`
					: `未配置 ${model.provider} 账号,请先在 设置 → 连接 中添加`;
			emitErrorAndEnd(out, model, errMsg);
			return;
		}
		const accountId = candidate.account.id;
		switches.trying(accountId);

		const auth = await resolveCandidateAuth(manager, accountId, candidate.credentialSnapshot, model);
		if (!auth.ok) {
			const cls = classifyProviderError(auth.error);
			lastError = { class: cls, message: auth.error };
			void manager.recordFailure(accountId, cls, auth.error);
			if (cls === "permanent") {
				emitErrorAndEnd(out, model, auth.error);
				return;
			}
			tried.add(accountId);
			switches.failed(accountId, auth.error);
			continue;
		}

		const callOptions: SimpleStreamOptions = {
			...(options as SimpleStreamOptions | undefined),
			apiKey: auth.apiKey,
			headers:
				auth.headers || options?.headers
					? {
							...(auth.headers as Record<string, string> | undefined),
							...(options?.headers as Record<string, string> | undefined),
						}
					: undefined,
		};

		const outcome = await pumpAttempt(model, context, callOptions, out, accountId, classifyProviderError);
		switch (outcome.kind) {
			case "ok":
				out.end();
				return;
			case "auth-or-quota": {
				lastError = { class: outcome.errorClass, message: outcome.message };
				tried.add(accountId);
				void manager.recordFailure(accountId, outcome.errorClass, outcome.message);
				switches.failed(accountId, outcome.message);
				continue;
			}
			case "transient": {
				lastError = { class: "transient", message: outcome.message };
				if (transientRetriesLeft > 0) {
					transientRetriesLeft -= 1;
					continue;
				}
				void manager.recordFailure(accountId, "transient", outcome.message);
				tried.add(accountId);
				switches.failed(accountId, outcome.message);
				continue;
			}
			case "permanent": {
				void manager.recordFailure(accountId, "permanent", outcome.message);
				emitErrorAndEnd(out, model, outcome.message);
				return;
			}
			case "committed-error": {
				void manager.recordFailure(accountId, outcome.errorClass, outcome.message);
				out.end();
				return;
			}
		}
	}
}

async function pumpAccountProviderAttempt(
	model: Model<Api>,
	context: Context,
	options: SimpleStreamOptions | undefined,
	out: AssistantMessageEventStream,
	onSwitch?: (event: ModelSwitch) => void,
): Promise<AttemptOutcome> {
	const manager = accountManagerFor(model.provider);
	await manager.load();
	const tried = new Set<string>();
	let lastError: { class: ProviderErrorClass; message: string } | null = null;
	let transientRetriesLeft = transientRetryLimit(options);
	const switches = accountSwitchReporter(model, onSwitch);

	while (true) {
		const candidate = manager.pickFallbackCandidate(tried);
		if (!candidate) {
			const message = lastError
				? `all ${model.provider} accounts unavailable (last error: ${lastError.message})`
				: manager.hasAnyAccount()
					? `all ${model.provider} accounts are cooling down or already tried`
					: `no ${model.provider} accounts configured`;
			if (lastError?.class === "permanent") return { kind: "permanent", message };
			if (lastError?.class === "transient") return { kind: "transient", message };
			return { kind: "auth-or-quota", errorClass: lastError?.class === "auth" ? "auth" : "quota", message };
		}
		const accountId = candidate.account.id;
		switches.trying(accountId);

		const auth = await resolveCandidateAuth(manager, accountId, candidate.credentialSnapshot, model);
		if (!auth.ok) {
			const cls = classifyProviderError(auth.error);
			lastError = { class: cls, message: auth.error };
			void manager.recordFailure(accountId, cls, auth.error);
			if (cls === "permanent") return { kind: "permanent", message: auth.error };
			tried.add(accountId);
			switches.failed(accountId, auth.error);
			continue;
		}

		const callOptions: SimpleStreamOptions = {
			...(options as SimpleStreamOptions | undefined),
			apiKey: auth.apiKey,
			headers:
				auth.headers || options?.headers
					? {
							...(auth.headers as Record<string, string> | undefined),
							...(options?.headers as Record<string, string> | undefined),
						}
					: undefined,
		};

		const outcome = await pumpAttempt(model, context, callOptions, out, accountId, classifyProviderError);
		switch (outcome.kind) {
			case "ok":
			case "permanent":
			case "committed-error":
				return outcome;
			case "auth-or-quota":
				lastError = { class: outcome.errorClass, message: outcome.message };
				tried.add(accountId);
				void manager.recordFailure(accountId, outcome.errorClass, outcome.message);
				switches.failed(accountId, outcome.message);
				continue;
			case "transient":
				lastError = { class: "transient", message: outcome.message };
				if (transientRetriesLeft > 0) {
					transientRetriesLeft -= 1;
					continue;
				}
				void manager.recordFailure(accountId, "transient", outcome.message);
				tried.add(accountId);
				switches.failed(accountId, outcome.message);
				continue;
		}
	}
}

type ResolvedAccountAuth =
	| { ok: true; apiKey?: string; headers?: ProviderHeaders; env?: Record<string, string> }
	| { ok: false; error: string };
const accountAuthChains = new Map<string, Promise<unknown>>();

function resolveCandidateAuth<TApi extends Api>(
	manager: ProviderAccountManager,
	accountId: string,
	fallbackCredential: AccountCredential,
	model: Model<TApi>,
): Promise<ResolvedAccountAuth> {
	return serializeAccountAuth(accountId, async () => {
		const credential = manager.getCredential(accountId)
			?? fallbackCredential;
		const credentials = new InMemoryCredentialStore();
		await credentials.modify(model.provider, async () => credential as Credential);
		const runtime = await ModelRuntime.create({
			credentials,
			modelsPath: null,
			refreshOnCreate: false,
		});
		const resolved = await runtime.getAuth(model);
		const auth: ResolvedAccountAuth = resolved
			? {
					ok: true,
					apiKey: resolved.auth.apiKey,
					headers: resolved.auth.headers,
					env: resolved.env,
				}
			: { ok: false, error: `${model.provider} credential could not be resolved` };
		const refreshed = await credentials.read(model.provider);
		if (refreshed && JSON.stringify(refreshed) !== JSON.stringify(credential)) {
			await manager.updateCredential(accountId, refreshed as AccountCredential);
		}
		return auth;
	});
}

function serializeAccountAuth<T>(accountId: string, action: () => Promise<T>): Promise<T> {
	const previous = accountAuthChains.get(accountId) ?? Promise.resolve();
	const current = previous.catch(() => undefined).then(action);
	accountAuthChains.set(accountId, current);
	return current.finally(() => {
		if (accountAuthChains.get(accountId) === current) accountAuthChains.delete(accountId);
	});
}

function transientRetryLimit(options: SimpleStreamOptions | undefined): number {
	const configured = options?.maxRetries;
	return typeof configured === "number" && Number.isFinite(configured)
		? Math.max(0, Math.floor(configured))
		: DEFAULT_TRANSIENT_RETRIES;
}

type AttemptOutcome =
	| { kind: "ok" }
	| { kind: "auth-or-quota"; errorClass: "auth" | "quota"; message: string }
	| { kind: "transient"; message: string }
	| { kind: "permanent"; message: string }
	| { kind: "committed-error"; errorClass: ProviderErrorClass; message: string };

async function pumpAttempt<TApi extends Api>(
	model: Model<TApi>,
	context: Context,
	options: SimpleStreamOptions,
	out: AssistantMessageEventStream,
	accountId?: string,
	classifyError: (message: string) => ProviderErrorClass = classifyProviderError,
): Promise<AttemptOutcome> {
	let yieldedAny = false;
	// An upstream may echo the credential it rejected; redact the one this request actually sent.
	const redact = (text: string) => (options.apiKey ? redactSecret(text, options.apiKey) : text);
	try {
		const stream = streamRegistryModel(model, context, options);
		for await (const ev of fairlyScheduled(stream)) {
			if (ev.type === "error") {
				const message = redact(ev.error?.errorMessage || "stream error");
				const cls = classifyError(message);
				if (yieldedAny) {
					out.push(ev);
					return { kind: "committed-error", errorClass: cls, message };
				}
				if (cls === "auth" || cls === "quota") {
					return { kind: "auth-or-quota", errorClass: cls, message };
				}
				if (cls === "transient") {
					return { kind: "transient", message };
				}
				out.push(ev);
				return { kind: "permanent", message };
			}
			out.push(ev);
			if (
				ev.type === "text_delta" ||
				ev.type === "thinking_delta" ||
				ev.type === "toolcall_delta" ||
				ev.type === "text_end" ||
				ev.type === "thinking_end" ||
				ev.type === "toolcall_end"
			) {
				yieldedAny = true;
			}
			if (ev.type === "done") {
				if (accountId) void accountManagerFor(model.provider).recordSuccess(accountId);
				return { kind: "ok" };
			}
		}
		if (yieldedAny) {
			if (accountId) void accountManagerFor(model.provider).recordSuccess(accountId);
			return { kind: "ok" };
		}
		return { kind: "transient", message: "stream ended without done event" };
	} catch (err) {
		const message = redact(toErrorMessage(err));
		const cls = classifyError(message);
		if (yieldedAny) {
			throw err;
		}
		if (cls === "auth" || cls === "quota") return { kind: "auth-or-quota", errorClass: cls, message };
		if (cls === "transient") return { kind: "transient", message };
		return { kind: "permanent", message };
	}
}

async function pumpVanillaProviderAttempt<TApi extends Api>(
	model: Model<TApi>,
	context: Context,
	options: SimpleStreamOptions | undefined,
	modelRegistry: FallbackModelRegistry,
	out: AssistantMessageEventStream,
): Promise<AttemptOutcome> {
	const auth = await modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok) {
		const cls = classifyVanillaError(auth.error);
		if (cls === "auth" || cls === "quota") return { kind: "auth-or-quota", errorClass: cls, message: auth.error };
		if (cls === "transient") return { kind: "transient", message: auth.error };
		return { kind: "permanent", message: auth.error };
	}
	const callOptions: SimpleStreamOptions = {
		...(options as SimpleStreamOptions | undefined),
		// A connection the user declared as anonymous still needs pi's client-side placeholder.
		apiKey: auth.apiKey ?? anonymousConnectionApiKey(model.provider),
		headers:
			auth.headers || options?.headers
				? {
						...(auth.headers as Record<string, string> | undefined),
						...(options?.headers as Record<string, string> | undefined),
					}
				: undefined,
	};
	return pumpAttempt(model, context, callOptions, out, undefined, classifyVanillaError);
}

function classifyVanillaError(message: string): ProviderErrorClass {
	const text = message.toLowerCase();
	if (
		text.includes("rate limit") ||
		text.includes("429") ||
		text.includes("quota") ||
		text.includes("usage limit") ||
		text.includes("insufficient_quota") ||
		text.includes("billing")
	) {
		return "quota";
	}
	if (
		text.includes("unauthorized") ||
		text.includes("forbidden") ||
		text.includes("401") ||
		text.includes("403") ||
		text.includes("api key") ||
		text.includes("apikey") ||
		text.includes("invalid key") ||
		text.includes("authentication")
	) {
		return "auth";
	}
	if (
		text.includes("timeout") ||
		text.includes("timed out") ||
		text.includes("econnreset") ||
		text.includes("econnrefused") ||
		text.includes("enotfound") ||
		text.includes("socket hang up") ||
		text.includes("503") ||
		text.includes("502") ||
		text.includes("500") ||
		text.includes("temporarily unavailable") ||
		text.includes("overloaded")
	) {
		return "transient";
	}
	return "permanent";
}

function runVanillaStream<TApi extends Api>(
	model: Model<TApi>,
	context: Context,
	options: SimpleStreamOptions | undefined,
	modelRegistry: FallbackModelRegistry,
): AssistantMessageEventStream {
	const out = createAssistantMessageEventStream();
	void (async () => {
		try {
			const auth = await modelRegistry.getApiKeyAndHeaders(model);
			if (!auth.ok) {
				emitErrorAndEnd(out, model, auth.error);
				return;
			}
			const callOptions: SimpleStreamOptions = {
				...(options as SimpleStreamOptions | undefined),
				// A connection the user declared as anonymous still needs pi's client-side placeholder.
				apiKey: auth.apiKey ?? anonymousConnectionApiKey(model.provider),
				headers:
					auth.headers || options?.headers
						? {
								...(auth.headers as Record<string, string> | undefined),
								...(options?.headers as Record<string, string> | undefined),
							}
						: undefined,
			};
			const stream = streamRegistryModel(model, context, callOptions);
			for await (const ev of fairlyScheduled(stream)) {
				out.push(ev);
				if (ev.type === "done" || ev.type === "error") {
					out.end();
					return;
				}
			}
			out.end();
		} catch (err) {
			emitErrorAndEnd(out, model, toErrorMessage(err));
		}
	})();
	return out;
}

/**
 * Network model streams can deliver long bursts through the Promise microtask
 * queue. With many concurrent Agents, draining those bursts without a
 * macrotask boundary starves the HTTP server and its SSE connections.
 */
export async function* fairlyScheduled<T>(source: AsyncIterable<T>): AsyncGenerator<T> {
	for await (const event of source) {
		yield event;
		await new Promise<void>((resolve) => setImmediate(resolve));
	}
}

function emitErrorAndEnd(
	out: AssistantMessageEventStream,
	model: Model<Api>,
	message: string,
): void {
	out.push({
		type: "error",
		reason: "error",
		error: {
			role: "assistant",
			content: [],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: emptyUsage(),
			stopReason: "error",
			errorMessage: message,
			timestamp: Date.now(),
		} as never,
	});
	out.end();
}

function emptyUsage() {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		total: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}
