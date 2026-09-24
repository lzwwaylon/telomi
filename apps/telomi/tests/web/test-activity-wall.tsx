import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { GoalSummary } from "../../shared/types.js";
import type { ActivityProjectionItem } from "../../shared/events/activity-projection.js";
import { ActivityWall } from "../../web/src/features/home/ActivityWall.js";

const timestamp = "2026-09-15T00:00:00.000Z";
const goal: GoalSummary = {
	id: "tts", title: "语音合成研究", description: "", preview: "",
	createdAt: timestamp, updatedAt: timestamp, lastActivityAt: timestamp,
	messageCount: 0, isStreaming: false, fresh: false, pulseLine: null,
	avatar: { head: "tufts", eye: "round", color: "sky" }, discoveryEnabled: false, outputLanguage: "zh-CN",
};
const research: ActivityProjectionItem = {
	activityId: "research", kind: "research", scope: { kind: "goal", goalId: goal.id },
	trigger: { kind: "manual" }, title: "研究语音合成", summary: "正在检索语音合成论文",
	lifecycle: "running", timing: { createdAt: timestamp, updatedAt: timestamp },
	resultLinks: [], steps: [], sourceRef: "research",
};
const wiki: ActivityProjectionItem = {
	...research, activityId: "wiki", kind: "wiki-update", lifecycle: "finished", outcome: "succeeded",
	title: "更新 Goal Wiki", summary: "Goal Wiki 已更新 · 53 个页面", sourceRef: "wiki",
};
const html = renderToStaticMarkup(<ActivityWall
	goals={[goal]}
	activities={[research, { ...research, activityId: "second-run" }, wiki, {
		...wiki, activityId: "failed-wiki", outcome: "failed", summary: "Wiki 更新失败，请重试",
	}]}
	onSelectGoal={() => {}}
/>);
assert.ok(html.includes(wiki.summary), "Homepage history describes finished work by its summary");
assert.ok(html.includes("Wiki 更新失败，请重试"), "A failed Activity still explains the failure");
assert.ok(html.includes("1 个 Goal 在运行"), "Two Activities in one Goal count as one explicitly labelled Goal");
console.log("Activity wall summary and count presentation passed");

const { stripMarkdownForPill } = await import("../../shared/strip-markdown.js");
assert.equal(stripMarkdownForPill("## 摘要\n- **模型**：`export_speech_decoder_onnx.py` [官方说明](https://example.com/docs)\n```ts\nsecretCode()\n```"), "摘要 模型：export_speech_decoder_onnx.py 官方说明");
assert.equal(stripMarkdownForPill("结果[[1]](htt"), "结果[1]", "old previews may end inside a citation URL");
assert.equal(stripMarkdownForPill("[官方说明](https://example.com/" + "a".repeat(150) + ") 后续结论"), "官方说明 后续结论", "strip URLs before truncation to retain the following text");

const finished = { ...research, lifecycle: "finished" as const, outcome: "succeeded" as const, summary: "研究报告已发布" };
function card(activities: ActivityProjectionItem[], pulseLine: string | null, preview = "") {
	return renderToStaticMarkup(<ActivityWall goals={[{ ...goal, pulseLine, preview }]} activities={activities} onSelectGoal={() => {}} />);
}
const idleCard = card([finished], "- **结论**：使用 `export_speech_decoder_onnx.py`。[[1]](htt");
assert.match(idleCard, /class="t-doing">研究报告已发布<\/div>/u);
assert.match(idleCard, /class="t-conversation">最近对话：结论：使用 export_speech_decoder_onnx.py。\[1\]<\/div>/u);
assert.doesNotMatch(idleCard, /\*\*|`|\]\(htt/u);
assert.match(card([research], "旧回复"), /class="t-doing">正在检索语音合成论文<\/div>/u);
assert.match(card([], null, "**保存的预览**"), /最近对话：保存的预览/u);
assert.doesNotMatch(card([], null), /class="t-conversation"/u);
assert.match(card([{ ...research, lifecycle: "waiting", summary: "等待确认" }, finished], "上一轮回复"), /class="t-doing">等待确认<\/div>/u);

assert.equal((card([finished, { ...finished, activityId: "duplicate" }], null).match(/研究报告已发布/gu) ?? []).length, 1, "primary status is not repeated in history");

assert.equal(stripMarkdownForPill("[语音合成](https://en.wikipedia.org/wiki/Speech_(synthesis)) 后续结论"), "语音合成 后续结论");
