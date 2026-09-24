import assert from "node:assert/strict";
import test from "node:test";
import type {
	ProviderResult,
	TranscriptResult,
} from "../../server/audio/types.js";
import type { TranscribeRequest } from "../../server/audio/providers/stt.js";
import { runVoiceTranscriptionPipeline } from "../../server/voice/transcription-pipeline.js";
import { runVoiceSttRoute } from "../../server/voice/transcription-routing.js";

const LOCAL = { connection: "telomi-audio", model: "local-asr", baseUrl: "http://127.0.0.1:9595/v1" };
const CLOUD = { connection: "openrouter", model: "openai/gpt-4o-mini-transcribe", baseUrl: "https://openrouter.ai/api/v1" };

/** An attempt is identified by the connection it runs through, the way production identifies it. */
const request: TranscribeRequest = {
	buffer: Buffer.from("real-audio-bytes"),
	filename: "audio.wav",
	mime: "audio/wav",
	language: "en",
	prompt: "Keywords: MFlow",
	selection: LOCAL,
};

function isLocalAttempt(input: TranscribeRequest): boolean {
	return input.selection?.connection === LOCAL.connection;
}

function success(
	provider: string,
	text = "MFlow organizes knowledge",
	model = "test-model",
): ProviderResult<TranscriptResult> {
	return {
		ok: true,
		provider,
		model,
		text,
		language: "en",
		durationSec: 1.5,
		segments: [{ start: 0, end: 1.5, text }],
	};
}

test("cloud fallback is privacy-off by default", async () => {
	const calls: TranscribeRequest[] = [];
	const routed = await runVoiceSttRoute(
		{
			request,
			primaryProvider: "telomi-audio",
			fallback: { enabled: false },
		},
		async (input) => {
			calls.push(input);
			return {
				ok: false,
				provider: "telomi-audio",
				reason: "local service unavailable",
			};
		},
	);

	assert.equal(routed.result.ok, false);
	assert.equal(calls.length, 1);
	assert.equal(calls[0]?.selection?.connection, "telomi-audio");
	assert.equal(routed.routing.fallback.enabled, false);
	assert.equal(routed.routing.fallback.used, false);
	assert.equal(routed.routing.fallback.skipReason, "disabled");
});

test("explicit local failure fallback preserves audio hints and model", async () => {
	const calls: TranscribeRequest[] = [];
	const routed = await runVoiceSttRoute(
		{
			request,
			primaryProvider: "telomi-audio",
			fallback: {
				enabled: true,
				provider: "openrouter-stt",
				selection: CLOUD,
				model: "openai/gpt-4o-mini-transcribe",
			},
		},
		async (input) => {
			calls.push(input);
			return isLocalAttempt(input)
				? {
						ok: false,
						provider: "telomi-audio",
						reason: "HTTP 503 from local service",
					}
				: success(
						"openrouter-stt",
						"MFlow organizes knowledge",
						input.model,
					);
		},
	);

	assert.equal(routed.result.ok, true);
	assert.equal(routed.result.provider, "openrouter-stt");
	assert.equal(calls.length, 2);
	assert.equal(calls[1]?.buffer, request.buffer);
	assert.equal(calls[1]?.language, "en");
	assert.equal(calls[1]?.prompt, "Keywords: MFlow");
	assert.equal(calls[1]?.model, "openai/gpt-4o-mini-transcribe");
	assert.equal(routed.routing.fallback.eligible, true);
	assert.equal(routed.routing.fallback.used, true);
	assert.deepEqual(
		routed.routing.attempts.map((attempt) => [
			attempt.provider,
			attempt.ok,
		]),
		[
			["telomi-audio", false],
			["openrouter-stt", true],
		],
	);
});

test("silence and empty transcripts never leave the device", async () => {
	for (const localResult of [
		{
			ok: false as const,
			provider: "telomi-audio",
			reason: "No audio detected",
		},
		success("telomi-audio", ""),
	]) {
		let calls = 0;
		const routed = await runVoiceSttRoute(
			{
				request,
				primaryProvider: "telomi-audio",
				fallback: {
					enabled: true,
					provider: "openai-whisper",
					selection: { connection: "openai", model: "whisper-1" },
					model: "whisper-1",
				},
			},
			async () => {
				calls += 1;
				return localResult;
			},
		);
		assert.equal(routed.result.ok, false);
		assert.equal(calls, 1);
		assert.equal(routed.routing.fallback.used, false);
		assert.equal(routed.routing.fallback.skipReason, "no-audio");
	}
});

test("OpenWhispr blank-audio markers never become transcript text or cloud uploads", async () => {
	for (const text of ["[BLANK_AUDIO]", "[ blank_audio ]"]) {
		let calls = 0;
		const routed = await runVoiceSttRoute(
			{
				request,
				primaryProvider: "telomi-audio",
				fallback: {
					enabled: true,
					provider: "openrouter-stt",
					selection: CLOUD,
					model: "openai/gpt-4o-mini-transcribe",
				},
			},
			async (input) => {
				calls += 1;
				return isLocalAttempt(input)
					? success("telomi-audio", text)
					: success("openrouter-stt", "hallucinated cloud text");
			},
		);

		assert.equal(routed.result.ok, false, text);
		if (routed.result.ok) continue;
		assert.equal(routed.result.reason, "No audio detected", text);
		assert.equal(calls, 1, text);
		assert.equal(routed.routing.fallback.used, false, text);
		assert.equal(routed.routing.fallback.skipReason, "no-audio", text);
	}

	const nonMarker = await runVoiceSttRoute(
		{
			request,
			primaryProvider: "telomi-audio",
			fallback: { enabled: false },
		},
		async () => success("telomi-audio", "[BLANK_AUDIO]."),
	);
	assert.equal(nonMarker.result.ok, true);
	if (nonMarker.result.ok) {
		assert.equal(nonMarker.result.text, "[BLANK_AUDIO].");
	}
});

test("cancelled requests never trigger a fallback upload", async () => {
	const controller = new AbortController();
	controller.abort();
	let calls = 0;
	const routed = await runVoiceSttRoute(
		{
			request: { ...request, signal: controller.signal },
			primaryProvider: "telomi-audio",
			fallback: {
				enabled: true,
				provider: "openrouter-stt",
				selection: CLOUD,
			},
		},
		async () => {
			calls += 1;
			return {
				ok: false,
				provider: "telomi-audio",
				reason: "request aborted",
			};
		},
	);
	assert.equal(calls, 1);
	assert.equal(routed.routing.fallback.skipReason, "cancelled");
});

test("a successful local attempt never calls cloud", async () => {
	let calls = 0;
	const routed = await runVoiceSttRoute(
		{
			request,
			primaryProvider: "telomi-audio",
			fallback: {
				enabled: true,
				provider: "openrouter-stt",
				selection: CLOUD,
			},
		},
		async () => {
			calls += 1;
			return success("telomi-audio");
		},
	);
	assert.equal(routed.result.ok, true);
	assert.equal(calls, 1);
	assert.equal(routed.routing.fallback.used, false);
	assert.equal(routed.routing.attempts.length, 1);
});

test("cloud primary failures do not cross-route through fallback policy", async () => {
	let calls = 0;
	const routed = await runVoiceSttRoute(
		{
			request,
			primaryProvider: "openai",
			fallback: {
				enabled: true,
				provider: "openrouter-stt",
				selection: CLOUD,
			},
		},
		async () => {
			calls += 1;
			return {
				ok: false,
				provider: "openai-whisper",
				reason: "HTTP 429",
			};
		},
	);
	assert.equal(calls, 1);
	assert.equal(routed.routing.fallback.eligible, false);
	assert.equal(routed.routing.fallback.used, false);
	assert.equal(routed.routing.fallback.skipReason, "not-local-primary");
});

test("dual failure returns a combined error and both auditable attempts", async () => {
	const routed = await runVoiceSttRoute(
		{
			request,
			primaryProvider: "telomi-audio",
			fallback: {
				enabled: true,
				provider: "openrouter-stt",
				selection: CLOUD,
			},
		},
		async (input) => ({
			ok: false,
			provider: input.selection?.connection ?? "configured-default",
			reason: isLocalAttempt(input) ? "local model crashed" : "cloud rate limited",
		}),
	);
	assert.equal(routed.result.ok, false);
	assert.match(
		routed.result.ok ? "" : routed.result.reason,
		/Local STT failed: local model crashed/,
	);
	assert.match(
		routed.result.ok ? "" : routed.result.reason,
		/Cloud fallback \(openrouter\) also failed: cloud rate limited/,
	);
	assert.equal(routed.routing.attempts.length, 2);
	assert.equal(routed.routing.fallback.used, true);
});


test("production pipeline uses only the explicitly configured fallback model", async () => {
	for (const fallback of [undefined, { ...CLOUD, model: "selected-transcription-model" }]) {
		const calls: TranscribeRequest[] = [];
		const result = await runVoiceTranscriptionPipeline({
			buffer: Buffer.alloc(256),
			mime: "audio/wav",
			cleanupRequested: false,
			glossary: { revision: "test", updatedAt: null, entries: [] },
			speech: {
				recognition: LOCAL,
				local: LOCAL,
				fallback,
				cleanupModel: null,
				cleanupEnabled: false,
				cleanupInstructions: "",
			},
		}, {
			transcribe: async (input) => {
				calls.push(input);
				return isLocalAttempt(input)
					? { ok: false, provider: LOCAL.connection, reason: "local unavailable" }
					: success(CLOUD.connection, "transcribed speech", input.model);
			},
		});
		assert.equal(calls.length, fallback ? 2 : 1);
		assert.equal(result.ok, Boolean(fallback));
		assert.equal(result.routing.fallback.used, Boolean(fallback));
		assert.equal(result.routing.fallback.model, fallback?.model);
		if (fallback) {
			assert.deepEqual(calls[1]?.selection, fallback);
			assert.equal(calls[1]?.model, fallback.model);
		} else {
			assert.equal(result.routing.fallback.provider, undefined);
			assert.equal(result.routing.fallback.skipReason, "disabled");
		}
	}
});
