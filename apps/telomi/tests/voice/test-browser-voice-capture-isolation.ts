import assert from "node:assert/strict";
import test from "node:test";
import {
	BrowserVoiceCapture,
	createVoiceCaptureAudioContext,
} from "../../web/src/features/voice/BrowserVoiceCapture.js";

test("voice capture keeps compatibility fallbacks for browsers without a silent sink", () => {
	const unsupportedOptions: AudioContextOptions[] = [];
	class UnsupportedAudioContext {
		constructor(options: AudioContextOptions = {}) {
			unsupportedOptions.push(options);
		}
	}
	createVoiceCaptureAudioContext(
		24_000,
		UnsupportedAudioContext as unknown as Parameters<
			typeof createVoiceCaptureAudioContext
		>[1],
	);
	assert.deepEqual(unsupportedOptions, [{ sampleRate: 24_000 }]);

	const rejectedOptions: Array<AudioContextOptions & { sinkId?: unknown }> = [];
	class RejectingSilentSinkAudioContext {
		async setSinkId(): Promise<void> {}
		constructor(options: AudioContextOptions & { sinkId?: unknown } = {}) {
			rejectedOptions.push(options);
			if (options.sinkId) throw new TypeError("silent sink is unsupported");
		}
	}
	createVoiceCaptureAudioContext(
		16_000,
		RejectingSilentSinkAudioContext as unknown as Parameters<
			typeof createVoiceCaptureAudioContext
		>[1],
	);
	assert.deepEqual(rejectedOptions, [
		{ sampleRate: 16_000, sinkId: { type: "none" } },
		{ sampleRate: 16_000 },
	]);
});

test("browser voice capture uses a no-output sink and releases every audio resource", async () => {
	const previous = {
		navigator: Object.getOwnPropertyDescriptor(globalThis, "navigator"),
		window: Object.getOwnPropertyDescriptor(globalThis, "window"),
		AudioContext: Object.getOwnPropertyDescriptor(globalThis, "AudioContext"),
		AudioWorkletNode: Object.getOwnPropertyDescriptor(globalThis, "AudioWorkletNode"),
		MediaRecorder: Object.getOwnPropertyDescriptor(globalThis, "MediaRecorder"),
	};
	const contextOptions: AudioContextOptions[] = [];
	let contextCloseCalls = 0;
	let trackStopCalls = 0;

	class FakeAudioContext {
		state: AudioContextState = "running";
		readonly sampleRate: number;
		readonly destination = {};
		readonly audioWorklet = {
			addModule: async () => undefined,
		};

		constructor(options: AudioContextOptions = {}) {
			contextOptions.push(options);
			this.sampleRate = options.sampleRate ?? 48_000;
		}

		async setSinkId(): Promise<void> {}

		createMediaStreamSource() {
			return {
				connect() {},
				disconnect() {},
			};
		}

		createGain() {
			return {
				gain: { value: 1 },
				connect() {},
				disconnect() {},
			};
		}

		async resume(): Promise<void> {
			this.state = "running";
		}

		async close(): Promise<void> {
			contextCloseCalls += 1;
			this.state = "closed";
		}
	}

	class FakeAudioWorkletNode {
		readonly port = {
			onmessage: null as ((event: MessageEvent<ArrayBuffer | "flushed">) => void) | null,
			postMessage: (message: string) => {
				if (message === "stop") {
					queueMicrotask(() => this.port.onmessage?.({ data: "flushed" } as MessageEvent<"flushed">));
				}
			},
		};

		connect() {}
		disconnect() {}
	}

	class FakeMediaRecorder {
		static isTypeSupported(): boolean {
			return true;
		}

		state: RecordingState = "inactive";
		readonly mimeType = "audio/webm";
		ondataavailable: ((event: BlobEvent) => void) | null = null;
		private readonly listeners = new Map<string, Array<() => void>>();

		start(): void {
			this.state = "recording";
		}

		requestData(): void {
			this.ondataavailable?.({ data: new Blob(["voice-e2e-frame"]) } as BlobEvent);
		}

		stop(): void {
			this.state = "inactive";
			queueMicrotask(() => {
				for (const listener of this.listeners.get("stop") ?? []) listener();
			});
		}

		addEventListener(type: string, listener: () => void): void {
			const listeners = this.listeners.get(type) ?? [];
			listeners.push(listener);
			this.listeners.set(type, listeners);
		}
	}

	const track = {
		stop() {
			trackStopCalls += 1;
		},
	};
	const stream = {
		getTracks: () => [track],
	};

	try {
		Object.defineProperty(globalThis, "navigator", {
			configurable: true,
			value: { mediaDevices: { getUserMedia: async () => stream } },
		});
		Object.defineProperty(globalThis, "window", {
			configurable: true,
			value: { setTimeout, clearTimeout },
		});
		Object.defineProperty(globalThis, "AudioContext", {
			configurable: true,
			value: FakeAudioContext,
		});
		Object.defineProperty(globalThis, "AudioWorkletNode", {
			configurable: true,
			value: FakeAudioWorkletNode,
		});
		Object.defineProperty(globalThis, "MediaRecorder", {
			configurable: true,
			value: FakeMediaRecorder,
		});

		const capture = new BrowserVoiceCapture({
			acquire: async () => ({
				stream: stream as unknown as MediaStream,
				deviceId: "voice-e2e",
				deviceLabel: "Telomi E2E generated track",
				selectionStatus: "default",
				usedFallback: false,
			}),
		});
		await capture.start(24_000);
		await capture.cancel();

		assert.deepEqual(contextOptions, [
			{
				sampleRate: 24_000,
				sinkId: { type: "none" },
			},
		]);
		assert.equal(contextCloseCalls, 1);
		assert.equal(trackStopCalls, 1);
		assert.equal(capture.sampleRate, null);
	} finally {
		for (const [name, descriptor] of Object.entries(previous)) {
			if (descriptor) {
				Object.defineProperty(globalThis, name, descriptor);
			} else {
				Reflect.deleteProperty(globalThis, name);
			}
		}
	}
});

test("cancelling a pending microphone acquisition cannot start capture after it resolves", async () => {
	const previous = {
		navigator: Object.getOwnPropertyDescriptor(globalThis, "navigator"),
		window: Object.getOwnPropertyDescriptor(globalThis, "window"),
		AudioContext: Object.getOwnPropertyDescriptor(globalThis, "AudioContext"),
		AudioWorkletNode: Object.getOwnPropertyDescriptor(globalThis, "AudioWorkletNode"),
		MediaRecorder: Object.getOwnPropertyDescriptor(globalThis, "MediaRecorder"),
	};
	let contextCreations = 0;
	let recorderStarts = 0;
	let trackStops = 0;

	class FakeAudioContext {
		state: AudioContextState = "running";
		readonly sampleRate = 24_000;
		readonly destination = {};
		readonly audioWorklet = { addModule: async () => undefined };

		constructor() {
			contextCreations += 1;
		}

		async setSinkId(): Promise<void> {}
		createMediaStreamSource() {
			return { connect() {}, disconnect() {} };
		}
		createGain() {
			return { gain: { value: 1 }, connect() {}, disconnect() {} };
		}
		async resume(): Promise<void> {}
		async close(): Promise<void> {
			this.state = "closed";
		}
	}

	class FakeAudioWorkletNode {
		readonly port = {
			onmessage: null as ((event: MessageEvent<ArrayBuffer | "flushed">) => void) | null,
			postMessage: () => undefined,
		};
		connect() {}
		disconnect() {}
	}

	class FakeMediaRecorder {
		static isTypeSupported(): boolean {
			return true;
		}
		state: RecordingState = "inactive";
		readonly mimeType = "audio/webm";
		ondataavailable: ((event: BlobEvent) => void) | null = null;
		private readonly listeners = new Map<string, Array<() => void>>();

		start(): void {
			recorderStarts += 1;
			this.state = "recording";
		}
		requestData(): void {}
		stop(): void {
			this.state = "inactive";
			queueMicrotask(() => {
				for (const listener of this.listeners.get("stop") ?? []) listener();
			});
		}
		addEventListener(type: string, listener: () => void): void {
			const listeners = this.listeners.get(type) ?? [];
			listeners.push(listener);
			this.listeners.set(type, listeners);
		}
	}

	let resolveAcquire!: (value: {
		stream: MediaStream;
		deviceId: string;
		deviceLabel: string;
		selectionStatus: "default";
		usedFallback: false;
	}) => void;
	const acquired = new Promise<{
		stream: MediaStream;
		deviceId: string;
		deviceLabel: string;
		selectionStatus: "default";
		usedFallback: false;
	}>((resolve) => {
		resolveAcquire = resolve;
	});
	const track = { stop: () => { trackStops += 1; } };
	const stream = { getTracks: () => [track] } as unknown as MediaStream;
	let capture: BrowserVoiceCapture | null = null;

	try {
		Object.defineProperty(globalThis, "navigator", {
			configurable: true,
			value: { mediaDevices: { getUserMedia: async () => stream } },
		});
		Object.defineProperty(globalThis, "window", {
			configurable: true,
			value: { setTimeout, clearTimeout },
		});
		Object.defineProperty(globalThis, "AudioContext", {
			configurable: true,
			value: FakeAudioContext,
		});
		Object.defineProperty(globalThis, "AudioWorkletNode", {
			configurable: true,
			value: FakeAudioWorkletNode,
		});
		Object.defineProperty(globalThis, "MediaRecorder", {
			configurable: true,
			value: FakeMediaRecorder,
		});

		capture = new BrowserVoiceCapture({ acquire: () => acquired });
		const starting = capture.start();
		await Promise.resolve();
		const cancelling = capture.cancel();
		resolveAcquire({
			stream,
			deviceId: "delayed-test-mic",
			deviceLabel: "Delayed test mic",
			selectionStatus: "default",
			usedFallback: false,
		});

		await assert.rejects(starting, /cancel/i);
		await cancelling;
		assert.equal(trackStops, 1);
		assert.equal(contextCreations, 0);
		assert.equal(recorderStarts, 0);
		assert.equal(capture.sampleRate, null);
	} finally {
		await capture?.cancel().catch(() => undefined);
		for (const [name, descriptor] of Object.entries(previous)) {
			if (descriptor) {
				Object.defineProperty(globalThis, name, descriptor);
			} else {
				Reflect.deleteProperty(globalThis, name);
			}
		}
	}
});
