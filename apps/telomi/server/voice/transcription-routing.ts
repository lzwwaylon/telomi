import type {
	ProviderResult,
	TranscriptResult,
} from "../audio/types.js";
import type { TranscribeRequest } from "../audio/providers/stt.js";
import { isManagedAudioConnection } from "../../shared/connections.js";
import type {
	VoiceCloudSttProvider,
	VoiceSttAttempt,
	VoiceSttFallbackSkipReason,
	VoiceSttRoutingMeta,
} from "../../shared/voice-stt-routing.js";
import { toErrorMessage } from "../lib/values.js";

export type VoiceSttFallbackPolicy =
	| { enabled: false }
	| {
			enabled: true;
			selection: NonNullable<TranscribeRequest["selection"]>;
			provider: VoiceCloudSttProvider;
			model?: string;
	  };

export interface VoiceSttRouteInput {
	request: TranscribeRequest;
	/** The connection the primary attempt runs through; also how the attempt is labelled. */
	primaryProvider: string;
	fallback: VoiceSttFallbackPolicy;
	preflightFailure?: string;
}

export interface VoiceSttRouteResult {
	result: ProviderResult<TranscriptResult>;
	routing: VoiceSttRoutingMeta;
}

type VoiceTranscriber = (
	request: TranscribeRequest,
) => Promise<ProviderResult<TranscriptResult>>;

/**
 * Runtime-owned STT routing. A cloud attempt is allowed only when:
 * - the primary connection is the one Telomi manages locally;
 * - the user explicitly enabled fallback;
 * - the failure is not silence/no-audio or cancellation.
 *
 * The function never asks an Agent or LLM to choose a Provider.
 */
export async function runVoiceSttRoute(
	input: VoiceSttRouteInput,
	transcriber: VoiceTranscriber,
): Promise<VoiceSttRouteResult> {
	const eligible =
		isManagedAudioConnection(input.primaryProvider) && input.fallback.enabled;
	const routing: VoiceSttRoutingMeta = {
		primaryProvider: input.primaryProvider,
		fallback: {
			enabled: input.fallback.enabled,
			eligible,
			used: false,
			...(input.fallback.enabled && eligible ? { provider: input.fallback.provider } : {}),
			...(input.fallback.enabled && eligible && input.fallback.model
				? { model: input.fallback.model }
				: {}),
		},
		attempts: [],
	};
	if (input.preflightFailure) {
		routing.fallback.skipReason =
			fallbackSkipReason(input, input.preflightFailure) ?? "no-audio";
		return {
			result: {
				ok: false,
				provider: input.primaryProvider,
				reason: input.preflightFailure,
			},
			routing,
		};
	}

	const primary = await attemptTranscription(input.request, transcriber);
	routing.attempts.push(primary.attempt);
	if (primary.result.ok) return { result: primary.result, routing };

	const skipReason = fallbackSkipReason(input, primary.result.reason);
	if (skipReason || !input.fallback.enabled) {
		routing.fallback.skipReason = skipReason;
		return { result: primary.result, routing };
	}

	routing.fallback.used = true;
	const fallback = await attemptTranscription(
		{
			...input.request,
			selection: input.fallback.selection,
			model: input.fallback.model,
		},
		transcriber,
	);
	routing.attempts.push(fallback.attempt);
	if (fallback.result.ok) return { result: fallback.result, routing };

	return {
		result: {
			ok: false,
			provider: fallback.result.provider,
			reason:
				`Local STT failed: ${primary.result.reason}. ` +
				`Cloud fallback (${fallback.result.provider}) also failed: ${fallback.result.reason}`,
		},
		routing,
	};
}

async function attemptTranscription(
	request: TranscribeRequest,
	transcriber: VoiceTranscriber,
): Promise<{
	result: ProviderResult<TranscriptResult>;
	attempt: VoiceSttAttempt;
}> {
	const startedAt = performance.now();
	let result: ProviderResult<TranscriptResult>;
	try {
		result = normalizeEmptyTranscript(await transcriber(request));
	} catch (error) {
		result = {
			ok: false,
			provider: request.selection?.connection ?? "configured-default",
			reason: toErrorMessage(error),
		};
	}
	const durationMs = Math.max(0, Math.round(performance.now() - startedAt));
	if (result.ok) {
		return {
			result,
			attempt: {
				provider: result.provider,
				...(result.model ? { model: result.model } : {}),
				ok: true,
				durationMs,
			},
		};
	}
	return {
		result,
		attempt: {
			provider: result.provider,
			...(request.model ? { model: request.model } : {}),
			ok: false,
			durationMs,
			reason: result.reason,
		},
	};
}

function normalizeEmptyTranscript(
	result: ProviderResult<TranscriptResult>,
): ProviderResult<TranscriptResult> {
	if (!result.ok) return result;
	const text = result.text.trim();
	if (text && !isBlankAudioMarker(text)) return result;
	return {
		ok: false,
		provider: result.provider,
		reason: "No audio detected",
	};
}

function isBlankAudioMarker(text: string): boolean {
	const normalized = text.toLowerCase();
	return normalized === "[blank_audio]" || normalized === "[ blank_audio ]";
}

function fallbackSkipReason(
	input: VoiceSttRouteInput,
	reason: string,
): VoiceSttFallbackSkipReason | undefined {
	if (input.request.signal?.aborted || isCancellation(reason)) return "cancelled";
	if (isNoAudio(reason)) return "no-audio";
	if (!isManagedAudioConnection(input.primaryProvider)) return "not-local-primary";
	if (!input.fallback.enabled) return "disabled";
	return undefined;
}

function isCancellation(reason: string): boolean {
	return /\b(?:abort(?:ed)?|cancel(?:led|ed)?)\b/i.test(reason);
}

function isNoAudio(reason: string): boolean {
	return /(?:no audio|no speech|silence|silent|audio.{0,20}too short|empty transcription)/i.test(
		reason,
	);
}
