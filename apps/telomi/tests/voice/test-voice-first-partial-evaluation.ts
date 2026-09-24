import assert from "node:assert/strict";
import test from "node:test";
import {
  decodeEvaluationAudioToPcm16,
  measureLocalSnapshotFirstPartial,
  resolveEvaluationFfmpegCommand,
  type FirstPartialAdapterFactory,
} from "../../server/voice/evaluation-first-partial.js";
import { pcm16MonoToWav } from "../../server/voice/local-snapshot-transcription.js";

test("first-partial evaluation replays PCM at a deterministic real-time cadence", async () => {
  let clock = 1_000;
  let closed = 0;
  let sentBytes = 0;
  const adapterFactory: FirstPartialAdapterFactory = (callbacks) => ({
    provider: "telomi-audio-local-snapshot",
    model: "test-qwen",
    async connect() {},
    sendAudio(bytes) {
      sentBytes += bytes.length;
      if (sentBytes >= 640) callbacks.onPartial?.("  首个结果  ");
      return true;
    },
    async finish() {
      return "";
    },
    cancel() {},
    close() {
      closed += 1;
    },
  });

  const result = await measureLocalSnapshotFirstPartial({
    pcm: Buffer.alloc(3_200),
    sampleRate: 8_000,
    snapshotSeconds: 2,
    replayChunkMs: 20,
    speechOnset: {
      startMs: 5,
      method: "waveform-spectrogram-reviewed",
      note: "Test annotation",
    },
    settleTimeoutMs: 1_000,
    adapterFactory,
    now: () => clock,
    sleep: async (durationMs) => {
      clock += durationMs;
    },
  });

  assert.equal(result.firstPartialMs, 20);
  assert.equal(result.speechStartToFirstPartialMs, 15);
  assert.deepEqual(result.evidence, {
    provider: "telomi-audio-local-snapshot",
    model: "test-qwen",
    mode: "cumulative-snapshot",
    text: "首个结果",
    sampleRate: 8_000,
    snapshotSeconds: 2,
    replayChunkMs: 20,
    audioSentSec: 0.04,
    speechOnset: {
      startMs: 5,
      method: "waveform-spectrogram-reviewed",
      note: "Test annotation",
    },
  });
  assert.equal(closed, 1);
});

test("first-partial evaluation fails closed on Provider errors and releases the adapter", async () => {
  let closed = 0;
  const adapterFactory: FirstPartialAdapterFactory = (callbacks) => ({
    provider: "telomi-audio-local-snapshot",
    model: "test-qwen",
    async connect() {},
    sendAudio() {
      callbacks.onError?.(new Error("preview provider failed"));
      return true;
    },
    async finish() {
      return "";
    },
    cancel() {},
    close() {
      closed += 1;
    },
  });

  await assert.rejects(
    measureLocalSnapshotFirstPartial({
      pcm: Buffer.alloc(3_200),
      sampleRate: 8_000,
      snapshotSeconds: 2,
      replayChunkMs: 20,
      settleTimeoutMs: 1_000,
      adapterFactory,
      sleep: async () => {},
    }),
    /preview provider failed/,
  );
  assert.equal(closed, 1);
});

test("first-partial evaluation rejects unusable inputs before constructing an adapter", async () => {
  let factoryCalls = 0;
  await assert.rejects(
    measureLocalSnapshotFirstPartial({
      pcm: Buffer.alloc(0),
      sampleRate: 16_000,
      snapshotSeconds: 2,
      replayChunkMs: 20,
      adapterFactory: () => {
        factoryCalls += 1;
        throw new Error("unreachable");
      },
    }),
    /PCM is empty/,
  );
  assert.equal(factoryCalls, 0);
});

test("evaluation audio decoding falls back when the package-resolved ffmpeg binary disappeared", () => {
  assert.equal(
    resolveEvaluationFfmpegCommand("/managed/ffmpeg", () => true),
    "/managed/ffmpeg",
  );
  assert.equal(
    resolveEvaluationFfmpegCommand("/stale/ffmpeg", () => false),
    "ffmpeg",
  );
  assert.equal(
    resolveEvaluationFfmpegCommand(null, () => false),
    "ffmpeg",
  );
});

test("evaluation audio decoding produces mono 16 kHz PCM outside the latency window", () => {
  const source = new Int16Array([0, 1_000, -1_000, 2_000]);
  const wav = pcm16MonoToWav(Buffer.from(source.buffer), 16_000);
  const pcm = decodeEvaluationAudioToPcm16(wav, 16_000);
  assert.deepEqual(
    [...new Int16Array(pcm.buffer, pcm.byteOffset, pcm.length / 2)],
    [...source],
  );
});
