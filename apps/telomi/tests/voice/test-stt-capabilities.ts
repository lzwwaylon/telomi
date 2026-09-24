import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { spawnSync } from "node:child_process";
import ffmpegStatic from "ffmpeg-static";

const testDataDir = mkdtempSync(join(tmpdir(), "telomi-stt-capabilities-"));
const previousDataDir = process.env.TELOMI_DATA_DIR;
process.env.TELOMI_DATA_DIR = testDataDir;

const { transcribe, warmupStt } = await import("../../server/audio/providers/stt.js");
const { configureManagedSpeech } = await import("./managed-speech.js");
const { pcm16MonoToWav } = await import("../../server/voice/local-snapshot-transcription.js");

after(() => {
	if (previousDataDir === undefined) delete process.env.TELOMI_DATA_DIR;
	else process.env.TELOMI_DATA_DIR = previousDataDir;
	rmSync(testDataDir, { recursive: true, force: true });
});

interface UpstreamRequest {
	method: string;
	path: string;
	body: string;
}

interface Upstream {
	baseUrl: string;
	requests: UpstreamRequest[];
	paths: string[];
	/** The most transcription requests this endpoint had in flight at once. */
	peakInFlight: number;
	close: () => Promise<void>;
}

interface UpstreamOptions {
	/** Absent: the endpoint serves no health document at all, like a plain OpenAI-compatible server. */
	health?: { capabilities?: string[]; max_concurrency?: number };
	/** Refuse the first transcription with this status, as a server that cannot decode the upload would. */
	rejectFirstWith?: { status: number; body: string };
	transcriptionDelayMs?: number;
	onJobPoll?: () => void;
}

async function startUpstream(options: UpstreamOptions = {}): Promise<Upstream> {
	const requests: UpstreamRequest[] = [];
	let transcriptions = 0;
	let inFlight = 0;
	let peakInFlight = 0;
	const jobs = new Map<string, { polls: number }>();
	const server: Server = createServer((request, response) => {
		const chunks: Buffer[] = [];
		request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
		request.on("end", async () => {
			const path = request.url ?? "";
			const method = request.method ?? "GET";
			requests.push({ method, path, body: Buffer.concat(chunks).toString("latin1") });
			const json = (status: number, body: unknown) => {
				response.writeHead(status, { "Content-Type": "application/json" });
				response.end(JSON.stringify(body));
			};
			if (path === "/health") {
				if (!options.health) return json(404, { detail: "not found" });
				return json(200, { ok: true, ...options.health });
			}
			if (path === "/v1/models") {
				return json(200, { data: [{ id: "chat-model" }, { id: "reported-asr", modality: "stt" }] });
			}
			if (path === "/v1/audio/warmup") {
				return json(200, { ok: true, loaded: true, model: "asr-model", ready_before_request: false, duration_ms: 12, ttl_sec: 60 });
			}
			if (path === "/v1/audio/transcriptions") {
				transcriptions += 1;
				if (transcriptions === 1 && options.rejectFirstWith) {
					return json(options.rejectFirstWith.status, { detail: options.rejectFirstWith.body });
				}
				inFlight += 1;
				peakInFlight = Math.max(peakInFlight, inFlight);
				if (options.transcriptionDelayMs) {
					await new Promise((resolve) => setTimeout(resolve, options.transcriptionDelayMs));
				}
				inFlight -= 1;
				return json(200, { text: "spoken words", language: "en", duration: 1 });
			}
			if (path === "/v1/audio/transcription-jobs") {
				jobs.set("job-1", { polls: 0 });
				return json(202, { id: "job-1", status: "queued", poll_after_ms: 1 });
			}
			if (path.startsWith("/v1/audio/transcription-jobs/")) {
				if (method === "GET") options.onJobPoll?.();
				const job = jobs.get("job-1")!;
				job.polls += 1;
				return json(200, job.polls === 1
					? { id: "job-1", status: "running", poll_after_ms: 1 }
					: { id: "job-1", status: "succeeded", result: { text: "long recording", duration: 90 } });
			}
			return json(404, { detail: "not found" });
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	assert.ok(address && typeof address === "object");
	return {
		baseUrl: `http://127.0.0.1:${address.port}/v1`,
		requests,
		get paths() { return requests.map((item) => item.path); },
		get peakInFlight() { return peakInFlight; },
		close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
	};
}

function dictation(): Buffer {
	return pcm16MonoToWav(Buffer.alloc(32_000), 16_000);
}

test("an endpoint without health serves push-to-talk and a long transcription as plain requests", async () => {
	const upstream = await startUpstream();
	await configureManagedSpeech({ connection: "plain-stt", model: "asr-model", baseUrl: upstream.baseUrl, apiKey: "plain-key" });
	try {
		const dictated = await transcribe({ buffer: dictation(), filename: "voice.wav", mime: "audio/wav" });
		const long = await transcribe({ buffer: dictation(), filename: "long.wav", mime: "audio/wav", mode: "job" });

		assert.equal(dictated.ok, true);
		assert.equal(long.ok, true);
		if (!long.ok) return;
		assert.equal(long.text, "spoken words");
		assert.deepEqual(upstream.paths.filter((path) => path.startsWith("/v1/")), [
			"/v1/audio/transcriptions",
			"/v1/audio/transcriptions",
		]);
		assert.equal(upstream.requests.some((item) => item.body.includes("timestamp_granularities")), false);
	} finally {
		await upstream.close();
	}
});

test("an endpoint advertising its extensions gets Jobs and warmup", async () => {
	const upstream = await startUpstream({ health: { capabilities: ["warmup", "transcription-jobs"] } });
	await configureManagedSpeech({ connection: "rich-stt", model: "asr-model", baseUrl: upstream.baseUrl, apiKey: "rich-key" });
	try {
		const long = await transcribe({ buffer: dictation(), filename: "long.wav", mime: "audio/wav", mode: "job" });
		assert.equal(long.ok, true);
		if (!long.ok) return;
		assert.equal(long.text, "long recording");
		const warmed = await warmupStt({});
		assert.equal(warmed.ok, true);
		if (!warmed.ok) return;
		assert.equal(warmed.advertised, true);
		assert.equal(warmed.model, "asr-model");
		assert.equal(warmed.readyBeforeRequest, false);
		assert.equal(warmed.durationMs, 12);
		assert.equal(warmed.ttlSec, 60);

		assert.deepEqual(upstream.paths, [
			"/health",
			"/v1/audio/transcription-jobs",
			"/v1/audio/transcription-jobs/job-1",
			"/v1/audio/transcription-jobs/job-1",
			"/v1/audio/warmup",
		]);
		assert.equal(upstream.requests.at(-1)!.body, JSON.stringify({ capability: "asr", model: "asr-model" }));
		// One probe covers every consumer of this connection for the catalog revision.
		assert.equal(upstream.paths.filter((path) => path === "/health").length, 1);
	} finally {
		await upstream.close();
	}
});

test("an endpoint advertising no extensions gets none of them", async () => {
	const upstream = await startUpstream({ health: { capabilities: [] } });
	await configureManagedSpeech({ connection: "bare-stt", model: "asr-model", baseUrl: upstream.baseUrl, apiKey: "bare-key" });
	try {
		const long = await transcribe({ buffer: dictation(), filename: "long.wav", mime: "audio/wav", mode: "job" });
		assert.equal(long.ok, true);
		const warmed = await warmupStt({});
		assert.equal(warmed.ok, true);
		if (!warmed.ok) return;
		assert.equal(warmed.advertised, false);

		assert.deepEqual(upstream.paths, ["/health", "/v1/audio/transcriptions"]);
		assert.equal(upstream.requests.some((item) => item.body.includes("timestamp_granularities")), false);
	} finally {
		await upstream.close();
	}
});

test("a declared concurrency limit serialises requests and its absence does not", async () => {
	const serial = await startUpstream({ health: { capabilities: [], max_concurrency: 1 }, transcriptionDelayMs: 60 });
	await configureManagedSpeech({ connection: "serial-stt", model: "asr-model", baseUrl: serial.baseUrl, apiKey: "serial-key" });
	try {
		await transcribeConcurrently();
		assert.equal(serial.peakInFlight, 1, "a single-slot endpoint must not receive overlapping requests");
	} finally {
		await serial.close();
	}

	const parallel = await startUpstream({ health: { capabilities: [] }, transcriptionDelayMs: 60 });
	await configureManagedSpeech({ connection: "parallel-stt", model: "asr-model", baseUrl: parallel.baseUrl, apiKey: "parallel-key" });
	try {
		await transcribeConcurrently();
		assert.equal(parallel.peakInFlight, 4, "an endpoint that declares no limit is used in parallel");
	} finally {
		await parallel.close();
	}
});

/** Four at once: a slot handed to a waiter must not also be taken by the next caller to arrive. */
async function transcribeConcurrently(): Promise<void> {
	const results = await Promise.all([0, 1, 2, 3].map(() =>
		transcribe({ buffer: dictation(), filename: "voice.wav", mime: "audio/wav" })));
	for (const result of results) assert.equal(result.ok, true, result.ok ? "" : result.reason);
}

test("local segmentation is sent only when the caller enables it, and its report is preserved", async () => {
	const upstream = await startUpstream({ health: { capabilities: [] } });
	await configureManagedSpeech({ connection: "vad-stt", model: "asr-model", baseUrl: upstream.baseUrl, apiKey: "vad-key" });
	const vad = {
		enabled: true,
		threshold: 0.6,
		minSpeechDurationMs: 300,
		minSilenceDurationMs: 250,
		maxSpeechDurationS: 45,
		speechPadMs: 120,
		samplesOverlap: 0.4,
	};
	try {
		await transcribe({ buffer: dictation(), filename: "quiet.wav", mime: "audio/wav", vad: { ...vad, enabled: false } });
		assert.equal(upstream.requests.at(-1)!.body.includes("vad_enabled"), false);

		await transcribe({ buffer: dictation(), filename: "voice.wav", mime: "audio/wav", vad });
		const submitted = upstream.requests.at(-1)!.body;
		assert.match(submitted, /name="vad_enabled"\r\n\r\ntrue/);
		assert.match(submitted, /name="vad_threshold"\r\n\r\n0.6/);
		assert.match(submitted, /name="vad_min_speech_duration_ms"\r\n\r\n300/);
		assert.match(submitted, /name="vad_samples_overlap"\r\n\r\n0.4/);
	} finally {
		await upstream.close();
	}
});

test("a transport failure reaches the caller as a structured result naming the endpoint", async () => {
	const upstream = await startUpstream();
	await upstream.close();
	await configureManagedSpeech({ connection: "down-stt", model: "asr-model", baseUrl: upstream.baseUrl, apiKey: "down-key" });
	const result = await transcribe({ buffer: dictation(), filename: "voice.wav", mime: "audio/wav" });
	assert.equal(result.ok, false);
	if (result.ok) return;
	assert.equal(result.provider, "down-stt");
	assert.match(result.reason, /ECONNREFUSED/);
	assert.match(result.reason, new RegExp(upstream.baseUrl));
});

test("aborting a long transcription asks the endpoint to cancel its Job", async () => {
	const controller = new AbortController();
	const upstream = await startUpstream({
		health: { capabilities: ["transcription-jobs"] },
		// A status poll proves the client has received the Job id before cancellation.
		onJobPoll: () => controller.abort(new Error("cancelled by test")),
	});
	await configureManagedSpeech({ connection: "job-stt", model: "asr-model", baseUrl: upstream.baseUrl, apiKey: "job-key" });
	try {
		const pending = transcribe({ buffer: dictation(), filename: "long.wav", mime: "audio/wav", mode: "job", signal: controller.signal });
		await assert.rejects(pending, /cancelled by test/);
		const jobRequests = upstream.requests.filter((item) => item.path.startsWith("/v1/audio/transcription-jobs")).map((item) => item.method);
		assert.deepEqual(jobRequests, ["POST", "GET", "DELETE"]);
	} finally {
		await upstream.close();
	}
});

test("a selection without a model uses the one the endpoint reports", async () => {
	const upstream = await startUpstream();
	await configureManagedSpeech({ connection: "unset-stt", model: "asr-model", baseUrl: upstream.baseUrl, apiKey: "unset-key" });
	try {
		const result = await transcribe({
			selection: { connection: "unset-stt", model: "", baseUrl: upstream.baseUrl },
			buffer: dictation(),
			filename: "voice.wav",
			mime: "audio/wav",
		});
		assert.equal(result.ok, true, result.ok ? "" : result.reason);
		if (!result.ok) return;
		assert.equal(result.model, "reported-asr");
		assert.match(upstream.requests.at(-1)!.body, /name="model"\r\n\r\nreported-asr/);
	} finally {
		await upstream.close();
	}
});

test("a connection declaring the JSON transcription contract is sent JSON, not multipart", async () => {
	const upstream = await startUpstream();
	await configureManagedSpeech({ connection: "gateway-stt", model: "asr-model", baseUrl: upstream.baseUrl, apiKey: "gateway-key" });
	const { loadCustomProviders, saveCustomProviders } = await import("../../server/providers/custom-models.js");
	const catalog = loadCustomProviders();
	catalog.providers!["gateway-stt"]!.compat = { transcription: "json" };
	saveCustomProviders(catalog);
	try {
		const result = await transcribe({ buffer: dictation(), filename: "voice.wav", mime: "audio/wav" });
		assert.equal(result.ok, true, result.ok ? "" : result.reason);
		const submitted = JSON.parse(upstream.requests.at(-1)!.body) as { model: string; input_audio: { format: string; data: string } };
		assert.equal(submitted.model, "asr-model");
		assert.equal(submitted.input_audio.format, "wav");
		assert.ok(submitted.input_audio.data.length > 0);
	} finally {
		await upstream.close();
	}
});

test("a server that cannot decode the upload gets a wav retry", async () => {
	const upstream = await startUpstream({ rejectFirstWith: { status: 415, body: "unsupported media type: audio/webm" } });
	await configureManagedSpeech({ connection: "strict-stt", model: "asr-model", baseUrl: upstream.baseUrl, apiKey: "strict-key" });
	try {
		const result = await transcribe({ buffer: browserRecording(), filename: "dictation.webm", mime: "audio/webm" });
		assert.equal(result.ok, true, result.ok ? "" : result.reason);
		const transcriptions = upstream.requests.filter((item) => item.path === "/v1/audio/transcriptions");
		assert.equal(transcriptions.length, 2);
		assert.match(transcriptions[0]!.body, /filename="dictation.webm"/);
		assert.match(transcriptions[1]!.body, /filename="dictation.wav"/);
		assert.match(transcriptions[1]!.body, /RIFF/);
	} finally {
		await upstream.close();
	}
});

/** A webm container ffmpeg can read: a fraction of a second of silence is enough to transcode. */
function browserRecording(): Buffer {
	const encoded = spawnSync(ffmpegStatic as unknown as string, [
		"-hide_banner", "-loglevel", "error",
		"-f", "lavfi", "-i", "anullsrc=r=16000:cl=mono", "-t", "0.2",
		"-c:a", "libopus", "-f", "webm", "pipe:1",
	], { maxBuffer: 8 * 1024 * 1024 });
	assert.equal(encoded.status, 0, encoded.stderr?.toString());
	return encoded.stdout;
}
