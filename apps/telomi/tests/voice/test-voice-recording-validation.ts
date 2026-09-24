import assert from "node:assert/strict";
import test from "node:test";
import {
	evaluateVoiceRecording,
	isEmptyVoiceRecording,
	MIN_VOICE_AUDIO_BYTES,
} from "../../shared/voice-recording.js";
import { runVoiceTranscriptionPipeline } from "../../server/voice/transcription-pipeline.js";

test("recording validation retains OpenWhispr boundary behavior", () => {
	assert.equal(MIN_VOICE_AUDIO_BYTES, 256);
	assert.deepEqual(
		evaluateVoiceRecording({
			blobSize: 50_000,
			receivedAudioData: true,
		}),
		{ usable: true, reason: null },
	);
	assert.deepEqual(
		evaluateVoiceRecording({
			blobSize: 256,
			receivedAudioData: true,
		}),
		{ usable: true, reason: null },
	);
	assert.equal(isEmptyVoiceRecording(256), false);
});

test("recording validation rejects missing chunks before inspecting size", () => {
	assert.deepEqual(
		evaluateVoiceRecording({
			blobSize: 0,
			receivedAudioData: false,
		}),
		{ usable: false, reason: "no-audio-data" },
	);
	assert.deepEqual(evaluateVoiceRecording(), {
		usable: false,
		reason: "no-audio-data",
	});
	assert.deepEqual(evaluateVoiceRecording({}), {
		usable: false,
		reason: "no-audio-data",
	});
});

test("recording validation rejects header-only and invalid sizes", () => {
	for (const blobSize of [110, 255, undefined, Number.NaN, Number.POSITIVE_INFINITY]) {
		assert.deepEqual(
			evaluateVoiceRecording({
				blobSize,
				receivedAudioData: true,
			}),
			{ usable: false, reason: "empty-container" },
		);
	}
	assert.equal(isEmptyVoiceRecording(255), true);
});

test("production pipeline rejects a tiny container without calling a Provider", async () => {
	const result = await runVoiceTranscriptionPipeline({
		buffer: Buffer.alloc(110),
		mime: "audio/webm;codecs=opus",
		language: "en",
		cleanupRequested: false,
		glossary: {
			revision: "recording-validation-glossary",
			updatedAt: null,
			entries: [],
		},
	});

	assert.equal(result.ok, false);
	if (result.ok) return;
	assert.match(result.reason, /No audio detected/);
	assert.equal(result.routing.attempts.length, 0);
	assert.equal(result.routing.fallback.used, false);
	assert.equal(result.routing.fallback.skipReason, "no-audio");
});
