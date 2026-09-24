import assert from "node:assert/strict";
import test from "node:test";
import {
	isVoiceInputCancellable,
	resolveVoiceInputControl,
	shouldPreserveCancelledVoiceRecording,
} from "../../web/src/features/voice/voiceInputControl.js";

test("voice input stays cancellable while microphone startup is pending", () => {
	assert.deepEqual(resolveVoiceInputControl("starting"), {
		action: "cancel",
		ariaBusy: true,
		ariaLabel: "取消启动语音输入",
		disabled: false,
		title: "取消麦克风启动",
	});

	assert.equal(resolveVoiceInputControl("idle").action, "start");
	assert.equal(resolveVoiceInputControl("error").action, "start");
	assert.equal(resolveVoiceInputControl("recording").action, "stop");
});

test("voice input stays cancellable while final transcription is pending", () => {
	assert.deepEqual(resolveVoiceInputControl("finalizing"), {
		action: "cancel",
		ariaBusy: true,
		ariaLabel: "取消语音文本确认",
		disabled: false,
		title: "取消最终文本确认",
	});

	assert.equal(isVoiceInputCancellable("idle"), false);
	assert.equal(isVoiceInputCancellable("error"), false);
	assert.equal(isVoiceInputCancellable("starting"), true);
	assert.equal(isVoiceInputCancellable("recording"), true);
	assert.equal(isVoiceInputCancellable("finalizing"), true);
	assert.equal(shouldPreserveCancelledVoiceRecording("starting"), false);
	assert.equal(shouldPreserveCancelledVoiceRecording("recording"), true);
	assert.equal(shouldPreserveCancelledVoiceRecording("finalizing"), false);
});
