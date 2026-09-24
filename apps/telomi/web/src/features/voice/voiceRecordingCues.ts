/**
 * Close TypeScript adaptation of OpenWhispr's dictationCues.js at
 * e1cb8301d898881e28372e61ba15a8fd57f4f25b. The frequencies, timing and
 * gain envelope intentionally remain identical for first-version parity.
 */

export type VoiceRecordingCueKind = "start" | "stop";

export const VOICE_RECORDING_CUE_SPEC = Object.freeze({
	startNotes: Object.freeze([523.25, 659.25]),
	stopNotes: Object.freeze([587.33, 440]),
	noteDurationSeconds: 0.09,
	noteGapSeconds: 0.025,
	noteAttackSeconds: 0.015,
	maxGain: 0.2,
	minGain: 0.0001,
	baseDelaySeconds: 0.005,
	stopTailSeconds: 0.01,
});

interface VoiceRecordingCueAudioParam {
	setValueAtTime(value: number, at: number): void;
	linearRampToValueAtTime(value: number, at: number): void;
	exponentialRampToValueAtTime(value: number, at: number): void;
}

interface VoiceRecordingCueOscillator {
	type: string;
	frequency: Pick<VoiceRecordingCueAudioParam, "setValueAtTime">;
	connect(destination: unknown): unknown;
	start(at: number): void;
	stop(at: number): void;
}

interface VoiceRecordingCueGain {
	gain: VoiceRecordingCueAudioParam;
	connect(destination: unknown): unknown;
}

export interface VoiceRecordingCueAudioContext {
	currentTime: number;
	state: string;
	destination: unknown;
	createOscillator(): VoiceRecordingCueOscillator;
	createGain(): VoiceRecordingCueGain;
	resume(): Promise<void>;
}

type VoiceRecordingCueAudioContextFactory = () => VoiceRecordingCueAudioContext | null;

function createBrowserAudioContext(): VoiceRecordingCueAudioContext | null {
	if (typeof window === "undefined") return null;
	const browserWindow = window as typeof window & {
		webkitAudioContext?: typeof AudioContext;
	};
	const AudioContextConstructor = window.AudioContext ?? browserWindow.webkitAudioContext;
	if (!AudioContextConstructor) return null;
	return new AudioContextConstructor() as unknown as VoiceRecordingCueAudioContext;
}

export class VoiceRecordingCuePlayer {
	private context: VoiceRecordingCueAudioContext | null = null;

	constructor(
		private readonly createAudioContext: VoiceRecordingCueAudioContextFactory =
			createBrowserAudioContext,
	) {}

	async prepare(): Promise<void> {
		await this.resumeContextIfNeeded();
	}

	async play(kind: VoiceRecordingCueKind, enabled: boolean): Promise<void> {
		try {
			if (!enabled) return;
			const context = await this.resumeContextIfNeeded();
			if (!context) return;

			const notes = kind === "start"
				? VOICE_RECORDING_CUE_SPEC.startNotes
				: VOICE_RECORDING_CUE_SPEC.stopNotes;
			const baseTime = context.currentTime + VOICE_RECORDING_CUE_SPEC.baseDelaySeconds;
			notes.forEach((frequency, index) => {
				const noteStart =
					baseTime +
					index * (
						VOICE_RECORDING_CUE_SPEC.noteDurationSeconds +
						VOICE_RECORDING_CUE_SPEC.noteGapSeconds
					);
				this.scheduleTone(context, frequency, noteStart);
			});
		} catch (error) {
			console.debug(
				`[voice] failed to play recording cue: ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
		}
	}

	private async resumeContextIfNeeded(): Promise<VoiceRecordingCueAudioContext | null> {
		try {
			if (!this.context || this.context.state === "closed") {
				this.context = this.createAudioContext();
			}
			if (!this.context) return null;
			if (this.context.state === "suspended") await this.context.resume();
			return this.context.state === "running" ? this.context : null;
		} catch (error) {
			console.debug(
				`[voice] failed to initialize recording cue audio: ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
			return null;
		}
	}

	private scheduleTone(
		context: VoiceRecordingCueAudioContext,
		frequency: number,
		startTime: number,
	): void {
		const oscillator = context.createOscillator();
		const gainNode = context.createGain();
		const stopTime = startTime + VOICE_RECORDING_CUE_SPEC.noteDurationSeconds;

		oscillator.type = "sine";
		oscillator.frequency.setValueAtTime(frequency, startTime);
		gainNode.gain.setValueAtTime(VOICE_RECORDING_CUE_SPEC.minGain, startTime);
		gainNode.gain.linearRampToValueAtTime(
			VOICE_RECORDING_CUE_SPEC.maxGain,
			startTime + VOICE_RECORDING_CUE_SPEC.noteAttackSeconds,
		);
		gainNode.gain.exponentialRampToValueAtTime(
			VOICE_RECORDING_CUE_SPEC.minGain,
			stopTime,
		);
		oscillator.connect(gainNode);
		gainNode.connect(context.destination);
		oscillator.start(startTime);
		oscillator.stop(stopTime + VOICE_RECORDING_CUE_SPEC.stopTailSeconds);
	}
}

export const voiceRecordingCuePlayer = new VoiceRecordingCuePlayer();
