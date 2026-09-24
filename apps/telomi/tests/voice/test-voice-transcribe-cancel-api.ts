import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import express from "express";
import type { GoalService } from "../../server/goals/service.js";
import { createVoiceRouter } from "../../server/voice/api.js";
import { VoiceHistoryStore } from "../../server/voice/history.js";
import type { VoiceTranscriptionPipelineResult } from "../../server/voice/transcription-pipeline.js";

const COMPLETED: VoiceTranscriptionPipelineResult = {
  ok: true,
  provider: "telomi-audio",
  text: "cancelled words",
  rawText: "cancelled words",
  canonicalText: "cancelled words",
  scriptNormalization: { text: "cancelled words", preference: null, profile: null, applied: false, changed: false },
  cleanedText: "cancelled words",
  glossary: { revision: "r", entryCount: 0, promptApplied: false },
  cleanup: { applied: false },
  segments: [],
  routing: {
    primaryProvider: "telomi-audio",
    fallback: { enabled: false, eligible: false, used: false, skipReason: "disabled" },
    attempts: [],
  },
};

async function cancelDuringTranscription(saveDiscardedTranscriptions: boolean) {
  const workspace = mkdtempSync(join(tmpdir(), "telomi-voice-transcribe-cancel-"));
  const history = new VoiceHistoryStore(workspace);
  history.updateSettings({ dataRetentionEnabled: true, audioRetentionDays: 30, saveDiscardedTranscriptions });
  const goals = { getGoal: (id: string) => (id === "goal-cancel" ? { id } : undefined) } as unknown as GoalService;
  let started!: () => void;
  const pipelineStarted = new Promise<void>((resolve) => { started = resolve; });
  let finished!: (aborted: boolean) => void;
  const pipelineFinished = new Promise<boolean>((resolve) => { finished = resolve; });
  const app = express();
  app.use(createVoiceRouter(goals, workspace, {} as never, {
    // The upstream answers anyway after the user cancels; the route must still not keep it.
    runTranscriptionPipeline: async (input) => {
      started();
      // Bounded, so a route that never propagates the cancellation fails instead of hanging.
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 2_000);
        input.signal?.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
      });
      finished(input.signal?.aborted === true);
      return COMPLETED;
    },
  }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const client = new AbortController();
    const request = fetch(
      `http://127.0.0.1:${address.port}/api/goals/goal-cancel/voice/transcribe?sessionId=sess_cancel&utteranceId=utt_cancel&durationMs=3000`,
      { method: "POST", headers: { "Content-Type": "audio/webm" }, body: Buffer.alloc(512, 1), signal: client.signal },
    ).catch((error: unknown) => error);
    await pipelineStarted;
    client.abort();
    assert.equal((await request as Error).name, "AbortError");
    assert.equal(await pipelineFinished, true, "the pipeline receives the cancellation");
    // History is written right after the pipeline settles.
    await new Promise<void>((resolve) => setImmediate(resolve));
    return history.getSnapshot(undefined, { includeDiscarded: true }).entries;
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(workspace, { recursive: true, force: true });
  }
}

test("cancelling during transcription keeps the recording only as a discarded entry", async () => {
  const entries = await cancelDuringTranscription(true);
  assert.equal(entries.length, 1);
  assert.equal(entries[0]!.status, "discarded");
  assert.equal(entries[0]!.provider, "not-transcribed");
  assert.equal(entries[0]!.text, "");
  assert.equal(entries[0]!.utteranceId, "utt_cancel");
  assert.equal(entries[0]!.hasAudio, true);
});

test("cancelling during transcription records nothing when discarded recordings are not kept", async () => {
  assert.deepEqual(await cancelDuringTranscription(false), []);
});
