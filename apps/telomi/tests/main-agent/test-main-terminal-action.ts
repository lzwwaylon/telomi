import assert from "node:assert/strict";

import type { AgentTool } from "@earendil-works/pi-agent-core";
import { validateToolArguments } from "@earendil-works/pi-ai";
import { Type } from "@sinclair/typebox";

import {
	asTerminalTool,
	createAssistantReplyDetails,
	parseMainTerminalDetails,
} from "../../server/main-agent/tools/terminal-action.js";
import { createMainResearchTool } from "../../server/main-agent/tools/research.js";

const signal = new AbortController().signal;
const update = () => undefined;
const researchTool = createMainResearchTool("/tmp/goal", { goalId: "goal-test" });
assert.deepEqual(validateToolArguments(researchTool, {
	type: "toolCall",
	id: "research-null-schedule",
	name: "research",
	arguments: { search_question: "Research speech generation.", report_context: "Report new findings for an expert reader.", schedule: null },
}), { search_question: "Research speech generation.", report_context: "Report new findings for an expert reader.", schedule: null });
assert.throws(() => validateToolArguments(researchTool, {
 type: "toolCall", id: "missing-report-context", name: "research",
 arguments: { search_question: "Research speech generation." },
}), /report_context/u);
const directResult = createAssistantReplyDetails(" 已保存笔记。 ");
assert.equal(directResult.action, "assistant_reply");
assert.equal(directResult.userResponse, "已保存笔记。");
assert.equal(directResult.trace.reasonCode, "assistant_reply");

assert.throws(() => createAssistantReplyDetails("  "), /without a reply/u);

const taskScopeBase: AgentTool<any> = {
	name: "research",
	label: "research",
	description: "test",
	parameters: Type.Object({}),
	execute: async () => ({
		content: [{ type: "text", text: "Published report" }],
		details: { runId: "run-child" },
	}),
};
const taskScope = asTerminalTool(taskScopeBase, "research", "external_research_requested");
const taskScopeResult = await taskScope.execute("research", {}, signal, update);
assert.equal(taskScopeResult.terminate, true);
assert.equal(taskScopeResult.details.action, "research");
assert.equal(taskScopeResult.details.trace.selectedRunId, "run-child");
assert.equal(taskScopeResult.details.userResponse, "Published report");

const concise = asTerminalTool({
	...taskScopeBase,
	execute: async () => ({
		content: [{ type: "text", text: "# Full report\n\nLong report body" }],
		details: { runId: "run-concise", userResponse: "Research complete. Short summary." },
	}),
}, "research", "external_research_requested");
const conciseResult = await concise.execute("research", {}, signal, update);
assert.equal(conciseResult.details.userResponse, "Research complete. Short summary.");

for (const invalid of [
	undefined,
	{},
	{ terminal: true, action: "unknown", userResponse: "x", trace: {} },
	{ terminal: true, action: "assistant_reply", userResponse: "", trace: {} },
	{
		terminal: true,
		action: "assistant_reply",
		userResponse: "x",
		trace: { coarseAction: "unknown", reasonCode: "x" },
	},
]) {
	assert.equal(parseMainTerminalDetails(invalid), undefined);
}

console.log("Main Agent terminal action contract tests passed");
