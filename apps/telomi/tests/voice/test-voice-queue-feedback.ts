import assert from "node:assert/strict";
import test from "node:test";
import {
	resolveComposerSendControls,
	resolveVoiceQueueNotice,
} from "../../web/src/features/voice/voiceQueueFeedback.js";

test("voice submission reports its authoritative queue position", () => {
	assert.equal(
		resolveVoiceQueueNotice(
			{ queued: true, queuePosition: 2 },
			true,
		),
		"当前任务仍在运行，这条语音输入已排队（前方 1 条）",
	);
});

test("non-voice and immediately started submissions do not show a voice queue notice", () => {
	assert.equal(
		resolveVoiceQueueNotice(
			{ queued: false, queuePosition: 0 },
			true,
		),
		null,
	);
	assert.equal(
		resolveVoiceQueueNotice(
			{ queued: true, queuePosition: 1 },
			false,
		),
		null,
	);
});

test("an active Agent Run keeps stop visible and adds send when a draft exists", () => {
	assert.deepEqual(resolveComposerSendControls(true, true), {
		showAbort: true,
		showSend: true,
	});
	assert.deepEqual(resolveComposerSendControls(true, false), {
		showAbort: true,
		showSend: false,
	});
	assert.deepEqual(resolveComposerSendControls(false, false), {
		showAbort: false,
		showSend: true,
	});
});
