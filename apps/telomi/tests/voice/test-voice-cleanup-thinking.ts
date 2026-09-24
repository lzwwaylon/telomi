import assert from "node:assert/strict";
import test from "node:test";
import {
	cleanup,
	extractVoiceCleanupText,
	MAX_EMPTIED_TRANSCRIPT_CHARS,
	resolveCleanupOutput,
	stripVoiceCleanupThinking,
	voiceCleanupInferencePolicy,
} from "../../server/voice/cleanup.js";

test("cleanup rejects obsolete bare model ids", async () => {
	assert.deepEqual(await cleanup({ text: "hello", modelId: "gpt-5.4-mini" }), {
		ok: false,
		modelId: "gpt-5.4-mini",
		reason: "modelId must use provider/model format",
	});
});

test("cleanup leaves Provider-specific reasoning suppression to pi-ai", () => {
	assert.deepEqual(voiceCleanupInferencePolicy(37), {
		maxTokens: 512,
	});
	assert.deepEqual(voiceCleanupInferencePolicy(1_000), {
		maxTokens: 2_048,
	});
	assert.equal("reasoning" in voiceCleanupInferencePolicy(37), false);
});

test("cleanup thinking stripping matches the pinned OpenWhispr module", () => {
	const vectors = [
		{
			input: "<think>let me reason about this</think>Meeting Notes Summary",
			expected: "Meeting Notes Summary",
		},
		{
			input: "Title Here<think>reasoning that never closed",
			expected: "Title Here",
		},
		{
			input: "Quarterly Plan<think>...</think>",
			expected: "Quarterly Plan",
		},
		{
			input: "Project Kickoff Notes",
			expected: "Project Kickoff Notes",
		},
		{
			input: "<think>just thinking, no answer</think>",
			expected: "",
		},
	] as const;

	for (const vector of vectors) {
		assert.equal(stripVoiceCleanupThinking(vector.input), vector.expected);
	}
	assert.equal(stripVoiceCleanupThinking(undefined), undefined);
});

test("cleanup extracts only user-visible text after removing literal reasoning blocks", () => {
	assert.equal(
		extractVoiceCleanupText([
			{ type: "thinking", text: "structured reasoning is ignored" },
			{ type: "text", text: "<think>literal reasoning</think>修正后的转写" },
			{ type: "text", text: "第二段" },
		]),
		"修正后的转写\n第二段",
	);
	assert.equal(
		extractVoiceCleanupText([
			{ type: "text", text: "<think>reasoning only</think>" },
		]),
		"",
	);
	assert.equal(extractVoiceCleanupText({ text: "not a model content array" }), "");
});

test("an empty output is a result when the model finished on its own and the input was short", () => {
	const fillers = "嗯啊那个";
	assert.deepEqual(resolveCleanupOutput("", { stopReason: "stop", inputText: fillers }), { ok: true, text: "" });
	// Truncation or an interrupted turn is not an editorial decision.
	assert.equal(resolveCleanupOutput("", { stopReason: "length", inputText: fillers }).ok, false);
	assert.equal(resolveCleanupOutput("", { stopReason: undefined, inputText: fillers }).ok, false);
	// A long transcript that vanishes is treated as a failure so the words are never lost silently.
	const long = "我".repeat(MAX_EMPTIED_TRANSCRIPT_CHARS + 1);
	assert.equal(resolveCleanupOutput("", { stopReason: "stop", inputText: long }).ok, false);
	assert.deepEqual(resolveCleanupOutput("", { stopReason: "stop", inputText: "我".repeat(MAX_EMPTIED_TRANSCRIPT_CHARS) }), { ok: true, text: "" });
	assert.deepEqual(resolveCleanupOutput("好的。", { stopReason: "stop", inputText: long }), { ok: true, text: "好的。" });
});
