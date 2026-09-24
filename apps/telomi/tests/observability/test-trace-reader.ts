import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { AddressInfo } from "node:net";
import express from "express";

import type { GoalService } from "../../server/goals/service.js";
import {
	agentSessionPath,
	appendResearchNodeRecord,
	appendRuntimeContext,
	runRecordDir,
} from "../../server/observability/run-records.js";
import { createTraceRouter } from "../../server/observability/trace-api.js";
import { listTraceRuns, readTraceRun, resolveTraceFile, type TraceFileRef } from "../../server/observability/trace-reader.js";

const workspaceDir = mkdtempSync(join(tmpdir(), "telomi-trace-reader-"));
const goalId = "goal_trace_reader";
mkdirSync(join(workspaceDir, goalId), { recursive: true });

const researchRunId = "2026-08-07T07-01-21.952Z";
const originalQuestion = "What changed in ASR this year?";
const researchTask = "Research current ASR models and cite primary sources.";
const researchDir = runRecordDir(workspaceDir, goalId, researchRunId);
mkdirSync(researchDir, { recursive: true });
const researchSession = agentSessionPath(researchDir, "prime-search", "github-attempt-1");
writeFileSync(researchSession, [
	JSON.stringify({ type: "session", id: "session-1" }),
	JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "done" }] } }),
].join("\n") + "\n");
appendRuntimeContext(researchDir, "research", {
	type: "runtime.agent_bound",
	stage_id: "prime-search-job-1-github",
	execution_id: "github-attempt-1",
	attempt: 1,
	agent: "prime_search",
	session_file: "prime-search--github-attempt-1.jsonl",
});
appendResearchNodeRecord(researchDir, {
	node_id: "prime-search-job-1-github",
	node_type: "agent",
	agent: "prime_search",
	execution_id: "github-attempt-1",
	attempt: 1,
	status: "succeeded",
	group_id: null,
	depends_on: [],
	input: { provider: "github" },
	output: {
		artifact_ref: "artifacts/source-bundles/github",
		metrics: { input_tokens: 100, output_tokens: 20, cost_usd: 0.1, model_calls: 1 },
		node_evaluation: {
			status: "captured",
			case_id: "case-github-1",
			case_ref: "node-evaluation/cases/case-github-1/manifest.json",
		},
	},
	time: {
		started_at: "2026-08-07T07:01:00.000Z",
		finished_at: "2026-08-07T07:02:00.000Z",
		duration_ms: 60_000,
	},
	trace_ref: "prime-search--github-attempt-1.jsonl",
});
const abandonedSession = agentSessionPath(researchDir, "prime-search", "retry-attempt-1");
writeFileSync(abandonedSession, `${JSON.stringify({ type: "session", id: "session-abandoned" })}\n`);
appendRuntimeContext(researchDir, "research", {
	type: "runtime.agent_bound",
	stage_id: "prime-search-retry",
	execution_id: "retry-attempt-1",
	attempt: 1,
	agent: "prime_search",
	session_file: "prime-search--retry-attempt-1.jsonl",
});
const resumedSession = agentSessionPath(researchDir, "prime-search", "retry-attempt-2");
writeFileSync(resumedSession, `${JSON.stringify({ type: "session", id: "session-resumed" })}\n`);
appendRuntimeContext(researchDir, "research", {
	type: "runtime.agent_bound",
	stage_id: "prime-search-retry",
	execution_id: "retry-attempt-2",
	attempt: 2,
	agent: "prime_search",
	session_file: "prime-search--retry-attempt-2.jsonl",
});
appendResearchNodeRecord(researchDir, {
	node_id: "prime-search-retry",
	node_type: "agent",
	agent: "prime_search",
	execution_id: "retry-attempt-2",
	attempt: 2,
	status: "succeeded",
	group_id: null,
	depends_on: [],
	input: {},
	output: { metrics: { input_tokens: 7, output_tokens: 3, cost_usd: 0.02, model_calls: 1 } },
	time: {
		started_at: "2026-08-07T07:02:00.000Z",
		finished_at: "2026-08-07T07:02:30.000Z",
		duration_ms: 30_000,
	},
	trace_ref: "prime-search--retry-attempt-2.jsonl",
});
appendResearchNodeRecord(researchDir, {
	node_id: "legacy-missing-session",
	node_type: "agent",
	agent: "prime_search",
	execution_id: "legacy-missing-session-attempt-1",
	attempt: 1,
	status: "interrupted",
	group_id: null,
	depends_on: [],
	input: {},
	output: { metrics: { input_tokens: 0, output_tokens: 0, cost_usd: 0, model_calls: 0 } },
	time: {
		started_at: "2026-08-07T07:02:00.000Z",
		finished_at: "2026-08-07T07:02:30.000Z",
		duration_ms: 30_000,
	},
	trace_ref: "prime-search--legacy-missing.jsonl",
});
for (let index = 1; index <= 27; index += 1) {
	const executionId = `legacy-no-metrics-${index}`;
	const sessionFile = `prime-search--${executionId}.jsonl`;
	writeFileSync(join(researchDir, sessionFile), `${JSON.stringify({ type: "session", id: executionId })}\n`);
	appendResearchNodeRecord(researchDir, {
		node_id: `legacy-no-metrics-${index}`,
		node_type: "agent",
		agent: "prime_search",
		execution_id: executionId,
		attempt: 1,
		status: "interrupted",
		group_id: null,
		depends_on: [],
		input: {},
		output: {},
		time: {
			started_at: "2026-08-07T07:02:00.000Z",
			finished_at: "2026-08-07T07:02:30.000Z",
			duration_ms: 30_000,
		},
		trace_ref: sessionFile,
	});
}
appendRuntimeContext(researchDir, "research", {
	type: "runtime.stage_output_rejected",
	stage_id: "writer-report",
	execution_id: "writer-report-1",
	submission: 1,
	submission_mode: "tool",
	validation_error: "Citation URL is outside the frozen Knowledge Snapshot",
});
appendRuntimeContext(researchDir, "research", {
	type: "runtime.stage_output_rejected",
	stage_id: "writer-report",
	execution_id: "writer-report-1",
	submission: 2,
	submission_mode: "agent_stop",
	validation_error: "Citation URL is outside the frozen Knowledge Snapshot",
});
appendRuntimeContext(researchDir, "research", {
	type: "runtime.stage_output_accepted",
	stage_id: "writer-report",
	execution_id: "writer-report-1",
	submission: 3,
	submission_mode: "tool",
});
writeFileSync(join(researchDir, "run-state.json"), `${JSON.stringify({
	status: "published",
	started_at: "2026-08-07T07:01:00.000Z",
	finished_at: "2026-08-07T07:02:00.000Z",
	question: researchTask,
	usage: {
		input_tokens: 120,
		output_tokens: 30,
		cost_usd: 0.25,
		model_calls: 4,
	},
})}\n`);
const providerDir = join(researchDir, "provider-bridges", "github", "attempt-1");
mkdirSync(providerDir, { recursive: true });
writeFileSync(join(providerDir, "query-ledger.jsonl"), `${JSON.stringify({ sequence: 1, status: "succeeded" })}\n`);
const ignoredProviderDocument = join(providerDir, "document-parsing", "candidate-1");
mkdirSync(ignoredProviderDocument, { recursive: true });
writeFileSync(join(ignoredProviderDocument, "document.md"), "intermediate content\n");
const caseDir = join(researchDir, "node-evaluation", "cases", "case-github-1");
mkdirSync(caseDir, { recursive: true });
writeFileSync(join(caseDir, "manifest.json"), `${JSON.stringify({ schemaVersion: 1, caseId: "case-github-1" })}\n`);
const wikiExecution = join(workspaceDir, goalId, "wiki", "runs", researchRunId, "artifacts", "search-executions");
mkdirSync(wikiExecution, { recursive: true });
writeFileSync(join(wikiExecution, "github-attempt-1.json"), `${JSON.stringify({
	schema_version: 2,
	terminal_status: "degraded_bundle",
	operations: [{
		status: "failed",
		error_code: "huggingface_repository_not_found_or_inaccessible",
		failure_class: "validation",
		retryable: false,
		details: {
			circuit_scope: "request",
			failure_scope: "request",
			recovery: {
				operation: "models_list",
				parameters: { search: "cohere-transcribe", author: "cohereforai" },
				then: "models_info",
			},
		},
		circuit_open: false,
	}],
})}\n`);
const wikiRunDir = join(workspaceDir, goalId, "wiki", "runs", researchRunId);
const sourceBundleDir = join(wikiRunDir, "artifacts", "source-bundles", "github");
mkdirSync(sourceBundleDir, { recursive: true });
writeFileSync(join(sourceBundleDir, "result.json"), "{}\n");
writeFileSync(join(sourceBundleDir, "source-index.json"), "{}\n");
for (const [path, content] of Object.entries({
	"artifacts/final_gate.json": JSON.stringify({ ok: true, halt: false }),
	"report/final.json": "{}",
	"report/final.md": "# Final report",
	"artifacts/report-flow/task.md": researchTask,
	"artifacts/report-flow/outline.json": "{}",
	"artifacts/report-flow/executable-plan.json": "{}",
	"artifacts/report-flow/writer.json": "{}",
	"artifacts/report-flow/knowledge-url-registry.json": "{}",
	"artifacts/report-flow/writer/manifest.json": "{}",
	"artifacts/report-flow/writer/sections/section-001.md": "Writer chapter",
	"artifacts/cornell-notes/snapshot-seed.json": "{}",
	"artifacts/accepted-chapters/section-001.md": "# Chapter",
	"artifacts/wiki-compilations/wiki-test/compilation.json": "{}",
	"artifacts/wiki-compilations/wiki-test/knowledge/topics/final.md": "# Final",
	"artifacts/wiki-compilations/wiki-test/agent-update/topics/final.md": "# Update",
})) {
	const target = join(wikiRunDir, path);
	mkdirSync(dirname(target), { recursive: true });
	writeFileSync(target, `${content}\n`);
}
appendResearchNodeRecord(researchDir, {
	node_id: "writer-report",
	node_type: "agent",
	agent: "report_writer",
	execution_id: "writer-report-1",
	attempt: 1,
	status: "succeeded",
	group_id: null,
	depends_on: [],
	input: {},
	output: {
		artifact_ref: "artifacts/report-flow/writer",
		submission_count: 3,
		validation_errors: [
			"Citation URL is outside the frozen Knowledge Snapshot",
			"Citation URL is outside the frozen Knowledge Snapshot",
		],
		metrics: {
			tool_counts: { submit_stage_output: 2 },
			input_tokens: 50,
			output_tokens: 10,
			cost_usd: 0.15,
			model_calls: 3,
		},
	},
	time: {
		started_at: "2026-08-07T07:02:00.000Z",
		finished_at: "2026-08-07T07:03:00.000Z",
		duration_ms: 60_000,
	},
	trace_ref: "prime-search--github-attempt-1.jsonl",
});

const goalRuntimeDir = dirname(dirname(researchDir));
const taskHistory = join(goalRuntimeDir, "history", "user_tasks.jsonl");
mkdirSync(dirname(taskHistory), { recursive: true });
writeFileSync(taskHistory, `${JSON.stringify({
	type: "task_history",
	goalId,
	originalQuestion,
	canonicalResearchTask: researchTask,
	researchRun: {
		workspaceRunId: researchRunId,
		model: "openai-codex/gpt-5.4-mini",
	},
})}\n`);
const mainRunId = "main_trace_reader";
const mainRunDir = join(goalRuntimeDir, "main-agent", "runs", mainRunId);
mkdirSync(mainRunDir, { recursive: true });
writeFileSync(join(mainRunDir, "main-agent.jsonl"), "{}\n");
writeFileSync(join(mainRunDir, "route-trace.json"), "{}\n");
writeFileSync(join(mainRunDir, "runtime--main.jsonl"), `${JSON.stringify({
	type: "node_execution",
	node_id: "main-agent",
	node_type: "agent",
	status: "succeeded",
	input: { question: originalQuestion },
	output: {},
	time: {
		started_at: "2026-08-07T07:00:00.000Z",
		finished_at: "2026-08-07T07:03:00.000Z",
		duration_ms: 180_000,
	},
})}\n`);

const wikiUpdateId = "wiki_trace_reader";
const wikiUpdateDir = join(goalRuntimeDir, "wiki-updates", wikiUpdateId);
const shardTrace = "note-wiki/test/batch-001/runtime/sdk-events.jsonl";
const curatorTrace = "note-wiki/test/curation/batch-001/runtime/sdk-events.jsonl";
for (const ref of [shardTrace, curatorTrace]) {
	const target = join(wikiUpdateDir, ref);
	mkdirSync(dirname(target), { recursive: true });
	writeFileSync(target, `${JSON.stringify({ type: "message", message: { role: "assistant" } })}\n`);
	const childTrace = join(dirname(target), "session-artifacts", "sub-fixture", "child.jsonl");
	mkdirSync(dirname(childTrace), { recursive: true });
	writeFileSync(childTrace, `${JSON.stringify({ type: "message", message: { role: "assistant", content: "child" } })}\n`);
}
for (const value of [
	{ caseId: "wiki-shard-case", runId: `${wikiUpdateId}-wiki-shard-1`, agentId: "wiki-shard-builder" },
	{ caseId: "wiki-curator-case", runId: `${wikiUpdateId}-wiki-curator-batch-001`, agentId: "wiki-curator" },
]) {
	const path = join(wikiUpdateDir, "node-evaluation", "cases", value.caseId, "manifest.json");
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify({ ...value, capturedAt: "2026-08-07T07:05:00.000Z" })}\n`);
}
writeFileSync(join(wikiUpdateDir, "wiki-update-job.json"), `${JSON.stringify({
	schema_version: 1,
	status: "succeeded",
	goal_id: goalId,
	run_id: wikiUpdateId,
	source_run_id: researchRunId,
	goal: "Trace Goal",
	goal_context: { title: "Trace Goal", description: "Trace fixture" },
	topic_plan: { schema_version: 1, goal_id: goalId, revision: "fixture", status: "active", topics: [{
		id: "trace", title: "Trace", intent: "Test Trace", questions: ["What changed?"], include: ["Trace"], exclude: ["Noise"],
	}] },
	cornell_notes: { relative_path: "artifacts/input/cornell-notes.json", sha256: "a".repeat(64), byte_length: 1 },
	attempts: 1,
	started_at: "2026-08-07T07:04:00.000Z",
	updated_at: "2026-08-07T07:06:00.000Z",
	finished_at: "2026-08-07T07:06:00.000Z",
	progress: {
		total_batches: 1,
		completed_batches: 1,
		page_count: 3,
		usage: { input_tokens: 10, output_tokens: 2, cost_usd: 0.01, model_calls: 1 },
		batches: [{ batch_index: 0, status: "succeeded", attempt: 1, started_at: "2026-08-07T07:04:00.000Z",
			finished_at: "2026-08-07T07:05:00.000Z", page_count: 2, reused: false,
			usage: { input_tokens: 10, output_tokens: 2, cost_usd: 0.01, model_calls: 1 }, trace_ref: shardTrace }],
		stages: [
			{ kind: "curation", stage_index: 0, total_stages: 1, status: "succeeded",
				started_at: "2026-08-07T07:05:00.000Z", finished_at: "2026-08-07T07:05:59.000Z", page_count: 3,
				usage: { input_tokens: 20, output_tokens: 4, cost_usd: 0.02, model_calls: 2 }, trace_ref: curatorTrace },
			{ kind: "publication", stage_index: 0, total_stages: 1, status: "succeeded",
				started_at: "2026-08-07T07:05:59.000Z", finished_at: "2026-08-07T07:06:00.000Z", page_count: 3,
				usage: { input_tokens: 0, output_tokens: 0, cost_usd: 0, model_calls: 0 } },
		],
	},
})}\n`);

const providerCallsContent = [
	{ seq: 1, node_id: "prime-search-job-1-github", attempt_id: "1", provider: "github" },
	{ seq: 2, node_id: "prime-search-job-1-github", attempt_id: "1", provider: "github" },
	{ seq: 3, node_id: "prime-search-retry", attempt_id: "2", provider: "arxiv" },
].map((call) => JSON.stringify(call)).join("\n") + "\n";
writeFileSync(join(researchDir, "provider-calls.jsonl"), providerCallsContent);
const research = readTraceRun({ workspaceDir, goalId, kind: "research", runId: researchRunId });
assert.deepEqual(
	research.files.find((file) => file.ref === "runtime/provider-calls.jsonl"),
	{ kind: "provider_calls", ref: "runtime/provider-calls.jsonl", mediaType: "application/x-ndjson", byteLength: Buffer.byteLength(providerCallsContent) },
);
assert.equal(research.nodes[0]?.provider_call_count, 2);
assert.equal(research.nodes.find((node) => node.nodeId === "prime-search-retry")?.provider_call_count, 1);
assert.ok(research.nodes.filter((node) => node.nodeType === "agent").every((node) => typeof node.provider_call_count === "number"));
assert.ok(research.nodes.filter((node) => node.nodeType === "runtime").every((node) => node.provider_call_count === undefined));
assert.equal(research.status, "succeeded");
assert.equal(research.durationMs, 60_000);
assert.equal(research.model, "openai-codex/gpt-5.4-mini");
assert.deepEqual(research.usage, {
	inputTokens: 157,
	outputTokens: 33,
	costUsd: 0.27,
	modelCalls: 5,
	basis: "terminal_agent_execution_metrics",
	completeness: "lower_bound",
	completeExecutions: 4,
	incompleteExecutions: 27,
});
assert.deepEqual(research.finalGate, { ok: true, halt: false, ref: "wiki/artifacts/final_gate.json" });
assert.equal(research.origin.userInput, originalQuestion);
assert.equal(research.origin.researchTask, researchTask);
assert.equal(research.linkage.mainAgent?.runId, mainRunId);
assert.equal(research.nodes.length, 31);
const retryAttempts = research.nodes.filter((node) => node.nodeId === "prime-search-retry");
assert.deepEqual(retryAttempts.map(({ executionId, attempt, status }) => ({ executionId, attempt, status })), [
	{ executionId: "retry-attempt-2", attempt: 2, status: "succeeded" },
]);
assert.equal(research.usage?.completeExecutions, 4);
assert.match(research.warnings.join("\n"), /unavailable for 27 terminal Agent executions/u);
assert.ok(retryAttempts.every((node) => node.traceRef && research.files.some((file) => file.ref === node.traceRef)));
assert.ok(research.nodes.every((node) => node.status !== "running"));
assert.ok(!research.warnings.some((warning) => warning.includes("Trace reference") && warning.includes("could not be resolved")));
assert.equal(research.nodes.find((node) => node.nodeId === "legacy-missing-session")?.traceRef, undefined);
assert.ok(research.warnings.some((warning) => warning.includes("unreadable raw trace_ref")));
assert.equal(research.nodes[0]?.attempt, 1);
assert.deepEqual(research.nodes[0]?.caseRef, {
	sourceRunId: researchRunId,
	caseId: "case-github-1",
	fileRef: "runtime/node-evaluation/cases/case-github-1/manifest.json",
});
assert.deepEqual(research.nodes[0]?.output.artifact_ref, {
	type: "directory",
	resolvedFiles: [
		{ kind: "source_bundle_result", ref: "wiki/artifacts/source-bundles/github/result.json", mediaType: "application/json", byteLength: 3 },
		{ kind: "source_bundle_index", ref: "wiki/artifacts/source-bundles/github/source-index.json", mediaType: "application/json", byteLength: 3 },
	],
});
assert.equal(
	(research.nodes[0]?.output.node_evaluation as { case_ref: string }).case_ref,
	"runtime/node-evaluation/cases/case-github-1/manifest.json",
);
assert.deepEqual(research.nodes.find((node) => node.nodeId === "writer-report")?.output.artifact_ref, {
	type: "directory",
	resolvedFiles: [
		{ kind: "writer_chapter_manifest", ref: "wiki/artifacts/report-flow/writer/manifest.json", mediaType: "application/json", byteLength: 3 },
		{ kind: "writer_chapter", ref: "wiki/artifacts/report-flow/writer/sections/section-001.md", mediaType: "text/markdown", byteLength: 15 },
	],
});
assert.equal(research.nodes.find((node) => node.nodeId === "writer-report")?.output.submission_count, 3);
assert.deepEqual(
	research.nodes.find((node) => node.nodeId === "writer-report")?.output.validation_errors,
	[
		"Citation URL is outside the frozen Knowledge Snapshot",
		"Citation URL is outside the frozen Knowledge Snapshot",
	],
);
assert.ok(!research.warnings.some((warning) => warning.includes("duplicate agent_stop validation")));
assert.ok(research.files.some((file) => file.kind === "agent_session"));
assert.ok(!research.files.some((file) => file.ref.includes("provider-bridges/")));
assert.ok(!research.files.some((file) => file.ref.endsWith("report-flow/writer.json")));
assert.ok(research.files.some((file) => file.kind === "search_execution"));
for (const ref of [
	"wiki/artifacts/final_gate.json",
	"wiki/report/final.json",
	"wiki/report/final.md",
	"wiki/artifacts/report-flow/task.md",
	"wiki/artifacts/report-flow/outline.json",
	"wiki/artifacts/report-flow/executable-plan.json",
	"wiki/artifacts/report-flow/knowledge-url-registry.json",
	"wiki/artifacts/report-flow/writer/manifest.json",
	"wiki/artifacts/report-flow/writer/sections/section-001.md",
	"wiki/artifacts/cornell-notes/snapshot-seed.json",
	"wiki/artifacts/accepted-chapters/section-001.md",
	"wiki/artifacts/wiki-compilations/wiki-test/compilation.json",
	"wiki/artifacts/wiki-compilations/wiki-test/knowledge/topics/final.md",
	"wiki/artifacts/wiki-compilations/wiki-test/agent-update/topics/final.md",
]) assert.ok(research.files.some((file) => file.ref === ref), `missing ${ref}`);
assert.equal(research.files.find((file) => file.ref.endsWith("/agent-update/topics/final.md"))?.kind, "wiki_agent_update");
assert.ok(!research.files.some((file) => file.ref.includes("document-parsing")));
assert.equal(listTraceRuns({ workspaceDir, goalId }).length, 2);
assert.equal(resolveTraceFile({
	workspaceDir,
	goalId,
	kind: "research",
	runId: researchRunId,
	ref: "runtime/prime-search--github-attempt-1.jsonl",
}), realpathSync(researchSession));
assert.throws(() => resolveTraceFile({
	workspaceDir,
	goalId,
	kind: "research",
	runId: researchRunId,
	ref: "runtime/../outside.json",
}), /Invalid Trace file ref/u);

// The Wiki Run pins its Curator model at the start; the Trace reads that pin when no Case names a model.
writeFileSync(join(wikiUpdateDir, "wiki-model-selection.json"), JSON.stringify({ TELOMI_WIKI_MAINTAINER_MODEL: "telomi-test/wiki-1", TELOMI_PRIME_AGENT_CHILD_MODEL: "telomi-test/child-1", TELOMI_WIKI_MAINTAINER_THINKING_LEVEL: "low" }));
const wiki = readTraceRun({ workspaceDir, goalId, kind: "wiki", runId: wikiUpdateId });
assert.equal(wiki.status, "succeeded");
assert.equal(wiki.model, "telomi-test/wiki-1");
assert.equal(wiki.nodes.length, 3);
assert.deepEqual(wiki.usage, {
	inputTokens: 30,
	outputTokens: 6,
	costUsd: 0.03,
	modelCalls: 3,
	basis: "terminal_agent_execution_metrics",
	completeness: "complete",
	completeExecutions: 2,
	incompleteExecutions: 0,
});
assert.equal(wiki.nodes[0]?.traceRef, `runtime/${shardTrace}`);
assert.equal(wiki.nodes[0]?.caseRef?.caseId, "wiki-shard-case");
assert.equal(wiki.nodes[1]?.traceRef, `runtime/${curatorTrace}`);
assert.equal(wiki.nodes[1]?.caseRef?.caseId, "wiki-curator-case");
const wikiChildTraces = wiki.files.filter((file) => file.kind === "related_agent_trace");
assert.equal(wikiChildTraces.length, 2);
assert.ok(wikiChildTraces.some((file) => file.ref === `runtime/${dirname(shardTrace)}/session-artifacts/sub-fixture/child.jsonl`));
assert.ok(wikiChildTraces.some((file) => file.ref === `runtime/${dirname(curatorTrace)}/session-artifacts/sub-fixture/child.jsonl`));
assert.equal(listTraceRuns({ workspaceDir, goalId, kind: "wiki" }).length, 1);
assert.equal(resolveTraceFile({ workspaceDir, goalId, kind: "wiki", runId: wikiUpdateId,
	ref: `runtime/${shardTrace}` }), realpathSync(join(wikiUpdateDir, shardTrace)));
assert.equal(resolveTraceFile({ workspaceDir, goalId, kind: "wiki", runId: wikiUpdateId,
	ref: wikiChildTraces[1]!.ref }), realpathSync(join(wikiUpdateDir, wikiChildTraces[1]!.ref.slice("runtime/".length))));

const goals = {
	getGoal: (requested: string) => requested === goalId ? { id: goalId, title: "Trace Goal" } : undefined,
	getSnapshot: async () => ({ messages: [
		{ role: "user", content: "An older Goal question" },
		{ role: "user", content: originalQuestion },
	] }),
} as unknown as Pick<GoalService, "getGoal" | "getSnapshot">;
const app = express();
app.use(createTraceRouter(workspaceDir, goals));
const server = app.listen(0, "127.0.0.1");
await new Promise<void>((resolve, reject) => {
	server.once("listening", resolve);
	server.once("error", reject);
});
try {
	const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	const listResponse = await fetch(`${base}/api/goals/${goalId}/traces?kind=research&limit=10`);
	assert.equal(listResponse.status, 200);
	const listedRuns = (await listResponse.json()) as {
		runs: Array<{ usage?: unknown; origin?: unknown; linkage?: unknown }>;
	};
	assert.equal(listedRuns.runs.length, 1);
	const runResponse = await fetch(`${base}/api/goals/${goalId}/traces/research/${researchRunId}`);
	assert.equal(runResponse.status, 200);
	const detail = await runResponse.json() as { run?: { usage?: unknown; origin?: unknown; linkage?: unknown } };
	assert.deepEqual(listedRuns.runs[0]?.usage, detail.run?.usage, "list and detail usage semantics must match");
	assert.deepEqual(listedRuns.runs[0]?.origin, detail.run?.origin, "list and detail origin semantics must match");
	assert.deepEqual(listedRuns.runs[0]?.linkage, detail.run?.linkage, "list and detail linkage semantics must match");
	const wikiResponse = await fetch(`${base}/api/goals/${goalId}/traces/wiki/${wikiUpdateId}`);
	assert.equal(wikiResponse.status, 200);
	const fileResponse = await fetch(`${base}/api/goals/${goalId}/traces/research/${researchRunId}/file?ref=${encodeURIComponent("runtime/prime-search--github-attempt-1.jsonl")}`);
	assert.equal(fileResponse.status, 200);
	assert.match(await fileResponse.text(), /session-1/u);
	const searchExecutionResponse = await fetch(`${base}/api/goals/${goalId}/traces/research/${researchRunId}/file?ref=${encodeURIComponent("wiki/artifacts/search-executions/github-attempt-1.json")}`);
	assert.equal(searchExecutionResponse.status, 200);
	const searchExecution = await searchExecutionResponse.json() as {
		terminal_status?: string;
		operations?: Array<{ error_code?: string; details?: { recovery?: { operation?: string } } }>;
	};
	assert.equal(searchExecution.terminal_status, "degraded_bundle");
	assert.equal(searchExecution.operations?.[0]?.error_code, "huggingface_repository_not_found_or_inaccessible");
	assert.equal(searchExecution.operations?.[0]?.details?.recovery?.operation, "models_list");
	const traversal = await fetch(`${base}/api/goals/${goalId}/traces/research/${researchRunId}/file?ref=${encodeURIComponent("runtime/../outside.json")}`);
	assert.equal(traversal.status, 404);
} finally {
	await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

if (process.env.TELOMI_TRACE_LIVE_BASE_URL) await testLiveResearchTrace();

console.log("trace reader tests passed");

async function testLiveResearchTrace(): Promise<void> {
	const baseUrl = process.env.TELOMI_TRACE_LIVE_BASE_URL!;
	const liveGoalId = requireEnv("TELOMI_TRACE_LIVE_GOAL_ID");
	const liveRunId = requireEnv("TELOMI_TRACE_LIVE_RUN_ID");
	const expectedTitle = requireEnv("TELOMI_TRACE_LIVE_GOAL_TITLE");
	const expectedQuestion = requireEnv("TELOMI_TRACE_LIVE_USER_INPUT");
	const goalBase = `${baseUrl}/api/goals/${encodeURIComponent(liveGoalId)}`;
	const list = await json(`${goalBase}/traces?kind=research&limit=50`) as { runs: Array<{ runId: string }> };
	assert.deepEqual(list.runs.map((run) => run.runId), [liveRunId]);
	const detail = await json(`${goalBase}/traces/research/${encodeURIComponent(liveRunId)}`) as {
		run: Record<string, any>;
	};
	const run = detail.run;
	assert.equal(run.nodes.length, 70);
	assert.equal(run.nodes.filter((node: any) => node.nodeType === "agent").length, 65);
	assert.equal(run.nodes.filter((node: any) => node.nodeType === "runtime").length, 5);
	assert.equal(run.nodes.filter((node: any) => node.nodeType === "agent" && node.traceRef).length, 65);
	assert.equal(run.nodes.filter((node: any) => node.caseRef?.fileRef).length, 62);
	assert.ok(run.nodes.every((node: any) => node.status === "succeeded"));
	assert.equal(run.origin.goalTitle, expectedTitle);
	assert.equal(run.origin.userInput, expectedQuestion);
	assert.ok(run.origin.researchTask);
	assert.ok(run.linkage.mainAgent?.runId);
	assert.ok(run.linkage.mainAgent?.sessionRef);
	assert.ok(run.linkage.mainAgent?.routeTraceRef);
	assert.ok(run.linkage.mainAgent?.runtimeTraceRef);
	assert.equal(run.status, "succeeded");
	assert.ok(run.startedAt && run.finishedAt && run.durationMs > 0);
	assert.ok(run.model);
	assert.ok(run.usage.inputTokens > 0 && run.usage.outputTokens > 0 && run.usage.modelCalls > 0);
	assert.ok(run.usage.costUsd >= 0);
	assert.deepEqual(run.finalGate, { ok: true, halt: false, ref: "wiki/artifacts/final_gate.json" });
	const fileRefs = new Set<string>(run.files.map((file: TraceFileRef) => file.ref));
	for (const ref of [
		"wiki/artifacts/final_gate.json",
		"wiki/report/final.json",
		"wiki/report/final.md",
		"wiki/artifacts/report-flow/task.md",
		"wiki/artifacts/report-flow/outline.json",
		"wiki/artifacts/report-flow/executable-plan.json",
		"wiki/artifacts/cornell-notes/snapshot-seed.json",
	]) assert.ok(fileRefs.has(ref), `Live Trace is missing ${ref}`);
	assert.ok([...fileRefs].some((ref) => ref.startsWith("wiki/artifacts/accepted-chapters/") && ref.endsWith(".md")));
	const standardizedRefs = new Set<string>();
	for (const node of run.nodes) {
		if (node.traceRef) standardizedRefs.add(node.traceRef);
		if (node.caseRef?.fileRef) standardizedRefs.add(node.caseRef.fileRef);
		collectProjectedRefs(node.input, standardizedRefs);
		collectProjectedRefs(node.output, standardizedRefs);
	}
	collectProjectedRefs(run.linkage, standardizedRefs);
	collectProjectedRefs(run.finalGate, standardizedRefs);
	for (const ref of standardizedRefs) assert.ok(fileRefs.has(ref), `Standardized ref is absent from files: ${ref}`);
	await assertReadableRefs(goalBase, liveRunId, [...fileRefs]);
	await assertReadableRefs(goalBase, liveRunId, [...standardizedRefs]);
	const report = await fetchTraceFile(goalBase, liveRunId, "wiki/report/final.md");
	assert.match(await report.text(), /ASR/u);
}

function collectProjectedRefs(value: unknown, refs: Set<string>): void {
	if (typeof value === "string") {
		if (/^(runtime|wiki|main)\//u.test(value)) refs.add(value);
		return;
	}
	if (Array.isArray(value)) {
		for (const item of value) collectProjectedRefs(item, refs);
		return;
	}
	if (!value || typeof value !== "object") return;
	assert.notEqual((value as Record<string, unknown>).type, "unresolved");
	for (const item of Object.values(value as Record<string, unknown>)) collectProjectedRefs(item, refs);
}

async function assertReadableRefs(goalBase: string, runId: string, refs: string[]): Promise<void> {
	for (let index = 0; index < refs.length; index += 16) {
		await Promise.all(refs.slice(index, index + 16).map(async (ref) => {
			const response = await fetchTraceFile(goalBase, runId, ref);
			await response.body?.cancel();
		}));
	}
}

async function fetchTraceFile(goalBase: string, runId: string, ref: string): Promise<Response> {
	const response = await fetch(`${goalBase}/traces/research/${encodeURIComponent(runId)}/file?ref=${encodeURIComponent(ref)}`);
	assert.equal(response.status, 200, `GET failed for ${ref}`);
	return response;
}

async function json(url: string): Promise<unknown> {
	const response = await fetch(url);
	assert.equal(response.status, 200, `GET failed for ${url}`);
	return response.json();
}

function requireEnv(name: string): string {
	const value = process.env[name]?.trim();
	if (!value) throw new Error(`${name} is required for live Trace regression`);
	return value;
}

