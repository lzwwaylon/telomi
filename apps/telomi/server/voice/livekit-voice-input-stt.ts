import {
	asLanguageCode,
	mergeFrames,
	stt,
	type AudioBuffer,
} from "@livekit/agents";
import { pcm16MonoToWav } from "./local-snapshot-transcription.js";
import type { LiveKitGoalClient } from "./livekit-goal-client.js";

export class TelomiVoiceInputSTT extends stt.STT {
	readonly label = "telomi.voice-input";
	private contextSnapshotId?: string;

	async beginUtterance(): Promise<void> {
		this.contextSnapshotId = await this.client.captureVoiceContext?.(this.goalId);
	}

	constructor(
		private readonly goalId: string,
		private readonly client: Pick<LiveKitGoalClient, "transcribeVoiceInput"> & Partial<Pick<LiveKitGoalClient, "captureVoiceContext">>,
		private readonly language = "auto",
	) {
		super({
			streaming: false,
			interimResults: false,
			alignedTranscript: false,
		});
	}

	override get model(): string {
		return "configured-voice-input-pipeline";
	}

	override get provider(): string {
		return "telomi";
	}

	override stream(): stt.SpeechStream {
		throw new Error("Telomi voice input only supports final transcription");
	}

	protected override async _recognize(
		buffer: AudioBuffer,
		signal?: AbortSignal,
	): Promise<stt.SpeechEvent> {
		const frame = mergeFrames(buffer);
		if (frame.channels !== 1) {
			throw new Error("Telomi voice input requires mono PCM audio");
		}
		const pcm = Buffer.from(
			frame.data.buffer,
			frame.data.byteOffset,
			frame.data.byteLength,
		);
		const text = await this.client.transcribeVoiceInput(
			this.goalId,
			pcm16MonoToWav(pcm, frame.sampleRate),
			signal,
			this.contextSnapshotId,
		);
		return {
			type: stt.SpeechEventType.FINAL_TRANSCRIPT,
			...(text
				? {
						alternatives: [
							{
								language: asLanguageCode(this.language === "auto" ? "und" : this.language),
								text,
								startTime: 0,
								endTime: frame.samplesPerChannel / frame.sampleRate,
								confidence: 1,
							},
						] as [stt.SpeechData],
					}
				: {}),
		};
	}
}
