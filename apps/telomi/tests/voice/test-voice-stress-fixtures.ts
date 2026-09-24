import { sha256 } from "../../server/lib/hash.js";
import assert from "node:assert/strict";
import test from "node:test";
import {
	generateVoiceStressFixture,
	type VoiceStressFixtureProfile,
} from "../../server/voice/evaluation-audio-fixtures.js";

const SAMPLE_RATE = 16_000;

test("versioned stress profiles are deterministic and never mutate source PCM", () => {
	const source = syntheticSpeech();
	const original = source.slice();
	const expectedDigests: Record<VoiceStressFixtureProfile, string> = {
		"weak-onset-v1":
			"1c8b6fb4507180653433d8d7a879ce1dd07250f90306956bdf82e90633f77f11",
		"keyboard-impulses-v1":
			"8997d937db69ef34d6f1ec354fa46b118caa9ef7f77bcd2f5e12ebff81110243",
		"simulated-far-field-v1":
			"bf8ce94aa05496227ea658fc97e8af46162c806fd50271fcc7b7cbbf6c3c839e",
	};
	for (const profile of Object.keys(expectedDigests) as VoiceStressFixtureProfile[]) {
		const first = generateVoiceStressFixture(source, {
			profile,
			sampleRate: SAMPLE_RATE,
		});
		const second = generateVoiceStressFixture(source, {
			profile,
			sampleRate: SAMPLE_RATE,
		});
		assert.deepEqual(first, second);
		assert.deepEqual(source, original);
		assert.equal(first.metadata.profile, profile);
		assert.equal(first.metadata.sourceSamples, source.length);
		assert.equal(digest(first.samples), expectedDigests[profile]);
	}
});

test("weak-onset profile attenuates only the beginning of detected speech", () => {
	const source = syntheticSpeech();
	const result = generateVoiceStressFixture(source, {
		profile: "weak-onset-v1",
		sampleRate: SAMPLE_RATE,
	});
	assert.equal(result.metadata.speechOnsetSample, SAMPLE_RATE + 320);
	assert.equal(result.samples.length, source.length + SAMPLE_RATE * 2);
	const outputOnset = result.metadata.speechOnsetSample!;
	assert.ok(
		rms(result.samples.subarray(outputOnset, outputOnset + 800)) <
			rms(source.subarray(320, 1_120)) * 0.5,
	);
	assert.deepEqual(
		result.samples.subarray(outputOnset + 8_000, outputOnset + 8_500),
		source.subarray(8_320, 8_820),
	);
});

test("keyboard profile adds bounded millisecond impulses around intact human speech", () => {
	const source = syntheticSpeech();
	const result = generateVoiceStressFixture(source, {
		profile: "keyboard-impulses-v1",
		sampleRate: SAMPLE_RATE,
	});
	assert.equal(result.samples.length, source.length + SAMPLE_RATE * 1.5);
	assert.equal(result.metadata.syntheticBurstCount, 5);
	assert.equal(result.metadata.syntheticBurstDurationMs, 14);
	assert.ok(rms(result.samples.subarray(3_900, 4_400)) > 0);
	assert.ok(peak(result.samples) <= 32_767);
	assert.ok(peak(result.samples) > 10_000);
});

test("far-field profile adds a deterministic reverberant tail without clipping", () => {
	const source = syntheticSpeech();
	const result = generateVoiceStressFixture(source, {
		profile: "simulated-far-field-v1",
		sampleRate: SAMPLE_RATE,
	});
	assert.equal(result.metadata.syntheticRoomTailMs, 137);
	assert.equal(
		result.samples.length,
		source.length + SAMPLE_RATE * 2 + Math.round(SAMPLE_RATE * 0.137),
	);
	assert.ok(peak(result.samples) <= Math.round(32_767 * 0.72));
	assert.ok(rms(result.samples.subarray(SAMPLE_RATE, -SAMPLE_RATE)) > 0);
});

test("stress fixture generation rejects an empty source and invalid sample rate", () => {
	assert.throws(
		() =>
			generateVoiceStressFixture(new Int16Array(), {
				profile: "weak-onset-v1",
				sampleRate: SAMPLE_RATE,
			}),
		/empty/i,
	);
	assert.throws(
		() =>
			generateVoiceStressFixture(syntheticSpeech(), {
				profile: "weak-onset-v1",
				sampleRate: 0,
			}),
		/sample rate/i,
	);
});

function syntheticSpeech(): Int16Array {
	const output = new Int16Array(10_000);
	for (let index = 320; index < 9_680; index += 1) {
		output[index] = Math.round(
			10_000 * Math.sin(2 * Math.PI * 220 * (index / SAMPLE_RATE)),
		);
	}
	return output;
}

function rms(samples: Int16Array): number {
	let sum = 0;
	for (const sample of samples) sum += (sample / 32_768) ** 2;
	return Math.sqrt(sum / Math.max(1, samples.length));
}

function peak(samples: Int16Array): number {
	let result = 0;
	for (const sample of samples) result = Math.max(result, Math.abs(sample));
	return result;
}

function digest(samples: Int16Array): string {
	return sha256(Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength));
}
