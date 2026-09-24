import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { VoiceHistoryRetentionDisabledNotice } from "../../web/src/features/settings/VoiceHistorySettings.js";

test("voice History makes disabled retention an explicit privacy state", () => {
  const html = renderToStaticMarkup(
    <VoiceHistoryRetentionDisabledNotice busy={false} onEnable={() => {}} />,
  );
  assert.match(html, /role="status"/);
  assert.match(html, /历史记录已关闭/);
  assert.match(html, /新的语音转写和原音频不会写入本地历史/);
  assert.match(html, /现有记录会保留/);
  assert.match(html, /开启记录/);
  assert.match(html, /data-testid="voice-history-retention-disabled"/);
  assert.match(html, /data-testid="voice-history-retention-enable"/);
});

test("voice History retention action exposes an explicit busy lock", () => {
  const html = renderToStaticMarkup(
    <VoiceHistoryRetentionDisabledNotice busy onEnable={() => {}} />,
  );
  assert.match(html, /正在开启…/);
  assert.match(html, /disabled=""/);
});
