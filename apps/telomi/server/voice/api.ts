import express, { Router } from "express";
import { loadAudioSettings } from "../audio/providers/settings.js";
import {
  defaultSttConnection,
  warmupStt,
} from "../audio/providers/stt.js";
import {
  isEmptyVoiceRecording,
  MIN_VOICE_AUDIO_BYTES,
} from "../../shared/voice-recording.js";
import { classifyVoiceTranscriptionFailure } from "../../shared/voice-history-failure.js";
import type { GoalService } from "../goals/service.js";
import { VoiceGlossaryStore } from "./glossary.js";
import {
  extractVoiceCorrections,
  VoiceCorrectionLearningStore,
} from "./correction-learning.js";
import {
  VoiceHistoryStore,
  type VoiceHistoryUserEditInput,
  voiceHistoryAudioDownloadFilename,
} from "./history.js";
import type { VoiceHistoryUserEditUnmeasuredReason } from "../../shared/voice-history.js";
import { parseVoiceMicrophoneRequestHeaders } from "./microphone-evidence.js";
import {
  isVoiceSessionId,
  isVoiceUtteranceId,
} from "../../shared/voice-stt.js";
import {
  runVoiceTranscriptionPipeline,
  type VoiceTranscriptionPipelineInput,
  type VoiceTranscriptionPipelineResult,
} from "./transcription-pipeline.js";
import { VoiceUtteranceContextStore } from "./utterance-context.js";
import {
  getAudioLocalRuntimeManager,
  type AudioLocalRuntimeManager,
} from "../audio/local-runtime.js";
import { toErrorMessage } from "../lib/values.js";

const MAX_AUDIO_BYTES = 50 * 1024 * 1024;
const MAX_UNDO_CORRECTIONS = 100;

export interface VoiceRouterDependencies {
  runTranscriptionPipeline?: (
    input: VoiceTranscriptionPipelineInput,
  ) => Promise<VoiceTranscriptionPipelineResult>;
}

export function createVoiceRouter(
  goals: GoalService,
  workspaceDir: string,
  localAudio = getAudioLocalRuntimeManager(),
  dependencies: VoiceRouterDependencies = {},
): Router {
  const router = Router();
  const glossary = new VoiceGlossaryStore(workspaceDir);
  const correctionLearning = new VoiceCorrectionLearningStore(workspaceDir);
  const history = new VoiceHistoryStore(workspaceDir);
  const utteranceContexts = new VoiceUtteranceContextStore(workspaceDir);
  const retryingHistoryIds = new Set<string>();
  const transcribeVoice =
    dependencies.runTranscriptionPipeline ?? runVoiceTranscriptionPipeline;

  router.post("/api/goals/:goalId/voice/context-snapshots", (req, res) => {
    if (!goals.getGoal(req.params.goalId)) {
      res.status(404).json({ error: "Unknown goal" });
      return;
    }
    try {
      const snapshot = utteranceContexts.capture();
      const audio = loadAudioSettings();
      res.status(201).json({
        contextSnapshotId: snapshot.id,
        capturedAt: snapshot.capturedAt,
        languagePreference: snapshot.languagePreference,
        languageHint: snapshot.languageHint ?? null,
        glossaryRevision: snapshot.glossary.revision,
        glossaryEntryCount: snapshot.glossary.entries.filter(
          (entry) => entry.enabled,
        ).length,
        vad: snapshot.vad,
        cleanup: snapshot.cleanup,
        recording: {
          audioCuesEnabled: audio.audioCuesEnabled ?? true,
        },
      });
    } catch (error) {
      res.status(500).json({
        error: toErrorMessage(error),
      });
    }
  });

  router.post("/api/goals/:goalId/voice/warmup", async (req, res) => {
    if (!goals.getGoal(req.params.goalId)) {
      res.status(404).json({ error: "Unknown goal" });
      return;
    }
    try {
      await localAudio.prepare(defaultSttConnection());
    } catch (error) {
      res.status(503).json({
        status: "unavailable",
        error: toErrorMessage(error),
        runtime: localAudio.status(),
      });
      return;
    }

    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort("local ASR warmup timed out"),
      45_000,
    );
    const abortOnDisconnect = () =>
      controller.abort("warmup client disconnected");
    req.once("aborted", abortOnDisconnect);
    try {
      const result = await warmupStt({
        signal: controller.signal,
      });
      if (!result.ok) {
        res.status(503).json({
          status: "unavailable",
          error: result.reason,
        });
        return;
      }
      // An endpoint that does not advertise warmup loads its model on the first transcription.
      if (!result.advertised) {
        res.json({ status: "skipped", reason: "stt_warmup_not_advertised" });
        return;
      }
      res.json({
        status: "ready",
        provider: result.provider,
        model: result.model,
        readyBeforeRequest: result.readyBeforeRequest,
        warmupDurationMs: result.durationMs,
        requestDurationMs: result.requestDurationMs,
        ttlSec: result.ttlSec,
      });
    } finally {
      clearTimeout(timeout);
      req.off("aborted", abortOnDisconnect);
    }
  });

  router.get("/api/voice/glossary", (_req, res) => {
    res.json(glossary.getSnapshot());
  });

  router.put("/api/voice/glossary", (req, res) => {
    try {
      const entries =
        req.body && typeof req.body === "object"
          ? (req.body as { entries?: unknown }).entries
          : undefined;
      res.json(glossary.replace(entries));
    } catch (error) {
      res.status(400).json({
        error: toErrorMessage(error),
      });
    }
  });

  router.get("/api/voice/correction-learning", (_req, res) => {
    res.json(correctionLearning.getSettings());
  });

  router.put("/api/voice/correction-learning", (req, res) => {
    const enabled =
      req.body && typeof req.body === "object"
        ? (req.body as { enabled?: unknown }).enabled
        : undefined;
    if (typeof enabled !== "boolean") {
      res.status(400).json({ error: "enabled must be a boolean" });
      return;
    }
    res.json(correctionLearning.setEnabled(enabled));
  });

  router.post("/api/voice/correction-learning/observe", (req, res) => {
    const body =
      req.body && typeof req.body === "object"
        ? (req.body as {
            originalText?: unknown;
            editedText?: unknown;
          })
        : {};
    if (
      typeof body.originalText !== "string" ||
      typeof body.editedText !== "string"
    ) {
      res
        .status(400)
        .json({ error: "originalText and editedText must be strings" });
      return;
    }
    const settings = correctionLearning.getSettings();
    if (!settings.enabled) {
      res.json({ ...settings, corrections: [], glossaryRevision: null });
      return;
    }
    const snapshot = glossary.getSnapshot();
    const corrections = extractVoiceCorrections(
      body.originalText,
      body.editedText,
      snapshot.entries.map((entry) => entry.canonical),
    );
    const learned = glossary.learnCanonicalTerms(corrections);
    res.json({
      ...settings,
      corrections: learned.learned,
      glossaryRevision: learned.snapshot.revision,
    });
  });

  router.post("/api/voice/correction-learning/undo", (req, res) => {
    const corrections =
      req.body && typeof req.body === "object"
        ? (req.body as { corrections?: unknown }).corrections
        : undefined;
    if (
      !Array.isArray(corrections) ||
      corrections.length === 0 ||
      corrections.length > MAX_UNDO_CORRECTIONS ||
      corrections.some(
        (value) => typeof value !== "string" || value.trim().length === 0,
      )
    ) {
      res.status(400).json({
        error: `corrections must contain 1 to ${MAX_UNDO_CORRECTIONS} non-empty strings`,
      });
      return;
    }

    const result = glossary.undoLearnedCanonicalTerms(corrections as string[]);
    res.json({
      removed: result.removed,
      glossaryRevision: result.snapshot.revision,
    });
  });

  router.get("/api/voice/history", (req, res) => {
    const limit =
      typeof req.query.limit === "string"
        ? Number.parseInt(req.query.limit, 10)
        : undefined;
    res.json(
      history.getSnapshot(limit, {
        includeDiscarded: parseFlag(req.query.includeDiscarded),
      }),
    );
  });

  router.get("/api/voice/history/settings", (_req, res) => {
    res.json(history.getSettings());
  });

  router.post("/api/voice/history/:id/user-edit", (req, res) => {
    const body =
      req.body && typeof req.body === "object" && !Array.isArray(req.body)
        ? (req.body as Record<string, unknown>)
        : {};
    try {
      let input: VoiceHistoryUserEditInput;
      if (body.outcome === "measured") {
        if (typeof body.editedText !== "string") {
          throw new Error("editedText must be a string");
        }
        input = {
          outcome: "measured",
          editedText: body.editedText,
          elapsedMs: body.elapsedMs as number,
        };
      } else if (body.outcome === "unmeasured") {
        if (typeof body.reason !== "string") {
          throw new Error("reason must be a string");
        }
        input = {
          outcome: "unmeasured",
          reason: body.reason as VoiceHistoryUserEditUnmeasuredReason,
          elapsedMs: body.elapsedMs as number,
        };
      } else {
        throw new Error("outcome must be measured or unmeasured");
      }
      const updated = history.recordUserEdit(req.params.id, input);
      res.json({ id: updated.id, userEdit: updated.userEdit });
    } catch (error) {
      const message = toErrorMessage(error);
      const status =
        message === "Voice history entry not found"
          ? 404
          : message === "Voice history user edit is already recorded" ||
              message ===
                "Only a completed transcription can record a user edit"
            ? 409
            : 400;
      res.status(status).json({ error: message });
    }
  });

  router.put("/api/voice/history/settings", (req, res) => {
    try {
      const body =
        req.body && typeof req.body === "object"
          ? (req.body as {
              dataRetentionEnabled?: unknown;
              audioRetentionDays?: unknown;
              saveDiscardedTranscriptions?: unknown;
            })
          : {};
      res.json(history.updateSettings(body));
    } catch (error) {
      res.status(400).json({
        error: toErrorMessage(error),
      });
    }
  });

  router.delete("/api/voice/history", (_req, res) => {
    res.json(history.clear());
  });

  router.get("/api/voice/history/:id/audio", (req, res) => {
    try {
      const audio = history.readAudio(req.params.id);
      if (!audio) {
        res.status(404).json({ error: "Audio is unavailable for this entry" });
        return;
      }
      res.setHeader("Content-Type", audio.mime);
      res.setHeader("Content-Length", audio.buffer.length);
      res.setHeader("Cache-Control", "private, no-store");
      res.setHeader("X-Content-Type-Options", "nosniff");
      if (req.query.download === "1") {
        res.setHeader(
          "Content-Disposition",
          `attachment; filename="${voiceHistoryAudioDownloadFilename(req.params.id, audio.mime)}"`,
        );
      }
      res.end(audio.buffer);
    } catch (error) {
      res.status(400).json({
        error: toErrorMessage(error),
      });
    }
  });

  router.delete("/api/voice/history/:id", (req, res) => {
    try {
      const deleted = history.delete(req.params.id);
      if (!deleted) {
        res.status(404).json({ error: "Voice history entry not found" });
        return;
      }
      res.json({ deleted: true, id: req.params.id });
    } catch (error) {
      res.status(400).json({
        error: toErrorMessage(error),
      });
    }
  });

  router.post("/api/voice/history/:id/retry", async (req, res) => {
    const id = req.params.id;
    let entry;
    try {
      entry = history.getEntry(id);
    } catch (error) {
      res.status(400).json({
        error: toErrorMessage(error),
      });
      return;
    }
    if (!entry) {
      res.status(404).json({ error: "Voice history entry not found" });
      return;
    }
    if (retryingHistoryIds.has(id)) {
      res.status(409).json({ error: "This transcription is already retrying" });
      return;
    }
    const audio = history.readAudio(id);
    if (!audio) {
      res.status(409).json({ error: "The retained audio is unavailable" });
      return;
    }

    let retryContext;
    let language: string | undefined;
    let cleanupRequested = false;
    let cleanupModelId: string | undefined;
    let cleanupInstructions: string | undefined;
    try {
      const requestedContextId = req.query.contextSnapshotId;
      if (
        requestedContextId !== undefined &&
        typeof requestedContextId !== "string"
      ) {
        throw new Error("contextSnapshotId must be a string");
      }
      if (requestedContextId) {
        retryContext = utteranceContexts.require(requestedContextId);
      } else {
        // The entry's own context is preferred; a retry without one inherits
        // what the entry recorded and fills the rest from current settings.
        const previousContext = entry.contextSnapshotId
          ? utteranceContexts.get(entry.contextSnapshotId)
          : null;
        const inheritedLanguage = previousContext?.languageHint;
        retryContext = utteranceContexts.capture({
          ...(inheritedLanguage ? { languageHint: inheritedLanguage } : {}),
          cleanup: {
            enabled: entry.cleanup.requested,
            modelId: entry.cleanup.modelId,
            instructions:
              previousContext?.cleanup.instructions ??
              loadAudioSettings().sttCleanupInstructions,
          },
        });
      }
      language = retryContext.languageHint;
      cleanupRequested = retryContext.cleanup.enabled;
      cleanupModelId = retryContext.cleanup.modelId;
      cleanupInstructions = retryContext.cleanup.instructions;
    } catch (error) {
      res.status(409).json({
        error: toErrorMessage(error),
        code: "voice_context_unavailable",
      });
      return;
    }
    retryingHistoryIds.add(id);
    try {
      await prepareLocalAudio(localAudio);
      const result = await transcribeVoice({
        buffer: audio.buffer,
        mime: audio.mime,
        language,
        languagePreference: retryContext.languagePreference,
        speech: retryContext.speech,
        cleanupRequested,
        cleanupModelId,
        cleanupInstructions,
        glossary: retryContext.glossary,
        vad: retryContext.vad,
      });
      if (!result.ok) {
        const errorCode = classifyVoiceTranscriptionFailure(
          result.provider,
          result.reason,
        );
        const updated = history.applyRetry(id, {
          status: "failed",
          provider: result.provider,
          errorMessage: result.reason,
          ...(errorCode ? { errorCode } : {}),
          contextSnapshotId: retryContext.id,
          cleanup: {
            requested: cleanupRequested,
            applied: false,
          },
          routing: result.routing,
        });
        res.status(502).json({
          error: result.reason,
          routing: result.routing,
          entry: updated,
        });
        return;
      }
      const updated = history.applyRetry(id, {
        status: "completed",
        text: result.text,
        rawText: result.rawText,
        canonicalText: result.canonicalText,
        provider: result.provider,
        contextSnapshotId: retryContext.id,
        model: result.model,
        language: result.language,
        durationSec: result.durationSec,
        glossaryRevision: result.glossary.revision,
        cleanup: toHistoryCleanup(cleanupRequested, result.cleanup),
        routing: result.routing,
      });
      res.json({ routing: result.routing, entry: updated });
    } catch (error) {
      const message = toErrorMessage(error);
      const failureProvider = defaultSttConnection();
      const errorCode = classifyVoiceTranscriptionFailure(
        failureProvider,
        message,
      );
      const updated = history.applyRetry(id, {
        status: "failed",
        provider: failureProvider,
        errorMessage: message,
        ...(errorCode ? { errorCode } : {}),
        contextSnapshotId: retryContext.id,
        cleanup: {
          requested: cleanupRequested,
          applied: false,
        },
      });
      res.status(502).json({ error: message, entry: updated });
    } finally {
      retryingHistoryIds.delete(id);
    }
  });

  router.post(
    "/api/goals/:goalId/voice/discarded",
    express.raw({ type: "audio/*", limit: MAX_AUDIO_BYTES }),
    (req, res) => {
      const goal = goals.getGoal(req.params.goalId);
      if (!goal) {
        res.status(404).json({ error: "Unknown goal" });
        return;
      }
      const buffer = req.body as Buffer | undefined;
      if (
        !buffer ||
        !Buffer.isBuffer(buffer) ||
        isEmptyVoiceRecording(buffer.length)
      ) {
        res.status(400).json({
          error: `Recording must contain at least ${MIN_VOICE_AUDIO_BYTES} bytes of audio data.`,
          code: "empty_recording",
        });
        return;
      }
      const durationMs =
        typeof req.query.durationMs === "string"
          ? Number(req.query.durationMs)
          : Number.NaN;
      let voiceIdentity: VoiceRequestIdentity;
      try {
        voiceIdentity = parseVoiceRequestIdentity(req.query);
      } catch (error) {
        res.status(400).json({
          error: toErrorMessage(error),
          code: "invalid_voice_identity",
        });
        return;
      }
      const mime = req.headers["content-type"] || "audio/webm";
      const microphone = parseVoiceMicrophoneRequestHeaders(req.headers);
      let discardedContext;
      try {
        const requestedContextId = req.query.contextSnapshotId;
        if (
          requestedContextId !== undefined &&
          typeof requestedContextId !== "string"
        ) {
          throw new Error("contextSnapshotId must be a string");
        }
        discardedContext = requestedContextId
          ? utteranceContexts.require(requestedContextId)
          : undefined;
      } catch (error) {
        res.status(409).json({
          error: toErrorMessage(error),
          code: "voice_context_unavailable",
        });
        return;
      }
      try {
        const saved = history.recordDiscarded({
          goalId: req.params.goalId,
          ...voiceIdentity,
          mime,
          audio: buffer,
          durationMs,
          text: "",
          rawText: "",
          canonicalText: "",
          ...(discardedContext
            ? {
                contextSnapshotId: discardedContext.id,
                glossaryRevision: discardedContext.glossary.revision,
              }
            : {}),
          cleanup: { requested: false, applied: false },
          ...(microphone ? { microphone } : {}),
        });
        res.status(saved.saved ? 201 : 200).json(publicHistoryResult(saved));
      } catch (error) {
        res.status(500).json({
          error: toErrorMessage(error),
        });
      }
    },
  );

  router.post(
    "/api/goals/:goalId/voice/transcribe",
    express.raw({ type: "audio/*", limit: MAX_AUDIO_BYTES }),
    async (req, res) => {
      const goal = goals.getGoal(req.params.goalId);
      if (!goal) {
        res.status(404).json({ error: "Unknown goal" });
        return;
      }
      const buffer = req.body as Buffer | undefined;
      if (
        !buffer ||
        !Buffer.isBuffer(buffer) ||
        isEmptyVoiceRecording(buffer.length)
      ) {
        res.status(400).json({
          error: `Recording must contain at least ${MIN_VOICE_AUDIO_BYTES} bytes of audio data.`,
          code: "empty_recording",
        });
        return;
      }
      const mime = req.headers["content-type"] || "audio/webm";
      const microphone = parseVoiceMicrophoneRequestHeaders(req.headers);
      let voiceIdentity: VoiceRequestIdentity;
      try {
        voiceIdentity = parseVoiceRequestIdentity(req.query);
      } catch (error) {
        res.status(400).json({
          error: toErrorMessage(error),
          code: "invalid_voice_identity",
        });
        return;
      }
      let utteranceContext;
      try {
        const requestedContextId = req.query.contextSnapshotId;
        if (
          requestedContextId !== undefined &&
          typeof requestedContextId !== "string"
        ) {
          throw new Error("contextSnapshotId must be a string");
        }
        // A request without a snapshot freezes the current settings now.
        utteranceContext = requestedContextId
          ? utteranceContexts.require(requestedContextId)
          : utteranceContexts.capture();
      } catch (error) {
        res.status(409).json({
          error: toErrorMessage(error),
          code: "voice_context_unavailable",
        });
        return;
      }
      const language = utteranceContext.languageHint;
      const wantCleanup = utteranceContext.cleanup.enabled;
      const cleanupModelId = utteranceContext.cleanup.modelId;
      const cleanupInstructions = utteranceContext.cleanup.instructions;
      const glossarySnapshot = utteranceContext.glossary;
      // The browser drops the request when the user cancels after stopping the recording.
      const cancelled = new AbortController();
      const cancelOnDisconnect = () => {
        if (!res.writableFinished) cancelled.abort("voice transcription cancelled by the client");
      };
      res.once("close", cancelOnDisconnect);
      // A cancelled utterance is a discard, kept under the same rules as a cancel during recording.
      const recordCancelled = () => {
        try {
          history.recordDiscarded({
            goalId: req.params.goalId,
            ...voiceIdentity,
            mime,
            audio: buffer,
            durationMs:
              typeof req.query.durationMs === "string"
                ? Number(req.query.durationMs)
                : Number.NaN,
            text: "",
            rawText: "",
            canonicalText: "",
            contextSnapshotId: utteranceContext.id,
            glossaryRevision: glossarySnapshot.revision,
            cleanup: { requested: false, applied: false },
            ...(microphone ? { microphone } : {}),
          });
        } catch (error) {
          console.warn(
            `[telomi][voice-history] failed to record cancelled transcription: ${
              toErrorMessage(error)
            }`,
          );
        }
      };

      try {
        await prepareLocalAudio(localAudio);
        const result = await transcribeVoice({
          buffer,
          mime,
          language,
          languagePreference: utteranceContext.languagePreference,
          speech: utteranceContext.speech,
          cleanupRequested: wantCleanup,
          cleanupModelId,
          cleanupInstructions,
          glossary: glossarySnapshot,
          vad: utteranceContext.vad,
          signal: cancelled.signal,
        });
        if (cancelled.signal.aborted) {
          recordCancelled();
          return;
        }
        if (!result.ok) {
          const errorCode = classifyVoiceTranscriptionFailure(
            result.provider,
            result.reason,
          );
          const saved = safeRecordHistory(history, {
            goalId: req.params.goalId,
            ...voiceIdentity,
            status: "failed",
            provider: result.provider,
            language,
            mime,
            audio: buffer,
            errorMessage: result.reason,
            ...(errorCode ? { errorCode } : {}),
            contextSnapshotId: utteranceContext.id,
            glossaryRevision: glossarySnapshot.revision,
            cleanup: {
              requested: wantCleanup,
              applied: false,
            },
            routing: result.routing,
            ...(microphone ? { microphone } : {}),
          });
          res.status(502).json({
            error: result.reason,
            provider: result.provider,
            contextSnapshotId: utteranceContext.id,
            routing: result.routing,
            history: publicHistoryResult(saved),
          });
          return;
        }
        const saved = safeRecordHistory(history, {
          goalId: req.params.goalId,
          ...voiceIdentity,
          status: "completed",
          text: result.text,
          rawText: result.rawText,
          canonicalText: result.canonicalText,
          provider: result.provider,
          model: result.model,
          language: result.language,
          durationSec: result.durationSec,
          mime,
          audio: buffer,
          contextSnapshotId: utteranceContext.id,
          glossaryRevision: result.glossary.revision,
          cleanup: toHistoryCleanup(wantCleanup, result.cleanup),
          routing: result.routing,
          ...(microphone ? { microphone } : {}),
        });

        res.json({
          ...voiceIdentity,
          provider: result.provider,
          contextSnapshotId: utteranceContext.id,
          model: result.model,
          language: result.language,
          durationSec: result.durationSec,
          text: result.text,
          rawText: result.rawText,
          canonicalText: result.canonicalText,
          scriptNormalization: result.scriptNormalization,
          glossary: result.glossary,
          cleanup: toHistoryCleanup(wantCleanup, result.cleanup),
          segments: result.segments,
          routing: result.routing,
          history: publicHistoryResult(saved),
        });
      } catch (error) {
        if (cancelled.signal.aborted) {
          recordCancelled();
          return;
        }
        const message = toErrorMessage(error);
        const failureProvider = defaultSttConnection();
        const errorCode = classifyVoiceTranscriptionFailure(
          failureProvider,
          message,
        );
        const saved = safeRecordHistory(history, {
          goalId: req.params.goalId,
          ...voiceIdentity,
          status: "failed",
          provider: failureProvider,
          language,
          mime,
          audio: buffer,
          errorMessage: message,
          ...(errorCode ? { errorCode } : {}),
          contextSnapshotId: utteranceContext.id,
          glossaryRevision: glossarySnapshot.revision,
          cleanup: {
            requested: wantCleanup,
            applied: false,
          },
          ...(microphone ? { microphone } : {}),
        });
        res.status(502).json({
          error: message,
          provider: failureProvider,
          contextSnapshotId: utteranceContext.id,
          history: publicHistoryResult(saved),
        });
      } finally {
        res.off("close", cancelOnDisconnect);
      }
    },
  );

  return router;
}

async function prepareLocalAudio(localAudio: AudioLocalRuntimeManager): Promise<void> {
  try {
    await localAudio.prepare(defaultSttConnection());
  } catch (error) {
    console.warn(
      `[telomi][voice] local audio runtime preparation failed: ${toErrorMessage(error)}`,
    );
  }
}

function parseFlag(value: unknown): boolean {
  if (value === undefined) return false;
  if (Array.isArray(value)) return value.some(parseFlag);
  const s = String(value).trim().toLowerCase();
  return s === "1" || s === "true" || s === "yes" || s === "on";
}

function safeRecordHistory(
  history: VoiceHistoryStore,
  input: Parameters<VoiceHistoryStore["record"]>[0],
): ReturnType<VoiceHistoryStore["record"]> {
  try {
    return history.record(input);
  } catch (error) {
    console.warn(
      `[telomi][voice-history] failed to record transcription: ${
        toErrorMessage(error)
      }`,
    );
    return { saved: false };
  }
}

interface VoiceRequestIdentity {
  sessionId?: string;
  utteranceId?: string;
}

function parseVoiceRequestIdentity(
  query: Record<string, unknown>,
): VoiceRequestIdentity {
  const sessionId = query.sessionId;
  const utteranceId = query.utteranceId;
  if (sessionId === undefined && utteranceId === undefined) return {};
  if (!isVoiceSessionId(sessionId) || !isVoiceUtteranceId(utteranceId)) {
    throw new Error(
      "sessionId and utteranceId must be valid strings when either is provided",
    );
  }
  return { sessionId, utteranceId };
}

function publicHistoryResult(result: ReturnType<VoiceHistoryStore["record"]>): {
  saved: boolean;
  id?: string;
  hasAudio?: boolean;
} {
  return {
    saved: result.saved,
    ...(result.entry
      ? { id: result.entry.id, hasAudio: result.entry.hasAudio }
      : {}),
  };
}

function toHistoryCleanup(
  requested: boolean,
  cleanup: {
    applied: boolean;
    modelId?: string;
    durationMs?: number;
    reason?: string;
  },
): {
  requested: boolean;
  applied: boolean;
  modelId?: string;
  durationMs?: number;
  reason?: string;
} {
  return {
    requested,
    applied: cleanup.applied,
    ...(cleanup.modelId ? { modelId: cleanup.modelId } : {}),
    ...(cleanup.durationMs !== undefined
      ? { durationMs: cleanup.durationMs }
      : {}),
    ...(cleanup.reason ? { reason: cleanup.reason } : {}),
  };
}
