import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { NodeBacktestService } from "../../server/evaluation/node-backtest.js";
import {
	createWikiCuratorReplayRecipe,
	createWikiShardReplayRecipe,
	validateWikiShardReplayGoalContext,
	runWikiCuratorNodeEvaluation,
	runWikiShardNodeEvaluation,
} from "../../server/evaluation/wiki-replay.js";
import { serverRuntimeDirForGoal } from "../../server/workspaces/server-runtime-paths.js";

import { getResearchSourceServiceManager } from "../../server/providers/source-service-client.js";

const root = mkdtempSync(join(tmpdir(), "telomi-wiki-frozen-replay-"));
const workspaceDir = join(root, "data");
const goalId = "goal_wiki_frozen";
const goalDirectory = join(workspaceDir, goalId);
const sourceRunId = "source-wiki-frozen";
const sourceRun = join(serverRuntimeDirForGoal(goalId, workspaceDir), "runs", "wiki-update-frozen");
const candidateRoot = join(root, "candidate");
for (const agentId of ["wiki-shard-builder", "wiki-curator"] as const) {
	for (const [variant, directory] of [["baseline", goalDirectory], ["candidate", candidateRoot]] as const) {
		const skill = join(directory, "skills", agentId, "fixture");
		mkdirSync(skill, { recursive: true });
		writeFileSync(join(skill, "SKILL.md"), `---\nname: fixture\ndescription: Wiki ${variant} fixture.\n---\n`);
		writeFileSync(join(skill, "variant.txt"), `${variant}\n`);
	}
}
mkdirSync(sourceRun, { recursive: true });
const topicPlan = {
	schema_version: 1 as const,
	goal_id: goalId,
	revision: "revision-1",
	status: "active" as const,
	topics: [{ id: "evaluation", title: "Evaluation", intent: "Track evaluation systems.",
		questions: ["How are agents evaluated?"], include: ["agent evaluation"], exclude: ["unrelated benchmarks"] }],
};
const evidence = {
	schema_version: 1 as const,
	snapshot_id: "snapshot-1",
	run_id: sourceRunId,
	pipeline: { id: "cornell-note", version: "1", sha256: "a".repeat(64) },
	source_bundle_refs: ["artifacts/source-bundles/source-1"],
	notes: [],
};

// Missing Goal context is rejected; current captured inputs are never rewritten.
const contextDirectory = join(root, "context-validation");
mkdirSync(contextDirectory, { recursive: true });
const contextPath = join(contextDirectory, "request.json");
const missingContext = JSON.stringify({ goal: "RESEARCH_QUESTION" });
writeFileSync(contextPath, missingContext);
assert.throws(() => validateWikiShardReplayGoalContext(contextDirectory), /structured Goal/u);
assert.equal(readFileSync(contextPath, "utf-8"), missingContext);
const capturedContext = JSON.stringify({ goal_context: { title: "Actual Goal title", description: "" } });
writeFileSync(contextPath, capturedContext);
validateWikiShardReplayGoalContext(contextDirectory);
assert.equal(readFileSync(contextPath, "utf-8"), capturedContext);
const shardTrace = writeWikiTrace(join(sourceRun, "wiki-shard-work"), "maintainer");
const shardRootSessions = ["entity", "concept"].map((task) =>
	writeRootSession(join(sourceRun, "wiki-shard-sessions"), task, task));
const capturedShard = await runWikiShardNodeEvaluation({
	goal: "Build an evidence-grounded evaluation Wiki.",
	goalContext: { title: "Evaluation Goal", description: "Durable knowledge scope" },
	evidence,
	topicPlan,
	workRoot: join(sourceRun, "wiki-shard-work"),
	sessionRoot: join(sourceRun, "wiki-shard-sessions"),
	batch: { id: "batch-1", index: 0, total: 1, sourceIds: ["source-1"] },
	signal: new AbortController().signal,
}, {
	env: { TELOMI_WIKI_MAINTAINER_THINKING_LEVEL: "low", TELOMI_WIKI_MAINTAINER_MODEL: "test/root", TELOMI_PRIME_AGENT_ROOT_MODEL: "test/root", TELOMI_PRIME_AGENT_CHILD_MODEL: "test/child" },
	recordDirectory: sourceRun,
	runId: sourceRunId,
	execute: async (input) => {
		assert.equal(input.env?.TELOMI_WIKI_MAINTAINER_THINKING_LEVEL, "low");
		writeLogicalWorkspaces(input.logicalWorkspaceCaptureRoot!, "wiki-shard-builder");
		return fakeWikiResult(join(input.workRoot, "knowledge"), [
			...shardRootSessions,
			join(shardTrace, "session-artifacts"),
		]);
	},
});
const curatorTrace = writeWikiTrace(join(sourceRun, "wiki-curator-work"), "curator");
const curatorRootSession = writeRootSession(join(sourceRun, "wiki-curator-sessions"), "wiki-curator");
await runWikiCuratorNodeEvaluation({
	operation: "initialize",
	goal: "Build an evidence-grounded evaluation Wiki.",
	topicPlan,
	draftRoots: [capturedShard.knowledgeRoot],
	workRoot: join(sourceRun, "wiki-curator-work"),
	sessionRoot: join(sourceRun, "wiki-curator-sessions"),
	signal: new AbortController().signal,
}, {
	env: { TELOMI_WIKI_MAINTAINER_THINKING_LEVEL: "low", TELOMI_WIKI_MAINTAINER_MODEL: "test/root", TELOMI_PRIME_AGENT_ROOT_MODEL: "test/root", TELOMI_PRIME_AGENT_CHILD_MODEL: "test/child" },
	recordDirectory: sourceRun,
	runId: sourceRunId,
	execute: async (input) => {
		assert.equal(input.env?.TELOMI_WIKI_MAINTAINER_THINKING_LEVEL, "low");
		writeLogicalWorkspaces(input.logicalWorkspaceCaptureRoot!, "wiki-curator");
		return fakeWikiResult(join(input.workRoot, "knowledge"), [
			curatorRootSession,
			join(curatorTrace, "session-artifacts"),
		]);
	},
});

const recipes = [
	createWikiShardReplayRecipe({ execute: fakeReplay("wiki-shard-builder") }),
	createWikiCuratorReplayRecipe({ execute: fakeReplay("wiki-curator") }),
];
const service = new NodeBacktestService({ workspaceDir, listGoalIds: () => [goalId], recipes });

try {
	service.start();
	const candidate = service.createCapabilitySnapshot(goalId, candidateRoot);
	for (const agentId of ["wiki-shard-builder", "wiki-curator"] as const) {
		const cases = service.listCases(goalId, agentId, 10);
		assert.equal(cases.length, 1, `${agentId} production execution must capture one Node Case`);
		assert.equal(cases[0]!.ref.sourceRunId, cases[0]!.value.runId);
		assert.ok(cases[0]!.value.workspace, `${agentId} production Case must record workspace snapshots`);
		assert.ok(cases[0]!.value.observed.logicalWorkspaces, `${agentId} production Case must record logical Workspaces`);
		const caseFiles = service.listCaseFiles(goalId, cases[0]!.ref);
		assert.match(caseFiles.find((file) => file.kind === "agent_trace")?.ref ?? "", /sessions\/(?:[^/]+\/)?[^/]+\.jsonl$/u,
			`${agentId} historical Case must use its Prime native Root session as Agent Trace`);
		if (agentId === "wiki-shard-builder") assert.ok(caseFiles.filter((file) => file.kind === "agent_trace").length >= 2,
			"Wiki Shard Case manifest must retain both primary task sessions");
		assert.ok(caseFiles.some((file) => file.kind === "runtime_trace"),
			`${agentId} historical Case must expose compact SDK lifecycle events`);
		for (const kind of agentId === "wiki-curator"
			? ["child_metadata", "agent_plan", "agent_assignment", "agent_contract", "agent_input"]
			: ["user_prompt", "worker_result"]) {
			assert.ok(caseFiles.some((file) => file.kind === kind),
				`${agentId} historical Case must expose ${kind}`);
		}
		if (agentId === "wiki-curator") {
			assert.ok(caseFiles.some((file) => file.kind === "relation_assignment"));
			assert.ok(caseFiles.some((file) => file.kind === "relation_contract"));
		}
		assert.match(readFileSync(join(
			sourceRun,
			"node-evaluation",
			"cases",
			cases[0]!.value.caseId,
			"observed-output",
			"rubric.md",
		), "utf-8"), /semantic quality/u);
		const run = service.enqueue(goalId, {
			agentId,
			cases: [cases[0]!.ref],
			candidate: { capabilitySnapshotId: candidate.id },
			repetitions: 1,
			rubricId: `${agentId}-wiki-quality-v1`,
		});
		const completed = await waitFor(service, run.id);
		assert.equal(completed.status, "awaiting_evaluation", completed.error);
		const execution = completed.executions[0]!;
		assert.deepEqual(execution.candidateCaseRef, {
			sourceRunId: `${run.id}::executions::${execution.id}`,
			caseId: execution.candidateCaseRef?.caseId,
		});
		const candidateCase = service.readCase(goalId, execution.candidateCaseRef!);
		assert.equal(candidateCase.capabilitySnapshotId, candidate.id);
		assert.ok(candidateCase.workspace, `${agentId} Candidate Replay Case must record workspace snapshots`);
		assert.ok(candidateCase.observed.logicalWorkspaces, `${agentId} Candidate Case must record logical Workspaces`);
		const logicalFile = agentId === "wiki-shard-builder"
			? join("logical-workspaces", "root", "entity", "workspace", "work", "entity", "fixture.json")
			: join("logical-workspaces", "child", "sub-fixture", "workspace", "work", "assignments", "fixture.json");
		assert.ok(existsSync(join(dirname(inputCasePath(workspaceDir, goalId, run.id, execution.id, candidateCase.caseId)), logicalFile)));
		assert.deepEqual(completed.executions.map((execution) => {
			const output = JSON.parse(readFileSync(service.artifactFile(goalId, run.id, execution.id), "utf-8")) as { variant: string };
			return [execution.variant, output.variant];
		}), [["candidate", "candidate"]]);
		const refs = completed.executions[0]!.refs ?? {};
		assert.ok(refs.wikiRootTrace1, `${agentId} replay must expose its Root session`);
		assert.equal(refs.agentTrace, refs.wikiRootTrace1,
			`${agentId} replay must use the Prime native Root session as its Agent Trace`);
		assert.ok(refs.wikiSdkEvents, `${agentId} replay must keep compact SDK lifecycle events`);
		assert.ok(refs.wikiWorkerResult1, `${agentId} replay must expose native child results`);
		if (agentId === "wiki-curator") {
			assert.ok(refs.wikiInput1, "curator replay must expose its file inputs");
			assert.ok(refs.wikiChildTrace1, "wiki-curator replay must expose native child traces");
			assert.ok(refs.wikiChildMetadata1, "wiki-curator replay must expose native child metadata");
			assert.ok(refs.wikiPlan, "wiki-curator replay must expose the Agent-authored Plan");
			assert.ok(refs.wikiAssignment1, "wiki-curator replay must expose child assignments");
			assert.ok(refs.wikiChildContract, "wiki-curator replay must expose the child contract");
			assert.ok(refs.wikiRelationAssignment, "wiki-curator replay must expose the relation assignment");
			assert.ok(refs.wikiRelationContract, "wiki-curator replay must expose the relation contract");
		} else {
			assert.ok(refs.wikiRootTrace2, "wiki-shard-builder replay must expose both primary task sessions");
			assert.ok(refs.wikiSdkEvents2, "wiki-shard-builder replay must expose both task event streams");
			assert.ok(refs.wikiUserPrompt2, "wiki-shard-builder replay must expose both initial User Prompts");
			assert.equal(Object.keys(refs).some((kind) => kind.startsWith("wikiInput")), false, "inline inputs are in captured User Prompts, not duplicate files");
			assert.equal(refs.wikiPlan, undefined);
		}
		assert.equal(service.evaluationBatch(goalId, run.id).pairs.length, 1);
	}
	console.log("Wiki Shard Builder and Wiki Curator compare Candidate Replay with Observed Baseline artifacts");
} finally {
	service.stop();
	await getResearchSourceServiceManager().close();
	rmSync(root, { recursive: true, force: true });
}

function fakeReplay(agentId: "wiki-shard-builder" | "wiki-curator") {
	return async (input: {
		harnessWorkspaceDirectory: string;
		recordDirectory: string;
		workDirectory: string;
		logicalWorkspaceCaptureRoot: string;
		artifactStore: { publishText(content: string, path: string): unknown };
	}) => {
		const variant = readFileSync(join(input.harnessWorkspaceDirectory, "skills", agentId, "fixture", "variant.txt"), "utf-8").trim();
		writeWikiTrace(input.workDirectory, agentId === "wiki-curator" ? "curator" : "maintainer");
		const sessionRoot = join(input.recordDirectory, "sessions", "sessions");
		for (const name of agentId === "wiki-curator" ? [agentId] : ["entity", "concept"]) {
			const rootSession = join(sessionRoot, name, `${name}.jsonl`);
			mkdirSync(join(rootSession, ".."), { recursive: true });
			writeFileSync(rootSession, '{"type":"message"}\n');
		}
		writeLogicalWorkspaces(input.logicalWorkspaceCaptureRoot, agentId);
		return {
			artifact: input.artifactStore.publishText(`${JSON.stringify({ variant })}\n`, "result.json"),
			usage: { inputTokens: 1, outputTokens: 1, costUsd: 0, calls: 1 },
			turns: 1,
			toolCalls: 1,
		};
	};
}

function writeLogicalWorkspaces(destination: string, agentId: "wiki-shard-builder" | "wiki-curator"): void {
	const keys = agentId === "wiki-shard-builder" ? ["root/entity", "root/concept"] : ["root", "child/sub-fixture"];
	for (const key of keys) {
		const root = join(destination, key);
		const task = key.endsWith("concept") ? "concept" : "entity";
		const file = agentId === "wiki-shard-builder"
			? join(root, "workspace", "work", task, "fixture.json")
			: join(root, "workspace", "work", "assignments", "fixture.json");
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(`${root}.json`, `${JSON.stringify({
			schemaVersion: 1,
			guestCwd: "/workspace",
			mounts: [{ guestPath: "/workspace", access: "read-write" }],
		}, null, 2)}\n`);
		writeFileSync(file, `${JSON.stringify({ agentId })}\n`);
	}
}

function inputCasePath(workspaceDir: string, goalId: string, runId: string, executionId: string, caseId: string): string {
	return join(serverRuntimeDirForGoal(goalId, workspaceDir), "evaluation", "node-backtests", runId,
		"executions", executionId, "node-evaluation", "cases", caseId, "manifest.json");
}

function fakeWikiResult(knowledgeRoot: string, sessionPaths: string[] = []) {
	mkdirSync(join(knowledgeRoot, "concepts"), { recursive: true });
	writeFileSync(join(knowledgeRoot, "README.md"), "# Evaluation Wiki\n");
	writeFileSync(join(knowledgeRoot, ".note-registry.json"), '{"schema_version":2,"entries":[]}\n');
	writeFileSync(join(knowledgeRoot, ".deferred-notes.json"), "[]\n");
	writeFileSync(join(knowledgeRoot, ".topic-plan.json"), `${JSON.stringify(topicPlan)}\n`);
	writeFileSync(join(knowledgeRoot, "concepts", "evaluation.md"), "# Evaluation\n\nGrounded evaluation page.\n");
	return { knowledgeRoot, pageCount: 1, usage: { inputTokens: 2, outputTokens: 1, costUsd: 0.01, calls: 1 }, sessionPaths };
}

function writeWikiTrace(workRoot: string, stage: "maintainer" | "curator"): string {
	const runtimeRoot = stage === "curator" ? join(workRoot, "curator-runtime") : join(workRoot, stage, "runtime");
	if (stage === "maintainer") {
		for (const task of ["entity", "concept"] as const) {
			const taskRuntime = join(runtimeRoot, task);
			const result = join(workRoot, stage, "workspace", "work", task, "result.json");
			mkdirSync(taskRuntime, { recursive: true });
			mkdirSync(join(result, ".."), { recursive: true });
			writeFileSync(join(taskRuntime, "sdk-events.jsonl"), '{"type":"tool_execution_start"}\n');
			writeFileSync(join(taskRuntime, "system-prompt.md"), "# Wiki system prompt\n");
			writeFileSync(join(taskRuntime, "user-prompt.md"), `# ${task} task\n`);
			writeFileSync(result, `{"task":"${task}","pages":[],"deferred_entries":[],"empty_reason":"fixture"}\n`);
		}
		writeFileSync(join(runtimeRoot, "system-prompt.md"), "# Wiki system prompt\n");
		return runtimeRoot;
	}
	const sdkEvents = join(runtimeRoot, "sdk-events.jsonl");
	const childTrace = join(runtimeRoot, "session-artifacts", "sub-fixture", "child.jsonl");
	const childMetadata = join(runtimeRoot, "session-artifacts", "sub-fixture", "rlm-subagent.json");
	const workerResult = join(workRoot, stage, "work", stage === "curator" ? "groups/fixture/result.json" : "results/fixture/result.json");
	const decisionRoot = join(workRoot, stage, "work");
	for (const path of [sdkEvents, childTrace, childMetadata, workerResult]) mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(sdkEvents, '{"type":"tool_execution_start"}\n');
	writeFileSync(childTrace, '{"type":"message"}\n');
	writeFileSync(childMetadata, '{"status":"completed"}\n');
	writeFileSync(workerResult, '{"ok":true}\n');
	writeFileSync(join(runtimeRoot, "system-prompt.md"), "# Wiki system prompt\n");
	writeFileSync(join(runtimeRoot, "result.json"), '{"status":"completed"}\n');
	mkdirSync(join(decisionRoot, "assignments"), { recursive: true });
	mkdirSync(join(workRoot, stage, "input"), { recursive: true });
	writeFileSync(join(decisionRoot, "plan.json"), '{"groups":[]}\n');
	writeFileSync(join(decisionRoot, "assignments", "fixture.json"), '{"group_id":"fixture"}\n');
	writeFileSync(join(decisionRoot, "child-contract.md"), "# Child contract\n");
	writeFileSync(join(workRoot, stage, "input", "index.json"), '{"input":true}\n');
	if (stage === "curator") {
		writeFileSync(join(decisionRoot, "relation-assignment.json"), '{"owned_pages":[]}\n');
		writeFileSync(join(decisionRoot, "relation-contract.md"), "# Relation contract\n");
	}
	return runtimeRoot;
}

function writeRootSession(sessionRoot: string, agentId: string, task?: string): string {
	const sessionDirectory = join(sessionRoot, "sessions", ...(task ? [task] : []));
	mkdirSync(sessionDirectory, { recursive: true });
	writeFileSync(join(sessionDirectory, `${agentId}.jsonl`), '{"type":"message"}\n');
	return sessionDirectory;
}

async function waitFor(service: NodeBacktestService, runId: string) {
	while (true) {
		const run = service.read(goalId, runId)!;
		if (["awaiting_evaluation", "failed", "cancelled"].includes(run.status)) return run;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}
