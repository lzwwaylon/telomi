import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import express from "express";

const home = mkdtempSync(join(tmpdir(), "telomi-tts-server-defaults-"));
const previousDataDir = process.env.TELOMI_DATA_DIR;
process.env.TELOMI_DATA_DIR = home;

const { speak, speakMany } = await import("../../server/audio/providers/tts.js");
const { configureManagedAudioGeneration } = await import("./managed-speech.js");
const { loadCustomProviders, saveCustomProviders } = await import("../../server/providers/custom-models.js");
const { mountAudioConfigApi } = await import("../../server/voice/config-api.js");

const api = express();
api.use(express.json());
mountAudioConfigApi(api);
const apiServer = api.listen(0, "127.0.0.1");
await new Promise<void>((resolve) => apiServer.once("listening", resolve));
const apiAddress = apiServer.address();
assert.ok(apiAddress && typeof apiAddress === "object");
const generationUrl = `http://127.0.0.1:${apiAddress.port}/api/audio-config/generation`;

after(async () => {
	apiServer.closeAllConnections();
	await new Promise<void>((resolve) => apiServer.close(() => resolve()));
	if (previousDataDir === undefined) delete process.env.TELOMI_DATA_DIR;
	else process.env.TELOMI_DATA_DIR = previousDataDir;
	rmSync(home, { recursive: true, force: true });
});

/** A valid silent wav, so the real ffmpeg transcode runs. */
function wave(): Buffer {
	const bytes = Buffer.alloc(4844);
	bytes.write("RIFF"); bytes.writeUInt32LE(4836, 4); bytes.write("WAVEfmt ", 8);
	bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
	bytes.writeUInt32LE(24000, 24); bytes.writeUInt32LE(48000, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
	bytes.write("data", 36); bytes.writeUInt32LE(4800, 40); return bytes;
}

interface Upstream {
	baseUrl: string;
	speech: Array<Record<string, unknown>>;
	peakInFlight: number;
	close: () => Promise<void>;
}

async function startUpstream(options: {
	/** Absent: no health document, like a plain OpenAI-compatible server. */
	health?: { capabilities?: string[]; max_concurrency?: number };
	models?: Array<Record<string, unknown>>;
	speechDelayMs?: number;
	/** Absent: any voice speaks. Present: the voices this server really speaks, listed or not. */
	speaks?: string[];
} = {}): Promise<Upstream> {
	const speech: Array<Record<string, unknown>> = [];
	let inFlight = 0;
	let peakInFlight = 0;
	const server: Server = createServer((request, response) => {
		const chunks: Buffer[] = [];
		request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
		request.on("end", async () => {
			const json = (status: number, body: unknown) => {
				response.writeHead(status, { "Content-Type": "application/json" });
				response.end(JSON.stringify(body));
			};
			if (request.url === "/health") return options.health ? json(200, { ok: true, ...options.health }) : json(404, { detail: "not found" });
			if (request.url === "/v1/models") return json(200, { data: options.models ?? [] });
			if (request.url !== "/v1/audio/speech") return json(404, { detail: "not found" });
			const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
			if (options.speaks && typeof body.voice === "string" && !options.speaks.includes(body.voice)) return json(400, { detail: `unknown voice ${body.voice}` });
			speech.push(body);
			inFlight += 1;
			peakInFlight = Math.max(peakInFlight, inFlight);
			if (options.speechDelayMs) await new Promise((resolve) => setTimeout(resolve, options.speechDelayMs));
			inFlight -= 1;
			response.writeHead(200, { "Content-Type": "audio/wav" });
			response.end(wave());
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	assert.ok(address && typeof address === "object");
	return {
		baseUrl: `http://127.0.0.1:${address.port}/v1`,
		speech,
		get peakInFlight() { return peakInFlight; },
		close: () => {
			server.closeAllConnections();
			return new Promise<void>((resolve) => server.close(() => resolve()));
		},
	};
}

test("a selection naming no model or voice speaks with what the server reports, and an explicit voice wins", async () => {
	const upstream = await startUpstream({
		models: [{ id: "chat-model" }, { id: "reported-speaker", modality: "tts", default_voice: "reported-voice", supported_voices: ["reported-voice", "chosen-voice"] }],
	});
	try {
		await configureManagedAudioGeneration({ connection: "reporting-tts", model: "", voice: "", rate: 1, baseUrl: upstream.baseUrl, apiKey: "reporting-key" });
		const reported = await speak({ text: "Server defaults", format: "wav" });
		assert.equal(reported.ok, true, reported.ok ? "" : reported.reason);
		assert.deepEqual([upstream.speech.at(-1)?.model, upstream.speech.at(-1)?.voice], ["reported-speaker", "reported-voice"]);

		await configureManagedAudioGeneration({ connection: "reporting-tts", model: "", voice: "chosen-voice", rate: 1, baseUrl: upstream.baseUrl, apiKey: "reporting-key" });
		assert.equal((await speak({ text: "Explicit voice", format: "wav" })).ok, true);
		assert.deepEqual([upstream.speech.at(-1)?.model, upstream.speech.at(-1)?.voice], ["reported-speaker", "chosen-voice"]);
	} finally {
		await upstream.close();
	}
});

test("batch generation honours the concurrency the server declares, and runs in parallel where it declares none", async () => {
	const segments = (prefix: string) => [1, 2, 3, 4].map((index) => ({ id: `${prefix}-${index}`, text: `Segment ${index}`, outPath: join(home, `${prefix}-${index}.wav`) }));

	const serial = await startUpstream({ health: { capabilities: [], max_concurrency: 1 }, speechDelayMs: 40 });
	try {
		await configureManagedAudioGeneration({ connection: "serial-tts", model: "speaker", voice: "one", rate: 1, baseUrl: serial.baseUrl, apiKey: "serial-key" });
		const progress: Array<[number, number]> = [];
		const spoken = await speakMany({ segments: segments("serial"), onSegment: (done, total) => progress.push([done, total]) });
		assert.equal(spoken.ok && spoken.errors.length, 0);
		assert.equal(serial.speech.length, 4);
		assert.equal(serial.peakInFlight, 1, "a single-slot endpoint must not receive overlapping speech requests");
		assert.deepEqual(progress, [[1, 4], [2, 4], [3, 4], [4, 4]], "each finished segment reports batch progress");
	} finally {
		await serial.close();
	}

	const parallel = await startUpstream({ speechDelayMs: 40 });
	try {
		await configureManagedAudioGeneration({ connection: "parallel-tts", model: "speaker", voice: "one", rate: 1, baseUrl: parallel.baseUrl, apiKey: "parallel-key" });
		const spoken = await speakMany({ segments: segments("parallel") });
		assert.equal(spoken.ok && spoken.errors.length, 0);
		assert.ok(parallel.peakInFlight > 1, "without a declared limit a batch is not serialised");
	} finally {
		await parallel.close();
	}
});

async function apply(connection: string, model: string, voice: string, rate = 1): Promise<{ status: number; error?: string }> {
	const response = await fetch(`${generationUrl}/apply`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ default: { connection, model, voice, rate } }),
	});
	const body = await response.json() as { error?: string };
	return { status: response.status, error: body.error };
}

test("listed voices apply as they are; a typed voice outside the list applies once the server speaks it", async () => {
	// A server serving a well-known model id with its own voices, and speaking one more it does not list (as OpenRouter does).
	const reporting = await startUpstream({ models: [{ id: "tts-1", modality: "tts", supported_voices: ["af_heart", "am_adam"] }], speaks: ["af_heart", "am_adam", "unlisted-voice"] });
	// A server that reports nothing about its voices.
	const silent = await startUpstream({ models: [{ id: "tts-1" }, { id: "speaker" }, { id: "discovered-speaker" }], speaks: ["alloy", "discovered-voice"] });
	try {
		await configureManagedAudioGeneration({ connection: "reporting-voices", model: "tts-1", voice: "af_heart", rate: 1, baseUrl: reporting.baseUrl, apiKey: "reporting-key" });
		await configureManagedAudioGeneration({ connection: "silent-voices", model: "speaker", voice: "typed", rate: 1, baseUrl: silent.baseUrl, apiKey: "silent-key" });
		const catalog = loadCustomProviders();
		catalog.providers!["silent-voices"]!.models = [{ id: "speaker" }, { id: "tts-1" }, { id: "discovered-speaker", supportedVoices: ["discovered-voice"] }];
		saveCustomProviders(catalog);

		assert.equal((await apply("reporting-voices", "tts-1", "af_heart")).status, 200, "a voice the server reports is accepted over the static table");
		assert.equal(reporting.speech.length, 0, "a listed voice is applied without speaking");
		assert.equal((await apply("reporting-voices", "tts-1", "unlisted-voice")).status, 200, "a voice the list leaves out applies once the server speaks it");
		assert.equal(reporting.speech.at(-1)?.voice, "unlisted-voice");
		const spoken = reporting.speech.length;
		assert.equal((await apply("reporting-voices", "tts-1", "unlisted-voice", 1.3)).status, 200, "a rate change keeps the voice proven when it was applied");
		assert.equal(reporting.speech.length, spoken, "changing only the rate speaks nothing");
		const refused = await apply("reporting-voices", "tts-1", "alloy");
		assert.equal(refused.status, 422, "the static table does not widen what the server speaks");
		assert.match(refused.error ?? "", /Unsupported voice for selected audio model: HTTP 400 .*unknown voice alloy/, "the server's own refusal is shown");

		assert.equal((await apply("silent-voices", "discovered-speaker", "discovered-voice")).status, 200, "discovered voices count as the server's");
		assert.equal((await apply("silent-voices", "discovered-speaker", "not-discovered")).status, 422);

		assert.equal((await apply("silent-voices", "speaker", "typed-by-hand")).status, 200, "a typed voice on a connection reporting nothing is accepted");
		assert.equal((await apply("silent-voices", "tts-1", "alloy")).status, 200, "the static table is the fallback where the server reports nothing");
		assert.equal((await apply("silent-voices", "tts-1", "af_heart")).status, 422);
	} finally {
		await Promise.all([reporting.close(), silent.close()]);
	}
});

test("a gateway serving several capabilities applies the speech models its discovery classified, and only those", async () => {
	// Like OpenRouter: the gateway's own model listing leaves speech models out.
	const gateway = await startUpstream({ models: [] });
	try {
		await configureManagedAudioGeneration({ connection: "speech-gateway", model: "gateway-speaker", voice: "", rate: 1, baseUrl: gateway.baseUrl, apiKey: "gateway-key" });
		const catalog = loadCustomProviders();
		const entry = catalog.providers!["speech-gateway"]!;
		delete entry.capability;
		entry.models = [{ id: "gateway-speaker", capabilities: ["tts"], supportedVoices: ["narrator"] }, { id: "gateway-chat", capabilities: ["chat"] }];
		saveCustomProviders(catalog);

		const speaker = await apply("speech-gateway", "gateway-speaker", "narrator");
		assert.equal(speaker.status, 200, speaker.error);
		const chat = await apply("speech-gateway", "gateway-chat", "");
		assert.equal(chat.status, 422);
		assert.match(chat.error ?? "", /Connection must declare audio generation capability for this model/);
	} finally {
		await gateway.close();
	}
});

test("applying a speed outside the range the server reports for the model is refused", async () => {
	const upstream = await startUpstream({ models: [{ id: "fixed-speed", modality: "tts", min_speed: 1, max_speed: 1 }] });
	try {
		await configureManagedAudioGeneration({ connection: "fixed-speed-tts", model: "fixed-speed", voice: "one", rate: 1, baseUrl: upstream.baseUrl, apiKey: "fixed-key" });
		const faster = await apply("fixed-speed-tts", "fixed-speed", "one", 1.5);
		assert.equal(faster.status, 422);
		assert.match(faster.error ?? "", /Unsupported speed for selected audio model/);
		assert.equal((await apply("fixed-speed-tts", "fixed-speed", "one", 1)).status, 200);
	} finally {
		await upstream.close();
	}
});

test("output format and prompt wrapping follow model metadata, not the model's brand", async () => {
	const upstream = await startUpstream({ models: [{ id: "wav-speaker", modality: "tts", response_formats: ["pcm", "wav"] }] });
	try {
		// The server says what the model can return: an mp3 is made from the wav it can send.
		await configureManagedAudioGeneration({ connection: "format-tts", model: "wav-speaker", voice: "one", rate: 1, baseUrl: upstream.baseUrl, apiKey: "format-key" });
		const transcoded = await speak({ text: "Needs mp3", format: "mp3" });
		assert.equal(transcoded.ok, true, transcoded.ok ? "" : transcoded.reason);
		assert.equal(upstream.speech.at(-1)?.response_format, "wav");

		// A server silent about formats gets the format asked for.
		await configureManagedAudioGeneration({ connection: "format-tts", model: "plain-speaker", voice: "one", rate: 1, baseUrl: upstream.baseUrl, apiKey: "format-key" });
		assert.equal((await speak({ text: "Plain", format: "wav" })).ok, true);
		assert.equal(upstream.speech.at(-1)?.response_format, "wav");
		assert.equal(upstream.speech.at(-1)?.input, "Plain");

		// A well-known model the server says nothing about: the static metadata supplies PCM-only output and the language instruction.
		await configureManagedAudioGeneration({ connection: "format-tts", model: "google/gemini-3.1-flash-tts-preview", voice: "Kore", rate: 1, baseUrl: upstream.baseUrl, apiKey: "format-key" });
		await speak({ text: "你好，世界", format: "wav" });
		assert.equal(upstream.speech.at(-1)?.response_format, "pcm");
		const wrapped = String(upstream.speech.at(-1)?.input);
		assert.ok(wrapped !== "你好，世界" && wrapped.endsWith("你好，世界"), "the language instruction precedes the text");
	} finally {
		await upstream.close();
	}
});

test("a settings row previews its own selection without applying it, and replays from the cache", async () => {
	const upstream = await startUpstream({ models: [{ id: "applied-speaker", modality: "tts" }, { id: "row-speaker", modality: "tts", supported_voices: ["row-voice"] }] });
	const origin = generationUrl.replace("/api/audio-config/generation", "");
	const preview = (body: Record<string, unknown>) => fetch(`${origin}/api/audio-config/voice-preview`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
	try {
		await configureManagedAudioGeneration({ connection: "preview-tts", model: "applied-speaker", voice: "", rate: 1, baseUrl: upstream.baseUrl, apiKey: "preview-key" });
		const row = { connection: "preview-tts", model: "row-speaker", voice: "row-voice", rate: 1.2, text: "试听这一行" };
		const first = await preview(row);
		const answer = await first.json() as { url?: string; error?: string };
		assert.equal(first.status, 200, answer.error);
		assert.match(answer.url ?? "", /^\/api\/audio-config\/voice-preview\/[0-9a-f]{40}\.mp3$/);
		const spoken = upstream.speech.at(-1);
		assert.deepEqual([spoken?.model, spoken?.voice, spoken?.speed, spoken?.input], ["row-speaker", "row-voice", 1.2, "试听这一行"], "the row speaks, not the applied selection");

		const audio = await fetch(`${origin}${answer.url}`);
		assert.equal(audio.status, 200);
		assert.equal(audio.headers.get("content-type"), "audio/mpeg");
		assert.ok((await audio.arrayBuffer()).byteLength > 0);

		const synthesized = upstream.speech.length;
		assert.equal(((await (await preview(row)).json()) as { url: string }).url, answer.url);
		assert.equal(upstream.speech.length, synthesized, "the same row and text replay without another synthesis");

		assert.equal((await preview({ ...row, text: "   " })).status, 400, "a preview needs text");
		assert.equal((await preview({ ...row, connection: "not a connection id" })).status, 400);
		assert.equal((await preview({ ...row, connection: "missing-tts" })).status, 502);
		assert.equal((await fetch(`${origin}/api/audio-config/voice-preview/not-a-preview.mp3`)).status, 404);
	} finally {
		await upstream.close();
	}
});
