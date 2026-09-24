import type { Api, Model } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { composeAgentSystemPrompt } from "./global-system-prompt.js";
import { ResearchModelGateway } from "./models/model-gateway.js";
import { completeRegistryModel } from "./pi-ai.js";
import { renderAgentPrompt } from "./prompt-registry.js";
import { toErrorMessage } from "../lib/values.js";
import { recordModelVerdict } from "./model-config/model-verdicts.js";

export interface ModelTestResult {
	ok: boolean;
	error?: string;
	durationMs: number;
}

/**
 * Look up one model in the registry the product actually runs on. Both the connection check and
 * the capability-default check need the same lookup and the same failure wording.
 */
export async function resolveRegistryModel(
	provider: string,
	modelId: string,
	paths: { authPath: string; modelsPath: string },
): Promise<{ ok: true; model: Model<Api> } | { ok: false; error: string }> {
	try {
		const runtime = await ModelRuntime.create({ authPath: paths.authPath, modelsPath: paths.modelsPath });
		const loadError = runtime.getError();
		if (loadError) return { ok: false, error: `models.json load error: ${loadError}` };
		const model = runtime.getModel(provider, modelId);
		if (!model) return { ok: false, error: `model '${provider}/${modelId}' is not available` };
		return { ok: true, model };
	} catch (error) {
		return { ok: false, error: toErrorMessage(error) };
	}
}

/**
 * Remove a secret from text meant for a response or a log. Providers routinely quote the rejected
 * key back, in full or as a head and tail fragment, so the diagnostic must be scrubbed before it
 * leaves this module.
 */
export function redactSecret(text: string, secret: string): string {
	if (!secret) return text;
	const fragments = [secret, ...(secret.length >= 16 ? [secret.slice(0, 8), secret.slice(-8)] : [])];
	let out = text;
	for (const fragment of fragments) {
		out = out.split(fragment).join("[redacted]");
	}
	return out;
}

/**
 * The authorization a candidate connection would use. An API key comes from the form, OAuth
 * headers come from resolving the staged credential; a local endpoint legitimately has neither.
 */
export interface CandidateAuthorization {
	apiKey?: string;
	headers?: Record<string, string | null>;
}

/**
 * Probe a *candidate* credential without storing it anywhere.
 *
 * Activation must not publish a credential it has not checked, so the key travels as a per-request
 * auth override: no consumer, concurrent request or competing edit can pick it up, and a failure
 * leaves the active credential untouched because nothing was written. The verdict comes from the
 * Provider's own answer; a locally well-formed key proves nothing. Only a completed answer counts
 * as a pass, so a timeout or an abort is a failure rather than a silent success.
 */
export async function testCandidateCredential(
	model: Model<Api>,
	auth: CandidateAuthorization,
	opts: { timeoutMs?: number } = {},
): Promise<ModelTestResult> {
	const start = Date.now();
	const secrets = [auth.apiKey ?? "", ...Object.values(auth.headers ?? {}).filter((value): value is string => typeof value === "string")];
	for (const [name, value] of Object.entries(auth.headers ?? {})) {
		if (typeof value === "string" && /^(?:proxy-)?authorization$/iu.test(name)) {
			const token = /^(?:Bearer|Basic|Token)\s+(.+)$/iu.exec(value)?.[1];
			if (token) secrets.push(token);
		}
	}
	const failure = (message: string): ModelTestResult => ({
		ok: false,
		error: secrets.reduce((text, secret) => redactSecret(text, secret), message),
		durationMs: Date.now() - start,
	});
	try {
		const result = await completeRegistryModel(
			model,
			{
				systemPrompt: composeAgentSystemPrompt(
					renderAgentPrompt("main", "model-connectivity-test", "system").content,
				),
				messages: [{
					role: "user",
					content: renderAgentPrompt("main", "model-connectivity-test", "user").content,
					timestamp: Date.now(),
				}],
			},
			{
				...(auth.apiKey ? { apiKey: auth.apiKey } : {}),
				...(auth.headers ? { headers: auth.headers } : {}),
				maxTokens: 64,
				signal: AbortSignal.timeout(opts.timeoutMs ?? 45_000),
			},
		);
		if (result.stopReason === "error") {
			return failure(result.errorMessage ?? "the Provider rejected the credential");
		}
		if (result.stopReason === "aborted") return failure("the connection test was aborted");
		return { ok: true, durationMs: Date.now() - start };
	} catch (error) {
		return failure(toErrorMessage(error));
	}
}

/**
 * One minimal completion through the configured registry and credential, exactly as serving
 * resolves them. Cheap by design: a few output tokens, so a low balance or a strict quota still
 * answers, and no pi CLI process is spawned.
 */
export async function testConfiguredModel(provider: string, modelId: string, paths: { authPath: string; modelsPath: string }, opts: { timeoutMs?: number } = {}): Promise<ModelTestResult> {
	const result = await probeConfiguredModel(provider, modelId, paths, opts);
	// The verdict outlives this response: the settings entry point reports a rejected model as such.
	recordModelVerdict(`${provider}/${modelId}`, result.ok ? undefined : result.error);
	return result;
}

async function probeConfiguredModel(provider: string, modelId: string, paths: { authPath: string; modelsPath: string }, opts: { timeoutMs?: number }): Promise<ModelTestResult> {
	if (provider === "openai-codex") return testCodexSubscriptionModel(modelId, opts.timeoutMs);
	const start = Date.now();
	try {
		const runtime = await ModelRuntime.create({ authPath: paths.authPath, modelsPath: paths.modelsPath });
		const loadErr = runtime.getError();
		if (loadErr) return { ok: false, error: `models.json load error: ${loadErr}`, durationMs: Date.now() - start };
		const model = runtime.getModel(provider, modelId);
		if (!model) return { ok: false, error: `model '${provider}/${modelId}' not found in registry`, durationMs: Date.now() - start };
		const resolved = await runtime.getAuth(model);
		if (!resolved) return { ok: false, error: `provider '${provider}' is not configured`, durationMs: Date.now() - start };
		return await testCandidateCredential(model, { apiKey: resolved.auth.apiKey, headers: resolved.auth.headers as Record<string, string> | undefined }, opts);
	} catch (err) {
		return { ok: false, error: toErrorMessage(err), durationMs: Date.now() - start };
	}
}

async function testCodexSubscriptionModel(modelId: string, timeoutMs = 45_000): Promise<ModelTestResult> {
	const start = Date.now();
	try {
		const gateway = new ResearchModelGateway();
		await gateway.refresh();
		await gateway.complete({
			runId: `settings-codex-test-${Date.now()}`,
			nodeId: "settings:codex-test",
			attempt: 1,
			systemPrompt: renderAgentPrompt("main", "model-connectivity-test", "system").content,
			messages: [{
				role: "user",
				content: renderAgentPrompt("main", "model-connectivity-test", "user").content,
				timestamp: Date.now(),
			}],
			policy: {
				preferred: [`openai-codex/${modelId}`],
				fallback: [],
				maxTokens: 128,
				maxRetries: 1,
			},
			signal: AbortSignal.timeout(timeoutMs),
		});
		return { ok: true, durationMs: Date.now() - start };
	} catch (error) {
		return {
			ok: false,
			error: toErrorMessage(error),
			durationMs: Date.now() - start,
		};
	}
}
