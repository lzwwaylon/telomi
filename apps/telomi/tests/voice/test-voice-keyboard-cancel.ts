import assert from "node:assert/strict";
import test from "node:test";
import { isVoiceCancelKeyboardEvent } from "../../web/src/features/voice/voiceKeyboard.js";

test("Escape cancels recording without stealing composition or handled shortcuts", () => {
	assert.equal(
		isVoiceCancelKeyboardEvent({
			key: "Escape",
			defaultPrevented: false,
			repeat: false,
			isComposing: false,
		}),
		true,
	);
	assert.equal(
		isVoiceCancelKeyboardEvent({
			key: "Enter",
			defaultPrevented: false,
			repeat: false,
			isComposing: false,
		}),
		false,
	);
	assert.equal(
		isVoiceCancelKeyboardEvent({
			key: "Escape",
			defaultPrevented: true,
			repeat: false,
			isComposing: false,
		}),
		false,
	);
	assert.equal(
		isVoiceCancelKeyboardEvent({
			key: "Escape",
			defaultPrevented: false,
			repeat: true,
			isComposing: false,
		}),
		false,
	);
	assert.equal(
		isVoiceCancelKeyboardEvent({
			key: "Escape",
			defaultPrevented: false,
			repeat: false,
			isComposing: true,
		}),
		false,
	);
});
