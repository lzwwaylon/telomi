import { resolveSpeechConfiguration } from "./configuration.js";
import {
	APIConnectionError,
	DEFAULT_API_CONNECT_OPTIONS,
	asLanguageCode,
	type APIConnectOptions,
	type AudioBuffer,
	type VAD,
	VADEventType,
	log,
	stt,
} from "@livekit/agents";
import type { AudioFrame } from "@livekit/rtc-node";
import {
	LocalSnapshotTranscriptionAdapter,
} from "./local-snapshot-transcription.js";
import type {
	StreamingTranscriptionAdapter,
	StreamingTranscriptionCallbacks,
} from "./streaming-transcription-adapter.js";
import { toErrorMessage } from "../lib/values.js";

const SAMPLE_RATE = 16_000;

type PreviewFactory = (
	callbacks: StreamingTranscriptionCallbacks,
) => StreamingTranscriptionAdapter;

export interface LiveKitSnapshotSTTOptions {
	vad: VAD;
	finalizer: stt.STT & { beginUtterance?: () => Promise<void> };
	model: string;
	language?: string;
	previewFactory?: PreviewFactory;
	onPreviewError?: (error: Error) => void;
}

export class LiveKitSnapshotSTT extends stt.STT {
	readonly label = "telomi-audio.LiveKitSnapshotSTT";
	readonly #options: LiveKitSnapshotSTTOptions;
	readonly #streams = new Set<LiveKitSnapshotSpeechStream>();

	constructor(options: LiveKitSnapshotSTTOptions) {
		super({
			streaming: true,
			interimResults: true,
			alignedTranscript: false,
		});
		this.#options = options;
	}

	override get model(): string {
		return this.#options.model;
	}

	override get provider(): string {
		return "telomi-audio-snapshot";
	}

	protected override async _recognize(
		frame: AudioBuffer,
		abortSignal?: AbortSignal,
	): Promise<stt.SpeechEvent> {
		return this.#options.finalizer.recognize(frame, abortSignal);
	}

	override stream(options?: {
		connOptions?: APIConnectOptions;
	}): stt.SpeechStream {
		const stream = new LiveKitSnapshotSpeechStream(
			this,
			this.#options,
			options?.connOptions ?? DEFAULT_API_CONNECT_OPTIONS,
			() => this.#streams.delete(stream),
		);
		this.#streams.add(stream);
		return stream;
	}

	override async close(): Promise<void> {
		for (const stream of this.#streams) stream.close();
		this.#streams.clear();
		await this.#options.finalizer.close();
	}
}

class LiveKitSnapshotSpeechStream extends stt.SpeechStream {
	readonly label = "telomi-audio.LiveKitSnapshotSpeechStream";
	readonly #options: LiveKitSnapshotSTTOptions;
	readonly #onClose: () => void;
	#vadStream: ReturnType<VAD["stream"]> | null = null;
	#preview: StreamingTranscriptionAdapter | null = null;
	#requestId = 0;
	#activeRequestId = "";
	#turnFrames: AudioFrame[] = [];
	#latestPartial = "";
	#closedOnce = false;

	constructor(
		provider: LiveKitSnapshotSTT,
		options: LiveKitSnapshotSTTOptions,
		connOptions: APIConnectOptions,
		onClose: () => void,
	) {
		super(provider, SAMPLE_RATE, connOptions);
		this.#options = options;
		this.#onClose = onClose;
	}

	protected override async run(): Promise<void> {
		this.#vadStream = this.#options.vad.stream();
		const inputTask = this.#forwardInput();
		const vadTask = this.#forwardVadEvents();
		const abortTask = new Promise<void>((resolve) => {
			this.abortSignal.addEventListener("abort", () => resolve(), {
				once: true,
			});
		});
		try {
			await Promise.race([inputTask, vadTask, abortTask]);
		} catch (error) {
			if (!this.abortSignal.aborted) {
				throw error instanceof APIConnectionError
					? error
					: new APIConnectionError({
							message: toErrorMessage(error),
						});
			}
		} finally {
			this.#preview?.close();
			this.#preview = null;
			this.#closeVadStream();
			this.#notifyClosed();
		}
	}

	override close(): void {
		super.close();
		this.#preview?.close();
		this.#preview = null;
		this.#closeVadStream();
		this.#notifyClosed();
	}

	async #forwardInput(): Promise<void> {
		const vadStream = this.#vadStream;
		if (!vadStream) return;
		for await (const frame of this.input) {
			if (frame === LiveKitSnapshotSpeechStream.FLUSH_SENTINEL) {
				vadStream.flush();
				continue;
			}
			vadStream.pushFrame(frame);
		}
		vadStream.endInput();
		await new Promise<void>((resolve) => {
			this.abortSignal.addEventListener("abort", () => resolve(), {
				once: true,
			});
		});
	}

	async #forwardVadEvents(): Promise<void> {
		const vadStream = this.#vadStream;
		if (!vadStream) return;
		for await (const event of vadStream) {
			switch (event.type) {
				case VADEventType.START_OF_SPEECH:
					await this.#startTurn(event.frames);
					break;
				case VADEventType.INFERENCE_DONE:
					if (!this.#activeRequestId) break;
					this.#turnFrames.push(...event.frames);
					this.#sendPreviewFrames(event.frames);
					break;
				case VADEventType.END_OF_SPEECH:
					if (!this.#activeRequestId) break;
					if (event.frames.length > 0) {
						this.#turnFrames = [...event.frames];
					}
					this.queue.put({
						type: stt.SpeechEventType.END_OF_SPEECH,
						requestId: this.#activeRequestId,
						alternatives: this.#latestPartial
							? [speechData(this.#latestPartial, this.#options.language)]
							: undefined,
					});
					await this.#finishTurn();
					break;
			}
		}
	}

	async #startTurn(frames: AudioFrame[]): Promise<void> {
		await this.#options.finalizer.beginUtterance?.();
		this.#preview?.close();
		this.#requestId += 1;
		const requestId = `snapshot-${this.#requestId}`;
		this.#activeRequestId = requestId;
		this.#turnFrames = [...frames];
		this.#latestPartial = "";
		this.#preview = this.#createPreview({
			onPartial: (text) => {
				const partial = text.trim();
				if (!partial || this.#activeRequestId !== requestId) return;
				this.#latestPartial = partial;
				this.queue.put({
					type: stt.SpeechEventType.INTERIM_TRANSCRIPT,
					requestId,
					alternatives: [speechData(partial, this.#options.language)],
				});
			},
			onError: this.#options.onPreviewError,
		});
		await this.#preview.connect();
		this.queue.put({
			type: stt.SpeechEventType.START_OF_SPEECH,
			requestId,
		});
		this.#sendPreviewFrames(frames);
	}

	async #finishTurn(): Promise<void> {
		const requestId = this.#activeRequestId;
		const preview = this.#preview;
		await preview?.finish();
		preview?.close();
		this.#preview = null;
		try {
			const event = await this.#options.finalizer.recognize(this.#turnFrames);
			const text = event.alternatives?.[0]?.text.trim();
			if (text) {
				this.queue.put({
					type: stt.SpeechEventType.FINAL_TRANSCRIPT,
					requestId,
					alternatives: [speechData(text, this.#options.language)],
				});
			}
		} catch (error) {
			log().warn(
				{ error, requestId },
				"authoritative speech transcription failed; preview was not committed",
			);
		}
		this.#activeRequestId = "";
		this.#turnFrames = [];
		this.#latestPartial = "";
	}

	#createPreview(
		callbacks: StreamingTranscriptionCallbacks,
	): StreamingTranscriptionAdapter {
		if (this.#options.previewFactory) {
			return this.#options.previewFactory(callbacks);
		}
		const speech = resolveSpeechConfiguration();
		return new LocalSnapshotTranscriptionAdapter({
			inputSampleRate: SAMPLE_RATE,
			language: this.#options.language,
			model: speech.local?.model ?? this.#options.model,
			responseFormat: "json",
			// The Worker session already prepared the endpoint; the preview never warms it again.
			warmup: async () => ({
				ok: true,
				provider: speech.local?.connection ?? "stt",
				model: speech.local?.model ?? this.#options.model,
				advertised: false,
				readyBeforeRequest: true,
				durationMs: 0,
				requestDurationMs: 0,
				ttlSec: 0,
			}),
			callbacks,
		});
	}

	#sendPreviewFrames(frames: AudioFrame[]): void {
		const preview = this.#preview;
		if (!preview) return;
		for (const frame of frames) {
			preview.sendAudio(
				Buffer.from(
					frame.data.buffer,
					frame.data.byteOffset,
					frame.data.byteLength,
				),
			);
		}
	}

	#notifyClosed(): void {
		if (this.#closedOnce) return;
		this.#closedOnce = true;
		this.#onClose();
	}

	#closeVadStream(): void {
		const stream = this.#vadStream;
		this.#vadStream = null;
		if (!stream) return;
		try {
			stream.close();
		} catch {
			// LiveKit VAD streams can already be closing during session shutdown.
		}
	}
}

function speechData(text: string, language = "und"): stt.SpeechData {
	return {
		language: asLanguageCode(language),
		text,
		startTime: 0,
		endTime: 0,
		confidence: 1,
	};
}
