import { voiceApi } from "@/features/voice/api";
import type { VoiceHistoryUserEditUnmeasuredReason } from "@shared/voice-history.js";
import { isVoiceHistoryEntryId } from "@shared/voice-history.js";
import type { VoiceTranscriptInsertion } from "@/features/voice/voiceComposerText";

const MAX_USER_EDIT_CHARACTERS = 5_000;

export interface PendingVoiceUserEdit {
	historyId: string;
	transcript: string;
	prefix: string;
	suffix: string;
	startedAt: number;
}

export type VoiceUserEditSubmissionBody =
	| {
			outcome: "measured";
			editedText: string;
			elapsedMs: number;
	  }
	| {
			outcome: "unmeasured";
			reason: VoiceHistoryUserEditUnmeasuredReason;
			elapsedMs: number;
	  };

export interface VoiceUserEditSubmission {
	historyId: string;
	body: VoiceUserEditSubmissionBody;
}

export function readSavedVoiceHistoryId(value: unknown): string | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const history = value as { saved?: unknown; id?: unknown };
	return history.saved === true &&
		typeof history.id === "string" &&
		isVoiceHistoryEntryId(history.id)
		? history.id
		: undefined;
}

export async function submitVoiceUserEditEvidence(
	submission: VoiceUserEditSubmission,
): Promise<void> {
	await voiceApi.history.userEdit(submission.historyId, submission.body);
}

export function createPendingVoiceUserEdit(input: {
	historyId?: string;
	insertion: VoiceTranscriptInsertion;
	transcript: string;
	startedAt: number;
}): PendingVoiceUserEdit | null {
	if (!input.historyId || !input.transcript) return null;
	const end = input.insertion.selection.start;
	const start = end - input.transcript.length;
	if (
		start < 0 ||
		input.insertion.selection.end !== end ||
		input.insertion.text.slice(start, end) !== input.transcript
	) {
		return null;
	}
	return {
		historyId: input.historyId,
		transcript: input.transcript,
		prefix: input.insertion.text.slice(0, start),
		suffix: input.insertion.text.slice(end),
		startedAt: input.startedAt,
	};
}

export function resolveVoiceUserEditSubmissions(
	pending: PendingVoiceUserEdit[],
	submittedText: string,
	submittedAt: number,
): VoiceUserEditSubmission[] {
	if (pending.length === 0) return [];
	if (pending.length > 1) {
		return pending.map((observation) => ({
			historyId: observation.historyId,
			body: unmeasuredBody(
				"multiple_voice_inputs",
				observation.startedAt,
				submittedAt,
			),
		}));
	}

	const observation = pending[0]!;
	const elapsedMs = roundedElapsed(observation.startedAt, submittedAt);
	if (Array.from(observation.transcript.normalize("NFC")).length > MAX_USER_EDIT_CHARACTERS) {
		return [{
			historyId: observation.historyId,
			body: {
				outcome: "unmeasured",
				reason: "text_too_long",
				elapsedMs,
			},
		}];
	}
	if (
		!submittedText.startsWith(observation.prefix) ||
		!submittedText.endsWith(observation.suffix) ||
		submittedText.length < observation.prefix.length + observation.suffix.length
	) {
		return [{
			historyId: observation.historyId,
			body: {
				outcome: "unmeasured",
				reason: "composer_context_changed",
				elapsedMs,
			},
		}];
	}

	const suffixStart = submittedText.length - observation.suffix.length;
	const editedText = submittedText.slice(observation.prefix.length, suffixStart);
	if (Array.from(editedText.normalize("NFC")).length > MAX_USER_EDIT_CHARACTERS) {
		return [{
			historyId: observation.historyId,
			body: {
				outcome: "unmeasured",
				reason: "text_too_long",
				elapsedMs,
			},
		}];
	}
	return [{
		historyId: observation.historyId,
		body: {
			outcome: "measured",
			editedText,
			elapsedMs,
		},
	}];
}

function unmeasuredBody(
	reason: VoiceHistoryUserEditUnmeasuredReason,
	startedAt: number,
	submittedAt: number,
): VoiceUserEditSubmissionBody {
	return {
		outcome: "unmeasured",
		reason,
		elapsedMs: roundedElapsed(startedAt, submittedAt),
	};
}

function roundedElapsed(startedAt: number, submittedAt: number): number {
	const value = Math.max(0, submittedAt - startedAt);
	return Math.round(value * 1_000) / 1_000;
}
