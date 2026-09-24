import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { VoiceHistoryEntry } from "../../shared/voice-history.js";
import {
  VoiceHistoryDeleteConfirmationContent,
  VoiceHistoryEntryCard,
} from "../../web/src/features/settings/VoiceHistorySettings.js";
import { Dialog } from "../../web/src/shared/ui/dialog.js";
import { formatVoiceHistoryDeleteError } from "../../web/src/features/voice/voiceHistoryDeletion.js";

const entry: VoiceHistoryEntry = {
  id: "voice_delete_confirmation",
  goalId: "goal_delete_confirmation",
  status: "completed",
  createdAt: "2026-07-22T08:00:00.000Z",
  updatedAt: "2026-07-22T08:00:00.000Z",
  attemptCount: 1,
  text: "请安排 MFlow 与 PostgreSQL 评审。",
  rawText: "请安排 M flow 与 Postgre SQL 评审。",
  canonicalText: "请安排 MFlow 与 PostgreSQL 评审。",
  provider: "telomi-audio",
  model: "Qwen3-ASR-0.6B-MLX-4bit",
  language: "Chinese",
  durationSec: 4.2,
  mime: "audio/webm",
  hasAudio: true,
  audioBytes: 4_096,
  cleanup: { requested: false, applied: false },
};

test("voice history requires an explicit destructive confirmation before deleting retained audio", () => {
  const html = renderToStaticMarkup(
    <Dialog open>
      <VoiceHistoryDeleteConfirmationContent
        entry={entry}
        busy={false}
        error={null}
        onCancel={() => {}}
        onConfirm={() => {}}
      />
    </Dialog>,
  );
  assert.match(html, /删除这条语音历史？/);
  assert.match(html, /永久删除这条转写记录及其保留的原音频/);
  assert.match(html, /此操作不可撤销/);
  assert.match(html, /data-testid="voice-history-delete-cancel"/);
  assert.match(html, /data-testid="voice-history-delete-confirm"/);
  assert.doesNotMatch(html, /删除中…/);
});

test("voice history confirmation exposes busy and failure states without losing the target", () => {
  const busyHtml = renderToStaticMarkup(
    <Dialog open>
      <VoiceHistoryDeleteConfirmationContent
        entry={entry}
        busy
        error={null}
        onCancel={() => {}}
        onConfirm={() => {}}
      />
    </Dialog>,
  );
  assert.match(busyHtml, /删除中…/);
  assert.equal((busyHtml.match(/disabled=""/g) ?? []).length, 2);

  const failedHtml = renderToStaticMarkup(
    <Dialog open>
      <VoiceHistoryDeleteConfirmationContent
        entry={entry}
        busy={false}
        error="HTTP 500"
        onCancel={() => {}}
        onConfirm={() => {}}
      />
    </Dialog>,
  );
  assert.match(failedHtml, /role="alert"/);
  assert.match(failedHtml, /HTTP 500/);
});

test("voice history deletion turns browser transport failures into actionable copy", () => {
  assert.equal(
    formatVoiceHistoryDeleteError(new TypeError("Failed to fetch")),
    "删除请求失败，请检查本地服务连接后重试",
  );
  assert.equal(
    formatVoiceHistoryDeleteError(new Error("HTTP 500")),
    "HTTP 500",
  );
});

test("voice history entry exposes a stable delete request control", () => {
  const html = renderToStaticMarkup(
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
  assert.match(
    html,
    /data-testid="voice-history-delete-request-voice_delete_confirmation"/,
  );
  assert.match(html, /aria-label="删除转写记录"/);
});
