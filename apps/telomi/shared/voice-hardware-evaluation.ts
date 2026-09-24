import type { VoiceMicrophoneSelectionStatus } from "./voice-microphone.js";

export const VOICE_HARDWARE_EVALUATION_PROMPT_ZH =
	"请在明天下午三点安排 MFlow 和 PostgreSQL 的评审会议，预算是六成。";

export const VOICE_HARDWARE_EVALUATION_CONDITIONS = [
	"baseline",
	"room-noise",
	"keyboard-noise",
	"far-field",
] as const;

export type VoiceHardwareEvaluationCondition =
	(typeof VOICE_HARDWARE_EVALUATION_CONDITIONS)[number];

export interface VoiceHardwareEvaluationPublicCapture {
	caseId: string;
	microphoneId: string;
	condition: VoiceHardwareEvaluationCondition;
	conditionNote: string;
	historyId: string;
	recordedAt: string;
	promotedAt: string;
	speakerId: string;
	hardwareName: string;
	deviceLabel: string;
	selectionStatus: VoiceMicrophoneSelectionStatus;
	audioBytes: number;
	durationSec?: number;
}

export interface VoiceHardwareEvaluationPublicCoverage {
	complete: boolean;
	missingSlices: string[];
	microphones: {
		required: number;
		actual: number;
		complete: boolean;
	};
}

export interface VoiceHardwareEvaluationSnapshot {
	prompt: string;
	updatedAt: string;
	captures: VoiceHardwareEvaluationPublicCapture[];
	coverage: VoiceHardwareEvaluationPublicCoverage;
}

export interface VoiceHardwareEvaluationConfirmations {
	physicalHardware: boolean;
	exactPrompt: boolean;
	privateAudioCopy: boolean;
	realCondition?: boolean;
}

export interface VoiceHardwareEvaluationPromotionRequest {
	historyId: string;
	hardwareName: string;
	speakerId: string;
	condition: VoiceHardwareEvaluationCondition;
	conditionNote?: string;
	confirmations: VoiceHardwareEvaluationConfirmations;
}
