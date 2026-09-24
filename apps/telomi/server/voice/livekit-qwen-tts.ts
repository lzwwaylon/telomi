import { resolveAudioGeneration } from "../audio/configuration.js";
import { randomUUID } from "node:crypto";
import {
	AudioByteStream,
	type APIConnectOptions,
	tokenize,
	tts,
} from "@livekit/agents";
import type { AudioFrame } from "@livekit/rtc-node";
import { speakPcm16Stream, captureAudioGeneration, speechPcmSampleRate } from "../audio/providers/tts.js";
import { getAudioLocalRuntimeManager } from "../audio/local-runtime.js";

const DEFAULT_SAMPLE_RATE = 24_000;
const NUM_CHANNELS = 1;

export class MultilingualSentenceTokenizer extends tokenize.SentenceTokenizer {
	tokenize(text: string, language?: string): string[] {
		return segmentSentences(text, language).map(([sentence]) => sentence);
	}

	stream(language?: string): tokenize.SentenceStream {
		return new tokenize.BufferedSentenceStream(
			(text) => segmentSentences(text, language),
			1,
			1,
		);
	}
}

function segmentSentences(
	text: string,
	language?: string,
): [string, number, number][] {
	return Array.from(
		new Intl.Segmenter(language, { granularity: "sentence" }).segment(text),
		({ segment, index }): [string, number, number] => [
			segment.trim(),
			index,
			index + segment.length,
		],
	).filter(([sentence]) => sentence.length > 0);
}

export interface QwenTtsDependencies {
	synthesize?: (text: string, signal: AbortSignal) => AsyncIterable<Uint8Array>;
	ensureReady?: (signal: AbortSignal) => Promise<void>;
	sampleRate?: number;
}

export class QwenLiveKitTTS extends tts.TTS {
	label = "telomi.QwenLiveKitTTS";
	private readonly managed: boolean;
	private readonly synthesizeAudio: NonNullable<QwenTtsDependencies["synthesize"]>;
	private readonly ensureAudioReady: NonNullable<QwenTtsDependencies["ensureReady"]>;

	constructor(dependencies: QwenTtsDependencies = {}) {
		super(
			validSampleRate(dependencies.sampleRate ?? speechPcmSampleRate()),
			NUM_CHANNELS,
			{ streaming: false },
		);
		this.managed = !dependencies.synthesize;
		this.synthesizeAudio =
			dependencies.synthesize ??
			(async function* (text, signal) {
				yield* speakPcm16Stream({ text, signal });
			});
		this.ensureAudioReady =
			dependencies.ensureReady ??
			(async (signal) => {
				await getAudioLocalRuntimeManager().ensureReady(signal);
			});
	}

	override get provider(): string {
		return this.managed ? resolveAudioGeneration("local")?.connection ?? "" : "injected";
	}

	override get model(): string {
		return this.managed ? resolveAudioGeneration("local")?.model ?? "" : "injected";
	}

	synthesize(
		text: string,
		connOptions?: APIConnectOptions,
		abortSignal?: AbortSignal,
	): tts.ChunkedStream {
		const audio = this.managed ? captureAudioGeneration("local") : undefined;
		return new QwenChunkedStream(
			this,
			text,
			audio ? (text, signal) => speakPcm16Stream({ text, signal, audio }) : this.synthesizeAudio,
			audio ? (signal) => getAudioLocalRuntimeManager().prepare(audio.connection, signal) : this.ensureAudioReady,
			connOptions,
			abortSignal,
		);
	}

	stream(): tts.SynthesizeStream {
		throw new Error(
			"QwenLiveKitTTS uses LiveKit's sentence stream adapter",
		);
	}
}

class QwenChunkedStream extends tts.ChunkedStream {
	label = "telomi.QwenChunkedStream";
	private readonly sampleRate: number;

	constructor(
		ttsProvider: QwenLiveKitTTS,
		text: string,
		private readonly synthesizeAudio: NonNullable<
			QwenTtsDependencies["synthesize"]
		>,
		private readonly ensureAudioReady: NonNullable<
			QwenTtsDependencies["ensureReady"]
		>,
		connOptions?: APIConnectOptions,
		abortSignal?: AbortSignal,
	) {
		super(text, ttsProvider, connOptions, abortSignal);
		this.sampleRate = ttsProvider.sampleRate;
	}

	protected async run(): Promise<void> {
		const requestId = `qwen_${randomUUID()}`;
		const audioFrames = new AudioByteStream(
			this.sampleRate,
			NUM_CHANNELS,
			Math.floor(this.sampleRate / 50),
		);
		let lastFrame: AudioFrame | undefined;
		let emittedAudio = false;

		const push = (frame: AudioFrame) => {
			if (lastFrame) {
				this.queue.put({
					requestId,
					segmentId: requestId,
					frame: lastFrame,
					final: false,
				});
			}
			lastFrame = frame;
			emittedAudio = true;
		};

		try {
			await this.ensureAudioReady(this.abortSignal);
			for await (const pcmChunk of this.synthesizeAudio(
				this.inputText,
				this.abortSignal,
			)) {
				if (this.abortSignal.aborted) return;
				if (!pcmChunk.byteLength) continue;
				for (const frame of audioFrames.write(pcmChunk)) push(frame);
			}
			for (const frame of audioFrames.flush()) {
				if (frame.samplesPerChannel > 0) push(frame);
			}
			if (!emittedAudio || !lastFrame) {
				throw new Error("Qwen TTS returned no PCM audio");
			}
			this.queue.put({
				requestId,
				segmentId: requestId,
				frame: lastFrame,
				final: true,
			});
		} catch (error) {
			if (
				this.abortSignal.aborted ||
				(error instanceof Error && error.name === "AbortError")
			) {
				return;
			}
			throw error;
		} finally {
			this.queue.close();
		}
	}
}

function validSampleRate(value: number): number {
	return Number.isSafeInteger(value) && value >= 8_000 && value <= 96_000
		? value
		: DEFAULT_SAMPLE_RATE;
}
