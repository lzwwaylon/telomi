import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { VoiceHistoryRefreshButton } from "../../web/src/features/settings/VoiceHistorySettings.js";
import { subscribeVoiceHistoryForegroundRefresh } from "../../web/src/features/voice/voiceHistoryRefresh.js";

test("voice History foreground refresh coalesces focus and visibility events", async () => {
  const windowTarget = new EventTarget();
  const documentTarget = new EventTarget() as EventTarget & {
    visibilityState: DocumentVisibilityState;
  };
  documentTarget.visibilityState = "visible";
  let refreshCount = 0;
  const dispose = subscribeVoiceHistoryForegroundRefresh(
    () => {
      refreshCount += 1;
    },
    { windowTarget, documentTarget },
  );

  windowTarget.dispatchEvent(new Event("focus"));
  documentTarget.dispatchEvent(new Event("visibilitychange"));
  await Promise.resolve();
  assert.equal(refreshCount, 1);

  documentTarget.visibilityState = "hidden";
  documentTarget.dispatchEvent(new Event("visibilitychange"));
  await Promise.resolve();
  assert.equal(refreshCount, 1);

  documentTarget.visibilityState = "visible";
  windowTarget.dispatchEvent(new Event("focus"));
  dispose();
  await Promise.resolve();
  assert.equal(refreshCount, 1);

  windowTarget.dispatchEvent(new Event("focus"));
  await Promise.resolve();
  assert.equal(refreshCount, 1);
});

test("voice History refresh action exposes idle and busy states", () => {
  const idle = renderToStaticMarkup(
    <VoiceHistoryRefreshButton busy={false} onRefresh={() => {}} />,
  );
  assert.match(idle, /刷新/);
  assert.doesNotMatch(idle, /disabled=""/);
  assert.match(idle, /data-testid="voice-history-refresh"/);

  const busy = renderToStaticMarkup(
    <VoiceHistoryRefreshButton busy onRefresh={() => {}} />,
  );
  assert.match(busy, /刷新中…/);
  assert.match(busy, /disabled=""/);
});
