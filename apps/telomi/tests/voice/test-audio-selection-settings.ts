import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

const data = mkdtempSync(join(tmpdir(), "audio-selection-settings-"));
process.env.TELOMI_DATA_DIR = data;
after(() => rmSync(data, { recursive: true, force: true }));

const { resolveAgentPath } = await import("../../server/config/agent-directory.js");
const { loadSettings } = await import("../../server/config/settings.js");
const { resolveSpeechConfiguration } = await import("../../server/voice/configuration.js");
const { resolveAudioGeneration } = await import("../../server/audio/configuration.js");
const { saveCustomProviders } = await import("../../server/providers/custom-models.js");

const settingsPath = resolveAgentPath("settings.json");
mkdirSync(join(data, ".pi", "agent"), { recursive: true });

test("saved audio selections resolve without rewriting settings", () => {
	saveCustomProviders({ providers: {
		"cloud-stt": { baseUrl: "https://stt.example/v1", api: "openai-completions", capability: "audio-recognition", models: [{ id: "whisper-1" }] },
		"cloud-tts": { baseUrl: "https://tts.example/v1", api: "openai-completions", capability: "audio-generation", models: [{ id: "tts-1" }] },
	} });
	writeFileSync(settingsPath, JSON.stringify({
		speechRecognition: {
			default: { connection: "telomi-audio", model: "Qwen3-ASR-0.6B-MLX-4bit" },
			recognition: { connection: "cloud-stt", model: "whisper-1" },
			cleanupEnabled: false, cleanupInstructions: "",
		},
		audioGeneration: {
			default: { connection: "telomi-audio", model: "Qwen3-TTS-12Hz-0.6B-CustomVoice-8bit", voice: "vivian", rate: 1 },
			podcast: { connection: "cloud-tts", model: "tts-1", voice: "alloy", rate: 1.2 },
		},
		pendingSpeechRecognition: {
			default: { connection: "cloud-stt", model: "whisper-1" },
			cleanupEnabled: false, cleanupInstructions: "",
		},
	}, null, 2));

	const persisted = readFileSync(settingsPath, "utf8");
	const speech = resolveSpeechConfiguration();
	assert.deepEqual(
		[speech.recognition.connection, speech.recognition.model, speech.local.connection, speech.local.model],
		["cloud-stt", "whisper-1", "telomi-audio", "Qwen3-ASR-0.6B-MLX-4bit"],
	);
	const podcast = resolveAudioGeneration("podcast");
	assert.deepEqual([podcast.connection, podcast.model, podcast.voice, podcast.rate], ["cloud-tts", "tts-1", "alloy", 1.2]);
	const playback = resolveAudioGeneration("playback");
	assert.deepEqual([playback.connection, playback.model, playback.voice], ["telomi-audio", "Qwen3-TTS-12Hz-0.6B-CustomVoice-8bit", "vivian"]);

	assert.equal(loadSettings().pendingSpeechRecognition?.default.connection, "cloud-stt");
	loadSettings();
	assert.equal(readFileSync(settingsPath, "utf8"), persisted, "reading configuration has no write side effects");
});

test("settings without audio selections are left untouched", () => {
	const original = JSON.stringify({ defaultProvider: "openai", defaultModel: "gpt-5" }, null, 2);
	writeFileSync(settingsPath, original);
	assert.equal(loadSettings().defaultProvider, "openai");
	assert.equal(readFileSync(settingsPath, "utf8"), original);
});
