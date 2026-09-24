import assert from "node:assert/strict";
import test from "node:test";
import {
	VoiceRecordingCuePlayer,
	VOICE_RECORDING_CUE_SPEC,
} from "../../web/src/features/voice/voiceRecordingCues.js";

interface ScheduledTone {
	frequency?: [number, number];
	setGain?: [number, number];
	linearGain?: [number, number];
	exponentialGain?: [number, number];
	startedAt?: number;
	stoppedAt?: number;
}

function createFakeAudioContext(initialState: "running" | "suspended" = "running") {
	const tones: ScheduledTone[] = [];
	let active: ScheduledTone | null = null;
	let resumeCalls = 0;
	const context = {
		currentTime: 10,
		state: initialState,
		destination: {},
		createOscillator() {
			const tone: ScheduledTone = {};
			tones.push(tone);
			active = tone;
			return {
				type: "sine",
				frequency: {
					setValueAtTime(value: number, at: number) {
						tone.frequency = [value, at];
					},
				},
				connect() {},
				start(at: number) {
					tone.startedAt = at;
				},
				stop(at: number) {
					tone.stoppedAt = at;
				},
			};
		},
		createGain() {
			const tone = active;
			assert.ok(tone);
			return {
				gain: {
					setValueAtTime(value: number, at: number) {
						tone.setGain = [value, at];
					},
					linearRampToValueAtTime(value: number, at: number) {
						tone.linearGain = [value, at];
					},
					exponentialRampToValueAtTime(value: number, at: number) {
						tone.exponentialGain = [value, at];
					},
				},
				connect() {},
			};
		},
		async resume() {
			resumeCalls += 1;
			context.state = "running";
		},
	};
	return { context, tones, get resumeCalls() { return resumeCalls; } };
}

test("recording cues retain the pinned OpenWhispr frequencies and envelope", async () => {
	const fake = createFakeAudioContext();
	const player = new VoiceRecordingCuePlayer(() => fake.context);

	await player.play("start", true);
	assert.deepEqual(VOICE_RECORDING_CUE_SPEC.startNotes, [523.25, 659.25]);
	const roundedTones = fake.tones.map((tone) => Object.fromEntries(
		Object.entries(tone).map(([key, value]) => [
			key,
			Array.isArray(value)
				? value.map((part) => Math.round(part * 1_000_000) / 1_000_000)
				: Math.round(value * 1_000_000) / 1_000_000,
		]),
	));
	assert.deepEqual(roundedTones, [
		{
			frequency: [523.25, 10.005],
			setGain: [0.0001, 10.005],
			linearGain: [0.2, 10.02],
			exponentialGain: [0.0001, 10.095],
			startedAt: 10.005,
			stoppedAt: 10.105,
		},
		{
			frequency: [659.25, 10.12],
			setGain: [0.0001, 10.12],
			linearGain: [0.2, 10.135],
			exponentialGain: [0.0001, 10.21],
			startedAt: 10.12,
			stoppedAt: 10.22,
		},
	]);
});

test("stop cues descend, reuse one AudioContext and resume it when needed", async () => {
	const fake = createFakeAudioContext("suspended");
	let factoryCalls = 0;
	const player = new VoiceRecordingCuePlayer(() => {
		factoryCalls += 1;
		return fake.context;
	});

	await player.play("stop", true);
	await player.play("stop", true);
	assert.equal(factoryCalls, 1);
	assert.equal(fake.resumeCalls, 1);
	assert.deepEqual(fake.tones.map((tone) => tone.frequency?.[0]), [587.33, 440, 587.33, 440]);
});

test("disabled or unavailable recording cues never block dictation", async () => {
	let factoryCalls = 0;
	const disabled = new VoiceRecordingCuePlayer(() => {
		factoryCalls += 1;
		throw new Error("must not construct");
	});
	await disabled.play("start", false);
	assert.equal(factoryCalls, 0);

	const unavailable = new VoiceRecordingCuePlayer(() => {
		throw new Error("audio output unavailable");
	});
	const previousDebug = console.debug;
	console.debug = () => undefined;
	try {
		await assert.doesNotReject(unavailable.play("start", true));
	} finally {
		console.debug = previousDebug;
	}
});
