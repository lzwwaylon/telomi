import assert from "node:assert/strict";
import test from "node:test";
import { groupVoiceHistoryEntries } from "../../web/src/features/voice/voiceHistoryDates.js";

const now = new Date(2026, 6, 22, 12);
const zh = { now, locale: "zh-CN" };

test("voice History labels today, yesterday and earlier local calendar dates", () => {
	const entries = [
		{ createdAt: new Date(2026, 6, 22, 1).toISOString() },
		{ createdAt: new Date(2026, 6, 21, 23, 59, 59).toISOString() },
		{ createdAt: new Date(2026, 6, 20, 10).toISOString() },
		{ createdAt: "not-a-date" },
	];
	assert.deepEqual(
		groupVoiceHistoryEntries(entries, zh).map((group) => group.label),
		["今天", "昨天", "2026年7月20日", "日期未知"],
	);
	assert.deepEqual(
		groupVoiceHistoryEntries([entries[0]!, entries[3]!], { now, locale: "en" }).map((group) => group.label),
		["today", "Unknown date"],
	);
});

test("voice History preserves entry order inside date groups", () => {
	const entries = [
		{ id: "newest", createdAt: new Date(2026, 6, 22, 11).toISOString() },
		{ id: "today-older", createdAt: new Date(2026, 6, 22, 9).toISOString() },
		{ id: "yesterday", createdAt: new Date(2026, 6, 21, 22).toISOString() },
		{ id: "older", createdAt: new Date(2026, 6, 20, 10).toISOString() },
	];

	assert.deepEqual(
		groupVoiceHistoryEntries(entries, zh).map((group) => ({
			label: group.label,
			ids: group.entries.map((entry) => entry.id),
		})),
		[
			{ label: "今天", ids: ["newest", "today-older"] },
			{ label: "昨天", ids: ["yesterday"] },
			{ label: "2026年7月20日", ids: ["older"] },
		],
	);
});
