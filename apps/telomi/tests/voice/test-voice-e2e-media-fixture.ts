import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { buildVoiceE2EMediaFixtureScript } from "../../scripts/voice-e2e-media-fixture.js";

/** Frames arrive on 1 ms timers; a loaded runner delivers them late, so wait for the state instead of a fixed delay. */
async function until(condition: () => boolean, what: string): Promise<void> {
	const deadline = Date.now() + 5_000;
	while (!condition()) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await new Promise((resolve) => setTimeout(resolve, 1));
	}
}

test("voice browser E2E config cannot inherit the shared Chrome CDP", () => {
	const config = JSON.parse(
		readFileSync(
			new URL("../../scripts/agent-browser.voice-e2e.json", import.meta.url),
			"utf8",
		),
	) as Record<string, unknown>;
	assert.equal("cdp" in config, false);
	assert.equal(config.namespace, "telomi-voice-e2e");
	assert.equal(config.session, "telomi-voice-e2e");
	assert.equal(config.headless, true);
});

test("voice browser fixture generates audio without AudioContext and restores MediaDevices", async () => {
	const writes: unknown[] = [];
	let writerAbortCalls = 0;
	const originalMediaDevices = {
		getUserMedia: async () => {
			throw new Error("physical microphone must not be called");
		},
	};

	class FakeTrackGenerator {
		readyState: MediaStreamTrackState = "live";
		readonly writable = {
			getWriter: () => ({
				ready: Promise.resolve(),
				write: async (value: unknown) => {
					writes.push(value);
				},
				abort: async () => {
					writerAbortCalls += 1;
				},
				releaseLock() {},
			}),
		};

		stop(): void {
			this.readyState = "ended";
		}
	}

	class FakeAudioData {
		constructor(readonly options: unknown) {}
		close() {}
	}

	class FakeMediaStream {
		constructor(private readonly tracks: FakeTrackGenerator[]) {}
		getTracks() {
			return this.tracks;
		}
		getAudioTracks() {
			return this.tracks;
		}
	}

	const navigator = { mediaDevices: originalMediaDevices };
	const managerCachedMediaDevices = navigator.mediaDevices;
	const window: Record<string, unknown> = {};
	const context = vm.createContext({
		AudioData: FakeAudioData,
		Int16Array,
		Math,
		MediaStream: FakeMediaStream,
		MediaStreamTrackGenerator: FakeTrackGenerator,
		Object,
		Promise,
		Reflect,
		Set,
		clearTimeout,
		navigator,
		setTimeout,
		window,
	});
	window.window = window;
	window.navigator = navigator;
	window.MediaStreamTrackGenerator = FakeTrackGenerator;
	window.AudioData = FakeAudioData;
	window.MediaStream = FakeMediaStream;
	window.setTimeout = setTimeout;
	window.clearTimeout = clearTimeout;

	const source = buildVoiceE2EMediaFixtureScript({ frameDurationMs: 1 });
	assert.doesNotMatch(source, /AudioContext|createMediaStreamDestination/);
	assert.match(source, /MediaStreamTrackGenerator/);

	vm.runInContext(source, context);
	const fixture = window.__piVoiceE2E as {
		dispose(): Promise<Record<string, unknown>>;
		setAmplitude(value: number): void;
		snapshot(): Record<string, unknown>;
	};
	// A failed assertion must still dispose the fixture, or its frame timer keeps this process alive.
	try {
		const stream = await managerCachedMediaDevices.getUserMedia({ audio: true } as never) as never as FakeMediaStream;
		await until(() => writes.length > 0, "a generated frame");
		assert.equal(stream.getAudioTracks()[0]?.readyState, "live");
		fixture.setAmplitude(0.1);
		const nonSilent = () => Array.from(
			((writes.at(-1) as FakeAudioData).options as { data: Int16Array }).data,
		).some((sample) => sample !== 0);
		await until(nonSilent, "a non-silent frame");

		const disposed = await fixture.dispose();
		assert.equal(stream.getAudioTracks()[0]?.readyState, "ended");
		assert.equal(writerAbortCalls, 1);
		assert.equal(navigator.mediaDevices, originalMediaDevices);
		assert.deepEqual(
			JSON.parse(JSON.stringify(disposed)),
			{
				activeStreams: 0,
				disposed: true,
				errors: [],
				generatedFrames: writes.length,
				microphoneRequests: 1,
				sourceExhausted: false,
			},
		);
	} finally {
		await fixture.dispose();
	}
});

test("voice browser fixture replays exact PCM16 samples before trailing silence", async () => {
	const writes: Array<{ options: { data: Int16Array } }> = [];
	const expected = [
		1000, -1000, 32767, -32768, 25, -25, 300, -300,
		901, -901, 17, -17, 2048, -2048, 123, -123,
	];
	const pcm = Buffer.alloc(expected.length * 2);
	expected.forEach(
		(sample, index) => pcm.writeInt16LE(sample, index * 2),
	);

	class FakeTrackGenerator {
		readyState: MediaStreamTrackState = "live";
		readonly writable = {
			getWriter: () => ({
				ready: Promise.resolve(),
				write: async (value: { options: { data: Int16Array } }) => {
					writes.push(value);
				},
				abort: async () => undefined,
				releaseLock() {},
			}),
		};
		stop(): void {
			this.readyState = "ended";
		}
	}
	class FakeAudioData {
		constructor(readonly options: { data: Int16Array }) {}
		close() {}
	}
	class FakeMediaStream {
		constructor(private readonly tracks: FakeTrackGenerator[]) {}
		getTracks() {
			return this.tracks;
		}
		getAudioTracks() {
			return this.tracks;
		}
	}

	const navigator = { mediaDevices: {} };
	const window: Record<string, unknown> = {};
	const context = vm.createContext({
		AudioData: FakeAudioData,
		DataView,
		Int16Array,
		Math,
		MediaStream: FakeMediaStream,
		MediaStreamTrackGenerator: FakeTrackGenerator,
		Object,
		Promise,
		Reflect,
		Set,
		Uint8Array,
		atob: (value: string) => Buffer.from(value, "base64").toString("binary"),
		clearTimeout,
		navigator,
		setTimeout,
		window,
	});
	window.window = window;
	window.navigator = navigator;
	window.MediaStreamTrackGenerator = FakeTrackGenerator;
	window.AudioData = FakeAudioData;
	window.MediaStream = FakeMediaStream;
	window.setTimeout = setTimeout;
	window.clearTimeout = clearTimeout;

	vm.runInContext(
		buildVoiceE2EMediaFixtureScript({
			frameDurationMs: 1,
			pcm16Base64: pcm.toString("base64"),
			sampleRate: 8_000,
		}),
		context,
	);
	const fixture = window.__piVoiceE2E as {
		dispose(): Promise<Record<string, unknown>>;
		snapshot(): Record<string, unknown>;
	};
	try {
		await navigator.mediaDevices.getUserMedia({ audio: true } as never);
		await until(() => writes.length >= 2 && fixture.snapshot().sourceExhausted === true, "the source to be replayed");
		assert.deepEqual(
			writes
				.slice(0, 2)
				.flatMap((write) => Array.from(write.options.data)),
			expected,
		);
	} finally {
		await fixture.dispose();
	}
});
