import assert from "node:assert/strict";
import test from "node:test";
import { isImeCompositionKeyboardEvent } from "../../web/src/shared/lib/composerKeyboard.js";

test("IME confirmation keys never submit a composer", () => {
	assert.equal(
		isImeCompositionKeyboardEvent({
			key: "Enter",
			keyCode: 13,
			isComposing: true,
		}),
		true,
	);
	assert.equal(
		isImeCompositionKeyboardEvent({
			key: "Process",
			keyCode: 0,
			isComposing: false,
		}),
		true,
	);
	assert.equal(
		isImeCompositionKeyboardEvent({
			key: "Enter",
			keyCode: 229,
			isComposing: false,
		}),
		true,
	);
	assert.equal(
		isImeCompositionKeyboardEvent({
			key: "Enter",
			keyCode: 13,
			isComposing: false,
		}),
		false,
	);
});
