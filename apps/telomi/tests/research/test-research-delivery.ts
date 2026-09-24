import assert from "node:assert/strict";

import { getVisibleMessages } from "../../server/main-agent/runner.js";
import { reportPublishedResponse, reportTitle, researchSkippedResponse, scheduleCreatedResponse } from "../../server/research/reports/delivery.js";
import { setUiLocale } from "../../web/src/app/i18n.js";
import { groupMessagesIntoTurns } from "../../web/src/features/chat/turn-adapter.js";
import { researchDeliveryFromReport } from "../../web/src/features/chat/research-delivery.js";
import { reportReference } from "../../server/research/reports/delivery.js";

await setUiLocale("zh-CN");

const callId = "research-1";
const user = { role: "user", content: [{ type: "text", text: "调研语音模型" }], timestamp: 1 };
const router = {
	role: "assistant",
	content: [
		{ type: "thinking", thinking: "internal routing" },
		{ type: "toolCall", id: callId, name: "research", arguments: { task: "调研语音模型" } },
	],
	timestamp: 2,
};
const result = {
	role: "toolResult",
	toolCallId: callId,
	toolName: "research",
	content: [{ type: "text", text: "Report published.\nTitle: 语音模型调研\nReport: /workspace/wiki/runs/run-1/report/final.md" }],
	details: {
		runId: "run-1",
		status: "published",
		stableFinalReportPath: "/workspace/wiki/runs/run-1/report/final.md",
		reportTitle: "语音模型调研",
	},
	isError: false,
	timestamp: 3,
};
const visible = {
	role: "assistant",
	mainRoute: { report: reportReference("run-1", "/workspace/wiki/runs/run-1/report/final.md", "语音模型调研") },
	content: [{ type: "text", text: "调研已完成。" }],
	timestamp: 4,
};

const filtered = getVisibleMessages([user, router, result, visible]);
assert.deepEqual((filtered[1] as typeof router).content, router.content, "UI keeps the routing text and the Tool call as Turn Activity");

const turns = groupMessagesIntoTurns(filtered as never[], {
	toolResultMap: new Map([[callId, result as never]]),
	pendingToolCalls: new Set(),
	isStreaming: false,
	lastAssistantIndex: 3,
});
const assistant = turns.find((turn) => turn.type === "assistant");
assert.ok(assistant && assistant.type === "assistant");
assert.deepEqual(assistant.activities.filter((activity) => activity.type === "tool").map((activity) => activity.toolName), ["research"]);
const expectedDelivery = {
	runId: "run-1",
	title: "语音模型调研",
	lede: "报告已生成，点击查看完整内容。",
	artifactName: "wiki/runs/run-1/report/final.md",
	cardId: "path_d2lraS9ydW5zL3J1bi0xL3JlcG9ydC9maW5hbA",
};
assert.deepEqual(researchDeliveryFromReport(assistant.report), expectedDelivery);

// A resumed Run publishes without a Tool call in the Turn; the stamped reply alone carries the card.
const resumedTurns = groupMessagesIntoTurns(getVisibleMessages([user, visible]) as never[], {
	toolResultMap: new Map(),
	pendingToolCalls: new Set(),
	isStreaming: false,
	lastAssistantIndex: 1,
});
const resumed = resumedTurns.find((turn) => turn.type === "assistant");
assert.ok(resumed && resumed.type === "assistant");
assert.deepEqual(researchDeliveryFromReport(resumed.report), expectedDelivery);
assert.equal(researchDeliveryFromReport(undefined), null, "a reply without a published report has no card");
assert.equal(reportReference("run-1", "/reports/run-1/final.md", "x"), undefined,
	"only the stable published path is a report reference");

// Runtime-written replies follow the Run's resolved language instead of a fixed one.
for (const reply of [reportPublishedResponse, researchSkippedResponse, (language: "zh-CN" | "en") => scheduleCreatedResponse(language, "X")]) {
	assert.match(reply("zh-CN"), /\p{Script=Han}/u);
	assert.doesNotMatch(reply("en"), /\p{Script=Han}/u);
}

console.log("research delivery: stamped reply and report card metadata passed");

assert.equal(reportTitle("# 完整报告\n\n正文不会进入 ToolResult。"), "完整报告");
assert.equal(reportTitle("正文", "指定标题"), "指定标题");

const readCallId = "read-1";
const readCall = {
	role: "assistant",
	content: [
		{ type: "thinking", thinking: "internal reasoning" },
		{ type: "toolCall", id: readCallId, name: "read", arguments: { path: "/work/topic-plan.json" } },
	],
	timestamp: 6,
};
const readResult = {
	role: "toolResult",
	toolCallId: readCallId,
	toolName: "read",
	content: [{ type: "text", text: "{}" }],
	isError: false,
	timestamp: 7,
};
const writeCallId = "write-1";
const writeCall = {
	role: "assistant",
	content: [{ type: "toolCall", id: writeCallId, name: "write", arguments: {
		path: "/work/topic-plan.json",
		content: "{}",
	} }],
	timestamp: 8,
};
const writeResult = {
	role: "toolResult",
	toolCallId: writeCallId,
	toolName: "write",
	content: [{ type: "text", text: "written" }],
	isError: false,
	timestamp: 9,
};
const ordinaryVisible = { ...visible, timestamp: 10 };
const ordinaryTurn = getVisibleMessages([
	user, readCall, readResult, writeCall, writeResult, ordinaryVisible,
]);
const ordinaryTurns = groupMessagesIntoTurns(ordinaryTurn as never[], {
	toolResultMap: new Map([[readCallId, readResult as never], [writeCallId, writeResult as never]]),
	pendingToolCalls: new Set(),
	isStreaming: false,
	lastAssistantIndex: ordinaryTurn.length - 1,
});
const ordinaryAssistant = ordinaryTurns.find((turn) => turn.type === "assistant");
assert.ok(ordinaryAssistant && ordinaryAssistant.type === "assistant");
assert.deepEqual(
	ordinaryAssistant.activities.filter((activity) => activity.type === "tool").map((activity) => activity.toolName),
	["read", "write"],
	"UI must retain ordinary Main Agent Tool calls for Turn Activity",
);
assert.equal(ordinaryAssistant.intent, "write · topic-plan.json",
	"completed Turn Activity must summarize the latest Tool call");
