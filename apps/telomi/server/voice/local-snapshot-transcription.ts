import { resolveSpeechConfiguration, noteSpeechConfiguration } from "./configuration.js";
import {
	transcribe,
	type SttWarmupRequest,
	type TranscribeRequest,
	warmupStt,
} from "../audio/providers/stt.js";
import { isManagedAudioConnection } from "../../shared/connections.js";
import type { VoiceVadConfig } from "../audio/voice-vad.js";
import type { StreamingTranscriptionAdapter, StreamingTranscriptionCallbacks } from "./streaming-transcription-adapter.js";

export const DEFAULT_SNAPSHOT_SECONDS = 2;
const DEFAULT_SNAPSHOT_INTERVAL_SECONDS = 3;
const DEFAULT_MAX_PREVIEW_SECONDS = 120;
const DEFAULT_WARMUP_TIMEOUT_MS = 45_000;

type Transcribe = (request: TranscribeRequest) => ReturnType<typeof transcribe>;
type Warmup = (request: SttWarmupRequest) => ReturnType<typeof warmupStt>;

export interface LocalSnapshotTranscriptionOptions {
	inputSampleRate: number;
	language?: string;
	prompt?: string;
	vad?: VoiceVadConfig;
	model?: string;
	snapshotSeconds?: number;
	snapshotIntervalSeconds?: number;
	maxPreviewSeconds?: number;
	responseFormat?: "json" | "verbose_json";
	callbacks?: StreamingTranscriptionCallbacks;
	transcribe?: Transcribe;
	warmup?: Warmup;
	warmupTimeoutMs?: number;
}

/**
 * Local snapshot STT adapter.
 *
 * Qwen3-ASR is fast enough on Apple Silicon to re-transcribe the accumulated
 * PCM every few seconds. Each result is a complete, replaceable hypothesis.
 * The normal batch transcription remains the authoritative final result.
 */
export class LocalSnapshotTranscriptionAdapter implements StreamingTranscriptionAdapter {
	readonly provider: string;
	readonly model: string;

	private readonly selection: TranscribeRequest["selection"];
	private readonly options: LocalSnapshotTranscriptionOptions;
	private readonly firstSnapshotBytes: number;
	private readonly snapshotIntervalBytes: number;
	private readonly maxPreviewBytes: number;
	private readonly transcribe: Transcribe;
	private buffers: Buffer[] = [];
	private bufferedBytes = 0;
	private lastSnapshotBytes = 0;
	private bestText = "";
	private hasSpeechSinceLastSnapshot = false;
	private inFlight: Promise<void> | null = null;
	private abortController: AbortController | null = null;
	private connectPromise: Promise<void> | null = null;
	private connectAbortController: AbortController | null = null;
	private ready = false;
	private finishing = false;
	private closed = false;

	constructor(options: LocalSnapshotTranscriptionOptions) {
		if (!Number.isInteger(options.inputSampleRate) || options.inputSampleRate < 8_000) {
			throw new Error("local snapshot STT requires a valid PCM sample rate");
		}
		this.options = options;
		const speech = resolveSpeechConfiguration();
		this.selection = speech?.local;
		if (speech) noteSpeechConfiguration("local", speech);
		this.provider = `${this.selection?.connection ?? "stt"}-snapshot`;
		this.model = options.model?.trim() || this.selection?.model || "";
		const snapshotSeconds = positiveNumber(options.snapshotSeconds, DEFAULT_SNAPSHOT_SECONDS);
		const snapshotIntervalSeconds = positiveNumber(
			options.snapshotIntervalSeconds,
			DEFAULT_SNAPSHOT_INTERVAL_SECONDS,
		);
		const maxPreviewSeconds = positiveNumber(
			options.maxPreviewSeconds,
			DEFAULT_MAX_PREVIEW_SECONDS,
		);
		this.firstSnapshotBytes = Math.max(
			2,
			Math.floor(options.inputSampleRate * 2 * snapshotSeconds),
		);
		this.snapshotIntervalBytes = Math.max(
			2,
			Math.floor(options.inputSampleRate * 2 * snapshotIntervalSeconds),
		);
		this.maxPreviewBytes = Math.max(
			this.firstSnapshotBytes,
			Math.floor(options.inputSampleRate * 2 * maxPreviewSeconds),
		);
		this.transcribe = options.transcribe ?? transcribe;
	}

	connect(): Promise<void> {
		if (this.closed) throw new Error("local snapshot transcription adapter is closed");
		if (this.ready) return Promise.resolve();
		if (this.connectPromise) return this.connectPromise;
		const promise = this.runConnect().finally(() => {
			if (this.connectPromise === promise) this.connectPromise = null;
		});
		this.connectPromise = promise;
		return promise;
	}

	private async runConnect(): Promise<void> {
		const controller = new AbortController();
		this.connectAbortController = controller;
		const timeoutMs = positiveNumber(
			this.options.warmupTimeoutMs,
			positiveNumberEnv("TELOMI_VOICE_LOCAL_WARMUP_TIMEOUT_MS", DEFAULT_WARMUP_TIMEOUT_MS),
		);
		const timer = setTimeout(() => controller.abort("ASR warmup timed out"), timeoutMs);
		try {
			// The managed service loads its model on warmup; any other endpoint is only connected to.
			this.options.callbacks?.onPreparing?.(isManagedAudioConnection(this.selection?.connection)
				? { stage: "model_warmup", message: "正在预热本地语音模型…" }
				: { stage: "provider_connection", message: "正在连接语音服务…" });
			// Warmup runs only where the endpoint advertises it; elsewhere this returns without a request.
			const result = await (this.options.warmup ?? warmupStt)({
				model: this.model,
				baseUrl: this.selection?.baseUrl,
				connection: this.selection?.connection,
				signal: controller.signal,
			});
			if (!result.ok) throw new Error(result.reason);
			if (this.closed) throw new Error("local snapshot transcription adapter is closed");
			this.ready = true;
			this.options.callbacks?.onReady?.(result.advertised ? {
				readyBeforeRequest: result.readyBeforeRequest,
				warmupDurationMs: result.durationMs,
				requestDurationMs: result.requestDurationMs,
			} : undefined);
		} finally {
			clearTimeout(timer);
			if (this.connectAbortController === controller) {
				this.connectAbortController = null;
			}
		}
		this.scheduleSnapshotIfNeeded();
	}

	sendAudio(bytes: Buffer): boolean {
		if (this.closed || this.finishing || bytes.length === 0) return false;
		if (this.bufferedBytes < this.maxPreviewBytes) {
			const remaining = this.maxPreviewBytes - this.bufferedBytes;
			const copy = Buffer.from(bytes.subarray(0, remaining));
			if (copy.length > 0) {
				this.buffers.push(copy);
				this.bufferedBytes += copy.length;
				this.hasSpeechSinceLastSnapshot =
					this.hasSpeechSinceLastSnapshot || pcm16HasSpeech(copy);
			}
		}
		if (this.ready) this.scheduleSnapshotIfNeeded();
		return this.ready;
	}

	async finish(): Promise<string> {
		if (this.closed) return this.bestText;
		this.finishing = true;
		this.abortController?.abort();
		await this.inFlight?.catch(() => undefined);
		return this.bestText;
	}

	cancel(): void {
		this.close();
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		this.ready = false;
		this.finishing = true;
		this.connectAbortController?.abort("local snapshot adapter closed");
		this.connectAbortController = null;
		this.abortController?.abort();
		this.abortController = null;
		this.buffers = [];
		this.bufferedBytes = 0;
	}

	private scheduleSnapshotIfNeeded(): void {
		const requiredBytes =
			this.lastSnapshotBytes === 0
				? this.firstSnapshotBytes
				: this.snapshotIntervalBytes;
		if (
			!this.ready ||
			this.closed ||
			this.finishing ||
			this.inFlight ||
			this.bufferedBytes < this.firstSnapshotBytes ||
			this.bufferedBytes - this.lastSnapshotBytes < requiredBytes ||
			!this.hasSpeechSinceLastSnapshot
		) {
			return;
		}

		const snapshotBytes = this.bufferedBytes;
		const pcm = Buffer.concat(this.buffers, snapshotBytes);
		this.lastSnapshotBytes = snapshotBytes;
		this.hasSpeechSinceLastSnapshot = false;
		const controller = new AbortController();
		this.abortController = controller;
		this.inFlight = this.runSnapshot(pcm, controller.signal)
			.catch((error) => {
				if (controller.signal.aborted || this.closed || this.finishing) return;
				this.options.callbacks?.onError?.(asError(error));
			})
			.finally(() => {
				if (this.abortController === controller) this.abortController = null;
				this.inFlight = null;
				this.scheduleSnapshotIfNeeded();
			});
	}

	private async runSnapshot(pcm: Buffer, signal: AbortSignal): Promise<void> {
		const result = await this.transcribe({
			buffer: pcm16MonoToWav(pcm, this.options.inputSampleRate),
			filename: "voice-preview.wav",
			mime: "audio/wav",
			language: this.options.language,
			prompt: this.options.prompt,
			vad: this.options.vad,
			model: this.model,
			selection: this.selection,
			responseFormat: this.options.responseFormat,
			signal,
		});
		if (signal.aborted || this.closed || this.finishing) return;
		if (!result.ok) throw new Error(result.reason);
		const text = result.text.trim();
		if (!text) return;
		this.bestText = text;
		this.options.callbacks?.onPartial?.(text);
	}
}

export function pcm16MonoToWav(pcm: Buffer, sampleRate: number): Buffer {
	const evenLength = pcm.length - (pcm.length % 2);
	const wav = Buffer.allocUnsafe(44 + evenLength);
	wav.write("RIFF", 0, "ascii");
	wav.writeUInt32LE(36 + evenLength, 4);
	wav.write("WAVE", 8, "ascii");
	wav.write("fmt ", 12, "ascii");
	wav.writeUInt32LE(16, 16);
	wav.writeUInt16LE(1, 20);
	wav.writeUInt16LE(1, 22);
	wav.writeUInt32LE(sampleRate, 24);
	wav.writeUInt32LE(sampleRate * 2, 28);
	wav.writeUInt16LE(2, 32);
	wav.writeUInt16LE(16, 34);
	wav.write("data", 36, "ascii");
	wav.writeUInt32LE(evenLength, 40);
	pcm.copy(wav, 44, 0, evenLength);
	return wav;
}

export function pcm16HasSpeech(pcm: Buffer): boolean {
	const sampleCount = Math.floor(pcm.length / 2);
	if (sampleCount === 0) return false;
	let sumSquares = 0;
	let peak = 0;
	for (let offset = 0; offset + 1 < pcm.length; offset += 2) {
		const normalized = Math.abs(pcm.readInt16LE(offset)) / 32_768;
		sumSquares += normalized * normalized;
		if (normalized > peak) peak = normalized;
	}
	const rms = Math.sqrt(sumSquares / sampleCount);
	return rms >= 0.003 || peak >= 0.02;
}

function positiveNumber(value: number | undefined, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function positiveNumberEnv(name: string, fallback: number): number {
	return positiveNumber(Number(process.env[name]), fallback);
}

function asError(value: unknown): Error {
	return value instanceof Error ? value : new Error(String(value));
}
