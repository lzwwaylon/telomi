import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import express from "express";

const testDataDir = mkdtempSync(join(tmpdir(), "telomi-self-hosted-stt-data-"));
const previousDataDir = process.env.TELOMI_DATA_DIR;
process.env.TELOMI_DATA_DIR = testDataDir;

const { transcribe } = await import("../../server/audio/providers/stt.js");
const { configureManagedSpeech } = await import("./managed-speech.js");
const {
	LocalSnapshotTranscriptionAdapter,
	pcm16MonoToWav,
} = await import("../../server/voice/local-snapshot-transcription.js");
const { runVoiceTranscriptionPipeline } = await import("../../server/voice/transcription-pipeline.js");

after(() => {
	if (previousDataDir === undefined) delete process.env.TELOMI_DATA_DIR;
	else process.env.TELOMI_DATA_DIR = previousDataDir;
	rmSync(testDataDir, { recursive: true, force: true });
});

test("self-hosted STT transcribes through an OpenAI-compatible endpoint", async () => {
	let requestPath = "";
	let authorization = "";
	let requestBody = Buffer.alloc(0);
	const server = createServer((request, response) => {
		requestPath = request.url ?? "";
		authorization = request.headers.authorization ?? "";
		const chunks: Buffer[] = [];
		request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
		request.on("end", () => {
			requestBody = Buffer.concat(chunks);
			response.writeHead(200, { "Content-Type": "application/json" });
			response.end(JSON.stringify({
				text: "MFlow self hosted",
				language: "en",
				duration: 1.25,
				segments: [{ start: 0, end: 1.25, text: "MFlow self hosted" }],
			}));
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	assert.ok(address && typeof address === "object");

	await configureManagedSpeech({ connection: "self-hosted-stt", model: "custom-whisper", baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: "private-test-key" });

	try {
		const result = await transcribe({
			buffer: pcm16MonoToWav(Buffer.alloc(32_000), 16_000),
			filename: "dictation.wav",
			mime: "audio/wav",
			language: "en",
			prompt: "MFlow",
		});

		assert.deepEqual(result, {
			ok: true,
			provider: "self-hosted-stt",
			model: "custom-whisper",
			text: "MFlow self hosted",
			language: "en",
			durationSec: 1.25,
			segments: [{ start: 0, end: 1.25, text: "MFlow self hosted" }],
		});
		assert.equal(requestPath, "/v1/audio/transcriptions");
		assert.equal(authorization, "Bearer private-test-key");
		assert.match(requestBody.toString("utf8"), /name="model"\r\n\r\ncustom-whisper/);
		assert.match(requestBody.toString("utf8"), /name="language"\r\n\r\nen/);
		assert.match(requestBody.toString("utf8"), /name="prompt"\r\n\r\nMFlow/);
	} finally {
		await new Promise<void>((resolve, reject) =>
			server.close((error) => error ? reject(error) : resolve()),
		);
	}
});

test("self-hosted STT rejects unsafe endpoint configuration before audio upload", async () => {
	const previousFetch = globalThis.fetch;
	globalThis.fetch = async () => {
		throw new Error("unsafe endpoint reached fetch");
	};
	try {
		const cases = [
			["ftp://127.0.0.1:9595/v1", "must use HTTP or HTTPS"],
			["http://example.com/v1", "public endpoints must use HTTPS"],
			["http://169.254.169.254/latest", "link-local and metadata endpoints are not allowed"],
			["https://user:password@example.com/v1", "must not contain credentials"],
			["https://example.com/v1?tenant=secret", "must not contain a query or fragment"],
		] as const;
		for (const [baseUrl, expectedReason] of cases) {
			const result = await transcribe({
				selection: { connection: "self-hosted-stt", model: "custom-whisper", baseUrl },
				buffer: pcm16MonoToWav(Buffer.alloc(320), 16_000),
				filename: "unsafe.wav",
				mime: "audio/wav",
			});
			assert.equal(result.ok, false, baseUrl);
			if (result.ok) continue;
			assert.match(result.reason, new RegExp(expectedReason, "i"), baseUrl);
			assert.doesNotMatch(result.reason, /unsafe endpoint reached fetch/, baseUrl);
		}
	} finally {
		globalThis.fetch = previousFetch;
	}
});

test("workspace audio settings keep recording preferences while speech models stay managed", async () => {
	const { mountAudioConfigApi } = await import("../../server/voice/config-api.js");
	const app = express();
	app.use(express.json());
	mountAudioConfigApi(app);
	const server = createServer(app);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	assert.ok(address && typeof address === "object");
	const origin = `http://127.0.0.1:${address.port}`;
	try {
		const patched = await fetch(`${origin}/api/audio-config`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ audioCuesEnabled: false }),
		});
		assert.equal(patched.status, 200, await patched.text());
		const persisted = (await (await fetch(`${origin}/api/audio-config`)).json()) as { config: Record<string, unknown> };
		assert.equal(persisted.config.audioCuesEnabled, false);
		// The legacy selectors are retired: speech models only change through Models and Services.
		await configureManagedSpeech({ connection: "self-hosted-stt", model: "custom-whisper", baseUrl: "http://127.0.0.1:19495/v1", apiKey: "self-hosted-secret" });
		const legacy = await fetch(`${origin}/api/audio-config`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ sttProvider: "telomi-audio", sttModel: "legacy-model", selfHostedSttBaseUrl: "http://127.0.0.1:1/v1/", sttLanguage: "en-US" }),
		});
		assert.equal(legacy.status, 200);
		const view = await legacy.json() as Record<string, unknown>;
		const recognition = await (await fetch(`${origin}/api/audio-config/recognition`)).json() as { effective: { recognition: { connection: string } } };
		assert.equal(recognition.effective.recognition.connection, "self-hosted-stt");
		assert.deepEqual(Object.keys(view.config as object).sort(), ["audioCuesEnabled", "sttLanguage", "sttVad"]);
		assert.equal(JSON.stringify(view).includes("self-hosted-secret"), false);
		const { loadSettings } = await import("../../server/config/settings.js");
		const audio = loadSettings().audio ?? {};
		assert.equal(audio.sttLanguage, "en-US");
		assert.equal("sttProvider" in audio || "sttModel" in audio || "selfHostedSttBaseUrl" in audio, false, "legacy model keys are never written");
	} finally {
		await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
	}
});

test("the production Pipeline sends glossary hints to self-hosted STT", async () => {
	let submitted = "";
	const server = createServer((request, response) => {
		const chunks: Buffer[] = [];
		request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
		request.on("end", () => {
			submitted = Buffer.concat(chunks).toString("utf8");
			response.writeHead(200, { "Content-Type": "application/json" });
			response.end(JSON.stringify({
				text: "MemFlow self hosted",
				language: "en",
				duration: 1,
				segments: [],
			}));
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	assert.ok(address && typeof address === "object");
	await configureManagedSpeech({ connection: "self-hosted-stt", model: "domain-asr", baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: "private-test-key" });
	// Stale legacy environment values no longer reach a managed consumer.
	process.env.TELOMI_AUDIO_SELF_HOSTED_STT_BASE_URL = "http://127.0.0.1:9/v1";
	process.env.TELOMI_AUDIO_SELF_HOSTED_STT_MODEL = "stale-environment-model";
	try {
		const result = await runVoiceTranscriptionPipeline({
			buffer: pcm16MonoToWav(Buffer.alloc(32_000), 16_000),
			mime: "audio/wav",
			language: "en",
			languagePreference: "en",
			cleanupRequested: false,
			glossary: {
				revision: "glossary_self_hosted",
				entries: [{
					id: "term_mflow",
					canonical: "MFlow",
					enabled: true,
				}],
			},
		});

		assert.equal(result.ok, true);
		if (!result.ok) return;
		assert.equal(result.rawText, "MemFlow self hosted");
		assert.equal(result.canonicalText, "MemFlow self hosted");
		assert.equal(result.text, "MemFlow self hosted");
		assert.equal(result.provider, "self-hosted-stt");
		assert.equal(result.model, "domain-asr");
		assert.equal(result.glossary.promptApplied, true);
		assert.match(submitted, /name="prompt"\r\n\r\nKeywords: MFlow/);
	} finally {
		delete process.env.TELOMI_AUDIO_SELF_HOSTED_STT_BASE_URL;
		delete process.env.TELOMI_AUDIO_SELF_HOSTED_STT_MODEL;
		await new Promise<void>((resolve, reject) =>
			server.close((error) => error ? reject(error) : resolve()),
		);
	}
});

test("self-hosted STT does not forward audio across HTTP redirects", async () => {
	let redirectedAudioReceived = false;
	const server = createServer((request, response) => {
		if (request.url === "/v1/audio/transcriptions") {
			response.writeHead(307, { Location: "/capture" });
			response.end();
			return;
		}
		if (request.url === "/capture") {
			redirectedAudioReceived = true;
			response.writeHead(200, { "Content-Type": "application/json" });
			response.end(JSON.stringify({ text: "leaked" }));
			return;
		}
		response.writeHead(404).end();
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	assert.ok(address && typeof address === "object");
	await configureManagedSpeech({ connection: "self-hosted-stt", model: "custom-whisper", baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: "private-test-key" });
	try {
		const result = await transcribe({
			buffer: pcm16MonoToWav(Buffer.alloc(320), 16_000),
			filename: "redirect.wav",
			mime: "audio/wav",
		});
		assert.equal(result.ok, false);
		if (!result.ok) assert.match(result.reason, /redirect/i);
		assert.equal(redirectedAudioReceived, false);
	} finally {
		await new Promise<void>((resolve, reject) =>
			server.close((error) => error ? reject(error) : resolve()),
		);
	}
});

test("a snapshot preview against an endpoint without warmup starts without loading a model", async () => {
	const speech = Buffer.alloc(640);
	speech.writeInt16LE(2_000, 0);
	await configureManagedSpeech({ connection: "self-hosted-stt", model: "remote-domain-asr", baseUrl: "http://127.0.0.1:19495/v1", apiKey: "private-test-key" });
	let requestConnection = "";
	let adapter!: LocalSnapshotTranscriptionAdapter;
	const partial = new Promise<string>((resolve) => {
		adapter = new LocalSnapshotTranscriptionAdapter({
			inputSampleRate: 16_000,
			model: "remote-domain-asr",
			snapshotSeconds: 0.02,
			// What `warmupStt` returns for an endpoint that advertises no warmup: no request was sent.
			warmup: async () => ({
				ok: true,
				provider: "self-hosted-stt",
				model: "remote-domain-asr",
				advertised: false,
				readyBeforeRequest: true,
				durationMs: 0,
				requestDurationMs: 0,
				ttlSec: 0,
			}),
			transcribe: async (request) => {
				requestConnection = request.selection?.connection ?? "";
				return {
					ok: true,
					provider: "self-hosted-stt",
					model: "remote-domain-asr",
					text: "remote preview",
				};
			},
			callbacks: { onPartial: resolve },
		});
	});

	await adapter.connect();
	assert.equal(adapter.sendAudio(speech), true);
	assert.equal(await partial, "remote preview");
	assert.equal(requestConnection, "self-hosted-stt");
	assert.equal(adapter.provider, "self-hosted-stt-snapshot");
	adapter.close();
});


test("dictation warmup follows the batch ASR endpoint and only where it advertises warmup", async () => {
	const { createVoiceRouter } = await import("../../server/voice/api.js");
	const requests: unknown[] = [];
	const provider = createServer((req, res) => {
		let body = "";
		req.on("data", (chunk) => { body += chunk; });
		req.on("end", () => {
			res.writeHead(200, { "content-type": "application/json" });
			if (req.url === "/health") {
				res.end(JSON.stringify({ ok: true, capabilities: ["warmup"] }));
				return;
			}
			requests.push(JSON.parse(body));
			res.end(JSON.stringify({ ok: true, loaded: true, model: "batch-model", ready_before_request: true, duration_ms: 0, ttl_sec: 1800 }));
		});
	});
	// A second endpoint that declares nothing beyond the OpenAI-compatible contract.
	let plainRequests = 0;
	const plain = createServer((req, res) => {
		plainRequests += req.url === "/health" ? 0 : 1;
		res.writeHead(req.url === "/health" ? 200 : 500, { "content-type": "application/json" });
		res.end(JSON.stringify({ ok: true, capabilities: [] }));
	});
	await Promise.all([provider, plain].map((listener) => new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve))));
	const providerAddress = provider.address();
	const plainAddress = plain.address();
	assert.ok(providerAddress && typeof providerAddress === "object");
	assert.ok(plainAddress && typeof plainAddress === "object");
	const local = `http://127.0.0.1:${providerAddress.port}/v1`;
	await configureManagedSpeech({ connection: "telomi-audio", model: "batch-model", baseUrl: local, apiKey: "managed-test-key" });
	let readinessCalls = 0;
	// The runtime's own gate decides; only the start it would perform is counted.
	const { AudioLocalRuntimeManager } = await import("../../server/audio/local-runtime.js");
	const localAudio = new AudioLocalRuntimeManager({ env: { TELOMI_AUDIO_STT_BASE_URL: local } });
	localAudio.ensureReady = async () => { readinessCalls += 1; return localAudio.status(); };
	const app = express();
	app.use(createVoiceRouter(
		{ getGoal: () => ({ id: "warmup-goal" }) } as unknown as Parameters<typeof createVoiceRouter>[0],
		testDataDir,
		localAudio,
	));
	const server = createServer(app);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	try {
		const address = server.address();
		assert.ok(address && typeof address === "object");
		const url = `http://127.0.0.1:${address.port}/api/goals/warmup-goal/voice/warmup`;
		const ready = await fetch(url, { method: "POST" });
		assert.equal(ready.status, 200);
		assert.equal((await ready.json()).status, "ready");
		assert.deepEqual(requests, [{ capability: "asr", model: "batch-model" }]);
		await configureManagedSpeech({ connection: "self-hosted-stt", model: "remote-asr", baseUrl: `http://127.0.0.1:${plainAddress.port}/v1`, apiKey: "private-test-key" });
		const skipped = await fetch(url, { method: "POST" });
		assert.deepEqual(await skipped.json(), { status: "skipped", reason: "stt_warmup_not_advertised" });
		assert.equal(readinessCalls, 1, "only the managed connection starts the bundled service");
		assert.equal(requests.length, 1);
		assert.equal(plainRequests, 0, "an endpoint without the capability is never asked to warm up");
	} finally {
		await Promise.all([server, provider, plain].map((listener) => new Promise<void>((resolve, reject) => {
			listener.close((error) => error ? reject(error) : resolve());
		})));
	}
});
