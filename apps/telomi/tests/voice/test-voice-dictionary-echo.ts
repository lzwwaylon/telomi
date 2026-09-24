import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

const testDataDir = mkdtempSync(join(tmpdir(), "telomi-dictionary-echo-"));
process.env.TELOMI_DATA_DIR = testDataDir;
after(() => rmSync(testDataDir, { recursive: true, force: true }));
const { matchesDictionaryPrompt, rejectDictionaryEcho } = await import("../../server/voice/dictionary-echo.js");
const { runVoiceTranscriptionPipeline } = await import("../../server/voice/transcription-pipeline.js");
const { runVoiceSttRoute } = await import("../../server/voice/transcription-routing.js");
const { configureManagedSpeech } = await import("./managed-speech.js");

test("dictionary echo filter retains OpenWhispr matching behavior", () => {
	const dictionary = "OpenWhispr, Parakeet, Alcahest";
	for (const echoed of [
		dictionary,
		"OpenWhispr, Parakeet, Alcahest.",
		"openwhispr, parakeet, alcahest",
		"OpenWhispr Parakeet Alcahest",
		"OpenWhispr,  Parakeet,  Alcahest",
		"OpenWhispr, Parakeet, Alcahest, OpenWhispr, Parakeet, Alcahest",
	]) {
		assert.equal(matchesDictionaryPrompt(echoed, dictionary), true, echoed);
	}
});

test("dictionary echo filter preserves legitimate and partial-overlap speech", () => {
	assert.equal(
		matchesDictionaryPrompt(
			"I just installed OpenWhispr and it works great",
			"OpenWhispr, Parakeet, Alcahest",
		),
		false,
	);
	assert.equal(
		matchesDictionaryPrompt(
			"OpenWhispr, Parakeet",
			"OpenWhispr, Parakeet, Alcahest",
		),
		false,
	);
	assert.equal(
		matchesDictionaryPrompt(
			"The quick brown fox jumps over the lazy dog",
			"OpenWhispr, Parakeet, Alcahest",
		),
		false,
	);
});

test("dictionary echo filter handles empty, single-word, Unicode and CJK prompts", () => {
	assert.equal(matchesDictionaryPrompt("some text", null), false);
	assert.equal(matchesDictionaryPrompt(null, "OpenWhispr"), false);
	assert.equal(matchesDictionaryPrompt("", ""), false);
	assert.equal(matchesDictionaryPrompt("OpenWhispr", "OpenWhispr"), true);
	assert.equal(
		matchesDictionaryPrompt("OpenWhispr is great", "OpenWhispr"),
		false,
	);
	assert.equal(
		matchesDictionaryPrompt(
			"Müller, François, José",
			"Müller, François, José",
		),
		true,
	);
	assert.equal(
		matchesDictionaryPrompt(
			"muller francois jose",
			"Müller, François, José",
		),
		false,
	);
	assert.equal(matchesDictionaryPrompt("東京, 大阪", "東京, 大阪"), true);
});

test("dictionary echo filter catches high-composition prompts with minor filler", () => {
	const dictionary =
		"Alpha, Bravo, Charlie, Delta, Echo, Foxtrot, Golf, Hotel, India, Juliet";
	const echoed =
		"Alpha Bravo Charlie Delta Echo Foxtrot Golf Hotel India Juliet the";
	assert.equal(matchesDictionaryPrompt(echoed, dictionary), true);
});

test("dictionary echo becomes a no-audio Provider result", () => {
	const result = rejectDictionaryEcho(
		{
			ok: true,
			provider: "telomi-audio",
			model: "test-model",
			text: "OpenWhispr, Parakeet, Alcahest.",
			segments: [],
		},
		"OpenWhispr, Parakeet, Alcahest",
	);
	assert.deepEqual(result, {
		ok: false,
		provider: "telomi-audio",
		reason: "No audio detected",
	});
});

test("dictionary echo cannot trigger an explicitly enabled cloud fallback", async () => {
	let calls = 0;
	const route = await runVoiceSttRoute(
		{
			request: {
				buffer: Buffer.alloc(256),
				filename: "audio.wav",
				mime: "audio/wav",
				prompt: "Keywords: OpenWhispr",
			},
			primaryProvider: "telomi-audio",
			fallback: {
				enabled: true,
				provider: "openrouter-stt",
				selection: { connection: "openrouter", model: "openai/gpt-4o-mini-transcribe" },
				model: "openai/gpt-4o-mini-transcribe",
			},
		},
		async () => {
			calls += 1;
			return rejectDictionaryEcho(
				{
					ok: true,
					provider: "telomi-audio",
					text: "OpenWhispr.",
					segments: [],
				},
				"OpenWhispr",
			);
		},
	);

	assert.equal(route.result.ok, false);
	assert.equal(calls, 1);
	assert.equal(route.routing.fallback.enabled, true);
	assert.equal(route.routing.fallback.used, false);
	assert.equal(route.routing.fallback.skipReason, "no-audio");
});

test("production pipeline blocks a local dictionary echo before cloud fallback", async () => {
	let receivedPrompt = "";
	let requestCount = 0;
	const server = createServer((request, response) => {
		const chunks: Buffer[] = [];
		request.on("data", (chunk: Buffer) => chunks.push(chunk));
		request.on("end", () => {
			// A plain OpenAI-compatible endpoint: no health document, so no extensions.
			if (request.url === "/health") {
				response.writeHead(404, { "content-type": "application/json" });
				response.end("{}");
				return;
			}
			requestCount += 1;
			const body = Buffer.concat(chunks).toString("utf8");
			assert.match(body, /Keywords: OpenWhispr/);
			receivedPrompt = "Keywords: OpenWhispr";
			response.writeHead(200, { "content-type": "application/json" });
			response.end(
				JSON.stringify({
					text: "OpenWhispr.",
					language: "en",
					duration: 1,
					segments: [],
				}),
			);
		});
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address();
	assert.ok(address && typeof address === "object");
	await configureManagedSpeech({ connection: "telomi-audio", model: "Qwen3-ASR-0.6B-MLX-4bit", baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: "12345" });

	try {
		const result = await runVoiceTranscriptionPipeline({
			buffer: Buffer.alloc(256),
			mime: "audio/wav",
			language: "en",
			cleanupRequested: false,
			glossary: {
				revision: "echo-test-glossary",
				updatedAt: null,
				entries: [
					{
						id: "term_openwhispr",
						canonical: "OpenWhispr",
						enabled: true,
					},
				],
			},
		});

		assert.equal(result.ok, false);
		if (result.ok) return;
		assert.equal(result.reason, "No audio detected");
		assert.equal(result.routing.attempts.length, 1);
		assert.equal(result.routing.attempts[0]?.provider, "telomi-audio");
		assert.equal(result.routing.fallback.used, false);
		assert.equal(result.routing.fallback.skipReason, "no-audio");
		assert.equal(requestCount, 1);
		assert.equal(receivedPrompt, "Keywords: OpenWhispr");
	} finally {
		await new Promise<void>((resolve, reject) => {
			server.close((error) => (error ? reject(error) : resolve()));
		});
	}
});
