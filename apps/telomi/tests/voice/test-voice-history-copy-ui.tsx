import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { VoiceHistoryEntry } from "../../shared/voice-history.js";
import { VoiceHistoryEntryCard } from "../../web/src/features/settings/VoiceHistorySettings.js";
import { copyVoiceHistoryText } from "../../web/src/features/voice/voiceHistoryClipboard.js";

const completedEntry: VoiceHistoryEntry = {
	id: "voice_copy_test",
	goalId: "goal_copy_test",
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
	contextSnapshotId: null,
	glossaryRevision: null,
	cleanup: { requested: false, applied: false },
	routing: {
		primaryProvider: "telomi-audio",
		fallback: { enabled: false, eligible: false, used: false },
		attempts: [],
	},
};

test("voice history copies the exact final transcript through the browser clipboard", async () => {
	const writes: string[] = [];
	await copyVoiceHistoryText(completedEntry.text, {
		writeText: async (text) => {
			writes.push(text);
		},
	});

	assert.deepEqual(writes, [completedEntry.text]);
});

test("voice history copy fails explicitly when the browser clipboard is unavailable", async () => {
	await assert.rejects(
		copyVoiceHistoryText(completedEntry.text, null),
		/浏览器不支持剪贴板写入/,
	);
});

test("completed voice history exposes copy feedback without exposing it for failed rows", () => {
	const completedHtml = renderToStaticMarkup(
		<VoiceHistoryEntryCard
			entry={completedEntry}
			retrying={false}
			playing={false}
			copying={false}
			copied={true}
			onRetry={async () => {}}
			onPlay={() => {}}
			onCopy={async () => {}}
			onRemove={async () => {}}
		/>,
	);
	assert.match(completedHtml, /data-testid="voice-history-copy-voice_copy_test"/);
	assert.match(completedHtml, /已复制/);

	const failedHtml = renderToStaticMarkup(
		<VoiceHistoryEntryCard
			entry={{ ...completedEntry, id: "voice_failed", status: "failed" }}
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
	assert.doesNotMatch(failedHtml, /voice-history-copy-voice_failed/);
});
