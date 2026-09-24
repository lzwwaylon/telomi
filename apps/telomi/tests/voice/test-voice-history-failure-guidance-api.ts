import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import express from "express";
import type { GoalService } from "../../server/goals/service.js";
import { createVoiceRouter } from "../../server/voice/api.js";
import { VoiceHistoryStore } from "../../server/voice/history.js";

test("failed transcription persists the classified recovery code in History", async () => {
  const workspace = mkdtempSync(
    join(tmpdir(), "telomi-voice-failure-guidance-api-"),
  );
  let server: ReturnType<ReturnType<typeof express>["listen"]> | undefined;

  try {
    const history = new VoiceHistoryStore(workspace);
    history.updateSettings({
      dataRetentionEnabled: true,
      audioRetentionDays: 30,
    });
    const goals = {
      getGoal: (id: string) => (id === "goal-failure" ? { id } : undefined),
    } as unknown as GoalService;

    const app = express();
    app.use(
      createVoiceRouter(goals, workspace, {} as never, {
        runTranscriptionPipeline: async () => ({
          ok: false,
          provider: "openai-whisper",
          reason: "OPENAI_API_KEY not set",
          routing: {
            primaryProvider: "openai-whisper",
            fallback: {
              enabled: false,
              eligible: false,
              used: false,
              skipReason: "not-local-primary",
            },
            attempts: [
              {
                provider: "openai-whisper",
                ok: false,
                durationMs: 1,
                reason: "OPENAI_API_KEY not set",
              },
            ],
          },
        }),
      }),
    );
    server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server!.once("listening", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const response = await fetch(
      `${baseUrl}/api/goals/goal-failure/voice/transcribe`,
      {
        method: "POST",
        headers: { "Content-Type": "audio/webm" },
        body: Buffer.alloc(512, 1),
      },
    );
    assert.equal(response.status, 502);
    const failure = await response.json();
    assert.equal(failure.history.saved, true);
    assert.match(failure.history.id, /^voice_[a-f0-9]{32}$/);
    assert.equal(failure.history.hasAudio, true);

    const snapshotResponse = await fetch(`${baseUrl}/api/voice/history`);
    assert.equal(snapshotResponse.status, 200);
    const snapshot = await snapshotResponse.json();
    assert.equal(snapshot.entries.length, 1);
    assert.equal(snapshot.entries[0].provider, "openai-whisper");
    assert.equal(snapshot.entries[0].errorCode, "API_KEY_MISSING");
    assert.equal(snapshot.entries[0].hasAudio, true);
  } finally {
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
    }
    rmSync(workspace, { recursive: true, force: true });
  }
});
