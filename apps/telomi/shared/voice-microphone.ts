export const VOICE_MICROPHONE_DEVICE_ID_HEADER =
	"x-telomi-voice-microphone-device-id";
export const VOICE_MICROPHONE_DEVICE_LABEL_HEADER =
	"x-telomi-voice-microphone-device-label";
export const VOICE_MICROPHONE_SELECTION_HEADER =
	"x-telomi-voice-microphone-selection";
export const VOICE_MICROPHONE_FALLBACK_HEADER =
	"x-telomi-voice-microphone-fallback";

export const VOICE_MICROPHONE_SELECTION_STATUSES = [
	"default",
	"built-in",
	"exact",
	"remapped",
	"ambiguous",
	"missing",
] as const;

export type VoiceMicrophoneSelectionStatus =
	(typeof VOICE_MICROPHONE_SELECTION_STATUSES)[number];

export interface VoiceMicrophoneCaptureMetadata {
	deviceId: string | null;
	deviceLabel: string;
	selectionStatus: VoiceMicrophoneSelectionStatus;
	usedFallback: boolean;
}

export interface VoiceMicrophoneEvidence {
	deviceLabel?: string;
	deviceFingerprint?: string;
	selectionStatus: VoiceMicrophoneSelectionStatus;
	usedFallback: boolean;
}

export function buildVoiceMicrophoneRequestHeaders(
	metadata: VoiceMicrophoneCaptureMetadata,
): Record<string, string> {
	return {
		...(metadata.deviceId
			? {
					[VOICE_MICROPHONE_DEVICE_ID_HEADER]: encodeURIComponent(
						metadata.deviceId,
					),
				}
			: {}),
		...(metadata.deviceLabel
			? {
					[VOICE_MICROPHONE_DEVICE_LABEL_HEADER]: encodeURIComponent(
						metadata.deviceLabel,
					),
				}
			: {}),
		[VOICE_MICROPHONE_SELECTION_HEADER]: metadata.selectionStatus,
		[VOICE_MICROPHONE_FALLBACK_HEADER]: metadata.usedFallback ? "1" : "0",
	};
}
