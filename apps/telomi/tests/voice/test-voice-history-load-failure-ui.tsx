import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { VoiceHistoryLoadFailureNotice } from "../../web/src/features/settings/VoiceHistorySettings.js";
import { fetchVoiceHistorySnapshot } from "../../web/src/features/voice/voiceHistoryLoader.js";

test("voice History loader requests the selected discarded visibility", async () => {
  const requests: string[] = [];
  const snapshot = { entries: [], marker: "loaded" };
  const result = await fetchVoiceHistorySnapshot(true, async (input) => {
    requests.push(String(input));
    return new Response(JSON.stringify(snapshot), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });

  assert.deepEqual(requests, [
    "/api/voice/history?limit=50&includeDiscarded=1",
  ]);
  assert.equal((result as { marker: string }).marker, "loaded");
});

test("voice History loader preserves the server failure detail", async () => {
  await assert.rejects(
    fetchVoiceHistorySnapshot(
      false,
      async () =>
        new Response(
          JSON.stringify({ error: "history ledger is unreadable" }),
          {
            status: 503,
            headers: { "Content-Type": "application/json" },
          },
        ),
    ),
    /history ledger is unreadable/,
  );
});

test("voice History first-load failure is explicit and recoverable", () => {
  const html = renderToStaticMarkup(
    <VoiceHistoryLoadFailureNotice
      error="history ledger is unreadable"
      busy={false}
      hasSnapshot={false}
      onRetry={() => {}}
    />,
  );

  assert.match(html, /无法读取语音历史/);
  assert.match(html, /history ledger is unreadable/);
  assert.match(html, /重新加载/);
  assert.match(html, /role="alert"/);
  assert.match(html, /data-testid="voice-history-load-failure"/);
  assert.doesNotMatch(html, /仍显示上次成功读取的记录/);
});

test("voice History refresh failure keeps the last snapshot visible", () => {
  const html = renderToStaticMarkup(
    <VoiceHistoryLoadFailureNotice
      error="temporary history failure"
      busy
      hasSnapshot
      onRetry={() => {}}
    />,
  );

  assert.match(html, /仍显示上次成功读取的记录/);
  assert.match(html, /正在重新加载…/);
  assert.match(html, /disabled=""/);
});
