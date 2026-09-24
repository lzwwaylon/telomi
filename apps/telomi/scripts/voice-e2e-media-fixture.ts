import { pathToFileURL } from "node:url";

export interface VoiceE2EMediaFixtureOptions {
	amplitude?: number;
	frameDurationMs?: number;
	pcm16Base64?: string;
	sampleRate?: number;
}

interface NormalizedVoiceE2EMediaFixtureOptions {
	amplitude: number;
	frameDurationMs: number;
	pcm16Base64: string | null;
	sampleRate: number;
}

function normalizeOptions(
	options: VoiceE2EMediaFixtureOptions,
): NormalizedVoiceE2EMediaFixtureOptions {
	const sampleRate = Number.isFinite(options.sampleRate)
		? Math.round(options.sampleRate!)
		: 48_000;
	const frameDurationMs = Number.isFinite(options.frameDurationMs)
		? Math.round(options.frameDurationMs!)
		: 10;
	const amplitude = Number.isFinite(options.amplitude)
		? options.amplitude!
		: 0;
	const pcm16Base64 = options.pcm16Base64 ?? null;
	if (sampleRate < 8_000 || sampleRate > 96_000) {
		throw new Error(`voice E2E sample rate is out of range: ${sampleRate}`);
	}
	if (frameDurationMs < 1 || frameDurationMs > 100) {
		throw new Error(
			`voice E2E frame duration is out of range: ${frameDurationMs}`,
		);
	}
	if (amplitude < 0 || amplitude > 0.25) {
		throw new Error(`voice E2E amplitude is out of range: ${amplitude}`);
	}
	if (pcm16Base64 !== null) {
		if (
			pcm16Base64.length === 0 ||
			pcm16Base64.length > 24 * 1024 * 1024 ||
			pcm16Base64.length % 4 !== 0 ||
			!/^[A-Za-z0-9+/]*={0,2}$/.test(pcm16Base64)
		) {
			throw new Error("voice E2E PCM16 payload is not bounded base64");
		}
		const decodedBytes = Buffer.from(pcm16Base64, "base64");
		if (decodedBytes.length === 0 || decodedBytes.length % 2 !== 0) {
			throw new Error("voice E2E PCM16 payload must contain complete samples");
		}
		if (amplitude > 0) {
			throw new Error("voice E2E fixture cannot combine PCM replay and tone generation");
		}
	}
	return { amplitude, frameDurationMs, pcm16Base64, sampleRate };
}

function installVoiceE2EMediaFixture(
	options: NormalizedVoiceE2EMediaFixtureOptions,
) {
	if (window.__piVoiceE2E && !window.__piVoiceE2E.snapshot().disposed) {
		throw new Error("Telomi voice E2E media fixture is already installed");
	}
	if (
		typeof window.MediaStreamTrackGenerator !== "function" ||
		typeof window.AudioData !== "function"
	) {
		throw new Error(
			"This browser cannot create a device-free audio track for voice E2E",
		);
	}

	const originalDescriptor = Object.getOwnPropertyDescriptor(
		navigator,
		"mediaDevices",
	);
	const originalMediaDevices = navigator.mediaDevices;
	const mediaDevicesTarget = originalMediaDevices ?? {};
	const originalEnumerateDevicesDescriptor = Object.getOwnPropertyDescriptor(
		mediaDevicesTarget,
		"enumerateDevices",
	);
	const originalGetUserMediaDescriptor = Object.getOwnPropertyDescriptor(
		mediaDevicesTarget,
		"getUserMedia",
	);
	const sessions = new Set<{
		dispose(): Promise<void>;
	}>();
	const errors: string[] = [];
	let disposed = false;
	let generatedFrames = 0;
	let microphoneRequests = 0;
	let sourceExhausted = false;
	let amplitude = options.amplitude;
	const sourceSamples = options.pcm16Base64
		? decodePcm16Base64(options.pcm16Base64)
		: null;

	function decodePcm16Base64(value: string): Int16Array {
		const binary = atob(value);
		const samples = new Int16Array(binary.length / 2);
		const bytes = new Uint8Array(2);
		const view = new DataView(bytes.buffer);
		for (let index = 0; index < samples.length; index += 1) {
			bytes[0] = binary.charCodeAt(index * 2);
			bytes[1] = binary.charCodeAt(index * 2 + 1);
			samples[index] = view.getInt16(0, true);
		}
		return samples;
	}

	function snapshot() {
		return {
			activeStreams: sessions.size,
			disposed,
			errors: [...errors],
			generatedFrames,
			microphoneRequests,
			sourceExhausted,
		};
	}

	function createGeneratedStream(): MediaStream {
		const track = new MediaStreamTrackGenerator({ kind: "audio" });
		const writer = track.writable.getWriter();
		const originalStop = track.stop.bind(track);
		const frameSamples = Math.max(
			1,
			Math.round((options.sampleRate * options.frameDurationMs) / 1_000),
		);
		let phase = 0;
		let sourceOffset = 0;
		let timestamp = 0;
		let sessionDisposed = false;
		let disposePromise: Promise<void> | null = null;
		let wakeDelay: (() => void) | null = null;
		let delayTimer: ReturnType<typeof setTimeout> | null = null;

		const session = {
			dispose(): Promise<void> {
				if (disposePromise) return disposePromise;
				sessionDisposed = true;
				if (delayTimer !== null) clearTimeout(delayTimer);
				wakeDelay?.();
				wakeDelay = null;
				delayTimer = null;
				if (track.readyState !== "ended") originalStop();
				disposePromise = writer
					.abort("Telomi voice E2E stream disposed")
					.catch(() => undefined)
					.then(() => {
						writer.releaseLock();
						sessions.delete(session);
					});
				return disposePromise;
			},
		};

		Object.defineProperty(track, "stop", {
			configurable: true,
			value: () => {
				void session.dispose();
			},
			writable: true,
		});
		sessions.add(session);

		void (async () => {
			try {
				while (!sessionDisposed && track.readyState === "live") {
					await writer.ready;
					if (sessionDisposed || track.readyState !== "live") break;
					const samples = new Int16Array(frameSamples);
					if (sourceSamples) {
						const remaining = sourceSamples.length - sourceOffset;
						const copied = Math.min(samples.length, Math.max(0, remaining));
						if (copied > 0) {
							samples.set(sourceSamples.subarray(sourceOffset, sourceOffset + copied));
							sourceOffset += copied;
						}
						if (sourceOffset >= sourceSamples.length) sourceExhausted = true;
					} else if (amplitude > 0) {
						for (let index = 0; index < samples.length; index += 1) {
							samples[index] = Math.round(
								Math.sin(phase) * amplitude * 32_767,
							);
							phase += (2 * Math.PI * 440) / options.sampleRate;
						}
					}
					const frame = new AudioData({
						data: samples,
						format: "s16",
						numberOfChannels: 1,
						numberOfFrames: frameSamples,
						sampleRate: options.sampleRate,
						timestamp,
					});
					try {
						await writer.write(frame);
						generatedFrames += 1;
						timestamp += options.frameDurationMs * 1_000;
					} finally {
						frame.close();
					}
					await new Promise<void>((resolve) => {
						wakeDelay = resolve;
						delayTimer = setTimeout(resolve, options.frameDurationMs);
					});
					wakeDelay = null;
					delayTimer = null;
				}
			} catch (error) {
				if (!sessionDisposed) errors.push(String(error));
			}
		})();

		return new MediaStream([track]);
	}

	const enumerateDevices = async () => [
			{
				deviceId: "telomi-voice-e2e-generated",
				groupId: "telomi-voice-e2e",
				kind: "audioinput",
				label: "Telomi E2E generated audio track",
				toJSON() {
					return {
						deviceId: this.deviceId,
						groupId: this.groupId,
						kind: this.kind,
						label: this.label,
					};
				},
			},
		];
	const getUserMedia = async (constraints?: MediaStreamConstraints) => {
		if (constraints?.audio === false) {
			throw new Error("Telomi voice E2E fixture only provides audio input");
		}
		microphoneRequests += 1;
		return createGeneratedStream();
	};

	Object.defineProperty(mediaDevicesTarget, "enumerateDevices", {
		configurable: true,
		value: enumerateDevices,
	});
	Object.defineProperty(mediaDevicesTarget, "getUserMedia", {
		configurable: true,
		value: getUserMedia,
	});
	if (!originalMediaDevices) {
		Object.defineProperty(navigator, "mediaDevices", {
			configurable: true,
			value: mediaDevicesTarget,
		});
	}

	const controller = {
		setAmplitude(value: number) {
			if (
				sourceSamples ||
				!Number.isFinite(value) ||
				value < 0 ||
				value > 0.25
			) {
				throw new Error("Telomi voice E2E amplitude is invalid");
			}
			amplitude = value;
		},
		async dispose() {
			if (!disposed) {
				disposed = true;
				await Promise.all([...sessions].map((session) => session.dispose()));
				if (originalEnumerateDevicesDescriptor) {
					Object.defineProperty(
						mediaDevicesTarget,
						"enumerateDevices",
						originalEnumerateDevicesDescriptor,
					);
				} else {
					Reflect.deleteProperty(mediaDevicesTarget, "enumerateDevices");
				}
				if (originalGetUserMediaDescriptor) {
					Object.defineProperty(
						mediaDevicesTarget,
						"getUserMedia",
						originalGetUserMediaDescriptor,
					);
				} else {
					Reflect.deleteProperty(mediaDevicesTarget, "getUserMedia");
				}
				if (!originalMediaDevices) {
					if (originalDescriptor) {
						Object.defineProperty(navigator, "mediaDevices", originalDescriptor);
					} else {
						Reflect.deleteProperty(navigator, "mediaDevices");
					}
				}
			}
			return snapshot();
		},
		snapshot,
	};
	window.__piVoiceE2E = controller;
	return snapshot();
}

declare global {
	interface Window {
		AudioData: typeof AudioData;
		MediaStream: typeof MediaStream;
		MediaStreamTrackGenerator: typeof MediaStreamTrackGenerator;
		__piVoiceE2E?: {
			setAmplitude(value: number): void;
			dispose(): Promise<{
				activeStreams: number;
				disposed: boolean;
				errors: string[];
				generatedFrames: number;
				microphoneRequests: number;
				sourceExhausted: boolean;
			}>;
			snapshot(): {
				activeStreams: number;
				disposed: boolean;
				errors: string[];
				generatedFrames: number;
				microphoneRequests: number;
				sourceExhausted: boolean;
			};
		};
	}
}

export function buildVoiceE2EMediaFixtureScript(
	options: VoiceE2EMediaFixtureOptions = {},
): string {
	const normalized = normalizeOptions(options);
	// tsx/esbuild decorates serialized function bodies with an internal __name
	// helper. Keep the emitted browser snippet self-contained so it also works
	// when piped directly into agent-browser.
	return `(() => { const __name = (value) => value; return (${installVoiceE2EMediaFixture.toString()})(${JSON.stringify(normalized)}); })();`;
}

const invokedDirectly =
	process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
	process.stdout.write(buildVoiceE2EMediaFixtureScript());
}
