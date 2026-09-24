import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { upsertUserTaskHistory } from "../../server/observability/task-history.js";
import { serverRuntimeDirForGoal } from "../../server/workspaces/server-runtime-paths.js";
import { composeAgentSystemPrompt } from "../../server/agent-runtime/global-system-prompt.js";
import { GoalTopicPlanStore } from "../../server/goals/topic-plan/index.js";
import { createResearchHistoryTool } from "../../server/main-agent/tools/research.js";
import { buildMainAgentPrompt } from "../../server/main-agent/system-prompts.js";

const workspaceDir = mkdtempSync(join(tmpdir(), "pi-main-topic-readiness-"));
const goalId = "goal_prompt_test";
upsertUserTaskHistory(serverRuntimeDirForGoal(goalId, workspaceDir), {
 version: 1, type: "task_history", taskId: "prior-search", source: "main_agent", goalId,
 createdAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-01T00:01:00Z",
 originalQuestion: "Prior request", canonicalResearchTask: "Previously searched evidence boundary",
 labels: {}, normalizedInput: "Previously searched evidence boundary", route: { executionKind: "research_runtime", workspaceRunId: "prior-run" },
});
const prompt = buildMainAgentPrompt(
	workspaceDir,
	goalId,
	"Research Goal",
	"Route one research task through the Goal workspace.",
);
assert.match(prompt, /Topic Plan: not confirmed/u);
assert.match(prompt, /Previously searched evidence boundary/u);
assert.match(prompt, /search_question/u);
assert.match(prompt, /report_context/u);
assert.match(prompt, /Reply in the language of the user's current request/u);
assert.match(
	buildMainAgentPrompt(workspaceDir, goalId, "Goal", "", "zh-CN"),
	/Reply in zh-CN/u,
);

const topicStore = new GoalTopicPlanStore(goalId, workspaceDir);
const proposal = topicStore.proposePatch({ source: "main_agent", patch: {
	schema_version: 1,
	base_revision: null,
	summary: "Confirm one Topic",
	operations: [{ op: "add", topic: {
		id: "research",
		title: "Research",
		intent: "Research the Goal",
		questions: [], include: [], exclude: [],
	} }],
} });
const active = topicStore.activate(proposal.proposal_id);
assert.match(buildMainAgentPrompt(workspaceDir, goalId, "Goal", ""), /Topic Plan: confirmed/u);
topicStore.proposePatch({ source: "main_agent", patch: {
	schema_version: 1,
	base_revision: active.revision,
	summary: "Adjust the confirmed Topic",
	operations: [{ op: "update", topic_id: active.topics[0]!.id, set: { include: ["evidence"] } }],
} });
assert.match(buildMainAgentPrompt(workspaceDir, goalId, "Goal", ""), /Topic Plan: changes await confirmation/u);

assert.match(prompt, /Research Goal[\s\S]+Route one research task through the Goal workspace/u,
	"Main Agent prompt must include both Goal title and description");

for (const required of [
	"research",
	"/work",
	"A normal assistant reply",
]) {
	assert.match(prompt, new RegExp(required, "u"), `Main Agent prompt must retain ${required}`);
}

for (const obsolete of [
	"You are an expert coding assistant operating inside pi",
	"Pi documentation (read only when",
	"Citation rules",
	"[CITE:",
	"Adaptive Harness Workspace",
	"Generator",
	"Writer",
	"You run on the host machine",
	"You run inside Docker",
]) {
	assert.doesNotMatch(prompt, new RegExp(obsolete.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"),
		`Main Agent prompt must not include obsolete section: ${obsolete}`);
}

assert.doesNotMatch(prompt, /Available tools:/u,
	"Main Agent must rely on provider Tool schemas instead of duplicating Tool names in the Prompt");
assert.doesNotMatch(prompt, /workspace_read/u, "Main Agent must not expose the removed workspace reader");
assert.doesNotMatch(prompt, /direct_reply/u, "Main Agent must reply without a dedicated Tool");
assert.match(prompt, /do not repeat the same call in that turn/u,
	"Main Agent must surface terminal Tool failures instead of repeating expensive work");
assert.doesNotMatch(prompt, /\/knowledge|\/user/u,
	"Main Agent prompt must describe only mounted sandbox paths");
assert.doesNotMatch(prompt, /Capability Revision|sha256:/u,
	"Runtime capability metadata must not leak into the semantic Prompt");
assert.doesNotMatch(prompt, /Goal Harness|capability snapshot|artifacts\/main|historical Run|job IDs/u,
	"Runtime implementation details must not leak into the semantic Prompt");
assert.doesNotMatch(prompt, /Show file paths clearly/u,
	"Main Agent must not inherit the Coding Agent file-path guideline");
assert.doesNotMatch(prompt, /rebuild=true|research\.schedule|latest, current, recent/u,
	"Specialized workflow instructions belong in Skills");
assert.doesNotMatch(prompt, /Task Scope/u, "Main Agent must not expose a second conversation Agent");
assert.doesNotMatch(prompt, /workspace_list/u, "Main Agent must not spend a Tool call selecting the fixed main workspace");
assert.ok(prompt.indexOf("Guidelines:") < prompt.indexOf("You are the telomi Main Agent"),
	"Global system prompt must precede the Agent prompt");
const composed = composeAgentSystemPrompt("ROLE_PROMPT", {
	tools: [{ name: "read", promptSnippet: "Read file contents", promptGuidelines: ["Read only what is needed"] }],
});
assert.match(composed, /- read: Read file contents/u);
assert.match(composed, /- Read only what is needed/u);
assert.ok(composed.endsWith("ROLE_PROMPT"));
assert.doesNotMatch(composeAgentSystemPrompt("ROLE_PROMPT"), /Available tools:/u);

assert.ok(prompt.length < 2_600,
	`Main Agent prompt should stay concise, received ${prompt.length} chars`);

console.log(`Main Agent system prompt contract passed (${prompt.length} chars)`);
for (let index = 0; index < 12; index++) {
	upsertUserTaskHistory(serverRuntimeDirForGoal(goalId, workspaceDir), {
		version: 1, type: "task_history", taskId: `run-${index}`, source: "main_agent", goalId,
		createdAt: `2026-09-02T00:${String(index).padStart(2, "0")}:00Z`, updatedAt: "2026-09-02T01:00:00Z",
		originalQuestion: "Research", canonicalResearchTask: `Search ${index}`, normalizedInput: `Search ${index}`, labels: {},
		route: { executionKind: "research_runtime", workspaceRunId: `run-${index}` },
		researchRun: { workspaceRunId: `run-${index}`, status: "failed", workflowId: "research-run", workflowVersion: 26, errorMessage: "Unavailable" },
	});
}
const historyPrompt = buildMainAgentPrompt(workspaceDir, goalId, "Goal", "Description");
assert.doesNotMatch(historyPrompt, /Previously searched evidence boundary/);
assert.match(historyPrompt, /research_history/);
const historyTool = createResearchHistoryTool({ goalId, workspaceDir });
const firstPage = await historyTool.execute("history", { offset: 0, limit: 10 });
assert.equal(firstPage.details.runs.length, 10);
assert.equal(firstPage.details.runs[0]?.status, "failed");
assert.equal(firstPage.details.next_offset, 10);
const lastPage = await historyTool.execute("history-2", { offset: 10, limit: 10 });
assert.equal(lastPage.details.runs.at(-1)?.search_question, "Previously searched evidence boundary");
assert.equal(lastPage.details.next_offset, null);
rmSync(workspaceDir, { recursive: true, force: true });
