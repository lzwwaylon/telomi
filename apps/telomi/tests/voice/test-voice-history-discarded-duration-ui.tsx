import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { VoiceHistoryEntry } from "../../shared/voice-history.js";
import { VoiceHistoryEntryCard } from "../../web/src/features/settings/VoiceHistorySettings.js";
import { formatVoiceHistoryDuration } from "../../web/src/features/voice/voiceHistoryDuration.js";

const discardedEntry: VoiceHistoryEntry = {
	id: "voice_0123456789abcdef0123456789abcdef",
	goalId: "goal-duration",
	status: "discarded",
	createdAt: "2026-07-22T12:00:00+08:00",
	updatedAt: "2026-07-22T12:00:00+08:00",
	attemptCount: 1,
	text: "",
	rawText: "",
	canonicalText: "",
	provider: "not-transcribed",
	durationSec: 65.6,
	mime: "audio/webm",
	hasAudio: true,
	audioBytes: 4_224,
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

test("discarded History duration follows OpenWhispr rounding and mm:ss semantics", () => {
	assert.equal(formatVoiceHistoryDuration(1), "00:01");
	assert.equal(formatVoiceHistoryDuration(59.6), "01:00");
	assert.equal(formatVoiceHistoryDuration(65.6), "01:06");
	assert.equal(formatVoiceHistoryDuration(3_600), "60:00");
});

test("discarded History duration rejects absent or invalid measurements", () => {
	assert.equal(formatVoiceHistoryDuration(undefined), null);
	assert.equal(formatVoiceHistoryDuration(0), null);
	assert.equal(formatVoiceHistoryDuration(-1), null);
	assert.equal(formatVoiceHistoryDuration(Number.NaN), null);
	assert.equal(formatVoiceHistoryDuration(Number.POSITIVE_INFINITY), null);
});

test("discarded History card shows retained recording duration with a safe fallback", () => {
	const measured = renderEntry(discardedEntry);
	assert.match(measured, /录音已由用户取消 · 01:06/);

	const unmeasured = renderEntry({ ...discardedEntry, durationSec: undefined });
	assert.match(unmeasured, /录音已由用户取消，可使用保留的原音频重新转写/);
	assert.doesNotMatch(unmeasured, /录音已由用户取消 ·/);
});
