import type { VoiceLanguagePreference } from "./voice-languages.js";
import type { VoiceVadConfig } from "../server/audio/voice-vad.js";
import type { VoiceCleanupConfig } from "./voice-cleanup.js";

export interface VoiceContextSnapshotDescriptor {
	contextSnapshotId: string;
	capturedAt: string;
	languagePreference: VoiceLanguagePreference;
	languageHint: string | null;
	glossaryRevision: string;
	glossaryEntryCount: number;
	vad: VoiceVadConfig;
	cleanup: VoiceCleanupConfig;
	/** Recording-time preferences fixed with the rest of the utterance context. Playback always pauses while recording. */
	recording: {
		audioCuesEnabled: boolean;
	};
}

export function isVoiceContextSnapshotId(value: unknown): value is string {
	return typeof value === "string" && /^voice_ctx_[a-f0-9]{64}$/.test(value);
}
