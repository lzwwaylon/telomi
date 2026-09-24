import type { Api, AssistantMessage, Context, Model, ProviderHeaders, Usage } from "@earendil-works/pi-ai";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";

import { hasAccountChain } from "../../accounts/manager.js";
import { streamWithAccountFallback } from "../../accounts/stream-fallback.js";
import { composeAgentSystemPrompt } from "../global-system-prompt.js";
import { completeRegistryModel } from "../pi-ai.js";
import { resolveAgentPath } from "../../config/agent-directory.js";
import { ResearchNodeError } from "../retry-policy.js";
import { researchModelError, scrubResearchModelError } from "./error-classifier.js";
import { parseResearchModelRef, researchModelCandidates, type ResearchModelPolicy } from "./model-policy.js";

interface ResearchRegistry {
	refresh(): Promise<unknown>;
	getError(): string | undefined;
	find(provider: string, modelId: string): Model<Api> | undefined;
	getApiKeyAndHeaders(model: Model<Api>): Promise<
		| { ok: true; apiKey?: string; headers?: ProviderHeaders; env?: Record<string, string> }
		| { ok: false; error: string }
	>;
}

type CompleteRegistryCall = typeof completeRegistryModel;

export interface ResearchModelRequest {
	runId: string;
	nodeId: string;
	attempt: number;
	systemPrompt?: string;
	messages: Context["messages"];
	policy: ResearchModelPolicy;
	signal?: AbortSignal;
}

export interface ResearchModelAttempt {
	model: string;
	outcome: "succeeded" | "not_found" | "auth_failed" | "request_failed" | "invalid_stop";
	durationMs: number;
	errorClass?: string;
	error?: string;
}

export interface ResearchModelResult {
	message: AssistantMessage;
	text: string;
	requestedModel: string;
	actualModel: string;
	usage: Usage;
	durationMs: number;
	attempts: ResearchModelAttempt[];
}

export interface ResearchModelGatewayOptions {
	authPath?: string;
	modelsPath?: string;
	registry?: ResearchRegistry;
	complete?: CompleteRegistryCall;
}

function extractText(message: AssistantMessage): string {
	return message.content
		.filter((block): block is Extract<AssistantMessage["content"][number], { type: "text" }> => block.type === "text")
		.map((block) => block.text)
		.join("\n")
		.trim();
}

function abortedModelError(
	modelRef: string,
	failureClass: "cancelled" | "provider",
	message?: string,
): ResearchNodeError {
	const detail = failureClass === "cancelled"
		? "was cancelled by the caller"
		: `was aborted by the Provider${message ? `: ${message}` : ""}`;
	return new ResearchNodeError(`model '${modelRef}' ${detail}`, failureClass, failureClass !== "cancelled");
}

export class ResearchModelGateway {
	private readonly registry: Promise<ResearchRegistry>;
	private readonly completeCall: CompleteRegistryCall;

	constructor(options: ResearchModelGatewayOptions = {}) {
		const authPath = options.authPath ?? resolveAgentPath("auth.json");
		const modelsPath = options.modelsPath ?? resolveAgentPath("models.json");
		this.registry = options.registry
			? Promise.resolve(options.registry)
			: ModelRuntime.create({ authPath, modelsPath }).then((runtime) => new ModelRegistry(runtime));
		this.completeCall = options.complete ?? completeRegistryModel;
	}

	async refresh(): Promise<void> {
		const registry = await this.registry;
		await registry.refresh();
		const loadError = registry.getError();
		if (loadError) throw new Error(`research model registry failed to load: ${scrubResearchModelError(loadError)}`);
	}

	async complete(request: ResearchModelRequest): Promise<ResearchModelResult> {
		const registry = await this.registry;
		const startedAt = Date.now();
		const attempts: ResearchModelAttempt[] = [];
		let lastError: ResearchNodeError | undefined;
		let actionablePermanentError: ResearchNodeError | undefined;

		for (const modelRef of researchModelCandidates(request.policy)) {
			if (request.signal?.aborted) throw abortedModelError(modelRef, "cancelled");
			const attemptStartedAt = Date.now();
			const { provider, modelId } = parseResearchModelRef(modelRef);
			const model = registry.find(provider, modelId);
			if (!model) {
				attempts.push({ model: modelRef, outcome: "not_found", durationMs: Date.now() - attemptStartedAt, error: "model not found" });
				lastError = new ResearchNodeError(`research model '${modelRef}' was not found`, "permanent", false);
				continue;
			}

			const useAccountFallback = hasAccountChain(provider);
			const auth = useAccountFallback
				? { ok: true as const, apiKey: undefined, headers: undefined, env: undefined }
				: await registry.getApiKeyAndHeaders(model);
			if (!auth.ok) {
				const error = researchModelError(auth.error, modelRef);
				attempts.push({ model: modelRef, outcome: "auth_failed", durationMs: Date.now() - attemptStartedAt,
					errorClass: error.failureClass, error: scrubResearchModelError(auth.error) });
				lastError = error;
				if (error.failureClass === "permanent") actionablePermanentError ??= error;
				continue;
			}

			// Model calls inherit caller cancellation only. Do not synthesize a
			// wall-clock deadline in the report production path.
			const signal = request.signal ?? new AbortController().signal;
			try {
				const context = {
					systemPrompt: composeAgentSystemPrompt(request.systemPrompt),
					messages: request.messages,
					tools: [],
				};
				const options = {
					apiKey: auth.apiKey,
					headers: auth.headers,
					env: auth.env,
					signal,
					...(request.policy.maxTokens === undefined ? {} : { maxTokens: request.policy.maxTokens }),
					maxRetries: request.policy.maxRetries ?? 1,
					maxRetryDelayMs: request.policy.maxRetryDelayMs ?? 30_000,
					...(request.policy.reasoning && request.policy.reasoning !== "off" ? { reasoning: request.policy.reasoning } : {}),
				};
				const message = useAccountFallback
					? await streamWithAccountFallback({
						model,
						context,
						options,
						modelRegistry: registry,
						providerFallback: false,
					}).result()
					: await this.completeCall(model, context, options);
				if (message.stopReason !== "stop") {
					const messageText = message.errorMessage || `unexpected stop reason '${message.stopReason}'`;
					const normalized = message.stopReason === "aborted"
						? abortedModelError(modelRef, request.signal?.aborted ? "cancelled" : "provider", messageText)
						: message.stopReason === "error"
							? researchModelError(messageText, modelRef)
							: new ResearchNodeError(`model '${modelRef}' returned ${messageText}`, "validation", false);
					lastError = normalized;
					attempts.push({ model: modelRef, outcome: "invalid_stop", durationMs: Date.now() - attemptStartedAt,
						errorClass: normalized.failureClass, error: scrubResearchModelError(messageText) });
					if (normalized.failureClass === "cancelled") throw normalized;
					if (normalized.failureClass === "permanent") actionablePermanentError ??= normalized;
					continue;
				}
				const text = extractText(message);
				if (!text) {
					lastError = new ResearchNodeError(`model '${modelRef}' returned no text`, "validation", false);
					attempts.push({ model: modelRef, outcome: "invalid_stop", durationMs: Date.now() - attemptStartedAt, errorClass: "validation", error: "empty text" });
					continue;
				}
				if (!(message.usage.input > 0) || !(message.usage.output > 0) || !(message.usage.totalTokens > 0)) {
					const meteringError = new ResearchNodeError(
						`model '${modelRef}' returned non-empty text without positive token usage`, "permanent", false);
					lastError = meteringError;
					actionablePermanentError ??= meteringError;
					attempts.push({ model: modelRef, outcome: "invalid_stop", durationMs: Date.now() - attemptStartedAt,
						errorClass: meteringError.failureClass, error: "missing positive token usage" });
					continue;
				}
				attempts.push({ model: modelRef, outcome: "succeeded", durationMs: Date.now() - attemptStartedAt });
				return {
					message,
					text,
					requestedModel: modelRef,
					actualModel: `${message.provider}/${message.model}`,
					usage: message.usage,
					durationMs: Date.now() - startedAt,
					attempts,
				};
			} catch (error) {
				const classified = request.signal?.aborted
					? abortedModelError(modelRef, "cancelled")
					: error instanceof ResearchNodeError ? error : researchModelError(error, modelRef);
				const normalized = classified.failureClass === "cancelled" && !request.signal?.aborted
					? abortedModelError(modelRef, "provider", scrubResearchModelError(error))
					: classified;
				if (normalized.failureClass === "cancelled") throw normalized;
				lastError = normalized;
				if (normalized.failureClass === "permanent") actionablePermanentError ??= normalized;
				attempts.push({ model: modelRef, outcome: "request_failed", durationMs: Date.now() - attemptStartedAt,
					errorClass: normalized.failureClass, error: scrubResearchModelError(normalized) });
			}
		}

		throw actionablePermanentError ?? lastError ?? new ResearchNodeError("research model policy had no usable model", "permanent", false);
	}
}
