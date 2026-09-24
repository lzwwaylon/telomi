import { sttProtocolForConnection } from "../audio/registry.js";
import { resolveSpeechConfiguration } from "./configuration.js";
import type { SpeechExecutionConfiguration } from "../../shared/speech-configuration.js";
import { transcribe } from "../audio/providers/stt.js";
import type { TranscriptSegment } from "../audio/types.js";
import {
  normalizeVoiceVadConfig,
  type VoiceVadConfig,
  type VoiceVadMetadata,
} from "../audio/voice-vad.js";
import type {
  VoiceGlossaryEntry,
  VoiceGlossarySnapshot,
} from "../../shared/voice-stt.js";
import { evaluateVoiceRecording } from "../../shared/voice-recording.js";
import type { VoiceSttRoutingMeta } from "../../shared/voice-stt-routing.js";
import { cleanup as cleanupTranscript } from "./cleanup.js";
import {
  normalizeVoiceTranscriptScript,
  type VoiceChineseScriptNormalization,
} from "./chinese-script.js";
import { rejectDictionaryEcho } from "./dictionary-echo.js";
import {
  buildGlossaryPrompt,
  selectVoicePromptTerms,
} from "./glossary.js";
import { runVoiceSttRoute } from "./transcription-routing.js";

export interface VoiceTranscriptionPipelineInput {
  speech?: SpeechExecutionConfiguration;
  buffer: Buffer;
  mime: string;
  language?: string;
  languagePreference?: string;
  cleanupRequested: boolean;
  cleanupModelId?: string;
  cleanupInstructions?: string;
  glossary: VoiceGlossarySnapshot;
  vad?: VoiceVadConfig;
  /** Aborts recognition and cleanup once the caller no longer wants the result. */
  signal?: AbortSignal;
}

export type VoiceTranscriptionPipelineResult =
  | {
      ok: false;
      provider: string;
      reason: string;
      routing: VoiceSttRoutingMeta;
    }
  | {
      ok: true;
      provider: string;
      model?: string;
      language?: string;
      durationSec?: number;
      text: string;
      rawText: string;
      canonicalText: string;
      scriptNormalization: VoiceChineseScriptNormalization;
      cleanedText: string;
      glossary: {
        revision: string;
        entryCount: number;
        promptApplied: boolean;
      };
      cleanup: VoiceCleanupMeta;
      segments: TranscriptSegment[];
      vad?: VoiceVadMetadata;
      routing: VoiceSttRoutingMeta;
    };

export type VoiceCleanupMeta =
  | { applied: false; modelId?: string; reason?: string }
  | { applied: true; modelId: string; durationMs: number };

export interface VoiceTranscriptionPipelineDependencies {
  transcribe?: typeof transcribe;
  cleanup?: typeof cleanupTranscript;
}

export async function runVoiceTranscriptionPipeline(
  input: VoiceTranscriptionPipelineInput,
  dependencies: VoiceTranscriptionPipelineDependencies = {},
): Promise<VoiceTranscriptionPipelineResult> {
  const transcribeAudio = dependencies.transcribe ?? transcribe;
  const cleanupAudioText = dependencies.cleanup ?? cleanupTranscript;
  const glossaryPrompt = buildGlossaryPrompt(input.glossary.entries);
  const speech = input.speech ?? resolveSpeechConfiguration();
  const vad = normalizeVoiceVadConfig(input.vad);
  const recordingValidation = evaluateVoiceRecording({
    blobSize: input.buffer.length,
    receivedAudioData: input.buffer.length > 0,
  });
  const route = await runVoiceSttRoute(
    {
      request: {
        buffer: input.buffer,
        // Without a chosen model the transcription reports what the user has to choose.
        selection: speech.recognition,
        model: speech.recognition?.model,
        mime: input.mime,
        language: input.language,
        filename: filenameFromMime(input.mime),
        prompt: glossaryPrompt,
        vad,
        signal: input.signal,
      },
      primaryProvider: speech.recognition?.connection ?? "stt",
      fallback: speech.fallback
        ? {
            enabled: true,
            // History and telemetry keep the transport label.
            provider: sttProtocolForConnection(speech.fallback.connection) === "openrouter-transcription"
              ? "openrouter-stt"
              : "openai-whisper",
            selection: speech.fallback,
            model: speech.fallback.model,
          }
        : { enabled: false },
      ...(recordingValidation.usable
        ? {}
        : {
            preflightFailure:
              "No audio detected: recording container has no audio frames",
          }),
    },
    async (request) =>
      rejectDictionaryEcho(
        await transcribeAudio(request),
        glossaryPrompt?.replace(/^Keywords:\s*/, ""),
      ),
  );
  const result = route.result;
  if (!result.ok) {
    return {
      ok: false,
      provider: result.provider,
      reason: result.reason,
      routing: route.routing,
    };
  }

  const scriptNormalization = normalizeVoiceTranscriptScript(
    result.text,
    input.languagePreference,
  );
  const canonicalText = scriptNormalization.text;
  let cleanedText = canonicalText;
  let cleanupMeta: VoiceCleanupMeta = { applied: false };
  if (input.cleanupRequested && canonicalText.trim() && !input.signal?.aborted) {
    const cleanupResult = await cleanupAudioText({
      text: canonicalText,
		language: result.language ?? input.language,
      modelId: input.cleanupModelId?.trim() || speech.cleanupModel,
      connectionBaseUrl: speech.cleanupBaseUrl,
      customDictionary: selectVoicePromptTerms(input.glossary.entries),
      customInstructions: input.cleanupInstructions,
      signal: input.signal,
    });
    if (cleanupResult.ok) {
      cleanedText = cleanupResult.text;
      cleanupMeta = {
        applied: true,
        modelId: cleanupResult.modelId,
        durationMs: cleanupResult.durationMs,
      };
    } else {
      cleanupMeta = {
        applied: false,
        modelId: cleanupResult.modelId,
        reason: cleanupResult.reason,
      };
    }
  }

  return {
    ok: true,
    provider: result.provider,
    model: result.model,
    language: result.language ?? input.language,
    durationSec: result.durationSec,
    text: cleanedText,
    rawText: result.text,
    canonicalText,
    scriptNormalization,
    cleanedText,
    glossary: {
      revision: input.glossary.revision,
      entryCount: enabledGlossaryEntryCount(input.glossary.entries),
      promptApplied:
        Boolean(glossaryPrompt) &&
        connectionSupportsGlossaryPrompt(result.provider),
    },
    cleanup: cleanupMeta,
    segments: result.segments,
    ...(result.vad ? { vad: result.vad } : {}),
    routing: route.routing,
  };
}

function enabledGlossaryEntryCount(entries: VoiceGlossaryEntry[]): number {
  return entries.filter((entry) => entry.enabled).length;
}

function connectionSupportsGlossaryPrompt(connection: string): boolean {
  // The JSON transcription contract has no prompt field.
  return sttProtocolForConnection(connection) !== "openrouter-transcription";
}

function filenameFromMime(mime: string): string {
  const lower = mime.toLowerCase();
  if (lower.includes("webm")) return "audio.webm";
  if (lower.includes("ogg")) return "audio.ogg";
  if (lower.includes("wav")) return "audio.wav";
  if (lower.includes("mpeg") || lower.includes("mp3")) return "audio.mp3";
  if (lower.includes("mp4") || lower.includes("m4a") || lower.includes("aac")) {
    return "audio.m4a";
  }
  if (lower.includes("flac")) return "audio.flac";
  return "audio.bin";
}
