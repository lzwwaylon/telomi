import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, extname, join } from "node:path";
import type { SpliceClip } from "./types.js";
import { audioEnv } from "./environment.js";

let ffmpegAvailable: boolean | undefined;
let resolvedFfmpegPath: string | undefined;

function ffmpegPath(): string {
	if (resolvedFfmpegPath) return resolvedFfmpegPath;
	const configured = audioEnv("FFMPEG_PATH")?.trim();
	if (configured && existsSync(configured)) {
		resolvedFfmpegPath = configured;
		return configured;
	}
	const system = spawnSync("ffmpeg", ["-version"], { encoding: "utf8" });
	if (system.status === 0) {
		resolvedFfmpegPath = "ffmpeg";
		return resolvedFfmpegPath;
	}
	for (const path of ["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg"]) {
		if (existsSync(path)) {
			resolvedFfmpegPath = path;
			return path;
		}
	}
	try {
		const fromWorkingDirectory = createRequire(join(process.cwd(), "package.json"));
		const bundled = fromWorkingDirectory("ffmpeg-static") as unknown;
		if (typeof bundled === "string" && existsSync(bundled)) {
			resolvedFfmpegPath = bundled;
			return bundled;
		}
	} catch {
		// The host application may intentionally rely on a system ffmpeg.
	}
	return "ffmpeg";
}

export function hasFfmpeg(): boolean {
	if (ffmpegAvailable !== undefined) return ffmpegAvailable;
	const r = spawnSync(ffmpegPath(), ["-version"], { encoding: "utf8" });
	ffmpegAvailable = r.status === 0;
	return ffmpegAvailable;
}

export interface RunResult {
	ok: boolean;
	stdout: string;
	stderr: string;
	code: number | null;
}

export function runFfmpeg(args: string[]): Promise<RunResult> {
	return new Promise((resolve) => {
		const proc = spawn(ffmpegPath(), args, { stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		proc.stdout?.on("data", (b) => (stdout += b.toString()));
		proc.stderr?.on("data", (b) => (stderr += b.toString()));
		proc.on("close", (code) => {
			resolve({ ok: code === 0, stdout, stderr, code });
		});
		proc.on("error", () => {
			resolve({ ok: false, stdout, stderr: stderr || "ffmpeg not found", code: -1 });
		});
	});
}

export function probeDurationSec(path: string): number | undefined {
	const r = spawnSync("ffprobe", [
		"-v", "error",
		"-show_entries", "format=duration",
		"-of", "default=noprint_wrappers=1:nokey=1",
		path,
	], { encoding: "utf8" });
	if (r.status !== 0) return undefined;
	const v = Number(r.stdout.trim());
	return Number.isFinite(v) ? v : undefined;
}

export async function spliceClips(clips: SpliceClip[], outPath: string): Promise<RunResult> {
	if (clips.length === 0) {
		return { ok: false, stdout: "", stderr: "no clips supplied", code: -1 };
	}

	const inputs: string[] = [];
	const filterParts: string[] = [];
	clips.forEach((clip, idx) => {
		inputs.push("-i", clip.src);
		const trim: string[] = [];
		if (clip.startSec !== undefined) trim.push(`start=${clip.startSec}`);
		if (clip.endSec !== undefined) trim.push(`end=${clip.endSec}`);
		const trimFilter = trim.length > 0 ? `atrim=${trim.join(":")},asetpts=PTS-STARTPTS` : "anull";
		const fades: string[] = [];
		if (clip.fadeInMs && clip.fadeInMs > 0) {
			fades.push(`afade=t=in:st=0:d=${clip.fadeInMs / 1000}`);
		}
		if (clip.fadeOutMs && clip.fadeOutMs > 0 && clip.endSec !== undefined && clip.startSec !== undefined) {
			const dur = Math.max(0, clip.endSec - clip.startSec);
			const start = Math.max(0, dur - clip.fadeOutMs / 1000);
			fades.push(`afade=t=out:st=${start}:d=${clip.fadeOutMs / 1000}`);
		}
		const chain = [trimFilter, ...fades].join(",");
		filterParts.push(`[${idx}:a]${chain}[a${idx}]`);
	});
	const concatInputs = clips.map((_, idx) => `[a${idx}]`).join("");
	filterParts.push(`${concatInputs}concat=n=${clips.length}:v=0:a=1[out]`);

	const ext = extname(outPath).toLowerCase();
	const codecArgs: string[] = [];
	if (ext === ".mp3") codecArgs.push("-c:a", "libmp3lame", "-qscale:a", "2");
	else if (ext === ".wav") codecArgs.push("-c:a", "pcm_s16le");
	else if (ext === ".m4a") codecArgs.push("-c:a", "aac", "-b:a", "192k");

	const args = ["-y", ...inputs, "-filter_complex", filterParts.join(";"), "-map", "[out]", ...codecArgs, outPath];
	return runFfmpeg(args);
}

export function transcodeSync(srcPath: string, outPath: string): boolean {
	const ext = extname(outPath).toLowerCase();
	const codec: string[] = [];
	if (ext === ".mp3") codec.push("-c:a", "libmp3lame", "-qscale:a", "2");
	else if (ext === ".wav") codec.push("-c:a", "pcm_s16le");
	else if (ext === ".m4a") codec.push("-c:a", "aac", "-b:a", "192k");
	else if (ext === ".flac") codec.push("-c:a", "flac");
	else if (ext === ".ogg") codec.push("-c:a", "libvorbis", "-qscale:a", "5");
	const r = spawnSync(ffmpegPath(), ["-y", "-i", srcPath, ...codec, outPath], { encoding: "utf8" });
	return r.status === 0 && existsSync(outPath);
}

export function transcodeRawPcmSync(srcPath: string, outPath: string, sampleRate = 24_000, channels = 1): boolean {
	const ext = extname(outPath).toLowerCase();
	const codec: string[] = [];
	if (ext === ".mp3") codec.push("-c:a", "libmp3lame", "-qscale:a", "2");
	else if (ext === ".wav") codec.push("-c:a", "pcm_s16le");
	else if (ext === ".m4a") codec.push("-c:a", "aac", "-b:a", "192k");
	else if (ext === ".flac") codec.push("-c:a", "flac");
	else if (ext === ".ogg") codec.push("-c:a", "libvorbis", "-qscale:a", "5");
	const r = spawnSync(ffmpegPath(), [
		"-y",
		"-f", "s16le",
		"-ar", String(sampleRate),
		"-ac", String(channels),
		"-i", srcPath,
		...codec,
		outPath,
	], { encoding: "utf8" });
	return r.status === 0 && existsSync(outPath);
}

/**
 * Transcode an in-memory audio buffer to 16kHz mono PCM WAV via ffmpeg's
 * stdin/stdout pipes — no temp files. Used by the STT Provider to
 * convert browser-recorded webm/opus (which `soundfile` can't decode) into
 * a format telomi-audio-local's `soundfile.read()` accepts.
 *
 * ffmpeg auto-detects the input format from the byte stream, so callers
 * don't need to specify the input mime type.
 */
export function transcodeBufferToWav(
	input: Buffer,
	opts: { sampleRate?: number; channels?: number } = {},
): Promise<{ ok: true; bytes: Buffer } | { ok: false; reason: string }> {
	const sampleRate = opts.sampleRate ?? 16_000;
	const channels = opts.channels ?? 1;
	return new Promise((resolve) => {
		const proc = spawn(
			ffmpegPath(),
			[
				"-hide_banner",
				"-loglevel", "error",
				"-i", "pipe:0",
				"-vn",
				"-ar", String(sampleRate),
				"-ac", String(channels),
				"-c:a", "pcm_s16le",
				"-f", "wav",
				"pipe:1",
			],
			{ stdio: ["pipe", "pipe", "pipe"] },
		);
		const chunks: Buffer[] = [];
		let stderr = "";
		proc.stdout.on("data", (b: Buffer) => chunks.push(b));
		proc.stderr.on("data", (b: Buffer) => (stderr += b.toString()));
		proc.on("error", (err) => {
			resolve({ ok: false, reason: `ffmpeg spawn failed: ${err.message}` });
		});
		proc.on("close", (code) => {
			if (code === 0) {
				resolve({ ok: true, bytes: Buffer.concat(chunks) });
			} else {
				resolve({ ok: false, reason: `ffmpeg exit ${code}: ${stderr.trim().slice(0, 400)}` });
			}
		});
		proc.stdin.on("error", (err) => {
			resolve({ ok: false, reason: `ffmpeg stdin error: ${err.message}` });
		});
		proc.stdin.end(input);
	});
}

export function fileBytes(path: string): number {
	try {
		return statSync(path).size;
	} catch {
		return 0;
	}
}

export function ensureDirFor(path: string): void {
	mkdirSync(dirname(path), { recursive: true });
}
