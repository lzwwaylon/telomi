import { voiceDataRoot } from "../server/workspaces/server-runtime-paths.js";
import { sha256 } from "../server/lib/hash.js";
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { writeFileAtomic } from "../server/lib/fs.js";
import ffmpegPath from "ffmpeg-static";
import { generateVoiceStressFixture } from "../server/voice/evaluation-audio-fixtures.js";

const SAMPLE_RATE = 16_000;
const repositoryRoot = resolve(process.cwd(), "../..");
const cacheRoot = resolve(voiceDataRoot(process.cwd()), "evaluation-fixtures");
const outputRoot = resolve(process.cwd(), "voice-evals", "generated", "v1");

const SOURCES = {
	aishell: {
		url: "https://qianwen-res.oss-cn-beijing.aliyuncs.com/Qwen3-ASR-Repo/asr_zh.wav",
		sha256: "46dbc998c9d1d48111267c40741dd3200f2e5bcf4075f8c4c97f4451160dce50",
		extension: "wav",
	},
	librispeech: {
		url: "https://qianwen-res.oss-cn-beijing.aliyuncs.com/Qwen2-Audio/audio/1272-128104-0000.flac",
		sha256: "4e25e22555cd16e90edb0a3b49fdcf1fe652b2a1250ab643634db33895c75b41",
		extension: "flac",
	},
	taimecs001: {
		url: "https://huggingface.co/datasets/JacobLinCool/TaiMECS/resolve/83f397e41840ba187cc6833e1320bd2e5fa858f1/001.mp3?download=true",
		sha256: "fb2b2c7f72e1d9536a9755140977ad848fb0dd5dcc330d8e1e55f257bb432fae",
		extension: "mp3",
	},
} as const;

const aishell = decodePcm16(await loadSource(SOURCES.aishell));
const librispeech = decodePcm16(await loadSource(SOURCES.librispeech));
const taimecs001 = decodePcm16(await loadSource(SOURCES.taimecs001));

const longPause = concatPcm([
	new Int16Array(SAMPLE_RATE * 2),
	librispeech,
	new Int16Array(SAMPLE_RATE * 3),
	librispeech,
	new Int16Array(SAMPLE_RATE * 2),
]);
const noisyAishell = addDeterministicWhiteNoise(
	concatPcm([
		new Int16Array(SAMPLE_RATE),
		aishell,
		new Int16Array(SAMPLE_RATE),
	]),
	{
		referenceSpeech: aishell,
		snrDb: 5,
		seed: 0x00c0ffee,
	},
);
const weakOnset = generateVoiceStressFixture(librispeech, {
	profile: "weak-onset-v1",
	sampleRate: SAMPLE_RATE,
});
const keyboardImpulses = generateVoiceStressFixture(aishell, {
	profile: "keyboard-impulses-v1",
	sampleRate: SAMPLE_RATE,
});
const simulatedFarField = generateVoiceStressFixture(taimecs001, {
	profile: "simulated-far-field-v1",
	sampleRate: SAMPLE_RATE,
});

writeGeneratedWav("librispeech-long-pause.wav", longPause);
writeGeneratedWav("aishell-white-noise-5db.wav", noisyAishell);
writeGeneratedWav("librispeech-weak-onset-v1.wav", weakOnset.samples);
writeGeneratedWav("aishell-keyboard-impulses-v1.wav", keyboardImpulses.samples);
writeGeneratedWav(
	"taimecs-001-simulated-far-field-v1.wav",
	simulatedFarField.samples,
);
console.log(JSON.stringify({
	weakOnset: weakOnset.metadata,
	keyboardImpulses: keyboardImpulses.metadata,
	simulatedFarField: simulatedFarField.metadata,
}, null, 2));

async function loadSource(source: {
	url: string;
	sha256: string;
	extension: string;
}): Promise<Buffer> {
	const path = resolve(cacheRoot, `${source.sha256}.${source.extension}`);
	if (existsSync(path)) {
		const bytes = readFileSync(path);
		assertSha256(bytes, source.sha256, path);
		return bytes;
	}
	if (!process.argv.includes("--fetch-remote-fixtures")) {
		throw new Error(`Missing cached audio fixture: ${path}. To download it, run npm run generate:voice-vad-fixtures -- --fetch-remote-fixtures from apps/telomi.`);
	}
	const response = await fetch(source.url, { redirect: "follow" });
	if (!response.ok || (response.url !== "" && new URL(response.url).protocol !== "https:")) {
		throw new Error(`fixture download failed: HTTP ${response.status} ${source.url}`);
	}
	const bytes = Buffer.from(await response.arrayBuffer());
	if (bytes.length > 64 * 1024 * 1024) throw new Error("source fixture exceeds 64 MiB");
	assertSha256(bytes, source.sha256, source.url);
	writeFileAtomic(path, bytes);
	return bytes;
}

function decodePcm16(bytes: Buffer): Int16Array {
	if (!ffmpegPath) throw new Error("ffmpeg-static did not resolve a binary");
	const result = spawnSync(ffmpegPath, [
		"-hide_banner",
		"-loglevel", "error",
		"-i", "pipe:0",
		"-f", "s16le",
		"-acodec", "pcm_s16le",
		"-ac", "1",
		"-ar", String(SAMPLE_RATE),
		"pipe:1",
	], {
		input: bytes,
		maxBuffer: 64 * 1024 * 1024,
	});
	if (result.status !== 0) {
		throw new Error(`ffmpeg decode failed: ${result.stderr.toString("utf8")}`);
	}
	const pcm = result.stdout;
	const copied = Uint8Array.from(pcm);
	return new Int16Array(copied.buffer);
}

function concatPcm(parts: Int16Array[]): Int16Array {
	const output = new Int16Array(
		parts.reduce((total, part) => total + part.length, 0),
	);
	let offset = 0;
	for (const part of parts) {
		output.set(part, offset);
		offset += part.length;
	}
	return output;
}

function addDeterministicWhiteNoise(
	input: Int16Array,
	options: { referenceSpeech: Int16Array; snrDb: number; seed: number },
): Int16Array {
	const speechRms = Math.sqrt(
		options.referenceSpeech.reduce(
			(sum, sample) => sum + (sample / 32_768) ** 2,
			0,
		) / options.referenceSpeech.length,
	);
	const targetNoiseRms = speechRms / 10 ** (options.snrDb / 20);
	let state = options.seed >>> 0;
	const rawNoise = new Float64Array(input.length);
	let rawSquareSum = 0;
	for (let index = 0; index < rawNoise.length; index += 1) {
		state ^= state << 13;
		state ^= state >>> 17;
		state ^= state << 5;
		const value = (state >>> 0) / 0xffff_ffff * 2 - 1;
		rawNoise[index] = value;
		rawSquareSum += value * value;
	}
	const scale = targetNoiseRms / Math.sqrt(rawSquareSum / rawNoise.length);
	const output = new Int16Array(input.length);
	for (let index = 0; index < input.length; index += 1) {
		const mixed = input[index]! / 32_768 + rawNoise[index]! * scale;
		output[index] = Math.round(Math.max(-1, Math.min(0.999969, mixed)) * 32_768);
	}
	return output;
}

function writeGeneratedWav(filename: string, samples: Int16Array): void {
	const pcm = Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength);
	const wav = Buffer.allocUnsafe(44 + pcm.length);
	wav.write("RIFF", 0, "ascii");
	wav.writeUInt32LE(36 + pcm.length, 4);
	wav.write("WAVE", 8, "ascii");
	wav.write("fmt ", 12, "ascii");
	wav.writeUInt32LE(16, 16);
	wav.writeUInt16LE(1, 20);
	wav.writeUInt16LE(1, 22);
	wav.writeUInt32LE(SAMPLE_RATE, 24);
	wav.writeUInt32LE(SAMPLE_RATE * 2, 28);
	wav.writeUInt16LE(2, 32);
	wav.writeUInt16LE(16, 34);
	wav.write("data", 36, "ascii");
	wav.writeUInt32LE(pcm.length, 40);
	pcm.copy(wav, 44);
	const path = resolve(outputRoot, filename);
	writeFileAtomic(path, wav);
	const relativePath = path.slice(repositoryRoot.length + 1);
	console.log(`${relativePath} ${wav.length} bytes sha256=${sha256(wav)}`);
}

function assertSha256(bytes: Buffer, expected: string, source: string): void {
	const actual = sha256(bytes);
	if (actual !== expected) {
		throw new Error(`SHA-256 mismatch for ${source}: expected ${expected}, received ${actual}`);
	}
}
