import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { VoiceHistoryClearConfirmationContent } from "../../web/src/features/settings/VoiceHistorySettings.js";
import { Dialog } from "../../web/src/shared/ui/dialog.js";
import {
  captureVoiceHistoryClearScope,
  formatVoiceHistoryClearError,
} from "../../web/src/features/voice/voiceHistoryDeletion.js";

test("voice history clear freezes its visible destructive scope before the request", () => {
  const usage = {
    entryCount: 3,
    discardedCount: 1,
    audioFileCount: 2,
  };
  const scope = captureVoiceHistoryClearScope(usage, false);
  usage.entryCount = 0;
  usage.discardedCount = 0;
  usage.audioFileCount = 0;
  assert.deepEqual(scope, {
    entryCount: 3,
    hiddenDiscardedCount: 1,
    audioFileCount: 2,
  });
  assert.equal(
    captureVoiceHistoryClearScope(
      { entryCount: 3, discardedCount: 1, audioFileCount: 2 },
      true,
    ).hiddenDiscardedCount,
    0,
  );
});

test("voice history clear confirmation names every destructive data scope", () => {
  const html = renderToStaticMarkup(
    <Dialog open>
      <VoiceHistoryClearConfirmationContent
        entryCount={3}
        hiddenDiscardedCount={1}
        audioFileCount={2}
        busy={false}
        error={null}
        onCancel={() => {}}
        onConfirm={() => {}}
      />
    </Dialog>,
  );
  assert.match(html, /清空全部语音历史？/);
  assert.match(html, /永久删除全部 3 条转写记录/);
  assert.match(html, /包括当前隐藏的 1 条已取消记录/);
  assert.match(html, /及 2 个保留的原音频文件/);
  assert.match(html, /此操作不可撤销/);
  assert.match(html, /data-testid="voice-history-clear-cancel"/);
  assert.match(html, /data-testid="voice-history-clear-confirm"/);
});

test("voice history clear confirmation does not invent hidden or audio data", () => {
  const html = renderToStaticMarkup(
    <Dialog open>
      <VoiceHistoryClearConfirmationContent
        entryCount={1}
        hiddenDiscardedCount={0}
        audioFileCount={0}
        busy={false}
        error={null}
        onCancel={() => {}}
        onConfirm={() => {}}
      />
    </Dialog>,
  );
  assert.match(html, /永久删除全部 1 条转写记录。此操作不可撤销/);
  assert.doesNotMatch(html, /当前隐藏/);
  assert.doesNotMatch(html, /原音频文件/);
});

test("voice history clear confirmation exposes locked busy and retained failure states", () => {
  const busyHtml = renderToStaticMarkup(
    <Dialog open>
      <VoiceHistoryClearConfirmationContent
        entryCount={2}
        hiddenDiscardedCount={0}
        audioFileCount={1}
        busy
        error={null}
        onCancel={() => {}}
        onConfirm={() => {}}
      />
    </Dialog>,
  );
  assert.match(busyHtml, /清空中…/);
  assert.equal((busyHtml.match(/disabled=""/g) ?? []).length, 2);

  const failedHtml = renderToStaticMarkup(
    <Dialog open>
      <VoiceHistoryClearConfirmationContent
        entryCount={2}
        hiddenDiscardedCount={0}
        audioFileCount={1}
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

test("voice history clear turns browser transport failures into actionable copy", () => {
  assert.equal(
    formatVoiceHistoryClearError(new TypeError("Failed to fetch")),
    "清空请求失败，请检查本地服务连接后重试",
  );
  assert.equal(formatVoiceHistoryClearError(new Error("HTTP 503")), "HTTP 503");
});
