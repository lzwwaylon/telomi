import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AgentTool } from "@earendil-works/pi-agent-core";
import { validateToolArguments } from "@earendil-works/pi-ai";
import { Type } from "@sinclair/typebox";

import {
	asTerminalTool,
	createAssistantReplyDetails,
	parseMainTerminalDetails,
} from "../../server/main-agent/tools/terminal-action.js";
import { createMainResearchTool } from "../../server/main-agent/tools/research.js";
import { createDeliverInvestigationTool, createInvestigateTool } from "../../server/main-agent/tools/investigate.js";
import { createMainAgentTools } from "../../server/main-agent/tools/index.js";
import { serverRuntimeDirForGoalDir } from "../../server/workspaces/server-runtime-paths.js";

const signal = new AbortController().signal;
const update = () => undefined;
const researchTool = createMainResearchTool("/tmp/goal", { goalId: "goal-test" });
const investigateTool = createInvestigateTool("/tmp/goal", { goalId: "goal-test" });
const mainToolNames = createMainAgentTools("/tmp/goal", () => [], { goalId: "goal-test" }).map((tool) => tool.name);
assert.ok(mainToolNames.includes("investigate") && mainToolNames.includes("wiki_update"));
assert.deepEqual(mainToolNames.filter((name) => ["wiki_search", "wiki_read_page", "wiki_graph_search"].includes(name)), []);
assert.equal(validateToolArguments(investigateTool, {
	type: "toolCall", id: "missing-scope", name: "investigate", arguments: { question: "Check saved materials." },
}).source_scope, undefined);
assert.equal(validateToolArguments(investigateTool, {
	type: "toolCall", id: "local-scope", name: "investigate",
	arguments: { question: "Check saved materials.", source_scope: "local_only" },
}).source_scope, "local_only");
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

const cited = "A=8+n-1 <cite>deep-search:read-1:cue-1</cite>";
const investigationDelivery = asTerminalTool({
	...taskScopeBase,
	name: "deliver_investigation",
	execute: async () => ({ content: [{ type: "text", text: JSON.stringify({ answer: cited }) }],
		details: { userResponse: cited } }),
}, "deliver_investigation", "local_knowledge_delivered");
const deliveryResult = await investigationDelivery.execute("deliver_investigation", {}, signal, update);
assert.equal(deliveryResult.terminate, true);
assert.equal(parseMainTerminalDetails(deliveryResult.details)?.userResponse, cited);
assert.equal(parseMainTerminalDetails({ ...deliveryResult.details, action: "investigate",
	trace: { coarseAction: "investigate", reasonCode: "local_knowledge_investigated" } })?.action, "investigate");

const root = mkdtempSync(join(tmpdir(), "main-investigation-delivery-"));
try {
	const goalDir = join(root, "goal_test");
	const id = "a".repeat(24);
	const runDir = join(serverRuntimeDirForGoalDir(goalDir), "research", "investigations", id);
	mkdirSync(runDir, { recursive: true });
	writeFileSync(join(runDir, "request.json"), JSON.stringify({ id, question: "Check the loss." }));
	writeFileSync(join(runDir, "result.json"), JSON.stringify({ id, question: "Check the loss.",
		answer: cited, citation_refs: ["deep-search:read-1:cue-1"], gaps: [], wiki_sha256: "hash" }));
	const delivery = createDeliverInvestigationTool(goalDir);
	const stored = await delivery.execute("deliver", { investigation_id: id }, signal, update);
	assert.equal(stored.details.userResponse, cited);
	assert.throws(() => validateToolArguments(delivery, { type: "toolCall", id: "bad-id",
		name: "deliver_investigation", arguments: { investigation_id: "../elsewhere" } }), /investigation_id/u);
} finally {
	rmSync(root, { recursive: true, force: true });
}

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
