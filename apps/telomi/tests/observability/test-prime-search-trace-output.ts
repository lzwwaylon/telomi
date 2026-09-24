import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { ObservabilityActivityProjection } from "../../server/observability/activity-projection.js";
import type { NodeExecutionRecord } from "../../server/observability/run-records.js";

const root = mkdtempSync(join(tmpdir(), "telomi-prime-search-trace-"));
const goalId = "goal_trace";
const runId = "2026-09-14T00-00-00.000Z";
const runDir = join(root, runId);

function writeJsonl(path: string, entries: unknown[]): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
}
const header = (at: string, rlmDepth = 0) => ({ type: "session", version: 3, id: `session-${at}`, timestamp: at, rlmDepth });
const assistant = (at: string, content: unknown[]) => ({ type: "message", timestamp: Date.parse(at), message: { role: "assistant", model: "gpt-test", content } });
const text = (at: string, value: string) => assistant(at, [{ type: "text", text: value }]);
const toolCall = (at: string, id: string, name: string, args: Record<string, unknown>) => assistant(at, [{ type: "toolCall", id, name, arguments: args }]);
const toolResult = (at: string, id: string, name: string, output: string, details?: unknown) => ({
	type: "message",
	timestamp: Date.parse(at),
	message: {
		role: "toolResult",
		toolCallId: id,
		toolName: name,
		content: [{ type: "text", text: output }],
		...(details === undefined ? {} : { details }),
	},
});

function node(executionId: string, sequence: number, startedAt: string, finishedAt: string, status: NodeExecutionRecord["status"]): NodeExecutionRecord & { event_id: number } {
	return {
		event_id: sequence,
		node_id: `prime-search-batch-${sequence}`,
		node_type: "agent",
		agent: "prime_search",
		execution_id: executionId,
		status,
		depends_on: [],
		input: { sequence },
		output: {},
		time: { started_at: startedAt, finished_at: finishedAt, duration_ms: 1 },
		trace_ref: `prime_search--${executionId}.jsonl`,
	};
}

try {
	// 1. A finished stage: Root, one Provider child and the Organizer live in the moved traces.
	writeJsonl(join(runDir, "prime_search--exec-1.jsonl"), [
		text("2026-09-14T00:00:00.500Z", "Prime Search 正在检索资料"),
		text("2026-09-14T00:00:01.500Z", "mirrored root text must not repeat"),
		text("2026-09-14T00:09:00.000Z", "Prime Search 已完成"),
	]);
	const traces = join(runDir, "prime-search-traces", "exec-1");
	writeJsonl(join(traces, "acquisition-session", "session", "root.jsonl"), [
		header("2026-09-14T00:00:01.000Z"),
		toolCall("2026-09-14T00:00:02.000Z", "call_root", "ipython", { code: "handles = dispatch()" }),
		toolResult("2026-09-14T00:00:03.000Z", "call_root", "ipython", "dispatched"),
	]);
	// Trace text is trimmed, so the fixture has no trailing whitespace to lose.
	const longOutput = "row ".repeat(1_000).trim();
	writeJsonl(join(traces, "acquisition-session", "session-artifacts", "sub-abc123", "child.jsonl"), [
		header("2026-09-14T00:00:04.000Z", 1),
		toolCall("2026-09-14T00:00:05.000Z", "call_child", "ipython", { code: "search_models()" }),
		toolResult("2026-09-14T00:00:06.000Z", "call_child", "ipython", longOutput, {
			results: Array.from({ length: 80 }, (_, index) => ({ title: `Model ${index}`, url: `https://example.com/${index}` })),
		}),
	]);
	writeJsonl(join(traces, "acquisition-session", "sdk-events.jsonl"), [
		{ type: "rlm_child_update", child: { id: "sub-abc123", sessionName: "github-models", status: "running" } },
	]);
	mkdirSync(join(traces, "decisions", "provider-executions", "sub-abc123", "work"), { recursive: true });
	writeFileSync(join(traces, "decisions", "provider-executions", "sub-abc123", "work", "github_candidates.json"), "{}\n");
	writeJsonl(join(traces, "organizer-session", "session", "organizer.jsonl"), [
		header("2026-09-14T00:08:00.000Z"),
		toolCall("2026-09-14T00:08:01.000Z", "call_org", "submit_organizer_decision", { groups: [] }),
		toolResult("2026-09-14T00:08:02.000Z", "call_org", "submit_organizer_decision", "submitted", { groups: [], ungrouped: ["S001"], token: "must-not-leak" }),
	]);

	// 2. A failed stage that was never moved: its workspace belongs to this execution by time.
	writeJsonl(join(runDir, "prime_search--exec-2.jsonl"), [
		text("2026-09-14T01:00:00.500Z", "Prime Search 正在检索资料"),
		text("2026-09-14T01:30:00.000Z", "Prime Search 失败"),
	]);
	const failedStage = join(runDir, "workspaces", "search-batch-2");
	writeJsonl(join(failedStage, "runtime", "acquisition-session", "session", "root.jsonl"), [
		header("2026-09-14T01:00:01.000Z"),
		toolCall("2026-09-14T01:00:02.000Z", "call_failed_root", "ipython", { code: "dispatch_arxiv()" }),
		toolResult("2026-09-14T01:00:03.000Z", "call_failed_root", "ipython", "dispatched"),
	]);
	writeJsonl(join(failedStage, "runtime", "acquisition-session", "session-artifacts", "sub-def456", "child.jsonl"), [
		header("2026-09-14T01:00:04.000Z"),
		toolCall("2026-09-14T01:00:05.000Z", "call_arxiv", "ipython", { code: "arxiv()" }),
		toolResult("2026-09-14T01:00:06.000Z", "call_arxiv", "ipython", "source_unavailable"),
	]);
	mkdirSync(join(failedStage, "agent", "provider-executions", "sub-def456", "work"), { recursive: true });
	writeFileSync(join(failedStage, "agent", "provider-executions", "sub-def456", "work", ".provider-assignment"), "arxiv\n");

	// 3. An archived workspace from another attempt of the same sequence must not be attributed here.
	writeJsonl(join(runDir, "prime_search--exec-3.jsonl"), [
		text("2026-09-14T03:00:00.500Z", "Prime Search 正在检索资料"),
		toolCall("2026-09-14T03:00:01.000Z", "call_merged", "ipython", { code: "merged_session()" }),
		toolResult("2026-09-14T03:00:02.000Z", "call_merged", "ipython", "from merged session"),
	]);
	writeJsonl(join(runDir, "workspaces", "search-batch-3.interrupted", "runtime", "acquisition-session", "session", "root.jsonl"), [
		header("2026-09-14T02:00:01.000Z"),
		toolCall("2026-09-14T02:00:02.000Z", "call_other_attempt", "ipython", { code: "other_attempt()" }),
	]);

	const projection = new ObservabilityActivityProjection();
	const steps = projection.fromNodes(goalId, runId, runDir, [
		node("exec-1", 1, "2026-09-14T00:00:00.000Z", "2026-09-14T00:09:00.000Z", "succeeded"),
		node("exec-2", 2, "2026-09-14T01:00:00.000Z", "2026-09-14T01:30:00.000Z", "failed"),
		node("exec-3", 3, "2026-09-14T03:00:00.000Z", "2026-09-14T03:10:00.000Z", "failed"),
	]);
	const outputRef = (index: number) => steps[index]!.agentActivities[0]!.outputRef!;

	const finished = projection.readOutput(goalId, outputRef(0));
	assert.ok(finished);
	assert.deepEqual(finished.lines.map((line) => [line.section ?? null, line.kind, line.toolName ?? line.text]), [
		[null, "status", "Prime Search 正在检索资料"],
		["Prime Search Root", "tool", "ipython"],
		["Provider child · github-models · github", "tool", "ipython"],
		["Source Organizer", "tool", "submit_organizer_decision"],
		[null, "status", "Prime Search 已完成"],
	], "Root, each Provider child and the Organizer appear in order, framed by the Runtime status");
	assert.deepEqual(finished.lines.map((line) => line.sequence), [1, 2, 3, 4, 5]);
	assert.deepEqual(finished.lines.map((line) => [line.sectionDepth, line.model]), [
		[undefined, undefined], [0, "gpt-test"], [1, "gpt-test"], [0, "gpt-test"], [undefined, undefined],
	], "each session line carries its session's depth under the Root and the model that produced it");
	assert.doesNotMatch(JSON.stringify(finished), /mirrored root text/u, "the merged mirror is not read twice");

	const childLine = finished.lines[2]!;
	assert.equal(childLine.truncated, true, "a long tool output is marked truncated in the list");
	assert.equal(childLine.toolOutput?.length, 2_001, "the list keeps 2000 characters and an ellipsis");
	assert.equal(finished.lines[1]!.truncated, undefined, "short lines are not marked");
	assert.deepEqual(finished.lines[3]!.toolDetails, { groups: [], ungrouped: ["S001"], token: "[REDACTED]" },
		"small structured details reach the list with credential keys redacted");
	assert.equal(childLine.toolDetails, undefined, "large structured details wait for the full line");
	const fullChild = projection.readOutput(goalId, outputRef(0), { line: childLine.ref });
	assert.equal(fullChild?.lines.length, 1);
	assert.equal(fullChild?.lines[0]?.toolOutput, longOutput, "reading the line by ref returns it in full");
	assert.equal(fullChild?.lines[0]?.truncated, undefined);
	assert.equal((fullChild?.lines[0]?.toolDetails as { results: unknown[] } | undefined)?.results.length, 80,
		"the full line carries the structured details whole");
	assert.deepEqual(projection.readOutput(goalId, outputRef(0), { line: "missing#1" })?.lines, []);

	const failed = projection.readOutput(goalId, outputRef(1));
	assert.deepEqual(failed?.lines.map((line) => [line.section ?? null, line.toolName ?? line.text]), [
		[null, "Prime Search 正在检索资料"],
		["Prime Search Root", "ipython"],
		["Provider child · sub-def456 · arxiv", "ipython"],
		[null, "Prime Search 失败"],
	], "a failed stage workspace inside the execution window supplies the grouped sessions");

	const unrelated = projection.readOutput(goalId, outputRef(2));
	assert.doesNotMatch(JSON.stringify(unrelated), /other_attempt/u, "an archive started outside the window belongs to another attempt");
	assert.match(JSON.stringify(unrelated), /from merged session/u, "without its own traces the record falls back to the merged session");
	assert.ok(unrelated?.lines.every((line) => line.section === undefined));

	console.log("Prime Search execution records group every session and read truncated lines in full");
} finally {
	rmSync(root, { recursive: true, force: true });
}
