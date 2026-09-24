import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import ffmpegPath from "ffmpeg-static";
import type {
  StreamingTranscriptionAdapter,
  StreamingTranscriptionCallbacks,
} from "./streaming-transcription-adapter.js";

export type VoiceSpeechOnsetMethod =
  "human-auditory" | "waveform-spectrogram-reviewed";

export interface VoiceSpeechOnsetAnnotation {
  startMs: number;
  method: VoiceSpeechOnsetMethod;
  note: string;
}

export interface VoiceFirstPartialEvidence {
  provider: string;
  model: string;
  mode: "cumulative-snapshot";
  text: string;
  sampleRate: number;
  snapshotSeconds: number;
  replayChunkMs: number;
  audioSentSec: number;
  speechOnset?: VoiceSpeechOnsetAnnotation;
}

export interface VoiceFirstPartialMeasurement {
  firstPartialMs: number;
  speechStartToFirstPartialMs?: number;
  evidence: VoiceFirstPartialEvidence;
}

export type FirstPartialAdapterFactory = (
  callbacks: StreamingTranscriptionCallbacks,
) => StreamingTranscriptionAdapter;

interface MeasureLocalSnapshotFirstPartialOptions {
  pcm: Buffer;
  sampleRate: number;
  snapshotSeconds: number;
  replayChunkMs: number;
  speechOnset?: VoiceSpeechOnsetAnnotation;
  settleTimeoutMs?: number;
  adapterFactory: FirstPartialAdapterFactory;
  now?: () => number;
  sleep?: (durationMs: number) => Promise<void>;
}

/**
 * Replay decoded PCM at wall-clock cadence until the production snapshot
 * Adapter emits its first visible, non-empty partial.
 *
 * Adapter readiness happens before the clock starts. This deliberately measures
 * warm ready-state first-partial latency. Decode, model installation and model
 * warmup are separate metrics and cannot silently enter this distribution.
 */
export async function measureLocalSnapshotFirstPartial(
  options: MeasureLocalSnapshotFirstPartialOptions,
): Promise<VoiceFirstPartialMeasurement> {
  validateMeasurementOptions(options);
  const now = options.now ?? performance.now.bind(performance);
  const sleep = options.sleep ?? defaultSleep;
  const settleTimeoutMs = options.settleTimeoutMs ?? 30_000;
  if (
    !Number.isFinite(settleTimeoutMs) ||
    settleTimeoutMs < 1 ||
    settleTimeoutMs > 120_000
  ) {
    throw new Error("first-partial settle timeout must be 1 to 120000 ms");
  }

  let partialText: string | undefined;
  let firstPartialMs: number | undefined;
  let audioSentBytes = 0;
  let providerError: Error | undefined;
  let startedAt: number | undefined;
  let notifyEvent!: () => void;
  const event = new Promise<void>((resolve) => {
    notifyEvent = resolve;
  });
  const adapter = options.adapterFactory({
    onPartial: (text) => {
      const normalized = text.trim();
      if (!normalized || partialText !== undefined || startedAt === undefined)
        return;
      partialText = normalized;
      firstPartialMs = roundMilliseconds(now() - startedAt);
      notifyEvent();
    },
    onError: (error) => {
      if (providerError || partialText !== undefined) return;
      providerError = error;
      notifyEvent();
    },
  });

  try {
    await adapter.connect();
    startedAt = now();
    const bytesPerSecond = options.sampleRate * 2;
    const requestedChunkBytes = Math.round(
      (bytesPerSecond * options.replayChunkMs) / 1_000,
    );
    const chunkBytes = Math.max(
      2,
      requestedChunkBytes - (requestedChunkBytes % 2),
    );

    for (let offset = 0; offset < options.pcm.length; offset += chunkBytes) {
      const chunk = options.pcm.subarray(
        offset,
        Math.min(options.pcm.length, offset + chunkBytes),
      );
      audioSentBytes += chunk.length;
      if (!adapter.sendAudio(chunk)) {
        throw new Error("first-partial Adapter rejected audio after readiness");
      }
      if (providerError) throw providerError;
      if (partialText !== undefined && firstPartialMs !== undefined) {
        return measurementResult({
          adapter,
          partialText,
          firstPartialMs,
          audioSentBytes,
          options,
        });
      }

      const replayDeadline =
        startedAt + (audioSentBytes / bytesPerSecond) * 1_000;
      await sleep(Math.max(0, replayDeadline - now()));
      if (providerError) throw providerError;
      if (partialText !== undefined && firstPartialMs !== undefined) {
        return measurementResult({
          adapter,
          partialText,
          firstPartialMs,
          audioSentBytes,
          options,
        });
      }
    }

    await Promise.race([event, sleep(settleTimeoutMs)]);
    if (providerError) throw providerError;
    if (partialText === undefined || firstPartialMs === undefined) {
      throw new Error(
        `no first partial was produced after ${roundSeconds(audioSentBytes / (options.sampleRate * 2))} seconds of audio`,
      );
    }
    return measurementResult({
      adapter,
      partialText,
      firstPartialMs,
      audioSentBytes,
      options,
    });
  } finally {
    adapter.close();
  }
}

export function decodeEvaluationAudioToPcm16(
  audio: Buffer,
  sampleRate = 16_000,
): Buffer {
  if (audio.length === 0) throw new Error("evaluation audio is empty");
  if (audio.length > 128 * 1024 * 1024) {
    throw new Error("evaluation audio exceeds 128 MiB");
  }
  if (
    !Number.isSafeInteger(sampleRate) ||
    sampleRate < 8_000 ||
    sampleRate > 96_000
  ) {
    throw new Error("evaluation PCM sample rate must be 8000 to 96000 Hz");
  }
  const result = spawnSync(
    resolveEvaluationFfmpegCommand(),
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      "pipe:0",
      "-f",
      "s16le",
      "-acodec",
      "pcm_s16le",
      "-ac",
      "1",
      "-ar",
      String(sampleRate),
      "pipe:1",
    ],
    {
      input: audio,
      maxBuffer: 256 * 1024 * 1024,
      timeout: 60_000,
    },
  );
  if (result.error) {
    throw new Error(`ffmpeg decode failed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(
      `ffmpeg decode failed: ${result.stderr.toString("utf8").trim()}`,
    );
  }
  const evenLength = result.stdout.length - (result.stdout.length % 2);
  if (evenLength === 0) throw new Error("ffmpeg decoded no PCM samples");
  return Buffer.from(result.stdout.subarray(0, evenLength));
}

export function resolveEvaluationFfmpegCommand(
  staticPath: string | null = ffmpegPath,
  fileExists: (path: string) => boolean = existsSync,
): string {
  return staticPath && fileExists(staticPath) ? staticPath : "ffmpeg";
}

function validateMeasurementOptions(
  options: MeasureLocalSnapshotFirstPartialOptions,
): void {
  if (options.pcm.length === 0) throw new Error("first-partial PCM is empty");
  if (options.pcm.length % 2 !== 0) {
    throw new Error("first-partial PCM must contain complete int16 samples");
  }
  if (
    !Number.isSafeInteger(options.sampleRate) ||
    options.sampleRate < 8_000 ||
    options.sampleRate > 96_000
  ) {
    throw new Error("first-partial sample rate must be 8000 to 96000 Hz");
  }
  if (
    !Number.isFinite(options.snapshotSeconds) ||
    options.snapshotSeconds < 0.1 ||
    options.snapshotSeconds > 30
  ) {
    throw new Error("first-partial snapshot window must be 0.1 to 30 seconds");
  }
  if (
    !Number.isFinite(options.replayChunkMs) ||
    options.replayChunkMs < 5 ||
    options.replayChunkMs > 1_000
  ) {
    throw new Error("first-partial replay chunk must be 5 to 1000 ms");
  }
  if (options.speechOnset) {
    const audioDurationMs =
      (options.pcm.length / (options.sampleRate * 2)) * 1_000;
    if (
      !Number.isFinite(options.speechOnset.startMs) ||
      options.speechOnset.startMs < 0 ||
      options.speechOnset.startMs >= audioDurationMs ||
      (options.speechOnset.method !== "human-auditory" &&
        options.speechOnset.method !== "waveform-spectrogram-reviewed") ||
      !options.speechOnset.note.trim()
    ) {
      throw new Error("first-partial speech-onset annotation is invalid");
    }
  }
}

function measurementResult(input: {
  adapter: StreamingTranscriptionAdapter;
  partialText: string;
  firstPartialMs: number;
  audioSentBytes: number;
  options: MeasureLocalSnapshotFirstPartialOptions;
}): VoiceFirstPartialMeasurement {
  const speechStartToFirstPartialMs = input.options.speechOnset
    ? roundMilliseconds(
        input.firstPartialMs - input.options.speechOnset.startMs,
      )
    : undefined;
  if (
    speechStartToFirstPartialMs !== undefined &&
    speechStartToFirstPartialMs < 0
  ) {
    throw new Error("first partial arrived before the annotated speech onset");
  }
  return {
    firstPartialMs: input.firstPartialMs,
    ...(speechStartToFirstPartialMs === undefined
      ? {}
      : { speechStartToFirstPartialMs }),
    evidence: {
      provider: input.adapter.provider,
      model: input.adapter.model,
      mode: "cumulative-snapshot",
      text: input.partialText,
      sampleRate: input.options.sampleRate,
      snapshotSeconds: input.options.snapshotSeconds,
      replayChunkMs: input.options.replayChunkMs,
      audioSentSec: roundSeconds(
        input.audioSentBytes / (input.options.sampleRate * 2),
      ),
      ...(input.options.speechOnset
        ? { speechOnset: input.options.speechOnset }
        : {}),
    },
  };
}

function defaultSleep(durationMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, durationMs));
}

function roundMilliseconds(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}

function roundSeconds(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}
