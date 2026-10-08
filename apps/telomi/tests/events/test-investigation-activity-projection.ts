import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { createActivityProjection } from "../../server/app/activity-projection.js";
import { readJson } from "../../server/lib/fs.js";
import { agentSessionPath, appendResearchNodeRecord, appendRuntimeContext } from "../../server/observability/run-records.js";
import { ObservabilityActivityProjection } from "../../server/observability/activity-projection.js";
import { listInvestigationExecutions, runInInvestigationThread } from "../../server/research/investigation-threads.js";
import { serverRuntimeDirForGoalDir } from "../../server/workspaces/server-runtime-paths.js";

const workspaceDir = mkdtempSync(join(tmpdir(), "telomi-investigation-activity-"));
const goalId = "goal-investigation";
const goalDir = join(workspaceDir, goalId);
const id = "a".repeat(24);
const runDir = join(serverRuntimeDirForGoalDir(goalDir), "research", "investigations", id);
const projection = createActivityProjection({ workspaceDir, listGoalIds: () => [goalId] });
const time = "2026-10-07T10:00:00.000Z";
const writeSession = (directory: string, execution: string, text: string) => {
	const path = agentSessionPath(directory, "note_agent", execution);
	mkdirSync(directory, { recursive: true });
	writeFileSync(path, `${JSON.stringify({ type: "message", timestamp: time,
		message: { role: "assistant", content: [{ type: "text", text }] } })}\n`);
	return path;
};

try {
	await runInInvestigationThread({ goalDir, executionId: id, question: "What does the original paper say?" }, async () => {
		const readingDir = join(goalDir, ".pi", "runtime", "note-reading", `${id}-1`);
		const path = writeSession(readingDir, "reader-1", "Reading the original paper");
		appendRuntimeContext(readingDir, "research", { type: "runtime.agent_bound", agent: "note_agent",
			stage_id: `note-reading-${id}-1`, execution_id: "reader-1", session_file: basename(path), created_at: time });
		const live = projection.getGoal(goalId).liveActivities.find(item => item.activityId === `investigation:${id}`);
		assert.ok(live, "A real running investigation is projected without a Research Run state");
		assert.equal(live.lifecycle, "running");
		const reader = live.steps.flatMap(step => step.agentActivities).find(agent => agent.agentName === "note_agent");
		assert.ok(reader?.outputRef, "Reader output is inspectable before it finishes");
		assert.ok(JSON.stringify(reader.summary).includes("Reading the original paper"), "The Stage shows its own actual operation");
		assert.ok(projection.readOutput(goalId, reader.outputRef)?.lines.some(line => line.text.includes("Reading the original paper")));
		assert.equal(projection.readOutput("another-goal", reader.outputRef), null);
		const readerId = reader.agentActivityId;
		mkdirSync(join(runDir, "external-search-1"), { recursive: true });
		assert.equal(projection.getGoal(goalId).liveActivities.find(item => item.activityId === `investigation:${id}`)
			?.steps.flatMap(step => step.agentActivities).find(agent => agent.agentName === "note_agent")?.agentActivityId, readerId,
			"A new acquisition directory cannot change an existing Reader's identity");
		const secondAcquisition = join(runDir, "external-search-2");
		const searchPath = writeSession(secondAcquisition, "search-2", "Searching the remaining evidence need");
		appendRuntimeContext(secondAcquisition, "research", { type: "runtime.agent_bound", agent: "prime_search",
			stage_id: "prime-search-batch-1", execution_id: "search-2", session_file: basename(searchPath) });
		const search = projection.getGoal(goalId).liveActivities.find(item => item.activityId === `investigation:${id}`)
			?.steps.find(step => step.stepId.startsWith("record:external-search-2:"));
		assert.ok(search);
		assert.ok(JSON.stringify(search.title).includes('"sequence":2'), "Acquisition rounds use the investigation's real sequence");
		// A prior failed Root cannot hide a newly bound Root with the same invocation identity.
		const rootPath = writeSession(runDir, id, "A fresh attempt is running");
		appendResearchNodeRecord(runDir, { node_id: "prime-investigation", node_type: "agent", agent: "prime_search",
			execution_id: id, status: "failed", depends_on: [], input: {}, output: {},
			time: { started_at: time, finished_at: time, duration_ms: 0 }, trace_ref: basename(rootPath) });
		appendRuntimeContext(runDir, "research", { type: "runtime.agent_bound", stage_id: "prime-investigation",
			agent: "prime_search", execution_id: id, session_file: basename(rootPath) });
		assert.ok(projection.getGoal(goalId).liveActivities.find(item => item.activityId === `investigation:${id}`)
			?.steps.some(step => step.lifecycle === "running" && step.agentActivities.some(agent => agent.agentName === "prime_search")),
			"Only a terminal record after the current binding can close a retried Root");
		appendResearchNodeRecord(readingDir, { node_id: `note-reading-${id}-1`, node_type: "agent", agent: "note_agent",
			execution_id: "reader-1", status: "succeeded", depends_on: [], input: {}, output: {},
			time: { started_at: time, finished_at: time, duration_ms: 0 }, trace_ref: basename(path) });
		return { id, question: "What does the original paper say?", answer: "A cited answer", citation_refs: [], gaps: [], wiki_sha256: "b".repeat(64) };
	});
	const historical = projection.getGoal(goalId).history.items.find(item => item.activityId === `investigation:${id}`);
	assert.ok(historical, "Previously saved investigations are visible without executing a model again");
	assert.equal(historical.outcome, "succeeded");
	assert.equal(historical.steps.filter(step => step.agentActivities.some(agent => agent.agentName === "note_agent")).length, 1);
	const readerRef = historical.steps.flatMap(step => step.agentActivities).find(agent => agent.agentName === "note_agent")?.outputRef;
	assert.ok(readerRef && projection.readOutput(goalId, readerRef)?.lines.some(line => line.text.includes("Reading the original paper")));

	// Executions saved before thread support still have their Runtime request and result.
	const legacyId = "c".repeat(24);
	const legacyDir = join(serverRuntimeDirForGoalDir(goalDir), "research", "investigations", legacyId);
	mkdirSync(legacyDir, { recursive: true });
	writeFileSync(join(legacyDir, "request.json"), JSON.stringify({ goalId, id: legacyId, question: "Older question" }));
	writeFileSync(join(legacyDir, "result.json"), JSON.stringify({ id: legacyId, question: "Older question", answer: "Older answer" }));
	const legacy = projection.getGoal(goalId).history.items.find(item => item.activityId === `investigation:${legacyId}`);
	assert.equal(legacy?.outcome, "succeeded", "Legacy history is projected without a migration or rerun");
	assert.equal(legacy?.lifecycle, "finished");
	const saved = listInvestigationExecutions(goalDir).find(row => row.execution.execution_id === id)!.execution;
	const executionPath = join(goalDir, "artifacts", "investigation-threads", saved.thread_id, "executions", `${id}.json`);
	writeFileSync(executionPath, JSON.stringify({ ...saved, status: "running", finished_at: undefined }));
	assert.equal(projection.getGoal(goalId).liveActivities.find(item => item.activityId === `investigation:${id}`)?.lifecycle,
		"waiting", "A copied or abandoned execution is never shown as actively running here");
	assert.equal(readJson<{ status: string }>(executionPath).status, "running", "Projection never rewrites historical execution evidence");
	// Old interrupted Readers retained their live log but never reached archive/manifest publication.
	const interruptedReaderDir = join(goalDir, ".pi", "runtime", "note-reading", `${id}-external-3`);
	const nativeDir = join(interruptedReaderDir, "stage", "runtime");
	const nativeTrace = writeSession(nativeDir, "live-reader", "Saved original reading before interruption");
	renameSync(nativeTrace, join(nativeDir, "session.jsonl"));
	const readerExecution = `note-reading/${id}-external-3-attempt-1`;
	appendRuntimeContext(interruptedReaderDir, "research", { type: "runtime.agent_bound", agent: "note_agent",
		stage_id: `note-reading-${id}-external-3`, execution_id: readerExecution,
		session_file: basename(agentSessionPath(interruptedReaderDir, "note_agent", readerExecution)), created_at: time });
	const interruptedReader = projection.getGoal(goalId).liveActivities.find(item => item.activityId === `investigation:${id}`)
		?.steps.find(step => step.stepId.startsWith(`record:${id}-external-3:`))?.agentActivities[0];
	assert.ok(interruptedReader?.outputRef);
	assert.ok(projection.readOutput(goalId, interruptedReader.outputRef)?.lines.some(line => line.text.includes("Saved original reading before interruption")),
		"An interrupted historical Reader exposes already recorded progress without rerunning or fabricating a manifest");
	const outputs = new ObservabilityActivityProjection();
	const oldAttempt = outputs.registerOutput({ kind: "recorded-agent", goalId, runId: id,
		runDirectory: interruptedReaderDir, agent: "note_agent", executionId: readerExecution,
		sessionFile: basename(agentSessionPath(interruptedReaderDir, "note_agent", readerExecution)),
		startedAt: "2026-10-07T09:00:00.000Z", finishedAt: "2026-10-07T09:01:00.000Z", lifecycle: "finished", outcome: "failed" });
	assert.ok(!outputs.readOutput(goalId, oldAttempt)?.lines.some(line => line.text.includes("Saved original reading before interruption")),
		"A reused live log cannot expose a later attempt as the failed attempt's output");
	const cancelledId = "d".repeat(24);
	const controller = new AbortController();
	await assert.rejects(runInInvestigationThread({ goalDir, executionId: cancelledId, question: "Cancelled question", signal: controller.signal }, async () => {
		controller.abort();
		throw new Error("User stopped the investigation");
	}));
	assert.equal(projection.getGoal(goalId).history.items.find(item => item.activityId === `investigation:${cancelledId}`)?.outcome,
		"cancelled", "User cancellation keeps its own outcome instead of becoming a model failure");
	console.log("Investigation live progress and historical Activity projection passed");
} finally {
	rmSync(workspaceDir, { recursive: true, force: true });
}
