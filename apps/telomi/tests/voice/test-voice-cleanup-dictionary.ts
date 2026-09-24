import assert from "node:assert/strict";
import test from "node:test";
import type { CleanupRequest } from "../../server/voice/cleanup.js";
import { runVoiceTranscriptionPipeline } from "../../server/voice/transcription-pipeline.js";

test("batch cleanup receives the enabled glossary terms", async () => {
  let cleanupRequest: CleanupRequest | undefined;
  const result = await runVoiceTranscriptionPipeline(
    {
      buffer: Buffer.alloc(512, 1),
      mime: "audio/webm",
      cleanupRequested: true,
      cleanupModelId: "local/model",
      cleanupInstructions: "保留专业词",
      glossary: {
        revision: "glossary-test",
        updatedAt: null,
        entries: [
          {
            id: "mflow",
            canonical: "MFlow",
            enabled: true,
          },
          {
            id: "postgresql",
            canonical: "PostgreSQL",
            enabled: true,
          },
          {
            id: "disabled",
            canonical: "DoNotSend",
            enabled: false,
          },
        ],
      },
    },
    {
      transcribe: async () => ({
        ok: true,
        text: "项目使用 MFlow 和 PostgreSQL。",
        provider: "pipeline-test",
        segments: [],
      }),
      cleanup: async (request) => {
        cleanupRequest = request;
        return {
          ok: true,
          text: request.text,
          modelId: "local/model",
          durationMs: 3,
        };
      },
    },
  );

  assert.equal(result.ok, true);
  assert.deepEqual(cleanupRequest?.customDictionary, [
    "MFlow",
    "PostgreSQL",
  ]);
  assert.equal(cleanupRequest?.customInstructions, "保留专业词");
});

test("cleanup Provider dictionary remains within the STT prompt budget", async () => {
  let cleanupRequest: CleanupRequest | undefined;
  const glossaryEntries = Array.from({ length: 20 }, (_, index) => ({
    id: `term-${index}`,
    canonical: `${index.toString().padStart(2, "0")}-${"术".repeat(100)}`,
    enabled: true,
  }));
  const result = await runVoiceTranscriptionPipeline(
    {
      buffer: Buffer.alloc(512, 1),
      mime: "audio/webm",
      cleanupRequested: true,
      cleanupModelId: "local/model",
      glossary: {
        revision: "bounded-glossary-test",
        updatedAt: null,
        entries: glossaryEntries,
      },
    },
    {
      transcribe: async () => ({
        ok: true,
        text: "测试",
        provider: "pipeline-test",
        segments: [],
      }),
      cleanup: async (request) => {
        cleanupRequest = request;
        return {
          ok: true,
          text: request.text,
          modelId: "local/model",
          durationMs: 1,
        };
      },
    },
  );

  assert.equal(result.ok, true);
  assert.ok(cleanupRequest?.customDictionary);
  assert.ok(
    `Keywords: ${cleanupRequest.customDictionary.join(", ")}`.length <= 800,
  );
  assert.ok(cleanupRequest.customDictionary.length < glossaryEntries.length);
});
