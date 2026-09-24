import { voiceDataRoot } from "../server/workspaces/server-runtime-paths.js";
import { sha256 } from "../server/lib/hash.js";
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { writeFileAtomic } from "../server/lib/fs.js";
import ffmpegPath from "ffmpeg-static";

const SAMPLE_RATE = 16_000;
const cacheRoot = resolve(voiceDataRoot(process.cwd()), "evaluation-fixtures");
const outputRoot = resolve(
	process.cwd(),
	"voice-evals",
	"generated",
	"public-acoustic-v1",
);

const SOURCES = {
	aishell: {
		url: "https://qianwen-res.oss-cn-beijing.aliyuncs.com/Qwen3-ASR-Repo/asr_zh.wav",
		sha256: "46dbc998c9d1d48111267c40741dd3200f2e5bcf4075f8c4c97f4451160dce50",
		extension: "wav",
		maxBytes: 8 * 1024 * 1024,
	},
	demandLiving: {
		url: "https://zenodo.org/records/1227121/files/DLIVING_16k.zip?download=1",
		sha256: "2b1726fe06e41551ce2397f2aaf3e4fb692c912d81914b04708df0bbb5252338",
		extension: "zip",
		maxBytes: 96 * 1024 * 1024,
	},
	keyboard: {
		url: "https://zenodo.org/records/16564409/files/keyboard_sound_dataset.zip?download=1",
		sha256: "6deb36c7eb6b3765f0fc69719e84faf1b7f0f15b00e2080be01f549709e36ec3",
		extension: "zip",
		maxBytes: 16 * 1024 * 1024,
	},
	amiFarField: {
		url: "https://groups.inf.ed.ac.uk/ami/AMICorpusMirror/amicorpus/ES2008a/audio/ES2008a.Array1-01.wav",
		sha256: "2382b3b7eea81ff6393555680c660f4b00be3f0971aef2a0a71197bb5109eae1",
		extension: "wav",
		maxBytes: 40 * 1024 * 1024,
	},
} as const;

const KEYBOARD_ENTRIES = [
	"pantograph/1010562.wav",
	"pantograph/1054568.wav",
	"pantograph/1100560.wav",
	"pantograph/1146862.wav",
	"pantograph/1193160.wav",
	"pantograph/1237898.wav",
	"pantograph/1285131.wav",
	"pantograph/1330905.wav",
	"pantograph/1378953.wav",
	"pantograph/1429812.wav",
	"pantograph/1480065.wav",
	"pantograph/1529992.wav",
] as const;

const OUTPUT_SHA256 = {
	"aishell-demand-living-8db.wav":
		"16c0b953c8a30e42baac59eafedf2e22c6b850b85cf96d4c10f408217a496cec",
	"aishell-sony-keyboard-8db.wav":
		"4e44fa5d5bcf96e4adacbe6bb922918a128a1d0cb05287b8c7f3d17d43097ecc",
	"ami-es2008a-array1-01-segment.wav":
		"afd733b75f1ce83ad255c0e712960c0d06898b6a6ef8ce596b3ccd144150070b",
} as const;

const aishell = decodePcm16((await loadSource(SOURCES.aishell)).bytes);
const paddedAishell = pad(aishell, SAMPLE_RATE, SAMPLE_RATE);

const demandArchive = await loadSource(SOURCES.demandLiving);
const demandLiving = decodePcm16(
	extractZipEntry(demandArchive.path, "DLIVING/ch01.wav"),
);
const demandOffset = SAMPLE_RATE * 60;
const demandSegment = takeLooped(
	demandLiving.subarray(demandOffset),
	paddedAishell.length,
);
const roomNoise = mixAtSnr(paddedAishell, demandSegment, aishell, 8);

const keyboardArchive = await loadSource(SOURCES.keyboard);
const keyboardTrack = new Int16Array(paddedAishell.length);
KEYBOARD_ENTRIES.forEach((entry, index) => {
	const click = decodePcm16(extractZipEntry(keyboardArchive.path, entry));
	overlay(
		keyboardTrack,
		click,
		Math.round(SAMPLE_RATE * (0.55 + index * 0.38)),
	);
});
const keyboardNoise = mixAtSnr(paddedAishell, keyboardTrack, aishell, 8);

const ami = decodePcm16((await loadSource(SOURCES.amiFarField)).bytes);
const amiStart = Math.round(SAMPLE_RATE * 32.265);
const amiEnd = Math.round(SAMPLE_RATE * 44.976);
const amiFarField = ami.slice(amiStart, amiEnd);

writeGeneratedWav("aishell-demand-living-8db.wav", roomNoise);
writeGeneratedWav("aishell-sony-keyboard-8db.wav", keyboardNoise);
writeGeneratedWav("ami-es2008a-array1-01-segment.wav", amiFarField);

async function loadSource(source: {
	url: string;
	sha256: string;
	extension: string;
	maxBytes: number;
}): Promise<{ bytes: Buffer; path: string }> {
	const path = resolve(cacheRoot, `${source.sha256}.${source.extension}`);
	if (existsSync(path)) {
		const bytes = readFileSync(path);
		assertSha256(bytes, source.sha256, path);
		return { bytes, path };
	}
	if (!process.argv.includes("--fetch-remote-fixtures")) {
		throw new Error(`Missing cached audio fixture: ${path}. To download it, run npm run generate:voice-public-acoustic-fixtures -- --fetch-remote-fixtures from apps/telomi.`);
	}
	const response = await fetch(source.url, { redirect: "follow" });
	if (!response.ok || new URL(response.url).protocol !== "https:") {
		throw new Error(`fixture download failed: HTTP ${response.status} ${source.url}`);
	}
	const contentLength = Number(response.headers.get("content-length") ?? 0);
	if (contentLength > source.maxBytes) {
		throw new Error(`source fixture exceeds ${source.maxBytes} bytes`);
	}
	const bytes = Buffer.from(await response.arrayBuffer());
	if (bytes.length > source.maxBytes) {
		throw new Error(`source fixture exceeds ${source.maxBytes} bytes`);
	}
	assertSha256(bytes, source.sha256, source.url);
	writeFileAtomic(path, bytes);
	return { bytes, path };
}

function extractZipEntry(archivePath: string, entry: string): Buffer {
	const result = spawnSync("unzip", ["-p", archivePath, entry], {
		maxBuffer: 32 * 1024 * 1024,
	});
	if (result.status !== 0 || result.stdout.length === 0) {
		throw new Error(
			`failed to extract ${entry}: ${result.stderr.toString("utf8")}`,
		);
	}
	return result.stdout;
}

function decodePcm16(bytes: Buffer): Int16Array {
	if (!ffmpegPath) throw new Error("ffmpeg-static did not resolve a binary");
	const result = spawnSync(
		ffmpegPath,
		[
			"-hide_banner",
			"-loglevel",
			"error",
			"-i",
			"pipe:0",
			"-f",
			"s16le",
			"-acodec",
			"pcm_s16le",
			"-ac",
			"1",
			"-ar",
			String(SAMPLE_RATE),
			"pipe:1",
		],
		{ input: bytes, maxBuffer: 64 * 1024 * 1024 },
	);
	if (result.status !== 0) {
		throw new Error(`ffmpeg decode failed: ${result.stderr.toString("utf8")}`);
	}
	const copied = Uint8Array.from(result.stdout);
	return new Int16Array(copied.buffer);
}

function mixAtSnr(
	speech: Int16Array,
	noise: Int16Array,
	referenceSpeech: Int16Array,
	snrDb: number,
): Int16Array {
	if (speech.length !== noise.length) {
		throw new Error("speech and noise lengths must match");
	}
	const noiseRms = rms(noise);
	if (noiseRms === 0) throw new Error("noise fixture is silent");
	const noiseGain = rms(referenceSpeech) / 10 ** (snrDb / 20) / noiseRms;
	const mixed = new Float64Array(speech.length);
	let peak = 0;
	for (let index = 0; index < mixed.length; index += 1) {
		mixed[index] =
			(speech[index] ?? 0) / 32_768 +
			((noise[index] ?? 0) / 32_768) * noiseGain;
		peak = Math.max(peak, Math.abs(mixed[index]!));
	}
	const outputGain = Math.min(1, 0.98 / Math.max(Number.EPSILON, peak));
	return Int16Array.from(mixed, (sample) => toPcm16(sample * outputGain));
}

function takeLooped(source: Int16Array, length: number): Int16Array {
	if (source.length === 0) throw new Error("loop source is empty");
	const output = new Int16Array(length);
	for (let index = 0; index < output.length; index += 1) {
		output[index] = source[index % source.length]!;
	}
	return output;
}

function overlay(target: Int16Array, source: Int16Array, offset: number): void {
	for (
		let index = 0;
		index < source.length && offset + index < target.length;
		index += 1
	) {
		target[offset + index] = toPcm16(
			(target[offset + index] ?? 0) / 32_768 +
				(source[index] ?? 0) / 32_768,
		);
	}
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

function rms(samples: Int16Array): number {
	let sum = 0;
	for (const sample of samples) sum += (sample / 32_768) ** 2;
	return Math.sqrt(sum / Math.max(1, samples.length));
}

function toPcm16(value: number): number {
	return Math.round(Math.max(-1, Math.min(0.999969, value)) * 32_768);
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
	const expected = OUTPUT_SHA256[filename as keyof typeof OUTPUT_SHA256];
	if (!expected) throw new Error(`missing expected SHA-256 for ${filename}`);
	assertSha256(wav, expected, filename);
	const path = resolve(outputRoot, filename);
	writeFileAtomic(path, wav);
	console.log(
		`${path.slice(process.cwd().length + 1)} ${wav.length} bytes sha256=${sha256(wav)}`,
	);
}

function assertSha256(bytes: Buffer, expected: string, source: string): void {
	const actual = sha256(bytes);
	if (actual !== expected) {
		throw new Error(
			`SHA-256 mismatch for ${source}: expected ${expected}, received ${actual}`,
		);
	}
}
