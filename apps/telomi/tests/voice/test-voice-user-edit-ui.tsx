import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
	VoiceUserEditDetails,
	VoiceUserEditUsageSummary,
} from "../../web/src/features/settings/VoiceHistorySettings.js";

test("voice history summarizes the micro-averaged submitted modification rate", () => {
	const html = renderToStaticMarkup(
		<VoiceUserEditUsageSummary
			usage={{
				measuredCount: 2,
				unmeasuredCount: 1,
				totalOriginalCharacters: 3,
				totalEditDistance: 1,
				modificationRate: 1 / 3,
			}}
		/>,
	);

	assert.match(html, /发送前修改率 33\.3%/);
	assert.match(html, /2 条可测/);
	assert.match(html, /1 条归因不确定，未计入修改率/);
});

test("voice history shows measured counts without storing a duplicate submitted message", () => {
	const html = renderToStaticMarkup(
		<VoiceUserEditDetails
			userEdit={{
				outcome: "measured",
				unit: "unicode-code-point",
				originalCharacterCount: 3,
				submittedCharacterCount: 3,
				editDistance: 1,
				modificationRate: 1 / 3,
				elapsedMs: 1_234,
				recordedAt: "2026-07-22T07:00:00.000Z",
			}}
		/>,
	);

	assert.match(html, /发送前修改 33\.3%/);
	assert.match(html, /1 \/ 3 个 Unicode 字符发生变化/);
	assert.match(html, /转写填入后 1\.23 秒发送/);
	assert.doesNotMatch(html, /editedText|submittedText/);
});

test("voice history explains why an ambiguous edit was excluded", () => {
	const html = renderToStaticMarkup(
		<VoiceUserEditDetails
			userEdit={{
				outcome: "unmeasured",
				reason: "multiple_voice_inputs",
				elapsedMs: 2_000,
				recordedAt: "2026-07-22T07:00:00.000Z",
			}}
		/>,
	);

	assert.match(html, /发送前修改率未计入/);
	assert.match(html, /同一条消息包含多段语音输入/);
	assert.match(html, /2\.00 秒后发送/);
});
