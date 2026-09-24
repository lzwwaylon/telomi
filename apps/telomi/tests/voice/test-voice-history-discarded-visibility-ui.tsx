import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { VoiceHistoryDiscardedToggle } from "../../web/src/features/settings/VoiceHistorySettings.js";

test("discarded History toggle exposes explicit show and hide states", () => {
  const hidden = renderToStaticMarkup(
    <VoiceHistoryDiscardedToggle
      discardedCount={2}
      showDiscarded={false}
      onToggle={() => {}}
    />,
  );
  assert.match(hidden, /data-testid="voice-history-show-discarded"/);
  assert.match(hidden, /aria-pressed="false"/);
  assert.match(hidden, />显示已取消 \(2\)</);

  const visible = renderToStaticMarkup(
    <VoiceHistoryDiscardedToggle
      discardedCount={2}
      showDiscarded
      onToggle={() => {}}
    />,
  );
  assert.match(visible, /aria-pressed="true"/);
  assert.match(visible, />隐藏已取消</);

  const busy = renderToStaticMarkup(
    <VoiceHistoryDiscardedToggle
      discardedCount={2}
      showDiscarded={false}
      busy
      onToggle={() => {}}
    />,
  );
  assert.match(busy, /disabled=""/);
});

test("discarded History toggle is absent when no recovery row exists", () => {
  const html = renderToStaticMarkup(
    <VoiceHistoryDiscardedToggle
      discardedCount={0}
      showDiscarded={false}
      onToggle={() => {}}
    />,
  );
  assert.equal(html, "");
});
