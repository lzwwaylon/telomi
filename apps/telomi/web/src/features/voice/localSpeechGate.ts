/**
 * Adapted from OpenWhispr's local speech gate.
 * Source: docs/openwhispr/src/helpers/localSpeechGate.js
 * Source commit: e1cb8301d898881e28372e61ba15a8fd57f4f25b
 * License details: apps/telomi/THIRD_PARTY_NOTICES.md
 */

const SILENCE_RMS_THRESHOLD = 0.002;
const SPEECH_WINDOW_RMS_THRESHOLD = 0.003;
const SPEECH_WINDOW_PEAK_THRESHOLD = 0.02;
const STRONG_SPEECH_RMS_THRESHOLD = 0.006;

export interface LocalSpeechGateState {
	peakRms: number;
	peakAmplitude: number;
	windowCount: number;
	speechWindowCount: number;
	consecutiveSpeechWindows: number;
	maxConsecutiveSpeechWindows: number;
}

export type LocalSpeechGateDecision =
	| { skip: false; reason: "unavailable" }
	| ({
			skip: boolean;
			reason: "silence" | "insufficient_speech" | "speech_detected";
	  } & Omit<LocalSpeechGateState, "consecutiveSpeechWindows">);

export function createLocalSpeechGateState(): LocalSpeechGateState {
	return {
		peakRms: 0,
		peakAmplitude: 0,
		windowCount: 0,
		speechWindowCount: 0,
		consecutiveSpeechWindows: 0,
		maxConsecutiveSpeechWindows: 0,
	};
}

export function recordLocalSpeechWindow(
	state: LocalSpeechGateState,
	rms: number,
	peak: number,
): LocalSpeechGateState {
	state.windowCount += 1;
	state.peakRms = Math.max(state.peakRms, rms);
	state.peakAmplitude = Math.max(state.peakAmplitude, peak);

	const isSpeechWindow = isLocalSpeechWindow(rms, peak);
	if (!isSpeechWindow) {
		state.consecutiveSpeechWindows = 0;
		return state;
	}

	state.speechWindowCount += 1;
	state.consecutiveSpeechWindows += 1;
	state.maxConsecutiveSpeechWindows = Math.max(
		state.maxConsecutiveSpeechWindows,
		state.consecutiveSpeechWindows,
	);
	return state;
}

export function isLocalSpeechWindow(rms: number, peak: number): boolean {
	return rms >= SPEECH_WINDOW_RMS_THRESHOLD && peak >= SPEECH_WINDOW_PEAK_THRESHOLD;
}

export function getLocalSpeechGateDecision(
	state: LocalSpeechGateState | null | undefined,
): LocalSpeechGateDecision {
	if (!state?.windowCount) return { skip: false, reason: "unavailable" };

	const metrics = {
		peakRms: state.peakRms,
		peakAmplitude: state.peakAmplitude,
		windowCount: state.windowCount,
		speechWindowCount: state.speechWindowCount,
		maxConsecutiveSpeechWindows: state.maxConsecutiveSpeechWindows,
	};

	if (state.peakRms < SILENCE_RMS_THRESHOLD) {
		return { skip: true, reason: "silence", ...metrics };
	}

	const hasSpeech = state.speechWindowCount >= 1 || state.peakRms >= STRONG_SPEECH_RMS_THRESHOLD;
	if (!hasSpeech) {
		return { skip: true, reason: "insufficient_speech", ...metrics };
	}

	return { skip: false, reason: "speech_detected", ...metrics };
}
