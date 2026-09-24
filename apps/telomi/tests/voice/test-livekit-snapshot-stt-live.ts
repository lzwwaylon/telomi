import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { resolve } from "node:path";
import { initializeLogger, stt } from "@livekit/agents";
import * as silero from "@livekit/agents-plugin-silero";
import { AudioFrame } from "@livekit/rtc-node";
import { LiveKitSnapshotSTT } from "../../server/voice/livekit-snapshot-stt.js";
import { TelomiVoiceInputSTT } from "../../server/voice/livekit-voice-input-stt.js";
import { LiveKitGoalClient } from "../../server/voice/livekit-goal-client.js";
import { resolveLiveKitVoiceConfig } from "../../server/voice/livekit-config.js";
import { resolveSpeechConfiguration } from "../../server/voice/configuration.js";

import { requireAudioFixture } from "./audio-fixture.js";

const fixturePath = resolve(
	process.argv[2] || "voice-evals/generated/v1/aishell-white-noise-5db.wav",
);
const goalId = process.argv[3]?.trim();
if (!goalId) throw new Error("Usage: npm run test:voice-realtime-stt-live -- <pcm-wav> <goal-id>; configure recognition in Telomi settings");
await requireAudioFixture(fixturePath);
const pcm = extractPcm16(await readFile(fixturePath));
const speech = resolveSpeechConfiguration();
const config = resolveLiveKitVoiceConfig();
// Match the browser entry point: start and warm the configured service before feeding audio.
const warmup = await fetch(`${config.telomiUrl}/api/goals/${encodeURIComponent(goalId)}/voice/warmup`, { method: "POST" });
assert.ok(warmup.ok, `Voice warmup failed: HTTP ${warmup.status}`);
initializeLogger({ pretty: false, level: "info" });
const vad = await silero.VAD.load({ minSilenceDuration: 350 });
const finalizer = new TelomiVoiceInputSTT(goalId, new LiveKitGoalClient(config), "zh");
const provider = new LiveKitSnapshotSTT({
	model: speech.local.model,
	vad,
	language: "zh",
	finalizer,
	onPreviewError: (error) => {
		metrics.previewError = error.message;
	},
});
const stream = provider.stream();
const frameSamples = 320;
const startedAt = performance.now();
const metrics: Record<string, number | string> = {
	fixture: fixturePath,
	audioDurationMs: Math.round((pcm.length / 16_000) * 1_000),
};

const eventsTask = (async () => {
	for await (const event of stream) {
		const elapsedMs = Math.round(performance.now() - startedAt);
		const text = event.alternatives?.[0]?.text;
		switch (event.type) {
			case stt.SpeechEventType.START_OF_SPEECH:
				metrics.speechStartMs = elapsedMs;
				break;
			case stt.SpeechEventType.INTERIM_TRANSCRIPT:
				if (metrics.firstPartialMs === undefined) {
					metrics.firstPartialMs = elapsedMs;
					metrics.firstPartialText = text || "";
				}
				break;
			case stt.SpeechEventType.END_OF_SPEECH:
				metrics.speechEndMs = elapsedMs;
				break;
			case stt.SpeechEventType.FINAL_TRANSCRIPT:
				metrics.finalMs = elapsedMs;
				metrics.finalText = text || "";
				return;
		}
	}
})();

for (let offset = 0; offset < pcm.length; offset += frameSamples) {
	const samples = new Int16Array(frameSamples);
	samples.set(pcm.subarray(offset, offset + frameSamples));
	stream.pushFrame(new AudioFrame(samples, 16_000, 1, frameSamples));
	await delay(20);
}
for (let index = 0; index < 30; index += 1) {
	stream.pushFrame(
		new AudioFrame(new Int16Array(frameSamples), 16_000, 1, frameSamples),
	);
	await delay(20);
}
await eventsTask;
stream.close();
await provider.close();
await vad.close();
console.log(JSON.stringify(metrics, null, 2));
assert.equal(metrics.previewError, undefined, "snapshot preview must not fail");
assert.ok(typeof metrics.finalText === "string" && metrics.finalText.trim(), "final transcription must not be empty");

function extractPcm16(wav: Buffer): Int16Array {
	if (wav.toString("ascii", 0, 4) !== "RIFF") {
		throw new Error("live realtime STT fixture must be a PCM WAV file");
	}
	let offset = 12;
	while (offset + 8 <= wav.length) {
		const chunk = wav.toString("ascii", offset, offset + 4);
		const size = wav.readUInt32LE(offset + 4);
		if (chunk === "data") {
			return new Int16Array(
				wav.buffer,
				wav.byteOffset + offset + 8,
				Math.floor(size / 2),
			);
		}
		offset += 8 + size + (size % 2);
	}
	throw new Error("live realtime STT fixture has no PCM data chunk");
}

function delay(milliseconds: number): Promise<void> {
	return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}
