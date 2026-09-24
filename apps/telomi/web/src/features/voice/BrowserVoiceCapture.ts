import type { LocalSpeechGateDecision, LocalSpeechGateState } from "@/features/voice/localSpeechGate";
import { uiText } from "@/app/ui-text";
import {
	createLocalSpeechGateState,
	getLocalSpeechGateDecision,
	recordLocalSpeechWindow,
} from "@/features/voice/localSpeechGate";
import {
	createPcmWorkletSource,
	measurePcm16Window,
	PCM_WORKLET_NAME,
} from "@/features/voice/pcm";
import {
	getVoiceMicrophoneManager,
	type VoiceMicrophoneAcquirer,
} from "@/features/voice/VoiceMicrophoneManager";
import type { VoiceMicrophoneCaptureMetadata } from "@shared/voice-microphone.js";
import {
	evaluateVoiceRecording,
	type VoiceRecordingValidation,
} from "@shared/voice-recording.js";

const MIME_CANDIDATES = [
	"audio/webm;codecs=opus",
	"audio/webm",
	"audio/mp4",
	"audio/ogg",
	"audio/wav",
];
const WORKLET_FLUSH_TIMEOUT_MS = 750;
// A browser that never settles addModule would otherwise leave voice input starting forever.
const WORKLET_LOAD_TIMEOUT_MS = 5_000;

/**
 * A browser API that may never settle, bounded. `addModule` resolving or rejecting is the normal
 * path; this only decides what happens when it does neither, so the caller gets an error it can
 * report instead of an await that never returns.
 */
function withTimeout<T>(pending: Promise<T>, timeoutMs: number, onTimeout: () => Error): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = window.setTimeout(() => reject(onTimeout()), timeoutMs);
		pending.then(
			(value) => { window.clearTimeout(timer); resolve(value); },
			(error: unknown) => { window.clearTimeout(timer); reject(error instanceof Error ? error : new Error(String(error))); },
		);
	});
}

type VoiceCaptureSilentSink = { type: "none" };
type VoiceCaptureAudioContextOptions = AudioContextOptions & {
	sinkId?: VoiceCaptureSilentSink;
};
type VoiceCaptureAudioContextConstructor = {
	new (options?: VoiceCaptureAudioContextOptions): AudioContext;
	prototype: AudioContext & {
		setSinkId?: (sinkId: string | VoiceCaptureSilentSink) => Promise<void>;
	};
};

/**
 * Keep the AudioWorklet graph clocked without reserving a physical output.
 * Chromium exposes a no-output sink for analysis/recording-only contexts. On
 * browsers without that capability the standard destination remains the
 * compatibility fallback.
 */
export function createVoiceCaptureAudioContext(
	preferredSampleRate: number,
	AudioContextConstructor: VoiceCaptureAudioContextConstructor =
		AudioContext as unknown as VoiceCaptureAudioContextConstructor,
): AudioContext {
	const supportsSilentSink =
		typeof AudioContextConstructor.prototype.setSinkId === "function";
	const options: VoiceCaptureAudioContextOptions = supportsSilentSink
		? {
				sampleRate: preferredSampleRate,
				sinkId: { type: "none" },
			}
		: { sampleRate: preferredSampleRate };
	try {
		return new AudioContextConstructor(options);
	} catch {
		// Some browsers expose setSinkId only for string device IDs. Preserve
		// recording support instead of failing microphone capture completely.
		return new AudioContextConstructor({ sampleRate: preferredSampleRate });
	}
}

export interface BrowserVoiceCaptureResult {
	blob: Blob;
	mime: string;
	durationMs: number;
	sampleRate: number;
	speechGate: LocalSpeechGateDecision;
	recordingValidation: VoiceRecordingValidation;
	microphone: VoiceMicrophoneCaptureMetadata;
}

/**
 * Deep browser capture Module.
 *
 * Interface: start, stop, cancel, sampleRate.
 * Implementation: one microphone stream feeds an AudioWorklet PCM path and a
 * MediaRecorder fallback path. The caller never coordinates those resources.
 */
export class BrowserVoiceCapture {
	private stream: MediaStream | null = null;
	private recorder: MediaRecorder | null = null;
	private chunks: Blob[] = [];
	private audioContext: AudioContext | null = null;
	private sourceNode: MediaStreamAudioSourceNode | null = null;
	private workletNode: AudioWorkletNode | null = null;
	private sinkNode: GainNode | null = null;
	private workletUrl: string | null = null;
	private speechGateState: LocalSpeechGateState = createLocalSpeechGateState();
	private startedAt = 0;
	private mime = "audio/webm";
	private stopping: Promise<BrowserVoiceCaptureResult | null> | null = null;
	private starting: Promise<number> | null = null;
	private cancelled = false;
	private preserveCancelledResult = false;
	private microphoneCapture: VoiceMicrophoneCaptureMetadata | null = null;
	private readonly microphone: VoiceMicrophoneAcquirer;

	constructor(
		microphone: VoiceMicrophoneAcquirer = getVoiceMicrophoneManager(),
	) {
		this.microphone = microphone;
	}

	get sampleRate(): number | null {
		return this.audioContext?.sampleRate ?? null;
	}

	start(preferredSampleRate = 24_000): Promise<number> {
		if (this.starting || this.stream || this.recorder) {
			return Promise.reject(new Error(uiText("voice.browservoicecapture.voiceCaptureIsAlreadyActive")));
		}
		if (!BrowserVoiceCapture.isSupported()) {
			return Promise.reject(new Error(uiText("voice.browservoicecapture.thisBrowserDoesNotSupportStreamingMicrophoneRecording")));
		}

		this.cancelled = false;
		this.preserveCancelledResult = false;
		this.chunks = [];
		this.speechGateState = createLocalSpeechGateState();
		const starting = this.startInternal(preferredSampleRate).finally(() => {
			if (this.starting === starting) this.starting = null;
		});
		this.starting = starting;
		return starting;
	}

	private async startInternal(preferredSampleRate: number): Promise<number> {
		const capture = await this.microphone.acquire();
		this.stream = capture.stream;
		this.microphoneCapture = {
			deviceId: capture.deviceId,
			deviceLabel: capture.deviceLabel,
			selectionStatus: capture.selectionStatus,
			usedFallback: capture.usedFallback,
		};

		try {
			if (this.cancelled) throw new VoiceCaptureStartCancelledError();
			await this.startPcmPipeline(preferredSampleRate);
			if (this.cancelled) throw new VoiceCaptureStartCancelledError();
			this.startMediaRecorder();
			this.startedAt = Date.now();
			return this.audioContext!.sampleRate;
		} catch (error) {
			await this.releaseResources();
			throw error;
		}
	}

	stop(): Promise<BrowserVoiceCaptureResult | null> {
		if (this.stopping) return this.stopping;
		if (!this.recorder || !this.stream) return Promise.resolve(null);
		this.stopping = this.stopInternal();
		return this.stopping;
	}

	cancel(preserveResult = false): Promise<BrowserVoiceCaptureResult | null> {
		this.cancelled = true;
		this.preserveCancelledResult = preserveResult;
		const starting = this.starting;
		if (starting) {
			return starting.then(
				() => this.cancelActiveCapture(),
				() => null,
			);
		}
		return this.cancelActiveCapture();
	}

	private cancelActiveCapture(): Promise<BrowserVoiceCaptureResult | null> {
		if (this.recorder && this.recorder.state !== "inactive") {
			return this.stop();
		}
		return this.releaseResources().then(() => null);
	}

	static isSupported(): boolean {
		return (
			typeof navigator !== "undefined" &&
			Boolean(navigator.mediaDevices?.getUserMedia) &&
			typeof MediaRecorder !== "undefined" &&
			typeof AudioContext !== "undefined" &&
			typeof AudioWorkletNode !== "undefined"
		);
	}

	private async startPcmPipeline(preferredSampleRate: number): Promise<void> {
		if (!this.stream) throw new Error(uiText("voice.browservoicecapture.microphoneStreamIsUnavailable"));
		this.audioContext = createVoiceCaptureAudioContext(preferredSampleRate);
		if (this.audioContext.state === "suspended") await this.audioContext.resume();

		this.workletUrl = URL.createObjectURL(
			new Blob([createPcmWorkletSource()], { type: "application/javascript" }),
		);
		// Every other await in this path is bounded, and an unbounded one here has no error to
		// show and no way out: the session stays in "starting" with a spinner until the user
		// cancels it. A rejection instead reaches the caller's catch, which releases the
		// microphone and puts the session into its error state with a reason.
		await withTimeout(
			this.audioContext.audioWorklet.addModule(this.workletUrl),
			WORKLET_LOAD_TIMEOUT_MS,
			() => new Error(uiText("voice.browservoicecapture.audioProcessorDidNotLoad")),
		);
		this.sourceNode = this.audioContext.createMediaStreamSource(this.stream);
		this.workletNode = new AudioWorkletNode(this.audioContext, PCM_WORKLET_NAME);
		this.sinkNode = this.audioContext.createGain();
		this.sinkNode.gain.value = 0;
		this.workletNode.port.onmessage = (event: MessageEvent<ArrayBuffer | "flushed">) => {
			if (!(event.data instanceof ArrayBuffer)) return;
			const samples = new Int16Array(event.data);
			const metrics = measurePcm16Window(samples);
			recordLocalSpeechWindow(this.speechGateState, metrics.rms, metrics.peak);

		};
		this.sourceNode.connect(this.workletNode);
		this.workletNode.connect(this.sinkNode);
		this.sinkNode.connect(this.audioContext.destination);
	}

	private startMediaRecorder(): void {
		if (!this.stream) throw new Error(uiText("voice.browservoicecapture.microphoneStreamIsUnavailable"));
		const selectedMime = pickMime();
		this.recorder = selectedMime
			? new MediaRecorder(this.stream, { mimeType: selectedMime })
			: new MediaRecorder(this.stream);
		this.mime = this.recorder.mimeType || selectedMime || "audio/webm";
		this.recorder.ondataavailable = (event) => {
			if (event.data.size > 0) this.chunks.push(event.data);
		};
		this.recorder.start(250);
	}

	private async stopInternal(): Promise<BrowserVoiceCaptureResult | null> {
		const recorder = this.recorder;
		const microphone = this.microphoneCapture;
		if (!microphone) throw new Error(uiText("voice.browservoicecapture.microphoneCaptureMetadataIsUnavailable"));
		const sampleRate = this.audioContext?.sampleRate ?? 24_000;
		await this.flushWorklet();
		const blob = await new Promise<Blob>((resolve, reject) => {
			recorder!.addEventListener("stop", () => {
				resolve(new Blob(this.chunks, { type: recorder!.mimeType || this.mime }));
			}, { once: true });
			recorder!.addEventListener("error", () => {
				reject(new Error(uiText("voice.browservoicecapture.mediarecorderFailedWhileStopping")));
			}, { once: true });
			if (recorder!.state !== "inactive") {
				recorder!.requestData();
				recorder!.stop();
			} else {
				resolve(new Blob(this.chunks, { type: recorder!.mimeType || this.mime }));
			}
		});
		const result: BrowserVoiceCaptureResult = {
			blob,
			mime: recorder?.mimeType || this.mime,
			durationMs: Math.max(0, Date.now() - this.startedAt),
			sampleRate,
			speechGate: getLocalSpeechGateDecision(this.speechGateState),
			recordingValidation: evaluateVoiceRecording({
				blobSize: blob.size,
				receivedAudioData: this.chunks.length > 0,
			}),
			microphone,
		};
		const cancelled = this.cancelled;
		const preserveCancelledResult = this.preserveCancelledResult;
		await this.releaseResources();
		this.stopping = null;
		return cancelled && !preserveCancelledResult ? null : result;
	}

	private async flushWorklet(): Promise<void> {
		const node = this.workletNode;
		if (!node) return;
		await new Promise<void>((resolve) => {
			const timeout = window.setTimeout(resolve, WORKLET_FLUSH_TIMEOUT_MS);
			const previous = node.port.onmessage;
			node.port.onmessage = (event: MessageEvent<ArrayBuffer | "flushed">) => {
				if (event.data === "flushed") {
					window.clearTimeout(timeout);
					node.port.onmessage = previous;
					resolve();
					return;
				}
				previous?.call(node.port, event);
			};
			node.port.postMessage("stop");
		});
	}

	private async releaseResources(): Promise<void> {
		this.workletNode?.disconnect();
		this.sourceNode?.disconnect();
		this.sinkNode?.disconnect();
		if (this.stream) {
			this.stream.getTracks().forEach((track) => track.stop());
		}
		if (this.audioContext && this.audioContext.state !== "closed") {
			await this.audioContext.close().catch(() => undefined);
		}
		if (this.workletUrl) URL.revokeObjectURL(this.workletUrl);
		this.stream = null;
		this.recorder = null;
		this.chunks = [];
		this.audioContext = null;
		this.sourceNode = null;
		this.workletNode = null;
		this.sinkNode = null;
		this.workletUrl = null;
		this.microphoneCapture = null;
	}
}

class VoiceCaptureStartCancelledError extends Error {
	constructor() {
		super("voice capture start was cancelled");
		this.name = "VoiceCaptureStartCancelledError";
	}
}

function pickMime(): string {
	for (const mime of MIME_CANDIDATES) {
		if (MediaRecorder.isTypeSupported(mime)) return mime;
	}
	return "";
}
