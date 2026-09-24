/**
 * Closely adapted from OpenWhispr's MIT-licensed recording guard:
 * https://github.com/OpenWhispr/openwhispr/blob/e1cb8301d898881e28372e61ba15a8fd57f4f25b/src/helpers/recordingGuard.js
 * https://github.com/OpenWhispr/openwhispr/blob/e1cb8301d898881e28372e61ba15a8fd57f4f25b/src/helpers/recordingValidation.js
 */

export const MIN_VOICE_AUDIO_BYTES = 256;

export type VoiceRecordingValidation =
	| { usable: true; reason: null }
	| {
			usable: false;
			reason: "no-audio-data" | "empty-container";
	  };

export function isEmptyVoiceRecording(blobSize: unknown): boolean {
	const size =
		typeof blobSize === "number" && Number.isFinite(blobSize)
			? blobSize
			: 0;
	return size < MIN_VOICE_AUDIO_BYTES;
}

export function evaluateVoiceRecording(
	input: {
		blobSize?: unknown;
		receivedAudioData?: unknown;
	} = {},
): VoiceRecordingValidation {
	if (input.receivedAudioData !== true) {
		return { usable: false, reason: "no-audio-data" };
	}
	if (isEmptyVoiceRecording(input.blobSize)) {
		return { usable: false, reason: "empty-container" };
	}
	return { usable: true, reason: null };
}
