import type { VoiceSttRoutingMeta } from "./voice-stt-routing.js";
import type { VoiceMicrophoneEvidence } from "./voice-microphone.js";

export const VOICE_HISTORY_MAX_ENTRIES = 1_000;
export const VOICE_HISTORY_DEFAULT_LIMIT = 50;
export const VOICE_HISTORY_MAX_LIMIT = 200;
export const VOICE_HISTORY_RETENTION_DAYS = [0, 7, 14, 30, 60, 90] as const;

export type VoiceHistoryStatus = "completed" | "failed" | "discarded";

export interface VoiceHistorySettings {
	dataRetentionEnabled: boolean;
	audioRetentionDays: number;
	saveDiscardedTranscriptions: boolean;
	updatedAt: string | null;
}

export interface VoiceHistoryCleanupMeta {
	requested: boolean;
	applied: boolean;
	modelId?: string;
	durationMs?: number;
	reason?: string;
}

export type VoiceHistoryUserEditUnmeasuredReason =
	| "multiple_voice_inputs"
	| "composer_context_changed"
	| "text_too_long";

export type VoiceHistoryUserEdit =
	| {
			outcome: "measured";
			unit: "unicode-code-point";
			originalCharacterCount: number;
			submittedCharacterCount: number;
			editDistance: number;
			modificationRate: number;
			elapsedMs: number;
			recordedAt: string;
	  }
	| {
			outcome: "unmeasured";
			reason: VoiceHistoryUserEditUnmeasuredReason;
			elapsedMs: number;
			recordedAt: string;
	  };

export interface VoiceHistoryEntry {
	id: string;
	goalId: string;
	sessionId?: string;
	utteranceId?: string;
	status: VoiceHistoryStatus;
	createdAt: string;
	updatedAt: string;
	attemptCount: number;
	text: string;
	rawText: string;
	canonicalText: string;
	provider: string;
	model?: string;
	language?: string;
	durationSec?: number;
	mime: string;
	hasAudio: boolean;
	audioBytes: number;
	errorMessage?: string;
	errorCode?: string;
	contextSnapshotId?: string;
	glossaryRevision?: string;
	cleanup: VoiceHistoryCleanupMeta;
	routing?: VoiceSttRoutingMeta;
	microphone?: VoiceMicrophoneEvidence;
	userEdit?: VoiceHistoryUserEdit;
}

export interface VoiceHistoryUserEditUsage {
	measuredCount: number;
	unmeasuredCount: number;
	totalOriginalCharacters: number;
	totalEditDistance: number;
	modificationRate: number | null;
}

export interface VoiceHistoryStorageUsage {
	entryCount: number;
	completedCount: number;
	failedCount: number;
	discardedCount: number;
	audioFileCount: number;
	audioBytes: number;
	userEdit: VoiceHistoryUserEditUsage;
}

export interface VoiceHistorySnapshot {
	settings: VoiceHistorySettings;
	entries: VoiceHistoryEntry[];
	usage: VoiceHistoryStorageUsage;
}

export interface VoiceHistorySaveResult {
	saved: boolean;
	entry?: VoiceHistoryEntry;
}

export function isVoiceHistoryEntryId(value: string): boolean {
	return /^voice_[a-f0-9]{32}$/i.test(value);
}
