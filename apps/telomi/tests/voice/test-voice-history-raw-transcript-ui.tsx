import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { VoiceHistoryEntry } from "../../shared/voice-history.js";
import { VoiceHistoryEntryCard } from "../../web/src/features/settings/VoiceHistorySettings.js";

const completedEntry: VoiceHistoryEntry = {
  id: "voice_1234567890abcdef1234567890abcdef",
  goalId: "goal-raw-transcript",
  status: "completed",
  createdAt: "2026-07-22T12:00:00+08:00",
  updatedAt: "2026-07-22T12:00:00+08:00",
  attemptCount: 1,
  text: "Provider 原文保持不变。",
  rawText: "Provider 原文保持不变。",
  canonicalText: "Provider 原文保持不变。",
  provider: "telomi-audio",
  model: "Qwen3-ASR-0.6B-MLX-4bit",
  mime: "audio/webm",
  hasAudio: false,
  audioBytes: 0,
  cleanup: { requested: false, applied: false },
};

function renderEntry(entry: VoiceHistoryEntry): string {
  return renderToStaticMarkup(
    <VoiceHistoryEntryCard
      entry={entry}
      retrying={false}
      playing={false}
      copying={false}
      copied={false}
      onRetry={async () => {}}
      onPlay={() => {}}
      onCopy={async () => {}}
      onRemove={async () => {}}
    />,
  );
}

test("completed History exposes Provider raw text even when final text is identical", () => {
  const html = renderEntry(completedEntry);
  assert.match(
    html,
    /data-testid="voice-history-raw-voice_1234567890abcdef1234567890abcdef"/,
  );
  assert.match(html, /查看 Provider 原文/);
  assert.match(html, /Provider 原文与最终文本相同，未应用 AI 文本清理/);
});

test("identical Provider raw text reports cleanup that ran without changing content", () => {
  const html = renderEntry({
    ...completedEntry,
    cleanup: { requested: true, applied: true, modelId: "test/model" },
  });
  assert.match(html, /Provider 原文与最终文本相同，AI 文本清理未改变内容/);
});

test("changed Provider raw text remains visible without a false unchanged notice", () => {
  const html = renderEntry({
    ...completedEntry,
    rawText: "Provider 原纹保持不变。",
  });
  assert.match(html, /Provider 原纹保持不变。/);
  assert.doesNotMatch(html, /Provider 原文与最终文本相同/);
});

test("failed, discarded and empty-raw History never expose a completed raw panel", () => {
  for (const entry of [
    { ...completedEntry, status: "failed" as const },
    { ...completedEntry, status: "discarded" as const },
    { ...completedEntry, rawText: "" },
  ]) {
    assert.doesNotMatch(renderEntry(entry), /data-testid="voice-history-raw-/);
  }
});
