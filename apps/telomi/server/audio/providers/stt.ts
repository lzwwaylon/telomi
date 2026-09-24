import { isProviderCredentialDeleted } from "../../config/credential-tombstones.js";
import { resolveSpeechConfiguration, speechConnectionKey, SPEECH_RECOGNITION_UNSET } from "../../voice/configuration.js";
import type { SpeechExecutionConfiguration } from "../../../shared/speech-configuration.js";
import { createSha256 } from "../../lib/hash.js";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { hasFfmpeg, transcodeBufferToWav } from "../ffmpeg.js";
import type { ProviderResult, TranscriptResult, TranscriptSegment } from "../types.js";
import {
	normalizeVoiceVadConfig,
	normalizeVoiceVadMetadata,
	type VoiceVadConfig,
} from "../voice-vad.js";
import { resolveSelfHostedSttEndpoint } from "./self-hosted-stt.js";
import { audioServiceHealth, serverDefaultAudioModel, withAudioConcurrency } from "./health.js";
import { sttProtocolForConnection } from "../registry.js";
import { toErrorMessage } from "../../lib/values.js";
import { observeModelOutcome } from "../../agent-runtime/model-config/model-verdicts.js";

type SpeechSelection = SpeechExecutionConfiguration["recognition"];

export interface TranscribeRequest {
	/** The connection to transcribe through; the configured recognition selection when absent. */
	selection?: SpeechSelection;
	filePath?: string;
	buffer?: Buffer;
	filename?: string;
	mime?: string;
	language?: string;
	prompt?: string;
	model?: string;
	signal?: AbortSignal;
	responseFormat?: "json" | "verbose_json";
	/** Long inputs: follow the endpoint's persisted Job state where it advertises `transcription-jobs`. */
	mode?: "request" | "job";
	/** Local Silero preprocessing, sent only when the caller enables it. Endpoints without it ignore it. */
	vad?: VoiceVadConfig;
}

export interface SttWarmupRequest {
	connection?: string;
	model?: string;
	signal?: AbortSignal;
	baseUrl?: string;
	fetchImpl?: typeof globalThis.fetch;
}

export interface SttWarmupResult {
	provider: string;
	model: string;
	/** False when the endpoint does not advertise `warmup`: nothing was sent and nothing is loading. */
	advertised: boolean;
	readyBeforeRequest: boolean;
	durationMs: number;
	requestDurationMs: number;
	ttlSec: number;
}

/** The connection transcription runs through when a caller names none. */
export function defaultSttConnection(): string {
	return resolveSpeechConfiguration().recognition?.connection ?? "";
}

/** One resolved transcription target: a connection, where it is, and what it is allowed to do there. */
interface SttTarget {
	connection: string;
	baseUrl: string;
	transcriptionEndpoint: string;
	apiKey?: string;
	model: string;
}

export async function transcribe(req: TranscribeRequest): Promise<ProviderResult<TranscriptResult>> {
	const selection = req.selection ?? resolveSpeechConfiguration().recognition;
	if (!selection) return { ok: false, provider: "stt", reason: SPEECH_RECOGNITION_UNSET };
	const connection = selection.connection;
	if (isProviderCredentialDeleted(connection)) {
		return { ok: false, provider: connection, reason: "STT connection credential was deleted" };
	}
	const endpoint = resolveSelfHostedSttEndpoint(selection.baseUrl);
	if (!endpoint.ok) return { ok: false, provider: connection, reason: `STT connection URL is unusable: ${endpoint.error}` };
	try {
		const apiKey = speechConnectionKey(connection, selection.baseUrl);
		const model = req.model || selection.model || await serverDefaultAudioModel(endpoint.baseUrl, apiKey, "stt");
		if (!model) return { ok: false, provider: connection, reason: `no recognition model selected and ${endpoint.baseUrl} reports none` };
		const target: SttTarget = {
			connection,
			baseUrl: endpoint.baseUrl,
			transcriptionEndpoint: endpoint.transcriptionEndpoint,
			apiKey,
			model,
		};
		const result = sttProtocolForConnection(connection) === "openrouter-transcription"
			? await transcribeAsJson(req, target)
			: await transcribeAsMultipart(req, target);
		// Only the selected model has a verdict worth keeping; a model the caller names is its own probe.
		if (!req.model) observeModelOutcome(`${connection}/${selection.model}`, result.ok ? undefined : result.reason);
		return result;
	} catch (error) {
		if (req.signal?.aborted) throw req.signal.reason ?? error;
		return { ok: false, provider: connection, reason: toErrorMessage(error) };
	}
}

/**
 * Load the endpoint's ASR model without running inference, where the endpoint advertises `warmup`.
 *
 * The service owns model-load deduplication and idle eviction. This client only asks, and reports
 * an unadvertised warmup as "nothing to do" rather than as a failure.
 */
export async function warmupStt(req: SttWarmupRequest = {}): Promise<ProviderResult<SttWarmupResult>> {
	const selection = req.baseUrl ? undefined : resolveSpeechConfiguration().local;
	const connection = req.connection ?? selection?.connection ?? defaultSttConnection();
	let model = req.model || selection?.model || "";
	if (isProviderCredentialDeleted(connection)) return { ok: false, provider: connection, reason: "STT connection credential was deleted" };
	const endpoint = resolveSelfHostedSttEndpoint(req.baseUrl ?? selection?.baseUrl);
	if (!endpoint.ok) return { ok: false, provider: connection, reason: "STT connection URL is missing or invalid" };
	const baseUrl = endpoint.baseUrl;
	const fetchImpl = req.fetchImpl ?? globalThis.fetch;
	let apiKey: string | undefined;
	try {
		apiKey = speechConnectionKey(connection, baseUrl);
	} catch (error) {
		return { ok: false, provider: connection, reason: toErrorMessage(error) };
	}
	const health = await audioServiceHealth(baseUrl, apiKey);
	if (!health.capabilities.includes("warmup")) {
		return { ok: true, provider: connection, model, advertised: false, readyBeforeRequest: true, durationMs: 0, requestDurationMs: 0, ttlSec: 0 };
	}
	// Warming a selection that names no model asks the endpoint which one it would serve.
	model ||= await serverDefaultAudioModel(baseUrl, apiKey, "stt") ?? "";

	const startedAt = Date.now();
	let response: Response;
	try {
		response = await fetchImpl(`${baseUrl}/audio/warmup`, {
			method: "POST",
			headers: {
				...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ capability: "asr", model }),
			signal: req.signal,
		});
	} catch (error) {
		return { ok: false, provider: connection, reason: `ASR warmup failed at ${baseUrl}: ${toErrorMessage(error)}` };
	}
	if (!response.ok) {
		const body = await response.text().catch(() => "");
		return { ok: false, provider: connection, reason: `HTTP ${response.status} from ${baseUrl}/audio/warmup: ${body.slice(0, 400)}` };
	}

	let data: Record<string, unknown>;
	try {
		data = await response.json() as Record<string, unknown>;
	} catch {
		return { ok: false, provider: connection, reason: "ASR warmup returned invalid JSON" };
	}
	if (data.ok !== true || data.loaded !== true || typeof data.model !== "string" || (model && data.model !== model)) {
		return { ok: false, provider: connection, reason: "ASR warmup did not report a loaded model" };
	}
	return {
		ok: true,
		provider: connection,
		model: data.model,
		advertised: true,
		readyBeforeRequest: data.ready_before_request === true,
		durationMs: finiteNonNegativeNumber(data.duration_ms),
		requestDurationMs: Date.now() - startedAt,
		ttlSec: finiteNonNegativeNumber(data.ttl_sec),
	};
}

interface AudioInput {
	bytes: Buffer;
	filename: string;
	mime: string;
}

interface TranscriptionResponse {
	text?: string;
	language?: string;
	duration?: number;
	segments?: Array<{ start?: number; end?: number; text?: string }>;
	vad?: unknown;
}

type TranscriptionAttempt =
	| { ok: true; data: TranscriptionResponse }
	| { ok: false; reason: string; mediaTypeRejected?: boolean };

/**
 * Any endpoint speaking the OpenAI multipart `/audio/transcriptions` contract: the managed local
 * service, a self-hosted Whisper server, or a compatible cloud API. Extensions beyond that
 * contract are sent only where the endpoint's health document advertises them.
 */
async function transcribeAsMultipart(req: TranscribeRequest, target: SttTarget): Promise<ProviderResult<TranscriptResult>> {
	const loaded = await loadAudioInput(req, "audio.wav", "audio/wav");
	if (loaded.error) return { ok: false, provider: target.connection, reason: loaded.error };
	let audio = loaded as AudioInput;
	const health = await audioServiceHealth(target.baseUrl, target.apiKey);
	const useJob = req.mode === "job" && health.capabilities.includes("transcription-jobs");
	const responseFormat = req.responseFormat ?? "verbose_json";

	for (let attempt = 0; ; attempt += 1) {
		const form = transcriptionForm(req, target, audio, responseFormat, useJob);
		// The endpoint's declared concurrency covers the request that occupies it: a plain
		// transcription for its whole length, a Job only while it is being handed over.
		const result = useJob
			? await followTranscriptionJob(
				target,
				() => withAudioConcurrency(target.baseUrl, health.maxConcurrency, () => submitTranscriptionJob(target, form, req.signal), req.signal),
				req.signal,
			)
			: await withAudioConcurrency(target.baseUrl, health.maxConcurrency, () => postTranscription(target, form, req.signal), req.signal);
		if (result.ok) return transcript(result.data, target, audio, req);
		if (attempt === 0 && result.mediaTypeRejected) {
			const transcoded = await toWav(audio);
			if (!transcoded.ok) return { ok: false, provider: target.connection, reason: `${result.reason}; ${transcoded.reason}` };
			audio = transcoded.audio;
			continue;
		}
		return { ok: false, provider: target.connection, reason: result.reason };
	}
}

function transcriptionForm(
	req: TranscribeRequest,
	target: SttTarget,
	audio: AudioInput,
	responseFormat: "json" | "verbose_json",
	useJob: boolean,
): FormData {
	const form = new FormData();
	form.append("file", new Blob([new Uint8Array(audio.bytes)], { type: audio.mime }), audio.filename);
	form.append("model", target.model);
	form.append("response_format", responseFormat);
	if (req.language) form.append("language", req.language);
	if (req.prompt) form.append("prompt", req.prompt);
	// A server that does not preprocess ignores these; one that does keeps its own default when
	// the caller has not turned local segmentation on.
	if (req.vad?.enabled) appendVoiceVadForm(form, req.vad);
	if (useJob) {
		form.append("idempotency_key", createSha256()
			.update(audio.bytes)
			.update(JSON.stringify({
				model: target.model,
				language: req.language,
				prompt: req.prompt,
				responseFormat,
				vad: req.vad,
			}))
			.digest("hex"));
	}
	return form;
}

/** Upload the audio to one of the endpoint's multipart routes. Audio never follows a redirect. */
async function sendAudio(target: SttTarget, url: string, form: FormData, signal?: AbortSignal): Promise<Response | { ok: false; reason: string }> {
	let response: Response;
	try {
		response = await fetch(url, {
			method: "POST",
			headers: target.apiKey ? { Authorization: `Bearer ${target.apiKey}` } : undefined,
			body: form,
			signal,
			redirect: "manual",
		});
	} catch (error) {
		if (signal?.aborted) throw signal.reason ?? error;
		return { ok: false, reason: `STT request failed at ${target.baseUrl}: ${transportErrorMessage(error)}` };
	}
	if (response.status >= 300 && response.status < 400) {
		await response.body?.cancel();
		return { ok: false, reason: `STT redirects are not allowed (HTTP ${response.status})` };
	}
	return response;
}

async function postTranscription(target: SttTarget, form: FormData, signal?: AbortSignal): Promise<TranscriptionAttempt> {
	const response = await sendAudio(target, target.transcriptionEndpoint, form, signal);
	if ("reason" in response) return response;
	if (!response.ok) return await responseFailure(response, target.baseUrl);
	return { ok: true, data: await response.json() as TranscriptionResponse };
}

/**
 * A server that cannot decode what it was sent. Browsers record webm/opus, which libsndfile-based
 * servers reject; the answer is the status, never who the server is. Some compatible servers
 * report the same refusal as a 400, so their explanation counts too.
 */
async function responseFailure(response: Response, baseUrl: string): Promise<{ ok: false; reason: string; mediaTypeRejected?: boolean }> {
	const body = await response.text().catch(() => "");
	const mediaTypeRejected = response.status === 415
		|| (response.status === 400 && /failed to decode|unsupported (?:media|audio|file)|format not recognis/i.test(body));
	return { ok: false, reason: `HTTP ${response.status} from ${baseUrl}: ${body.slice(0, 400)}`, ...(mediaTypeRejected ? { mediaTypeRejected } : {}) };
}

async function toWav(audio: AudioInput): Promise<{ ok: true; audio: AudioInput } | { ok: false; reason: string }> {
	if (!hasFfmpeg()) return { ok: false, reason: `ffmpeg is not installed to transcode ${audio.mime || audio.filename} to wav` };
	const transcoded = await transcodeBufferToWav(audio.bytes);
	if (!transcoded.ok) return { ok: false, reason: `transcode to wav failed: ${transcoded.reason}` };
	const dot = audio.filename.lastIndexOf(".");
	const stem = dot > 0 ? audio.filename.slice(0, dot) : audio.filename;
	return { ok: true, audio: { bytes: transcoded.bytes, filename: `${stem || "audio"}.wav`, mime: "audio/wav" } };
}

function transcript(data: TranscriptionResponse, target: SttTarget, audio: AudioInput, req: TranscribeRequest): ProviderResult<TranscriptResult> {
	const segments: TranscriptSegment[] = (data.segments ?? []).map((segment) => ({
		start: typeof segment.start === "number" ? segment.start : 0,
		end: typeof segment.end === "number" ? segment.end : 0,
		text: (segment.text ?? "").trim(),
	}));
	const vad = normalizeVoiceVadMetadata(data.vad);
	return {
		ok: true,
		provider: target.connection,
		model: target.model,
		text: data.text ?? "",
		language: data.language ?? req.language,
		durationSec: data.duration ?? wavDurationSec(audio.bytes),
		segments,
		...(vad ? { vad } : {}),
	};
}

interface TranscriptionJobState {
	id?: string;
	status?: "queued" | "running" | "cancelling" | "succeeded" | "failed" | "cancelled";
	poll_after_ms?: number;
	result?: TranscriptionResponse;
	error?: string;
}

type JobSubmission = { ok: true; state: TranscriptionJobState } | { ok: false; reason: string; mediaTypeRejected?: boolean };

async function submitTranscriptionJob(target: SttTarget, form: FormData, signal?: AbortSignal): Promise<JobSubmission> {
	const response = await sendAudio(target, `${target.baseUrl}/audio/transcription-jobs`, form, signal);
	if ("reason" in response) return response;
	if (!response.ok) return await responseFailure(response, target.baseUrl);
	return { ok: true, state: await response.json() as TranscriptionJobState };
}

/**
 * A long transcription lives in the endpoint's persisted Job state instead of one open request.
 * Only the submission takes a concurrency slot: a running Job is the server's queue to manage, and
 * holding a client slot for it would block every short request behind it.
 */
async function followTranscriptionJob(
	target: SttTarget,
	submit: () => Promise<JobSubmission>,
	signal?: AbortSignal,
): Promise<TranscriptionAttempt> {
	const submitted = await submit();
	if (!submitted.ok) return submitted;
	let state = submitted.state;
	const jobId = state.id;
	if (!jobId) return { ok: false, reason: "STT Job submission returned no id" };
	const headers = target.apiKey ? { Authorization: `Bearer ${target.apiKey}` } : undefined;
	try {
		for (;;) {
			if (state.status === "succeeded") {
				return state.result
					? { ok: true, data: state.result }
					: { ok: false, reason: `STT Job ${jobId} completed without a result` };
			}
			if (state.status === "failed" || state.status === "cancelled") {
				return { ok: false, reason: `STT Job ${jobId} ${state.status}: ${state.error ?? "unknown error"}` };
			}
			if (state.status !== "queued" && state.status !== "running" && state.status !== "cancelling") {
				return { ok: false, reason: `STT Job ${jobId} returned an invalid state` };
			}
			await waitForJobPoll(state.poll_after_ms, signal);
			const poll = await fetch(`${target.baseUrl}/audio/transcription-jobs/${encodeURIComponent(jobId)}`, { headers, signal });
			if (!poll.ok) return await responseFailure(poll, target.baseUrl);
			state = await poll.json() as TranscriptionJobState;
		}
	} catch (error) {
		if (signal?.aborted) {
			await fetch(`${target.baseUrl}/audio/transcription-jobs/${encodeURIComponent(jobId)}`, { method: "DELETE", headers })
				.catch(() => undefined);
		}
		throw error;
	}
}

function waitForJobPoll(value: number | undefined, signal?: AbortSignal): Promise<void> {
	const durationMs = Math.max(1, Math.min(5_000, Number(value) || 1_000));
	return new Promise((resolve, reject) => {
		if (signal?.aborted) return reject(signal.reason ?? new DOMException("STT request aborted", "AbortError"));
		const timer = setTimeout(done, durationMs);
		function done() {
			signal?.removeEventListener("abort", abort);
			resolve();
		}
		function abort() {
			clearTimeout(timer);
			reject(signal?.reason ?? new DOMException("STT request aborted", "AbortError"));
		}
		signal?.addEventListener("abort", abort, { once: true });
	});
}

function transportErrorMessage(error: unknown): string {
	if (!(error instanceof Error)) return String(error);
	const cause = error.cause;
	if (!cause || typeof cause !== "object") return error.message;
	const code = "code" in cause ? String(cause.code) : "";
	const message = cause instanceof Error ? cause.message : "";
	return [error.message, code, message].filter(Boolean).join(": ");
}

function appendVoiceVadForm(form: FormData, value: VoiceVadConfig): void {
	const config = normalizeVoiceVadConfig(value);
	form.append("vad_enabled", String(config.enabled));
	form.append("vad_threshold", String(config.threshold));
	form.append("vad_min_speech_duration_ms", String(config.minSpeechDurationMs));
	form.append("vad_min_silence_duration_ms", String(config.minSilenceDurationMs));
	form.append("vad_max_speech_duration_s", String(config.maxSpeechDurationS));
	form.append("vad_speech_pad_ms", String(config.speechPadMs));
	form.append("vad_samples_overlap", String(config.samplesOverlap));
}

function finiteNonNegativeNumber(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

/** A server that reports no duration still leaves one in the wav header it was sent. */
function wavDurationSec(bytes: Buffer): number | undefined {
	if (
		bytes.length < 12 ||
		bytes.toString("ascii", 0, 4) !== "RIFF" ||
		bytes.toString("ascii", 8, 12) !== "WAVE"
	) return undefined;

	let byteRate: number | undefined;
	let dataBytes: number | undefined;
	for (let offset = 12; offset + 8 <= bytes.length;) {
		const type = bytes.toString("ascii", offset, offset + 4);
		const declaredSize = bytes.readUInt32LE(offset + 4);
		const start = offset + 8;
		if (type === "fmt " && declaredSize >= 16 && start + 12 <= bytes.length) {
			byteRate = bytes.readUInt32LE(start + 8);
		}
		if (type === "data") {
			dataBytes = Math.min(declaredSize, bytes.length - start);
			break;
		}
		const next = start + declaredSize + (declaredSize % 2);
		if (next <= offset || next > bytes.length) break;
		offset = next;
	}
	return byteRate && dataBytes !== undefined ? dataBytes / byteRate : undefined;
}

async function loadAudioInput(
	req: TranscribeRequest,
	defaultFilename: string,
	defaultMime: string,
): Promise<{ bytes?: Buffer; filename?: string; mime?: string; error?: string }> {
	if (req.buffer) {
		return { bytes: req.buffer, filename: req.filename || defaultFilename, mime: req.mime || defaultMime };
	}
	if (req.filePath) {
		const bytes = await readFile(req.filePath, { signal: req.signal });
		return { bytes, filename: basename(req.filePath), mime: req.mime || guessMime(basename(req.filePath)) };
	}
	return { error: "filePath or buffer is required" };
}

/** The JSON transcription contract: base64 `input_audio` instead of multipart. */
async function transcribeAsJson(req: TranscribeRequest, target: SttTarget): Promise<ProviderResult<TranscriptResult>> {
	if (!target.apiKey) return { ok: false, provider: target.connection, reason: `no API key for connection '${target.connection}'` };
	const loaded = await loadAudioInput(req, "audio.wav", "audio/wav");
	if (loaded.error) return { ok: false, provider: target.connection, reason: loaded.error };
	const audio = loaded as AudioInput;

	const body: Record<string, unknown> = {
		model: target.model,
		input_audio: {
			data: audio.bytes.toString("base64"),
			format: jsonAudioFormat(audio),
		},
	};
	if (req.language) body.language = req.language;

	const response = await fetch(target.transcriptionEndpoint, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${target.apiKey}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify(body),
		signal: req.signal,
	});
	if (!response.ok) {
		const text = await response.text().catch(() => "");
		return { ok: false, provider: target.connection, reason: `HTTP ${response.status}: ${text.slice(0, 400)}` };
	}
	const data = (await response.json()) as { text?: string; language?: string; usage?: { seconds?: number } };
	const text = data.text ?? "";
	const durationSec = data.usage?.seconds;
	return {
		ok: true,
		provider: target.connection,
		model: target.model,
		text,
		language: data.language || req.language,
		durationSec,
		segments: text ? [{ start: 0, end: durationSec ?? 0, text }] : [],
	};
}

function jsonAudioFormat({ filename, mime }: AudioInput): string {
	const lowerMime = mime.toLowerCase();
	if (lowerMime.includes("mpeg") || lowerMime.includes("mp3")) return "mp3";
	if (lowerMime.includes("wav")) return "wav";
	if (lowerMime.includes("flac")) return "flac";
	if (lowerMime.includes("ogg")) return "ogg";
	if (lowerMime.includes("webm")) return "webm";
	if (lowerMime.includes("aac")) return "aac";
	if (lowerMime.includes("mp4") || lowerMime.includes("m4a")) return "m4a";
	const ext = filename.toLowerCase().split(".").pop() || "";
	if (["mp3", "wav", "flac", "m4a", "ogg", "webm", "aac"].includes(ext)) return ext;
	return "wav";
}

function guessMime(filename: string): string {
	const ext = filename.toLowerCase().split(".").pop() || "";
	const map: Record<string, string> = {
		mp3: "audio/mpeg",
		wav: "audio/wav",
		m4a: "audio/mp4",
		webm: "audio/webm",
		ogg: "audio/ogg",
		flac: "audio/flac",
		aac: "audio/aac",
	};
	return map[ext] || "application/octet-stream";
}
