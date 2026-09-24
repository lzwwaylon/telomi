import { resolveSpeechConfiguration, assertSpeechConnectionAffinity } from "./configuration.js";
import { refreshConnectionRuntime, loadCustomProviders } from "../providers/custom-models.js";
import { isProviderCredentialDeleted } from "../config/credential-tombstones.js";
/**
 * LLM cleanup pass for raw STT output.
 *
 * Takes the transcript text the ASR returned and runs it through a small/fast
 * model with the OpenWhispr-style cleanup system prompt (see cleanup-prompt.ts).
 * Returns the cleaned text on success, an error object on failure. Callers
 * should fail-soft to the raw transcript so a slow/broken LLM never blocks
 * the user from sending their message.
 *
 * Model resolution order:
 *   1. opts.modelId (e.g. "anthropic/claude-haiku-4-5-20251001")
 *   2. Unified speech role override or inherited LLM default.
 */

import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { resolveAgentPath } from "../config/agent-directory.js";
import { buildCleanupSystemPrompt } from "./cleanup-prompt.js";
import { toErrorMessage } from "../lib/values.js";

const AUTH_PATH = resolveAgentPath("auth.json");
const MODELS_PATH = resolveAgentPath("models.json");
const DEFAULT_TIMEOUT_MS = 30_000;

export interface CleanupRequest {
  text: string;
	language?: string;
  /** Override the cleanup model. Format: "<provider>/<modelId>".
   *  Otherwise inherits the unified speech cleanup selection. */
  modelId?: string | null;
  connectionBaseUrl?: string | null;
  customDictionary?: string[];
  customInstructions?: string;
  agentName?: string | null;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export type CleanupResult =
  | { ok: true; text: string; modelId: string; durationMs: number }
  | { ok: false; reason: string; modelId?: string };

function parseCompoundModelId(value: string): {
  provider: string;
  modelId: string;
} | null {
  const slash = value.indexOf("/");
  if (slash <= 0 || slash === value.length - 1) return null;
  return { provider: value.slice(0, slash), modelId: value.slice(slash + 1) };
}

function resolveModelId(req: CleanupRequest): string | null {
  if (req.modelId === null) return null;
  const explicit = req.modelId?.trim();
  if (explicit) return explicit;
  return resolveSpeechConfiguration().cleanupModel;
}

function calculateMaxTokens(textLength: number): number {
  // floor 512: max_output_tokens is output-only on reasoning models; a 100-token
  // cap was empirically tight for short Chinese inputs (~37 chars ≈ 60-80 output
  // tokens after re-emit + punctuation/formatting), occasionally producing
  // length-truncated empty output. 512 is still cheap and removes the cliff.
  return Math.max(512, Math.min(textLength * 3, 2048));
}

export function voiceCleanupInferencePolicy(textLength: number): {
  maxTokens: number;
} {
  // Deliberately omit `reasoning`. pi-ai owns Provider-specific off/default
  // request shapes, while the output boundary below remains the final guard.
  return {
    maxTokens: calculateMaxTokens(textLength),
  };
}

/**
 * Remove literal reasoning blocks emitted inside a model's text content.
 * This is a close TypeScript port of OpenWhispr's stripThinkingTags helper.
 */
export function stripVoiceCleanupThinking(text: string): string;
export function stripVoiceCleanupThinking<T>(text: T): T;
export function stripVoiceCleanupThinking(text: unknown): unknown {
  if (typeof text !== "string") return text;
  return text
    .replace(/<think>[\s\S]*?<\/think>/g, "")
    .replace(/<think>[\s\S]*$/, "")
    .trim();
}

export function extractVoiceCleanupText(content: unknown): string {
  if (typeof content === "string") {
    return stripVoiceCleanupThinking(content);
  }
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const p of content as Array<{ type?: string; text?: string }>) {
    if (p && p.type === "text" && typeof p.text === "string")
      parts.push(p.text);
  }
  return stripVoiceCleanupThinking(parts.join("\n"));
}

function mergeAbortSignals(
  a: AbortSignal | undefined,
  b: AbortSignal,
): AbortSignal {
  if (!a) return b;
  const ctrl = new AbortController();
  if (a.aborted || b.aborted) {
    ctrl.abort();
    return ctrl.signal;
  }
  const forward = () => ctrl.abort();
  a.addEventListener("abort", forward, { once: true });
  b.addEventListener("abort", forward, { once: true });
  return ctrl.signal;
}

/**
 * Longest transcript an empty output may erase. The rules tell the model to
 * output nothing for filler-only speech, so a short input vanishing is a
 * result; a long one vanishing is more likely a model failure, and the words
 * are kept rather than lost silently.
 * ponytail: fixed character threshold, replace with a real judgement if it misfires.
 */
export const MAX_EMPTIED_TRANSCRIPT_CHARS = 20;

export function resolveCleanupOutput(
  out: string,
  context: { stopReason: string | undefined; inputText: string },
): { ok: true; text: string } | { ok: false; reason: string } {
  if (out) return { ok: true, text: out };
  if (context.stopReason !== "stop") return { ok: false, reason: "cleanup returned empty output before finishing" };
  if (Array.from(context.inputText.trim()).length > MAX_EMPTIED_TRANSCRIPT_CHARS) {
    return { ok: false, reason: "cleanup returned empty output for a transcript too long to be filler" };
  }
  return { ok: true, text: "" };
}

export async function cleanup(req: CleanupRequest): Promise<CleanupResult> {
  const text = req.text?.trim() ?? "";
  if (!text) {
    return {
      ok: true,
      text: "",
      modelId: "(skipped: empty input)",
      durationMs: 0,
    };
  }

  const startedAt = Date.now();
  const compoundId = resolveModelId(req);
  if (!compoundId) return { ok: false, reason: "Cleanup model is not configured" };
  const parsedModel = parseCompoundModelId(compoundId);
  if (!parsedModel) {
    return {
      ok: false,
      modelId: compoundId,
      reason: "modelId must use provider/model format",
    };
  }
  const { provider, modelId } = parsedModel;

  const connectionBaseUrl = req.connectionBaseUrl !== undefined ? req.connectionBaseUrl : loadCustomProviders().providers?.[provider]?.baseUrl ?? null;
  const checkConnection = () => assertSpeechConnectionAffinity(provider, connectionBaseUrl);
  let runtime: ModelRuntime;
  let model: ReturnType<ModelRuntime["getModel"]> | null = null;
  try {
    checkConnection();
    runtime = await ModelRuntime.create({ authPath: AUTH_PATH, modelsPath: MODELS_PATH });
    await refreshConnectionRuntime(runtime);
    if (isProviderCredentialDeleted(provider)) throw new Error("cleanup credential was deleted");
    model = runtime.getModel(provider, modelId) ?? null;
  } catch (err) {
    return {
      ok: false,
      modelId: compoundId,
      reason: `model lookup failed: ${toErrorMessage(err)}`,
    };
  }
  if (!model) {
    return {
      ok: false,
      modelId: compoundId,
      reason: `unknown model: ${compoundId}`,
    };
  }

  const systemPrompt = buildCleanupSystemPrompt({
	language: req.language,
    agentName: req.agentName ?? null,
    customDictionary: req.customDictionary,
    customInstructions: req.customInstructions,
  });

  const timeoutCtrl = new AbortController();
  const timer = setTimeout(
    () => timeoutCtrl.abort(),
    req.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );
  const signal = mergeAbortSignals(req.signal, timeoutCtrl.signal);

  try {
    checkConnection();
    const result = await runtime.completeSimple(
      model,
      {
        systemPrompt,
        messages: [{ role: "user", content: text, timestamp: Date.now() }],
      },
      {
        signal,
        transformHeaders: (headers) => { checkConnection(); return headers; },
        ...voiceCleanupInferencePolicy(text.length),
      },
    );
    const out = extractVoiceCleanupText(result.content);
    const resolved = resolveCleanupOutput(out, { stopReason: result.stopReason, inputText: text });
    if (!resolved.ok) {
      const usage = result.usage;
      console.warn("[voice/cleanup] empty output", {
        modelId: compoundId,
        stopReason: result.stopReason,
        inputLen: text.length,
        maxTokens: calculateMaxTokens(text.length),
        outputTokens: usage?.output,
        inputTokens: usage?.input,
        elapsedMs: Date.now() - startedAt,
      });
      return {
        ok: false,
        modelId: compoundId,
        reason: `${resolved.reason} (stopReason=${result.stopReason ?? "?"}, output=${usage?.output ?? "?"} tokens)`,
      };
    }
    return {
      ok: true,
      text: resolved.text,
      modelId: compoundId,
      durationMs: Date.now() - startedAt,
    };
  } catch (err) {
    const reason = toErrorMessage(err);
    return {
      ok: false,
      modelId: compoundId,
      reason: timeoutCtrl.signal.aborted
        ? `cleanup timed out after ${req.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms`
        : reason,
    };
  } finally {
    clearTimeout(timer);
  }
}
