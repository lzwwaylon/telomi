import assert from "node:assert/strict";
import test from "node:test";
import {
	normalizeChineseContentForScoring,
	normalizeVoiceTranscriptScript,
} from "../../server/voice/chinese-script.js";

test("explicit zh-TW and zh-CN preferences produce deterministic display scripts", () => {
	assert.deepEqual(
		normalizeVoiceTranscriptScript(
			"我们推出新的语言模型与训练资料。OpenWhispr",
			"zh-TW",
		),
		{
			text: "我們推出新的語言模型與訓練資料。OpenWhispr",
			preference: "zh-TW",
			profile: "opencc-s2tw-v1",
			applied: true,
			changed: true,
		},
	);
	assert.deepEqual(
		normalizeVoiceTranscriptScript(
			"我們推出新的語言模型與訓練資料。OpenWhispr",
			"zh-CN",
		),
		{
			text: "我们推出新的语言模型与训练资料。OpenWhispr",
			preference: "zh-CN",
			profile: "opencc-t2s-v1",
			applied: true,
			changed: true,
		},
	);
});

test("auto and non-Chinese preferences preserve Provider text", () => {
	for (const preference of ["auto", "zh", "en-US", undefined]) {
		assert.deepEqual(
			normalizeVoiceTranscriptScript("我們使用 OpenWhispr。", preference),
			{
				text: "我們使用 OpenWhispr。",
				preference: null,
				profile: null,
				applied: false,
				changed: false,
			},
		);
	}
});

test("content-scoring projection removes script-only differences", () => {
	assert.equal(
		normalizeChineseContentForScoring("我們使用 OpenWhispr。"),
		normalizeChineseContentForScoring("我们使用 OpenWhispr。"),
	);
});
