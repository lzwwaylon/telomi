export type VoiceStressFixtureProfile =
	| "weak-onset-v1"
	| "keyboard-impulses-v1"
	| "simulated-far-field-v1";

export interface VoiceStressFixtureMetadata {
	profile: VoiceStressFixtureProfile;
	sampleRate: number;
	sourceSamples: number;
	outputSamples: number;
	speechOnsetSample?: number;
	syntheticBurstCount?: number;
	syntheticBurstDurationMs?: number;
	syntheticRoomTailMs?: number;
}

export interface VoiceStressFixtureResult {
	samples: Int16Array;
	metadata: VoiceStressFixtureMetadata;
}

/**
 * Versioned deterministic audio-transform Module for release evaluation fixtures.
 *
 * The profiles change acoustic conditions around source-authored human speech.
 * They do not create reference text and must never be classified as real room or
 * hardware-microphone evidence.
 */
export function generateVoiceStressFixture(
	source: Int16Array,
	options: {
		profile: VoiceStressFixtureProfile;
		sampleRate: number;
	},
): VoiceStressFixtureResult {
	if (source.length === 0) throw new Error("stress fixture source is empty");
	if (
		!Number.isSafeInteger(options.sampleRate) ||
		options.sampleRate < 8_000 ||
		options.sampleRate > 96_000
	) {
		throw new Error("stress fixture sample rate must be 8000 to 96000 Hz");
	}
	if (options.profile === "weak-onset-v1") {
		return weakOnset(source, options.sampleRate);
	}
	if (options.profile === "keyboard-impulses-v1") {
		return keyboardImpulses(source, options.sampleRate);
	}
	if (options.profile === "simulated-far-field-v1") {
		return simulatedFarField(source, options.sampleRate);
	}
	const exhaustive: never = options.profile;
	throw new Error(`unsupported stress fixture profile: ${exhaustive}`);
}

function weakOnset(
	source: Int16Array,
	sampleRate: number,
): VoiceStressFixtureResult {
	const paddingSamples = sampleRate;
	const samples = pad(source, paddingSamples, paddingSamples);
	const sourceOnset = detectSpeechOnset(source, sampleRate);
	const speechOnsetSample = paddingSamples + sourceOnset;
	const recoverySamples = Math.round(sampleRate * 0.45);
	for (let offset = 0; offset < recoverySamples; offset += 1) {
		const index = speechOnsetSample + offset;
		if (index >= samples.length) break;
		const progress = offset / Math.max(1, recoverySamples - 1);
		const gain = 0.12 + 0.88 * progress;
		samples[index] = toPcm16((samples[index] ?? 0) / 32_768 * gain);
	}
	return {
		samples,
		metadata: {
			profile: "weak-onset-v1",
			sampleRate,
			sourceSamples: source.length,
			outputSamples: samples.length,
			speechOnsetSample,
		},
	};
}

function keyboardImpulses(
	source: Int16Array,
	sampleRate: number,
): VoiceStressFixtureResult {
	const paddingSamples = Math.round(sampleRate * 0.75);
	const samples = pad(source, paddingSamples, paddingSamples);
	const positions = [
		Math.round(sampleRate * 0.25),
		paddingSamples + Math.round(source.length * 0.12),
		paddingSamples + Math.round(source.length * 0.45),
		paddingSamples + Math.round(source.length * 0.78),
		paddingSamples + source.length + Math.round(sampleRate * 0.25),
	];
	const burstDurationMs = 14;
	const burstSamples = Math.round(sampleRate * burstDurationMs / 1_000);
	let seed = 0x4b455942;
	for (const position of positions) {
		for (let offset = 0; offset < burstSamples; offset += 1) {
			const index = position + offset;
			if (index >= samples.length) break;
			seed = xorshift32(seed);
			const noise = (seed >>> 0) / 0xffff_ffff * 2 - 1;
			const envelope = Math.exp(-6 * offset / Math.max(1, burstSamples - 1));
			const mixed = (samples[index] ?? 0) / 32_768 + noise * envelope * 0.45;
			samples[index] = toPcm16(mixed);
		}
	}
	return {
		samples,
		metadata: {
			profile: "keyboard-impulses-v1",
			sampleRate,
			sourceSamples: source.length,
			outputSamples: samples.length,
			syntheticBurstCount: positions.length,
			syntheticBurstDurationMs: burstDurationMs,
		},
	};
}

function simulatedFarField(
	source: Int16Array,
	sampleRate: number,
): VoiceStressFixtureResult {
	const roomTailMs = 137;
	const taps = [
		{ delay: 0, gain: 1 },
		{ delay: Math.round(sampleRate * 0.023), gain: 0.42 },
		{ delay: Math.round(sampleRate * 0.047), gain: 0.24 },
		{ delay: Math.round(sampleRate * 0.091), gain: 0.12 },
		{ delay: Math.round(sampleRate * roomTailMs / 1_000), gain: 0.06 },
	];
	const tailSamples = taps.at(-1)!.delay;
	const wet = new Float64Array(source.length + tailSamples);
	for (let index = 0; index < source.length; index += 1) {
		const value = (source[index] ?? 0) / 32_768;
		for (const tap of taps) wet[index + tap.delay]! += value * tap.gain;
	}
	const speechRms = floatRms(wet);
	const targetNoiseRms = speechRms / 10 ** (12 / 20);
	let seed = 0x46415246;
	const rawNoise = new Float64Array(wet.length);
	for (let index = 0; index < rawNoise.length; index += 1) {
		seed = xorshift32(seed);
		rawNoise[index] = (seed >>> 0) / 0xffff_ffff * 2 - 1;
	}
	const noiseScale = targetNoiseRms / Math.max(Number.EPSILON, floatRms(rawNoise));
	let mixedPeak = 0;
	for (let index = 0; index < wet.length; index += 1) {
		wet[index] = wet[index]! + rawNoise[index]! * noiseScale;
		mixedPeak = Math.max(mixedPeak, Math.abs(wet[index]!));
	}
	const outputGain = Math.min(1, 0.62 / Math.max(Number.EPSILON, mixedPeak));
	const processed = new Int16Array(wet.length);
	for (let index = 0; index < processed.length; index += 1) {
		processed[index] = toPcm16(wet[index]! * outputGain);
	}
	const paddingSamples = sampleRate;
	const samples = pad(processed, paddingSamples, paddingSamples);
	return {
		samples,
		metadata: {
			profile: "simulated-far-field-v1",
			sampleRate,
			sourceSamples: source.length,
			outputSamples: samples.length,
			syntheticRoomTailMs: roomTailMs,
		},
	};
}

function detectSpeechOnset(source: Int16Array, sampleRate: number): number {
	const frameSamples = Math.max(1, Math.round(sampleRate * 0.02));
	const overallRms = pcmRms(source);
	const threshold = Math.max(0.006, overallRms * 0.2);
	for (
		let frameStart = 0;
		frameStart + frameSamples * 2 <= source.length;
		frameStart += frameSamples
	) {
		if (
			pcmRms(source.subarray(frameStart, frameStart + frameSamples)) >= threshold &&
			pcmRms(
				source.subarray(
					frameStart + frameSamples,
					frameStart + frameSamples * 2,
				),
			) >= threshold
		) {
			return frameStart;
		}
	}
	return 0;
}

function pad(
	source: Int16Array,
	leadingSamples: number,
	trailingSamples: number,
): Int16Array {
	const output = new Int16Array(
		leadingSamples + source.length + trailingSamples,
	);
	output.set(source, leadingSamples);
	return output;
}

function pcmRms(samples: Int16Array): number {
	let sum = 0;
	for (const sample of samples) sum += (sample / 32_768) ** 2;
	return Math.sqrt(sum / Math.max(1, samples.length));
}

function floatRms(samples: Float64Array): number {
	let sum = 0;
	for (const sample of samples) sum += sample * sample;
	return Math.sqrt(sum / Math.max(1, samples.length));
}

function xorshift32(value: number): number {
	let state = value >>> 0;
	state ^= state << 13;
	state ^= state >>> 17;
	state ^= state << 5;
	return state >>> 0;
}

function toPcm16(value: number): number {
	return Math.round(Math.max(-1, Math.min(0.999969, value)) * 32_768);
}
