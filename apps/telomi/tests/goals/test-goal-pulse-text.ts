import assert from "node:assert/strict";
import { test } from "node:test";

import "../web/setup-ui-locale.js";

import { resolveGoalPulseText } from "../../web/src/features/goals/pulse-text.js";
import type { GoalSnapshot, GoalSummary } from "../../shared/types.js";

function snapshot(overrides: Partial<GoalSnapshot>): GoalSnapshot {
	return { ...overrides } as GoalSnapshot;
}

function summary(overrides: Partial<GoalSummary>): GoalSummary {
	return { ...overrides } as GoalSummary;
}

test("an error message outranks every other status and keeps the foreground slot live", () => {
	const pulse = resolveGoalPulseText(
		snapshot({ errorMessage: " 模型调用失败 ", statusMessage: "正在收尾", pulseLine: "正在阅读来源", isStreaming: true }),
		summary({ pulseLine: "上次运行" }),
	);
	assert.equal(pulse.text, "模型调用失败");
	assert.equal(pulse.tone, "error");
	assert.equal(pulse.dot, "error");
	assert.equal(pulse.source, "error");
	assert.deepEqual(pulse.foregroundSlot, { text: "模型调用失败", tone: "error", active: true });
	assert.equal(pulse.isPlaceholder, false);
});

test("a status message outranks the pulse line of a running goal", () => {
	const pulse = resolveGoalPulseText(
		snapshot({ statusMessage: "正在等待确认", pulseLine: "正在阅读来源", isStreaming: true }),
		null,
	);
	assert.equal(pulse.text, "正在等待确认");
	assert.equal(pulse.tone, "muted");
	assert.equal(pulse.dot, "live");
	assert.equal(pulse.source, "status");
	assert.deepEqual(pulse.foregroundSlot, { text: "正在等待确认", tone: "muted", active: true });
});

test("stopping without a status message reads as stopping and stays active", () => {
	const pulse = resolveGoalPulseText(snapshot({ stopState: "stopping", isStreaming: false }), null);
	assert.equal(pulse.text, "正在停止…");
	assert.equal(pulse.tone, "muted");
	assert.equal(pulse.dot, "idle");
	assert.equal(pulse.source, "status");
	assert.deepEqual(pulse.foregroundSlot, { text: "正在停止…", tone: "muted", active: true });
});

test("a running goal shows its pulse line, preferring the snapshot over the list summary", () => {
	const pulse = resolveGoalPulseText(
		snapshot({ isStreaming: true, pulseLine: "正在阅读来源" }),
		summary({ pulseLine: "上次运行" }),
	);
	assert.equal(pulse.text, "正在阅读来源");
	assert.equal(pulse.tone, "normal");
	assert.equal(pulse.dot, "live");
	assert.equal(pulse.source, "foreground");
	assert.deepEqual(pulse.foregroundSlot, { text: "正在阅读来源", tone: "normal", active: true });
});

test("a running goal without a pulse line falls back to the running text", () => {
	const pulse = resolveGoalPulseText(snapshot({ isStreaming: true, pulseLine: "   " }), null);
	assert.equal(pulse.text, "正在运行…");
	assert.equal(pulse.source, "foreground");
	assert.equal(pulse.dot, "live");
});

test("an idle goal keeps the last pulse line from the list summary without claiming activity", () => {
	const pulse = resolveGoalPulseText(snapshot({ isStreaming: false }), summary({ pulseLine: "上次运行" }));
	assert.equal(pulse.text, "上次运行");
	assert.equal(pulse.tone, "normal");
	assert.equal(pulse.dot, "idle");
	assert.equal(pulse.source, "foreground");
	assert.deepEqual(pulse.foregroundSlot, { text: "上次运行", tone: "normal", active: false });
	assert.equal(pulse.isPlaceholder, false);
});

test("a goal with nothing to report falls through to the idle placeholder", () => {
	for (const [snap, goal] of [[null, null], [snapshot({ pulseLine: " " }), summary({ pulseLine: "" })]] as const) {
		const pulse = resolveGoalPulseText(snap, goal);
		assert.equal(pulse.text, "暂无活动");
		assert.equal(pulse.tone, "muted");
		assert.equal(pulse.dot, "idle");
		assert.equal(pulse.source, "placeholder");
		assert.equal(pulse.foregroundSlot, null);
		assert.equal(pulse.isPlaceholder, true);
	}
});
