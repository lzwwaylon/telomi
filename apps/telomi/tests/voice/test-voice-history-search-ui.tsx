import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { VoiceHistoryEntry } from "../../shared/voice-history.js";
import { VoiceHistorySearchControl } from "../../web/src/features/settings/VoiceHistorySettings.js";
import { filterVoiceHistoryEntries } from "../../web/src/features/voice/voiceHistorySearch.js";

function entry(id: string, text: string, rawText = text): VoiceHistoryEntry {
  return {
    id,
    status: "completed",
    text,
    rawText,
    canonicalText: text,
    provider: "telomi-audio",
    model: "local-qwen",
    createdAt: "2026-07-22T00:00:00.000Z",
    updatedAt: "2026-07-22T00:00:00.000Z",
    attemptCount: 1,
    hasAudio: false,
  };
}

test("voice History search matches normalized final text and preserves order", () => {
  const entries = [
    entry("first", "MFlow 和 PostgreSQL"),
    entry("second", "Cafe\u0301 review"),
    entry("raw-only", "最终正文", "MFlow Provider 原文"),
    entry("last", "mflow retrospective"),
  ];

  assert.deepEqual(
    filterVoiceHistoryEntries(entries, "MFLOW").map((item) => item.id),
    ["first", "last"],
  );
  assert.deepEqual(
    filterVoiceHistoryEntries(entries, "Café").map((item) => item.id),
    ["second"],
  );
});

test("voice History search trims the query and keeps a blank query unfiltered", () => {
  const entries = [entry("first", "MFlow"), entry("second", "PostgreSQL")];
  assert.equal(filterVoiceHistoryEntries(entries, "   "), entries);
  assert.deepEqual(
    filterVoiceHistoryEntries(entries, "  postgresql  ").map((item) => item.id),
    ["second"],
  );
});

test("voice History search control exposes results, clear and no-result states", () => {
  const resultsHtml = renderToStaticMarkup(
    <VoiceHistorySearchControl
      query="mflow"
      resultCount={2}
      loadedCount={7}
      onQueryChange={() => {}}
      onClear={() => {}}
    />,
  );
  assert.match(resultsHtml, /type="search"/);
  assert.match(resultsHtml, /aria-label="搜索语音历史"/);
  assert.match(resultsHtml, /value="mflow"/);
  assert.ok(resultsHtml.includes("当前列表找到 2 / 7 条"));
  assert.match(resultsHtml, /清除历史搜索/);
  assert.match(resultsHtml, /data-testid="voice-history-search-clear"/);

  const emptyHtml = renderToStaticMarkup(
    <VoiceHistorySearchControl
      query="不存在"
      resultCount={0}
      loadedCount={7}
      onQueryChange={() => {}}
      onClear={() => {}}
    />,
  );
  assert.match(emptyHtml, /没有匹配的转写记录/);
  assert.match(emptyHtml, /role="status"/);
});
