import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { VoiceHistoryEntry } from "../../shared/voice-history.js";
import { voiceHistoryAudioDownloadFilename } from "../../server/voice/history.js";
import { VoiceHistoryEntryCard } from "../../web/src/features/settings/VoiceHistorySettings.js";

const entry: VoiceHistoryEntry = {
	id: "voice_0123456789abcdef0123456789abcdef",
	goalId: "goal_download_test",
	status: "completed",
	createdAt: "2026-07-22T08:00:00.000Z",
	updatedAt: "2026-07-22T08:00:00.000Z",
	attemptCount: 1,
	text: "请安排 MFlow 与 PostgreSQL 评审。",
	rawText: "请安排 MFlow 与 PostgreSQL 评审。",
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

function renderHistoryEntry(value: VoiceHistoryEntry): string {
	return renderToStaticMarkup(
		<VoiceHistoryEntryCard
			entry={value}
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

test("voice history builds an ASCII attachment filename from a validated id and MIME", () => {
	assert.equal(
		voiceHistoryAudioDownloadFilename(entry.id, "audio/webm; codecs=opus"),
		"Telomi-voice_0123456789abcdef0123456789abcdef.webm",
	);
	assert.equal(
		voiceHistoryAudioDownloadFilename(entry.id, "audio/x-wav"),
		"Telomi-voice_0123456789abcdef0123456789abcdef.wav",
	);
	assert.throws(
		() => voiceHistoryAudioDownloadFilename("../secret", "audio/webm"),
		/Invalid voice history entry id/,
	);
});

test("retained voice history exposes an explicit original-audio download", () => {
	const html = renderHistoryEntry(entry);
	assert.match(
		html,
		/data-testid="voice-history-download-voice_0123456789abcdef0123456789abcdef"/,
	);
	assert.match(
		html,
		/href="\/api\/voice\/history\/voice_0123456789abcdef0123456789abcdef\/audio\?download=1"/,
	);
	assert.match(html, />下载</);
});

test("voice history without retained audio never exposes a stale download", () => {
	const html = renderHistoryEntry({ ...entry, hasAudio: false, audioBytes: 0 });
	assert.doesNotMatch(
		html,
		/voice-history-download-voice_0123456789abcdef0123456789abcdef/,
	);
});
