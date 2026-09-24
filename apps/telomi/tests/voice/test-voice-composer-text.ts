import assert from "node:assert/strict";
import test from "node:test";
import {
	insertVoiceTranscript,
	mergeVoiceTranscript,
} from "../../web/src/features/voice/voiceComposerText.js";
import { voiceCleanupNotice } from "../../web/src/features/voice/voiceCleanupFeedback.js";

test("voice input replaces the current composer selection", () => {
	assert.deepEqual(
		insertVoiceTranscript("Hello old world", "new", { start: 6, end: 9 }),
		{
			text: "Hello new world",
			selection: { start: 9, end: 9 },
		},
	);
});

test("voice input inserts at a collapsed cursor and spaces both boundaries", () => {
	assert.deepEqual(
		insertVoiceTranscript("Hello world", "beautiful", { start: 5, end: 5 }),
		{
			text: "Hello beautiful world",
			selection: { start: 15, end: 15 },
		},
	);
});

test("an empty voice result preserves the selected draft text and selection", () => {
	assert.deepEqual(
		insertVoiceTranscript("Hello old world", "", { start: 6, end: 9 }),
		{
			text: "Hello old world",
			selection: { start: 6, end: 9 },
		},
	);
});

test("voice insertion normalizes a stale reversed selection", () => {
	assert.deepEqual(
		insertVoiceTranscript("Hello world", "there", { start: 11, end: 6 }),
		{
			text: "Hello there",
			selection: { start: 11, end: 11 },
		},
	);
});

test("voice insertion clamps a selection outside the latest draft", () => {
	assert.deepEqual(
		insertVoiceTranscript("Hello", "Say", { start: -1, end: -1 }),
		{
			text: "Say Hello",
			selection: { start: 3, end: 3 },
		},
	);
});

test("voice replacement stays inside straight quotes", () => {
	assert.deepEqual(
		insertVoiceTranscript('He said "old".', "new", { start: 9, end: 12 }),
		{
			text: 'He said "new".',
			selection: { start: 12, end: 12 },
		},
	);
});

test("voice replacement preserves an apostrophe suffix", () => {
	assert.deepEqual(
		insertVoiceTranscript("user's account", "admin", { start: 0, end: 4 }),
		{
			text: "admin's account",
			selection: { start: 5, end: 5 },
		},
	);
});

test("voice replacement stays inside an inline-code span", () => {
	assert.deepEqual(
		insertVoiceTranscript("Use `old` now", "fresh", { start: 5, end: 8 }),
		{
			text: "Use `fresh` now",
			selection: { start: 10, end: 10 },
		},
	);
});

test("continuous voice input preserves an intentional paragraph break", () => {
	assert.equal(
		mergeVoiceTranscript("First paragraph.\n", "Second paragraph."),
		"First paragraph.\nSecond paragraph.",
	);
});

test("continuous voice input separates adjacent words", () => {
	assert.equal(mergeVoiceTranscript("Hello", "world"), "Hello world");
});

test("voice punctuation attaches to the existing draft", () => {
	assert.equal(mergeVoiceTranscript("Hello", ", world"), "Hello, world");
});

test("voice text attaches after an opening delimiter", () => {
	assert.equal(
		mergeVoiceTranscript("Call function(", "argument"),
		"Call function(argument",
	);
	assert.equal(mergeVoiceTranscript("He said “", "hello"), "He said “hello");
});

test("an empty voice result does not mutate the draft", () => {
	assert.equal(mergeVoiceTranscript("Keep this", ""), "Keep this");
});

test("cleanup failure keeps the transcript usable and returns one stable notice", () => {
	assert.equal(
		voiceCleanupNotice({
			requested: true,
			applied: false,
			modelId: "missing/model",
			reason: "unknown model: missing/model",
		}, "嗯 保留这句"),
		"AI 文本清理失败，已保留未经清理的转写文本",
	);
	assert.equal(
		voiceCleanupNotice({
			requested: false,
			applied: false,
		}, "保留这句"),
		null,
	);
	// Cleanup that removes everything is a result, not a failure: the user learns why nothing was inserted.
	assert.equal(
		voiceCleanupNotice({
			requested: true,
			applied: true,
			modelId: "openai-codex/gpt-5.4-mini",
			durationMs: 123,
		}, ""),
		"这段录音只有口头语，清理后没有内容",
	);
	assert.equal(
		voiceCleanupNotice({
			requested: true,
			applied: true,
			modelId: "openai-codex/gpt-5.4-mini",
			durationMs: 123,
		}, "保留这句"),
		null,
	);
});

test("pre-spaced voice text is not double-spaced", () => {
	assert.equal(mergeVoiceTranscript("Hello", " world"), "Hello world");
});
