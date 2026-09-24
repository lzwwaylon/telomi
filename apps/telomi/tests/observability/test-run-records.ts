import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	agentSessionPath,
	agentSystemPromptPath,
	appendNodeExecutionRecord,
	appendResearchNodeRecord,
	appendRuntimeContext,
	latestNodeDependencyIds,
	readRunRecords,
	readAgentNodeUsage,
	runRecordDir,
	runtimeContextPath,
	sealInterruptedAgentExecutions,
	validateNodeExecutionTrace,
	writeAgentSystemPrompt,
} from "../../server/observability/run-records.js";
import { readRuntimeStageReports } from "../../server/research/workspace-adapter.js";

const root = mkdtempSync(join(tmpdir(), "telomi-run-records-"));
const runDir = runRecordDir(root, "goal_123", "Run:123");
const plannerPath = agentSessionPath(runDir, "Cornell Note", "A001");
const plannerPromptPath = agentSystemPromptPath(runDir, "Cornell Note", "Cornell Note 1", "Attempt:1");

assert.equal(runDir, join(root, ".pi", "runtime", "harness", "goal_123", "runs", "Run-123"));
assert.equal(plannerPath, join(runDir, "cornell-note--a001.jsonl"));
assert.equal(
	plannerPromptPath,
	join(runDir, "cornell-note--cornell-note-1--attempt-1.system-prompt.txt"),
);
assert.equal(runtimeContextPath(runDir, "research"), join(runDir, "runtime--research.jsonl"));
for (const kind of ["main", "evaluation"] as const) {
	const directory = join(root, kind);
	const node = appendNodeExecutionRecord(directory, kind, {
		node_id: `${kind}-agent`,
		node_type: "agent",
		agent: `${kind}_agent`,
		execution_id: "attempt-1",
		attempt: 1,
		status: "succeeded",
		group_id: null,
		depends_on: [],
		input: {},
		output: {},
		time: {
			started_at: "2026-07-29T00:00:00.000Z",
			finished_at: "2026-07-29T00:00:01.000Z",
			duration_ms: 1_000,
		},
	});
	assert.equal(node.event_id, 1);
	assert.equal(readRunRecords(directory).runtime?.kind, kind);
}

mkdirSync(runDir, { recursive: true });
const systemPrompt = "Exact Agent system prompt\nwithout an injected trailing newline";
assert.equal(
	writeAgentSystemPrompt(runDir, "Cornell Note", "Cornell Note 1", "Attempt:1", systemPrompt),
	plannerPromptPath,
);
assert.equal(readFileSync(plannerPromptPath, "utf-8"), systemPrompt);
assert.equal(statSync(plannerPromptPath).mode & 0o777, 0o600);
chmodSync(plannerPromptPath, 0o644);
writeAgentSystemPrompt(runDir, "Cornell Note", "Cornell Note 1", "Attempt:1", systemPrompt);
assert.equal(statSync(plannerPromptPath).mode & 0o777, 0o600);
writeFileSync(plannerPath, [
	JSON.stringify({ type: "session", id: "pi-session-1" }),
	JSON.stringify({ type: "message", message: { role: "toolResult", toolName: "submit_stage_output" } }),
].join("\n") + "\n", "utf-8");
appendRuntimeContext(runDir, "research", {
	type: "agent.bound",
	agent: "cornell-note",
	execution_id: "a001",
	session_file: "cornell-note--a001.jsonl",
});
appendRuntimeContext(runDir, "research", { type: "runtime.validation_succeeded", execution_id: "a001" });
appendRuntimeContext(runDir, "research", {
	type: "runtime.agent_bound",
	stage_id: "cornell-note-1",
	execution_id: "a001",
	attempt: 1,
	agent: "cornell_note",
	session_file: "cornell-note--a001.jsonl",
	system_prompt_file: "cornell-note--cornell-note-1--attempt-1.system-prompt.txt",
});
appendRuntimeContext(runDir, "research", {
	type: "runtime.stage_completed",
	stage_id: "cornell-note-1",
	execution_id: "a001",
	metrics: {
		turns: 2,
		tool_calls: 3,
		tool_counts: { bash: 2, submit_stage_output: 1 },
		input_tokens: 100,
		output_tokens: 20,
		cost_usd: 0.01,
		model_calls: 1,
	},
});
appendRuntimeContext(runDir, "research", {
	type: "runtime.agent_bound",
	stage_id: "evidence-screening-source-1",
	execution_id: "evidence-screening-attempt-a936643b",
	attempt: 1,
	agent: "cornell_note",
	session_file: "evidence-screening--attempt-a936643b.jsonl",
});
appendRuntimeContext(runDir, "research", {
	type: "runtime.stage_cancelled",
	stage_id: "evidence-screening-source-1",
	execution_id: "evidence-screening-attempt-a936643b",
	error: "Agent stage cancelled by user",
});
const plannerNode = appendResearchNodeRecord(runDir, {
	node_id: "cornell-note-1",
	node_type: "agent",
	agent: "cornell_note",
	execution_id: "a001",
	attempt: 1,
	status: "succeeded",
	group_id: null,
	depends_on: [],
	input: { stage_id: "cornell-note-1" },
	output: { artifact_ref: "artifacts/cornell-notes/cornell-note-1.json" },
	time: {
		started_at: "2026-07-29T00:00:00.000Z",
		finished_at: "2026-07-29T00:00:01.000Z",
		duration_ms: 1_000,
	},
	trace_ref: "cornell-note--a001.jsonl",
});
const workerOne = appendResearchNodeRecord(runDir, {
	node_id: "prime-search-1",
	node_type: "agent",
	agent: "prime_search",
	execution_id: "worker-1",
	attempt: 1,
	status: "succeeded",
	group_id: "prime-searchs-1",
	depends_on: [plannerNode.event_id],
	input: {},
	output: {},
	time: {
		started_at: "2026-07-29T00:00:01.000Z",
		finished_at: "2026-07-29T00:00:02.000Z",
		duration_ms: 1_000,
	},
});
const workerTwo = appendResearchNodeRecord(runDir, {
	node_id: "prime-search-2",
	node_type: "agent",
	agent: "prime_search",
	execution_id: "worker-2",
	attempt: 1,
	status: "succeeded",
	group_id: "prime-searchs-1",
	depends_on: [plannerNode.event_id],
	input: {},
	output: {},
	time: {
		started_at: "2026-07-29T00:00:01.000Z",
		finished_at: "2026-07-29T00:00:03.000Z",
		duration_ms: 2_000,
	},
});
const nativePrimeTrace = agentSessionPath(runDir, "prime-search", "native-usage");
writeFileSync(nativePrimeTrace, [
	JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "starting" }] } }),
	JSON.stringify({ type: "message", message: { role: "assistant", usage: { input: 7, output: 3, cost: { total: 0.02 } } } }),
].join("\n") + "\n");
const nativePrimeTree = join(runDir, "prime-search-traces", "native-usage", "session-artifacts", "child");
mkdirSync(nativePrimeTree, { recursive: true });
writeFileSync(join(nativePrimeTree, "child.jsonl"), `${JSON.stringify({
	type: "message",
	message: { role: "assistant", usage: { input: 11, output: 5, cost: { total: 0.04 } } },
})}\n`);
writeFileSync(join(nativePrimeTree, "root.jsonl"), `${JSON.stringify({
	type: "message",
	message: { role: "assistant", usage: { input: 7, output: 3, cost: { total: 0.02 } } },
})}\n`);
appendResearchNodeRecord(runDir, {
	node_id: "prime-search-native-usage",
	node_type: "agent",
	agent: "prime_search",
	execution_id: "native-usage",
	attempt: 1,
	status: "succeeded",
	group_id: null,
	depends_on: [workerTwo.event_id],
	input: {},
	output: { metrics: { model_calls: 2 } },
	time: {
		started_at: "2026-07-29T00:00:03.000Z",
		finished_at: "2026-07-29T00:00:04.000Z",
		duration_ms: 1_000,
	},
	trace_ref: "prime-search--native-usage.jsonl",
});
assert.ok(plannerNode.event_id < workerOne.event_id);
assert.ok(workerOne.event_id < workerTwo.event_id);
assert.deepEqual(latestNodeDependencyIds(runDir, "research"), [
	workerTwo.event_id + 1,
]);
assert.deepEqual(readAgentNodeUsage(runDir, "research"), {
	inputTokens: 18,
	outputTokens: 8,
	costUsd: 0.06,
	modelCalls: 2,
	completeExecutions: 1,
	incompleteExecutionIds: ["a001", "worker-1", "worker-2"],
});

const parsed = readRunRecords(runDir);
assert.equal(parsed.runId, "Run-123");
assert.equal(parsed.runtime?.kind, "research");
assert.deepEqual(parsed.runtime?.events.map((event) => event.type), [
	"agent.bound",
	"runtime.validation_succeeded",
	"runtime.agent_bound",
	"runtime.stage_completed",
	"runtime.agent_bound",
	"runtime.stage_cancelled",
	"node_execution",
	"node_execution",
	"node_execution",
	"node_execution",
]);
assert.equal(parsed.agentSessions.length, 2);
const parsedPlanner = parsed.agentSessions.find((session) => session.agent === "cornell-note");
assert.equal(parsedPlanner?.executionId, "a001");
assert.equal(parsedPlanner?.entries.length, 2);
assert.equal(parsedPlanner?.toolCompletions.length, 1);
assert.equal(parsedPlanner?.toolCompletions[0]?.toolName, "submit_stage_output");
assert.equal(parsedPlanner?.toolCompletions[0]?.isError, false);

const reports = readRuntimeStageReports(runDir, "Run-123");
const plannerReport = reports.find((report) => report.stage_id === "cornell-note-1");
const cancelledReport = reports.find((report) => report.stage_id === "evidence-screening-source-1");
assert.equal(plannerReport?.attempt, 1);
assert.equal(plannerReport?.metrics.tool_calls, 3);
assert.equal(plannerReport?.metrics.model_calls, 1);
assert.deepEqual(plannerReport?.metrics.tool_counts, { bash: 2, submit_stage_output: 1 });
assert.equal(
	plannerReport?.system_prompt_file,
	"cornell-note--cornell-note-1--attempt-1.system-prompt.txt",
);
assert.equal(cancelledReport?.attempt, 1);
assert.equal(cancelledReport?.status, "cancelled");
assert.equal(cancelledReport?.failure_class, "cancelled");

appendRuntimeContext(runDir, "research", {
	type: "runtime.agent_bound",
	stage_id: "prime-search-resumed",
	execution_id: "prime-search-resumed-1",
	attempt: 1,
	agent: "prime_search",
	session_file: "prime-search--resumed.jsonl",
});
appendResearchNodeRecord(runDir, {
	node_id: "prime-search-resumed",
	node_type: "agent",
	agent: "prime_search",
	execution_id: "prime-search-resumed-1",
	attempt: 1,
	status: "succeeded",
	group_id: null,
	depends_on: [],
	input: {},
	output: { metrics: { model_calls: 2, tool_calls: 4 } },
	time: {
		started_at: "2026-07-29T00:00:03.000Z",
		finished_at: "2026-07-29T00:00:04.000Z",
		duration_ms: 1_000,
	},
});
const resumedReport = readRuntimeStageReports(runDir, "Run-123")
	.find((report) => report.stage_id === "prime-search-resumed");
assert.equal(resumedReport?.status, "succeeded");
assert.equal(resumedReport?.metrics.model_calls, 2);
assert.equal(resumedReport?.metrics.tool_calls, 4);

const recoveryDir = runRecordDir(root, "goal_123", "Run:recovery");
const abandonedPath = agentSessionPath(recoveryDir, "prime-search", "attempt-1");
mkdirSync(recoveryDir, { recursive: true });
writeFileSync(abandonedPath, [
	JSON.stringify({ type: "session", id: "abandoned-session" }),
	JSON.stringify({
		type: "message",
		message: {
			role: "assistant",
			usage: { input: 11, output: 4, cost: { total: 0.03 } },
		},
	}),
].join("\n") + "\n");
appendRuntimeContext(recoveryDir, "research", {
	type: "runtime.agent_bound",
	stage_id: "prime-search-retry",
	execution_id: "attempt-1",
	attempt: 1,
	agent: "prime_search",
	session_file: "prime-search--attempt-1.jsonl",
	message_count_before: 0,
	created_at: "2026-08-09T00:00:00.000Z",
});
const emptySessionPath = agentSessionPath(recoveryDir, "prime-search", "attempt-2");
writeFileSync(emptySessionPath, `${JSON.stringify({ type: "session", id: "empty-session" })}\n`);
appendRuntimeContext(recoveryDir, "research", {
	type: "runtime.agent_bound",
	stage_id: "prime-search-retry",
	execution_id: "attempt-2",
	attempt: 2,
	agent: "prime_search",
	session_file: "prime-search--attempt-2.jsonl",
	message_count_before: 0,
	created_at: "2026-08-09T00:00:10.000Z",
});
const partialSessionPath = agentSessionPath(recoveryDir, "prime-search", "attempt-3");
writeFileSync(partialSessionPath, [
	JSON.stringify({ type: "session", id: "partial-session" }),
	JSON.stringify({ type: "message", message: { role: "assistant", usage: { input: 5, output: 2 } } }),
].join("\n") + "\n");
appendRuntimeContext(recoveryDir, "research", {
	type: "runtime.agent_bound",
	stage_id: "prime-search-retry",
	execution_id: "attempt-3",
	attempt: 3,
	agent: "prime_search",
	session_file: "prime-search--attempt-3.jsonl",
	message_count_before: 0,
	created_at: "2026-08-09T00:00:20.000Z",
});
const sealed = sealInterruptedAgentExecutions(recoveryDir, "research", "2026-08-09T00:01:00.000Z");
assert.equal(sealed.length, 3);
assert.equal(sealed[0]?.status, "interrupted");
assert.equal(sealed[0]?.execution_id, "attempt-1");
assert.equal(sealed[0]?.attempt, 1);
assert.equal(sealed[0]?.trace_ref, "prime-search--attempt-1.jsonl");
assert.deepEqual(readAgentNodeUsage(recoveryDir, "research"), {
	inputTokens: 11,
	outputTokens: 4,
	costUsd: 0.03,
	modelCalls: 1,
	completeExecutions: 1,
	incompleteExecutionIds: ["attempt-2", "attempt-3"],
});
assert.deepEqual(validateNodeExecutionTrace(recoveryDir, "research"), { ok: true, issues: [] });
assert.equal(sealInterruptedAgentExecutions(recoveryDir, "research").length, 0);

const brokenDir = runRecordDir(root, "goal_123", "Run:broken-trace-ref");
appendRuntimeContext(brokenDir, "research", {
	type: "runtime.agent_bound",
	stage_id: "writer-report",
	execution_id: "writer-attempt-1",
	attempt: 1,
	agent: "report_writer",
	session_file: "report-writer--missing.jsonl",
});
sealInterruptedAgentExecutions(brokenDir, "research");
assert.deepEqual(validateNodeExecutionTrace(brokenDir, "research"), {
	ok: false,
	issues: ["agent execution 'writer-attempt-1' has no readable trace_ref"],
});

console.log("observability/run-records tests passed");
