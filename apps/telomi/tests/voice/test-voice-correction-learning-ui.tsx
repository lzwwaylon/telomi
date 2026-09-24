import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { VoiceCorrectionLearningNotice } from "../../web/src/features/settings/VoiceCorrectionLearningNotice.js";

test("learned correction notice exposes an accessible undo action", () => {
	const html = renderToStaticMarkup(
		<VoiceCorrectionLearningNotice
			message="已从本次修改学习: Sinead"
			corrections={["Sinead"]}
			undoing={false}
			onUndo={() => undefined}
		/>,
	);

	assert.match(html, /role="status"/);
	assert.match(html, /已从本次修改学习: Sinead/);
	assert.match(html, /data-testid="voice-correction-undo"/);
	assert.match(html, /aria-label="撤销本次自动学习"/);
	assert.match(html, />撤销自动学习</);
});

test("ordinary voice notices omit undo and pending undo cannot be clicked twice", () => {
	const ordinary = renderToStaticMarkup(
		<VoiceCorrectionLearningNotice
			message="未检测到足够的语音"
			corrections={[]}
			undoing={false}
			onUndo={() => undefined}
		/>,
	);
	assert.doesNotMatch(ordinary, /voice-correction-undo/);

	const pending = renderToStaticMarkup(
		<VoiceCorrectionLearningNotice
			message="已从本次修改学习: Sinead"
			corrections={["Sinead"]}
			undoing
			onUndo={() => undefined}
		/>,
	);
	assert.match(pending, /disabled=""/);
	assert.match(pending, />正在撤销…</);
});

test("voice errors use an assertive, high-contrast notice", () => {
	const html = renderToStaticMarkup(
		<VoiceCorrectionLearningNotice
			message="麦克风权限被拒绝"
			corrections={[]}
			undoing={false}
			onUndo={() => undefined}
			tone="error"
		/>,
	);

	assert.match(html, /role="alert"/);
	assert.match(html, /aria-live="assertive"/);
	assert.match(html, /text-\[0\.75rem\]/);
	assert.match(html, /text-\[var\(--destructive\)\]/);
});
