import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	AgentStageExecutionError,
	stageNodeGroupId,
	type AgentStageRequest,
	type AgentStageRunner,
	type ValidatedStageArtifact,
} from "../../server/agent-runtime/agent-stage-runtime.js";
import { RunArtifactStore } from "../../server/agent-runtime/artifact-store.js";
import { sha256 } from "../../server/lib/hash.js";
import { ObservabilityActivityProjection } from "../../server/observability/activity-projection.js";
import {
	appendResearchNodeRecord,
	appendResearchRuntimeNode,
	latestNodeDependencyIds,
	type NodeExecutionRecord,
} from "../../server/observability/run-records.js";
import { RuntimeCornellNoteAgentProcessor } from "../../server/research/cornell-note-agent.js";
import { RuntimeCornellNotesMaterializer } from "../../server/research/pipeline/cornell-notes.js";
import type { LogicalSource } from "../../server/research/research-types.js";

const goalId = "goal_fanout_grouping";
const runId = "2026-09-20T00-00-00.000Z";
const root = mkdtempSync(join(tmpdir(), "telomi-node-fanout-"));
const runDir = join(root, "run-records");
const workspaceDir = join(root, "workspace");
const controlDir = join(root, "control");
const sourceDir = join(root, "source");
const pipeline = { id: "research-run", version: "1", sha256: sha256("pipeline") };
const recorded: Array<NodeExecutionRecord & { event_id: number }> = [];
const failing = new Set<string>();
let startedStageIds: string[] = [];
let clock = 0;

/** Replays the Stage Runtime seam: identity and dependencies are resolved when a Stage starts. */
const recordingRunner: AgentStageRunner = {
	async runStage<T>(request: AgentStageRequest<T>): Promise<ValidatedStageArtifact<T>> {
		startedStageIds.push(request.stageId);
		const groupId = stageNodeGroupId(request, "research");
		const dependsOn = latestNodeDependencyIds(runDir, "research", { group: groupId });
		// 同一波起跑的 Stage 在任何记录落盘前都已确定身份与依赖。
		await new Promise((resolve) => { setImmediate(resolve); });
		const sourceId = request.session.key.replace("cornell-note/", "");
		const failed = failing.delete(sourceId);
		const entryPath = join(request.workDirectory, "cornell-note.json");
		if (!failed) {
			writeFileSync(entryPath, `${JSON.stringify({
				sections: [{
					section_title: "Note",
					summary: "The Source is readable.",
					cue_notes: [{
						cue: "Readable + Source",
						note: "The Source body is one line.",
						evidence: [{ source_path: "note.md", start_line: 1, end_line: 1 }],
					}],
				}],
			})}\n`);
		}
		const value = failed ? undefined : request.output.validate({
			entryPath,
			outputRoot: request.workDirectory,
			workDirectory: request.workDirectory,
		});
		recorded.push(appendResearchNodeRecord(runDir, {
			node_id: request.stageId,
			node_type: "agent",
			agent: request.role,
			execution_id: `${request.stageId}--${request.attemptId}`,
			attempt: request.attempt ?? 1,
			status: failed ? "failed" : "succeeded",
			group_id: groupId,
			depends_on: dependsOn,
			input: { stage_id: request.stageId },
			output: { metrics: { model_calls: 4, tool_calls: 3 } },
			time: { started_at: timestamp(), finished_at: timestamp(), duration_ms: 1_000 },
		}));
		if (failed) throw new AgentStageExecutionError("Cornell Note validation exhausted", "validation");
		return {
			value: value as T,
			artifact: request.artifactStore.publishFile(entryPath, request.output.publishRelativePath),
			submissionCount: 1,
			validationErrors: [],
			session: { id: request.stageId, mode: "fresh" },
			turns: 1,
			toolCalls: 1,
			toolCounts: { ipython: 1 },
			usage: { inputTokens: 1, outputTokens: 1, costUsd: 0, calls: 1 },
			sessionPath: join(request.controlDirectory, `${request.attemptId}.jsonl`),
		};
	},
};

const materializer = new RuntimeCornellNotesMaterializer(new RuntimeCornellNoteAgentProcessor({
	outputLanguage: "en",
	documentConcurrency: 2,
	cornellNoteModel: "openai-codex/test",
	cornellNoteThinkingLevel: "medium",
}, recordingRunner));

function logicalSource(id: string, revision: string): LogicalSource {
	return {
		id,
		title: id,
		url: `https://example.com/${id}`,
		providerId: "arxiv",
		sourceIdentity: id,
		revisionSha256: sha256(revision),
		directoryPath: sourceDir,
		organizationKind: "ungrouped",
		members: [],
	};
}

function materialize(sequence: number, sources: LogicalSource[]) {
	return materializer.materialize({
		runId,
		sequence,
		question: "How is a fanout recorded?",
		goal: { title: "Fanout grouping", description: "" },
		discoveryEnabled: false,
		sources,
		sourceBundleRefs: [],
		pipeline,
		workspaceDir,
		controlDir,
		signal: new AbortController().signal,
		artifactStore: new RunArtifactStore(workspaceDir),
	});
}

function runtimeNode(nodeId: string): NodeExecutionRecord & { event_id: number } {
	const record = appendResearchRuntimeNode(runDir, {
		node_id: nodeId,
		status: "succeeded",
		input: {},
		output: {},
		started_at: timestamp(),
		finished_at: timestamp(),
	});
	recorded.push(record);
	return record;
}

function timestamp(): string {
	clock += 1_000;
	return new Date(Date.parse("2026-09-20T00:00:00.000Z") + clock).toISOString();
}

function agentRecords() {
	return recorded.filter((node) => node.node_type === "agent");
}

function nodeIdRecords(nodeId: string) {
	return agentRecords().filter((node) => node.node_id === nodeId);
}

try {
	mkdirSync(runDir, { recursive: true });
	mkdirSync(sourceDir, { recursive: true });
	writeFileSync(join(sourceDir, "note.md"), "one readable line\n");
	const searchBatchOne = runtimeNode("prime-search-batch-1");

	// Four Sources through two concurrency slots: the first wave starts together, the rest
	// start only after earlier members are already recorded.
	const first = await materialize(1, ["source-a", "source-b", "source-c", "source-d"]
		.map((id) => logicalSource(id, "revision-1")));
	assert.equal(first.evidence.notes.length, 4);
	const batchOneStageIds = startedStageIds;
	const fanoutOne = `${runId}:cornell_note:sequence-1`;
	assert.deepEqual(agentRecords().map((node) => node.group_id), Array<string>(4).fill(fanoutOne),
		"a staggered start must not change the fanout a Note belongs to");
	assert.deepEqual(agentRecords().map((node) => node.depends_on),
		Array<number[]>(4).fill([searchBatchOne.event_id]),
		"every member depends on what the fanout started from, not on the siblings that finished first");

	// The node after the fanout depends on the complete fanout.
	const searchBatchTwo = runtimeNode("prime-search-batch-2");
	assert.deepEqual(searchBatchTwo.depends_on, agentRecords().map((node) => node.event_id));

	// A second batch where Source B fails: its Note has no checkpoint to reuse.
	const batchTwo = ["source-a", "source-b"].map((id) => logicalSource(id, "revision-2"));
	failing.add("source-b");
	startedStageIds = [];
	const failedRun = await materialize(2, batchTwo);
	assert.deepEqual(failedRun.failures.map((failure) => failure.source_id), ["source-b"]);
	const attempted = startedStageIds;
	assert.equal(attempted.length, 2);

	// Resumed: Source A is reused from its checkpoint, so the pending list shrinks to B alone.
	startedStageIds = [];
	const resumed = await materialize(2, batchTwo);
	assert.deepEqual(resumed.evidence.notes.map((note) => note.note.source_id).sort(), ["source-a", "source-b"]);
	assert.deepEqual(startedStageIds, attempted.slice(1),
		"a shorter pending list must not rename the Stage the same Source already ran under");
	const fanoutTwo = `${runId}:cornell_note:sequence-2`;
	const retries = nodeIdRecords(startedStageIds[0]!);
	assert.equal(retries.length, 2, "the resumed Note stays one logical node in its batch");
	assert.deepEqual(retries.map((node) => node.group_id), [fanoutTwo, fanoutTwo]);
	assert.deepEqual(retries.map((node) => node.depends_on),
		[[searchBatchTwo.event_id], [searchBatchTwo.event_id]],
		"a resumed member keeps the dependencies of its own fanout, not the nodes recorded meanwhile");

	const steps = new ObservabilityActivityProjection().fromNodes(goalId, runId, runDir, recorded);
	assert.deepEqual(
		steps.map((step) => step.stepId),
		[
			`node:${searchBatchOne.event_id}`,
			`group:${fanoutOne}`,
			`node:${searchBatchTwo.event_id}`,
			`group:${fanoutTwo}`,
		],
		"each logical fanout projects as exactly one parallel step",
	);

	const groupOne = steps[1]!;
	assert.equal(groupOne.parallelSteps.length, 4, "the whole fanout stays in one parallel step");
	assert.deepEqual(groupOne.dependsOnStepIds, [`node:${searchBatchOne.event_id}`]);

	const groupTwo = steps[3]!;
	assert.deepEqual(groupTwo.parallelSteps.map((step) => step.stepId).sort(),
		[`node:${nodeIdRecords(attempted[0]!)[0]!.event_id}`, `node:${retries[0]!.event_id}`].sort(),
		"a later fanout is its own step, and its retried member is one node with two attempts");
	assert.deepEqual(groupTwo.dependsOnStepIds, [`node:${searchBatchTwo.event_id}`]);
	const retriedStep = groupTwo.parallelSteps.find((step) => step.stepId === `node:${retries[0]!.event_id}`);
	assert.equal(retriedStep?.agentActivities[0]?.attempts.length, 2);
	assert.equal(retriedStep?.outcome, "succeeded", "the retry decides the outcome of the Note");

	// The same Source in another batch is another logical node, inside its own fanout.
	const sourceAInBatchOne = batchOneStageIds.find((stageId) => stageId.includes("source-a"))!;
	assert.notEqual(sourceAInBatchOne, attempted[0]);
	assert.equal(nodeIdRecords(sourceAInBatchOne).length, 1);
	assert.ok(groupOne.parallelSteps
		.some((step) => step.stepId === `node:${nodeIdRecords(sourceAInBatchOne)[0]!.event_id}`));
} finally {
	rmSync(root, { recursive: true, force: true });
}

console.log("Node fanout grouping test passed");
