import { mkdtempSync, statSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureDirFor, hasFfmpeg, transcodeRawPcmSync, transcodeSync } from "../ffmpeg.js";
import type { AudioFormat, ProviderResult, SpeakOptions, SpeakResult } from "../types.js";
import { audioEnv } from "../environment.js";
import { acquireAudioSlot, audioServiceHealth } from "./health.js";
import { getAudioLocalRuntimeManager } from "../local-runtime.js";
import { toErrorMessage } from "../../lib/values.js";
import { observeModelOutcome } from "../../agent-runtime/model-config/model-verdicts.js";

import { requireAudioGeneration, audioGenerationKey, noteAudioGeneration, resolveSpeechModel, type AudioGenerationExecution, type SpeechModel } from "../configuration.js";
import type { AudioGenerationConsumer } from "../../../shared/audio-generation.js";

export type AudioGenerationOperation = AudioGenerationExecution;

export function captureAudioGeneration(consumer: AudioGenerationConsumer = "playback"): AudioGenerationOperation {
	const selected = requireAudioGeneration(consumer);
	audioGenerationKey(selected);
	noteAudioGeneration(consumer, selected);
	return selected;
}

/** The captured selection decides connection, model, voice and rate. */
export interface SpeakRequest extends SpeakOptions {
	audio?: AudioGenerationOperation;
	text: string;
}

/** Everything one `/audio/speech` request needs, resolved when it goes out. */
interface SpeechTarget extends SpeechModel {
	audio: AudioGenerationOperation;
	endpoint: string;
	apiKey?: string;
}

/**
 * Take one of the endpoint's declared slots, then resolve the request. The credential, model and
 * voice are read once the slot is held, so a request that queued behind another uses what is
 * current when it is sent. Health and the model listing are cached per catalog revision.
 */
async function openSpeech(audio: AudioGenerationOperation, signal?: AbortSignal): Promise<{ target: SpeechTarget; release: () => void }> {
	await getAudioLocalRuntimeManager().prepare(audio.connection, signal);
	const { maxConcurrency } = await audioServiceHealth(audio.baseUrl, audioGenerationKey(audio));
	const release = await acquireAudioSlot(audio.baseUrl, maxConcurrency, signal);
	try {
		const apiKey = audioGenerationKey(audio);
		const model = await resolveSpeechModel(audio, apiKey);
		return { target: { ...model, audio, endpoint: `${audio.baseUrl}/audio/speech`, apiKey }, release };
	} catch (error) {
		release();
		throw error;
	}
}

/** Every `/audio/speech` reply passes here, so the Provider's verdict on the selected model is recorded once. */
async function requestSpeech(target: SpeechTarget, req: SpeakRequest, wireFormat: SpeechWireFormat): Promise<Response> {
	const { audio } = target;
	const response = await fetch(target.endpoint, {
		method: "POST",
		redirect: "error",
		signal: req.signal,
		headers: {
			...(target.apiKey ? { Authorization: `Bearer ${target.apiKey}` } : {}),
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			model: target.model,
			input: speechInput(target, req.text),
			// Nothing names a voice: the server's own default speaks.
			...(target.voice ? { voice: target.voice } : {}),
			response_format: wireFormat,
			...(audio.rate ? { speed: audio.rate } : {}),
		}),
	});
	const verdict = `${audio.connection}/${audio.model}`;
	if (response.ok) observeModelOutcome(verdict);
	else observeModelOutcome(verdict, `${response.status}: ${(await response.clone().text().catch(() => "")).slice(0, 2_000) || "status code (no body)"}`);
	return response;
}

const SPEECH_WIRE_FORMATS = ["mp3", "pcm", "wav", "aac", "flac", "opus"] as const;
type SpeechWireFormat = (typeof SPEECH_WIRE_FORMATS)[number];

/**
 * The `response_format` to ask for. A model that reports the formats it returns gets the closest of
 * those, and the file is transcoded after; any other model gets the OpenAI format for the file.
 */
function speechWireFormat(model: SpeechModel, format: AudioFormat): SpeechWireFormat {
	const wanted: SpeechWireFormat = format === "m4a" ? "aac" : format === "webm" || format === "ogg" ? "mp3" : format;
	const returned = SPEECH_WIRE_FORMATS.filter((item) => model.responseFormats?.includes(item));
	if (returned.length === 0 || returned.includes(wanted)) return wanted;
	return returned.includes("wav") ? "wav" : returned[0]!;
}

function isLikelyMandarinText(text: string): boolean {
	const hasHan = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/u.test(text);
	const hasJapaneseKana = /[\u3040-\u30ff]/u.test(text);
	const hasHangul = /[\uac00-\ud7af]/u.test(text);
	return hasHan && !hasJapaneseKana && !hasHangul;
}

function speechInput(model: SpeechModel, text: string): string {
	if (!model.languageInstruction || !isLikelyMandarinText(text)) return text;
	return [
		"Say the following text in Mandarin Chinese (BCP-47: cmn).",
		"Do not translate it. Do not add any extra words. Only speak the text after `Text:`.",
		`Text: ${text}`,
	].join("\n");
}

/** The rate raw PCM from `/audio/speech` is framed at: 24 kHz under the OpenAI contract, adjustable for an endpoint that differs. */
export function speechPcmSampleRate(): number {
	const v = Number(audioEnv("TTS_SAMPLE_RATE"));
	return Number.isFinite(v) && v > 0 ? v : 24_000;
}

type FetchedSpeech = { ok: true; target: SpeechTarget; wireFormat: SpeechWireFormat; bytes: Buffer } | { ok: false; reason: string };

async function fetchSpeech(audio: AudioGenerationOperation, req: SpeakRequest, format: AudioFormat): Promise<FetchedSpeech> {
	const { target, release } = await openSpeech(audio, req.signal);
	try {
		const wireFormat = speechWireFormat(target, format);
		let response: Response;
		try {
			response = await requestSpeech(target, req, wireFormat);
		} catch (error) {
			if (req.signal?.aborted) throw error;
			return { ok: false, reason: `fetch ${target.endpoint} failed: ${toErrorMessage(error)}` };
		}
		if (!response.ok) {
			const detail = await response.text().then((text) => text.replace(/\s+/g, " ").trim().slice(0, 300)).catch(() => "");
			return { ok: false, reason: `HTTP ${response.status} from ${target.endpoint}: ${detail || "TTS request rejected"}` };
		}
		return { ok: true, target, wireFormat, bytes: Buffer.from(await response.arrayBuffer()) };
	} finally {
		release();
	}
}

/** One utterance written to a file, through whichever OpenAI-compatible endpoint the connection names. */
export async function speak(req: SpeakRequest): Promise<ProviderResult<SpeakResult>> {
	const audio = req.audio ?? captureAudioGeneration();
	const provider = audio.connection;
	const format: AudioFormat = req.format || "mp3";
	const fetched = await fetchSpeech(audio, req, format);
	if (!fetched.ok) return { ok: false, provider, reason: fetched.reason };
	const { target, wireFormat, bytes } = fetched;
	const outPath = req.outPath || tmpFile(`speech-${Date.now()}.${format}`);
	ensureDirFor(outPath);
	const spoken = (size: number): ProviderResult<SpeakResult> => ({ ok: true, provider, model: target.model, voice: target.voice, format, outPath, bytes: size });

	if (wireFormat === format) {
		writeFileSync(outPath, bytes);
		return spoken(bytes.length);
	}
	if (!hasFfmpeg()) {
		return { ok: false, provider, reason: `ffmpeg required to convert ${wireFormat} to ${format}` };
	}
	const tmpInput = tmpFile(`speech-${Date.now()}.${wireFormat}`);
	writeFileSync(tmpInput, bytes);
	const ok = wireFormat === "pcm"
		? transcodeRawPcmSync(tmpInput, outPath, speechPcmSampleRate(), 1)
		: transcodeSync(tmpInput, outPath);
	if (!ok) {
		return { ok: false, provider, reason: `ffmpeg transcoding ${wireFormat} -> ${format} failed` };
	}
	let size = 0;
	try { size = statSync(outPath).size; } catch { /* ignore */ }
	return spoken(size);
}

/** Speech as it arrives. A file the model cannot return directly is synthesized whole and transcoded first. */
export async function* speakStream(req: SpeakRequest): AsyncIterable<Uint8Array> {
	const audio = req.audio ?? captureAudioGeneration();
	const format: AudioFormat = req.format || "mp3";
	const wireFormat = speechWireFormat(await resolveSpeechModel(audio, audioGenerationKey(audio)), format);
	if (wireFormat !== format) {
		const r = await speak({ ...req, audio });
		if (r.ok) yield new Uint8Array(await readFile(r.outPath));
		return;
	}
	yield* streamSpeech(audio, req, wireFormat, "end");
}

/** Raw PCM16 for the real-time voice adapter, which frames it at `speechPcmSampleRate()`. */
export async function* speakPcm16Stream(req: SpeakRequest): AsyncIterable<Uint8Array> {
	yield* streamSpeech(req.audio ?? captureAudioGeneration("local"), req, "pcm", "throw");
}

/**
 * How a rejected `/audio/speech` reply ends the stream. Real-time synthesis has no second chance and
 * surfaces the endpoint and status; buffered playback ends the stream so its caller can retry whole.
 */
type SpeechRejection = "throw" | "end";

/** The slot is held until the last byte is read, or until the consumer stops reading. */
async function* streamSpeech(audio: AudioGenerationOperation, req: SpeakRequest, wireFormat: SpeechWireFormat, onReject: SpeechRejection): AsyncIterable<Uint8Array> {
	const { target, release } = await openSpeech(audio, req.signal);
	try {
		yield* speechBody(await requestSpeech(target, req, wireFormat), target.endpoint, onReject);
	} finally {
		release();
	}
}

async function* speechBody(response: Response, endpoint: string, onReject: SpeechRejection): AsyncIterable<Uint8Array> {
	if (!response.ok || !response.body) {
		await response.body?.cancel();
		if (onReject === "throw") throw new Error(`HTTP ${response.status} from ${endpoint}: TTS request rejected`);
		return;
	}
	const reader = response.body.getReader();
	while (true) {
		const { value, done } = await reader.read();
		if (done) break;
		if (value) yield value;
	}
}

function tmpFile(name: string): string {
	const dir = mkdtempSync(join(tmpdir(), "telomi-audio-"));
	return join(dir, name);
}

// ---------- batch synthesis ----------

export interface SpeakManySegment {
	id: string;
	text: string;
	outPath: string;
}

export interface SpeakManyOptions {
	audio?: AudioGenerationOperation;
	consumer?: AudioGenerationConsumer;
	concurrency?: number;
	/** Called after each segment settles, so long batches can report progress. */
	onSegment?: (done: number, total: number) => void;
}

export interface SpeakManyRequest extends SpeakManyOptions {
	segments: SpeakManySegment[];
}

export interface SpeakManyResultEntry {
	id: string;
	outPath: string;
	bytes: number;
	durationSec?: number;
	model?: string;
	voice?: string;
}

export interface SpeakManyResult {
	provider: string;
	model?: string;
	results: SpeakManyResultEntry[];
	errors: Array<{ id: string; error: string }>;
}

export async function speakMany(req: SpeakManyRequest): Promise<ProviderResult<SpeakManyResult>> {
	const audio = req.audio ?? captureAudioGeneration(req.consumer);
	const provider = audio.connection;
	if (req.segments.length === 0) {
		return { ok: true, provider, results: [], errors: [] };
	}
	const { maxConcurrency } = await audioServiceHealth(audio.baseUrl, audioGenerationKey(audio));
	let done = 0;
	const entries = await runLimited(req.segments, ttsBatchConcurrency(maxConcurrency, req.concurrency), async (seg) => {
		const speakSegment = () => speak({
			audio,
			text: seg.text,
			outPath: seg.outPath,
			format: formatFromOutPath(seg.outPath),
		});
		let r = await speakSegment();
		for (let attempt = 1; r.ok === false && attempt < BATCH_SPEECH_ATTEMPTS && transientSpeechFailure(r.reason); attempt++) {
			await new Promise((resolve) => setTimeout(resolve, batchRetryDelayMs(attempt)));
			r = await speakSegment();
		}
		req.onSegment?.(++done, req.segments.length);
		if (r.ok === false) {
			return { error: { id: seg.id, error: r.reason } };
		}
		return { result: { id: seg.id, outPath: r.outPath, bytes: r.bytes, model: r.model, voice: r.voice } };
	});
	const results = entries.flatMap((entry) => entry.result ? [entry.result] : []);
	const errors = entries.flatMap((entry) => entry.error ? [entry.error] : []);
	return { ok: true, provider, model: results.find((entry) => entry.model)?.model, results, errors };
}

/** A batch is long and costly to restart, so one throttled or briefly unavailable request must not
 * fail it: 429s, 5xx and dropped connections wait and try again, any other failure stops at once.
 * Single utterances (playback, live voice) keep failing fast. */
const BATCH_SPEECH_ATTEMPTS = 5;

function transientSpeechFailure(reason: string): boolean {
	return /^HTTP (?:429|5\d\d) /u.test(reason) || /^fetch \S+ failed:/u.test(reason);
}

// ponytail: fixed exponential backoff (2s, 4s, 8s, 16s); honour Retry-After if a provider needs longer.
function batchRetryDelayMs(attempt: number): number {
	const base = Number(audioEnv("TTS_RETRY_BASE_MS"));
	return (Number.isFinite(base) && base >= 0 ? base : 2_000) * 2 ** (attempt - 1);
}

function formatFromOutPath(outPath: string): AudioFormat | undefined {
	const m = outPath.toLowerCase().match(/\.(wav|mp3|m4a|webm|ogg|flac)$/);
	if (!m) return undefined;
	return m[1] as AudioFormat;
}

/** Workers for a batch: never more than the endpoint declared it wants in flight; a parallel default where it declares nothing. */
function ttsBatchConcurrency(declared: number | undefined, requested?: number): number {
	const env = Number(audioEnv("CLOUD_TTS_CONCURRENCY"));
	const fallback = Number.isFinite(env) && env > 0 ? env : 4;
	const value = Number.isFinite(requested) && requested && requested > 0 ? requested : fallback;
	return Math.max(1, Math.min(declared ?? Infinity, 12, Math.floor(value)));
}

async function runLimited<T, R>(items: T[], concurrency: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
	const results = new Array<R>(items.length);
	let cursor = 0;
	const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
		while (true) {
			const index = cursor++;
			if (index >= items.length) return;
			results[index] = await fn(items[index], index);
		}
	});
	await Promise.all(workers);
	return results;
}
