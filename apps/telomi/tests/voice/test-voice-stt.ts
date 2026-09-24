import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { audioEnv } from "../../server/audio/environment.js";
import { STT_PROTOCOLS, TTS_PROTOCOLS } from "../../server/audio/registry.js";
import {
	DEFAULT_VOICE_VAD_CONFIG,
	isNormalizedVoiceVadConfig,
	normalizeVoiceVadConfig,
} from "../../server/audio/voice-vad.js";
import {
	VOICE_STREAM_PROTOCOL_VERSION,
	parseVoiceStreamClientMessage,
	parseVoiceStreamServerMessage,
} from "../../shared/voice-stt.js";
import {
	normalizeVoiceLanguagePreference,
	VOICE_LANGUAGE_OPTIONS,
	voiceLanguageHint,
} from "../../shared/voice-languages.js";
import {
	buildGlossaryPrompt,
	VoiceGlossaryStore,
} from "../../server/voice/glossary.js";
import {
	LocalSnapshotTranscriptionAdapter,
	pcm16HasSpeech,
	pcm16MonoToWav,
} from "../../server/voice/local-snapshot-transcription.js";
import {
	createLocalSpeechGateState,
	getLocalSpeechGateDecision,
	recordLocalSpeechWindow,
} from "../../web/src/features/voice/localSpeechGate.js";
import { measurePcm16Window } from "../../web/src/features/voice/pcm.js";

test("audio protocol lists name only wire protocols and the Telomi namespace is read", () => {
	assert.deepEqual([...STT_PROTOCOLS], ["openai-transcription", "openrouter-transcription"]);
	assert.deepEqual([...TTS_PROTOCOLS], ["openai-speech"]);
	assert.equal(
		audioEnv("STT_BASE_URL", {
			TELOMI_AUDIO_STT_BASE_URL: "current",
		}),
		"current",
	);
});

test("voice stream protocol accepts only bounded start messages", () => {
	assert.equal(VOICE_STREAM_PROTOCOL_VERSION, 2);
	assert.deepEqual(
		parseVoiceStreamClientMessage({
			type: "start",
			protocolVersion: VOICE_STREAM_PROTOCOL_VERSION,
			sessionId: "session_123",
			utteranceId: "utterance_123",
			sampleRate: 24_000,
			language: "zh-CN",
			delay: "medium",
		}),
		{
			type: "start",
			protocolVersion: VOICE_STREAM_PROTOCOL_VERSION,
			sessionId: "session_123",
			utteranceId: "utterance_123",
			sampleRate: 24_000,
			language: "zh-CN",
			delay: "medium",
		},
	);
	assert.equal(parseVoiceStreamClientMessage({ type: "start", sampleRate: 24_000 }), null);
	assert.equal(
		parseVoiceStreamClientMessage({
			type: "start",
			protocolVersion: VOICE_STREAM_PROTOCOL_VERSION,
			utteranceId: "utterance_123",
			sampleRate: 24_000,
		}),
		null,
	);
	assert.equal(
		parseVoiceStreamClientMessage({
			type: "start",
			protocolVersion: VOICE_STREAM_PROTOCOL_VERSION,
			sessionId: "../escape",
			utteranceId: "utterance_123",
			sampleRate: 24_000,
		}),
		null,
	);
	assert.equal(
		parseVoiceStreamClientMessage({
			type: "start",
			protocolVersion: VOICE_STREAM_PROTOCOL_VERSION,
			sessionId: "session_123",
			utteranceId: "../escape",
			sampleRate: 24_000,
		}),
		null,
	);
	assert.deepEqual(
		parseVoiceStreamClientMessage({
			type: "finish",
			sessionId: "session_123",
			utteranceId: "utterance_123",
		}),
		{
			type: "finish",
			sessionId: "session_123",
			utteranceId: "utterance_123",
		},
	);
	assert.deepEqual(
		parseVoiceStreamClientMessage({
			type: "cancel",
			sessionId: "session_123",
			utteranceId: "utterance_123",
		}),
		{
			type: "cancel",
			sessionId: "session_123",
			utteranceId: "utterance_123",
		},
	);
	assert.equal(
		parseVoiceStreamClientMessage({
			type: "finish",
			utteranceId: "utterance_123",
		}),
		null,
	);
});

test("voice stream events require one ordered session envelope", () => {
	assert.deepEqual(
		parseVoiceStreamServerMessage({
			type: "partial",
			sessionId: "session_123",
			sequence: 3,
			occurredAt: "2026-07-24T12:00:00.000Z",
			causationId: "utterance_123",
			utteranceId: "utterance_123",
			revision: 2,
			text: "MFlow",
			provider: "telomi-audio-local-snapshot",
			model: "Qwen3-ASR",
		}),
		{
			type: "partial",
			sessionId: "session_123",
			sequence: 3,
			occurredAt: "2026-07-24T12:00:00.000Z",
			causationId: "utterance_123",
			utteranceId: "utterance_123",
			revision: 2,
			text: "MFlow",
			provider: "telomi-audio-local-snapshot",
			model: "Qwen3-ASR",
		},
	);
	assert.equal(
		parseVoiceStreamServerMessage({
			type: "partial",
			utteranceId: "utterance_123",
			revision: 2,
			text: "MFlow",
			provider: "telomi-audio-local-snapshot",
			model: "Qwen3-ASR",
		}),
		null,
	);
	assert.equal(
		parseVoiceStreamServerMessage({
			type: "partial",
			sessionId: "session_123",
			sequence: 0,
			occurredAt: "not-a-date",
			causationId: "utterance_123",
			utteranceId: "utterance_123",
			revision: 2,
			text: "MFlow",
			provider: "telomi-audio-local-snapshot",
			model: "Qwen3-ASR",
		}),
		null,
	);
});

test("voice language preference retains OpenWhispr registry and base-code behavior", () => {
	assert.equal(VOICE_LANGUAGE_OPTIONS.length, 61);
	assert.equal(normalizeVoiceLanguagePreference("zh-CN"), "zh-CN");
	assert.equal(normalizeVoiceLanguagePreference("not-a-language"), "auto");
	assert.equal(voiceLanguageHint("auto"), undefined);
	assert.equal(voiceLanguageHint("zh-CN"), "zh");
	assert.equal(voiceLanguageHint("en-GB"), "en");
	assert.equal(voiceLanguageHint("ja"), "ja");
});

test("local VAD defaults and sanitizer retain the pinned OpenWhispr contract", () => {
	assert.deepEqual(normalizeVoiceVadConfig(undefined), DEFAULT_VOICE_VAD_CONFIG);
	assert.deepEqual(
		normalizeVoiceVadConfig({
			enabled: true,
			threshold: 99,
			minSpeechDurationMs: -1,
			minSilenceDurationMs: "bad",
			maxSpeechDurationS: 0,
			speechPadMs: null,
			samplesOverlap: -2,
		}),
		{
			enabled: true,
			threshold: 0.95,
			minSpeechDurationMs: 50,
			minSilenceDurationMs: 200,
			maxSpeechDurationS: 5,
			speechPadMs: 100,
			samplesOverlap: 0,
		},
	);
	assert.equal(isNormalizedVoiceVadConfig(DEFAULT_VOICE_VAD_CONFIG), true);
	assert.equal(
		isNormalizedVoiceVadConfig({
			...DEFAULT_VOICE_VAD_CONFIG,
			unsignedExtraField: true,
		}),
		false,
	);
});

test("local speech gate retains OpenWhispr silence and speech behavior", () => {
	const silent = createLocalSpeechGateState();
	recordLocalSpeechWindow(silent, 0.0012, 0.01);
	recordLocalSpeechWindow(silent, 0.0016, 0.015);
	assert.deepEqual(getLocalSpeechGateDecision(silent), {
		skip: true,
		reason: "silence",
		peakRms: 0.0016,
		peakAmplitude: 0.015,
		windowCount: 2,
		speechWindowCount: 0,
		maxConsecutiveSpeechWindows: 0,
	});

	const speech = createLocalSpeechGateState();
	recordLocalSpeechWindow(speech, 0.003, 0.025);
	recordLocalSpeechWindow(speech, 0.0061, 0.065);
	assert.equal(getLocalSpeechGateDecision(speech).skip, false);
	assert.deepEqual(getLocalSpeechGateDecision(createLocalSpeechGateState()), {
		skip: false,
		reason: "unavailable",
	});
});

test("PCM metrics are normalized for speech gate thresholds", () => {
	const silence = measurePcm16Window(new Int16Array([0, 0, 0]));
	assert.deepEqual(silence, { rms: 0, peak: 0 });
	const fullScale = measurePcm16Window(new Int16Array([32_767, -32_768]));
	assert.ok(fullScale.rms > 0.99);
	assert.equal(fullScale.peak, 1);
});

test("local snapshot adapter sends glossary-guided PCM WAV and returns a full hypothesis", async () => {
	const pcm = Buffer.alloc(640);
	pcm.writeInt16LE(1_200, 0);
	let ready = false;
	let transcribeCalls = 0;
	let capturedPrompt: string | undefined;
	let capturedWav: Buffer | undefined;
	let capturedVad: unknown;
	let warmupCalls = 0;
	const lifecycle: string[] = [];
	let adapter!: LocalSnapshotTranscriptionAdapter;
	const partial = new Promise<string>((resolve) => {
		adapter = new LocalSnapshotTranscriptionAdapter({
			inputSampleRate: 16_000,
			language: "en",
			prompt: "Keywords: MFlow",
			vad: { ...DEFAULT_VOICE_VAD_CONFIG, enabled: true },
			model: "test-local-asr",
			snapshotSeconds: 0.02,
			warmup: async (request) => {
				warmupCalls += 1;
				lifecycle.push("warmup");
				assert.equal(request.model, "test-local-asr");
				assert.equal(request.signal?.aborted, false);
				return {
					ok: true,
					provider: "telomi-audio",
					model: "test-local-asr",
					advertised: true,
					readyBeforeRequest: false,
					durationMs: 25,
					requestDurationMs: 30,
					ttlSec: 1_800,
				};
			},
			transcribe: async (request) => {
				transcribeCalls += 1;
				capturedPrompt = request.prompt;
				capturedWav = request.buffer;
				capturedVad = request.vad;
				return {
					ok: true,
					provider: "telomi-audio",
					model: "test-local-asr",
					text: "MFlow organizes knowledge",
				};
			},
			callbacks: {
				onReady: (readiness) => {
					ready = true;
					lifecycle.push("ready");
					assert.equal(readiness?.readyBeforeRequest, false);
					assert.equal(readiness?.warmupDurationMs, 25);
				},
				onPartial: resolve,
			},
		});

		void adapter.connect().then(() => {
			assert.equal(adapter.sendAudio(pcm), true);
		});
	});

	assert.equal(await partial, "MFlow organizes knowledge");
	assert.equal(ready, true);
	assert.equal(warmupCalls, 1);
	assert.deepEqual(lifecycle, ["warmup", "ready"]);
	assert.equal(capturedPrompt, "Keywords: MFlow");
	assert.deepEqual(capturedVad, { ...DEFAULT_VOICE_VAD_CONFIG, enabled: true });
	assert.equal(capturedWav?.subarray(0, 4).toString("ascii"), "RIFF");
	assert.equal(capturedWav?.readUInt32LE(24), 16_000);
	assert.equal(capturedWav?.readUInt32LE(40), pcm.length);
	assert.equal(capturedWav?.subarray(44).equals(pcm), true);
	assert.equal(transcribeCalls, 1);

	adapter.sendAudio(Buffer.alloc(640));
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(transcribeCalls, 1, "silence should not trigger another local snapshot");
	adapter.close();
});

test("local snapshot adapter separates first preview latency from later cadence", async () => {
	const speech = Buffer.alloc(640);
	speech.writeInt16LE(2_000, 0);
	let transcribeCalls = 0;
	const adapter = new LocalSnapshotTranscriptionAdapter({
		inputSampleRate: 16_000,
		snapshotSeconds: 0.02,
		snapshotIntervalSeconds: 0.04,
		warmup: async () => ({
			ok: true,
			provider: "telomi-audio",
			model: "test-local-asr",
			advertised: true,
			readyBeforeRequest: true,
			durationMs: 0,
			requestDurationMs: 0,
			ttlSec: 1_800,
		}),
		transcribe: async () => {
			transcribeCalls += 1;
			return {
				ok: true,
				provider: "telomi-audio",
				model: "test-local-asr",
				text: `preview-${transcribeCalls}`,
			};
		},
	});

	await adapter.connect();
	adapter.sendAudio(speech);
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(transcribeCalls, 1);

	adapter.sendAudio(speech);
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(transcribeCalls, 1);

	adapter.sendAudio(speech);
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(transcribeCalls, 2);
	adapter.close();
});

test("closing a local snapshot adapter aborts an in-flight ASR warmup", async () => {
	let signal: AbortSignal | undefined;
	let release!: () => void;
	const waiting = new Promise<void>((resolve) => {
		release = resolve;
	});
	const adapter = new LocalSnapshotTranscriptionAdapter({
		inputSampleRate: 16_000,
		model: "test-local-asr",
		warmupTimeoutMs: 5_000,
		warmup: async (request) => {
			signal = request.signal;
			await waiting;
			return {
				ok: false,
				provider: "telomi-audio",
				reason: "aborted",
			};
		},
	});

	const connecting = adapter.connect();
	await new Promise<void>((resolve) => setImmediate(resolve));
	adapter.close();
	assert.equal(signal?.aborted, true);
	release();
	await assert.rejects(connecting, /aborted/);
});

test("PCM WAV encoder drops an incomplete final sample", () => {
	const wav = pcm16MonoToWav(Buffer.from([1, 2, 3]), 24_000);
	assert.equal(wav.length, 46);
	assert.equal(wav.readUInt32LE(4), 38);
	assert.equal(wav.readUInt32LE(28), 48_000);
	assert.equal(wav.readUInt16LE(34), 16);
	assert.deepEqual([...wav.subarray(44)], [1, 2]);
});

test("local snapshot speech gate ignores silence between spoken revisions", () => {
	assert.equal(pcm16HasSpeech(Buffer.alloc(640)), false);
	const quiet = Buffer.alloc(640);
	quiet.writeInt16LE(100, 0);
	assert.equal(pcm16HasSpeech(quiet), false);
	const speech = Buffer.alloc(640);
	speech.writeInt16LE(2_000, 0);
	assert.equal(pcm16HasSpeech(speech), true);
});

test("glossary store keeps the provenance the settings page writes", () => {
	const root = mkdtempSync(join(tmpdir(), "telomi-voice-glossary-"));
	try {
		const saved = new VoiceGlossaryStore(root).replace([
			{ canonical: "Kubernetes", source: "manual" },
			{ canonical: "Sinead", source: "learned" },
			{ canonical: "Telomi", source: "imported" },
			{ canonical: "Legacy", source: "unknown" },
		]);
		assert.deepEqual(saved.entries.map((entry) => entry.source), ["manual", "learned", "imported", undefined]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("glossary store keeps canonical terms and ignores legacy aliases", () => {
	const root = mkdtempSync(join(tmpdir(), "telomi-voice-glossary-"));
	try {
		const store = new VoiceGlossaryStore(root);
		const empty = store.getSnapshot();
		assert.equal(empty.entries.length, 0);
		assert.equal(empty.updatedAt, null);

		const saved = store.replace([
			{
				canonical: "Telomi",
				aliases: ["pie mom", "派猫"],
				language: "zh-CN",
			},
			{
				canonical: "OpenWhispr",
				aliases: ["open whisper"],
			},
		]);
		assert.equal(saved.entries.length, 2);
		assert.ok(saved.entries[0]!.id.startsWith("term_"));
		assert.equal(store.getSnapshot().revision, saved.revision);
		assert.equal("aliases" in saved.entries[0]!, false);
		assert.equal("aliases" in saved.entries[1]!, false);
		assert.equal(buildGlossaryPrompt(saved.entries), "Keywords: Telomi, OpenWhispr");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
