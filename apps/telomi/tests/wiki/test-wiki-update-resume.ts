import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LlmWikiCompiler } from "../../server/wiki/compiler.js";
import { noteWikiEntries } from "../../server/wiki/note-wiki-maintainer.js";
import {
	canResumeWikiUpdateJob,
	MAX_WIKI_UPDATE_ATTEMPTS,
	WikiUpdateJobStore,
	WIKI_UPDATE_JOB_FILE,
} from "../../server/wiki/wiki-update-job.js";
import { runRecordsDir } from "../../server/observability/run-records.js";
import { RunArtifactStore } from "../../server/agent-runtime/artifact-store.js";
import type { CornellNotesSnapshot } from "../../server/cornell/contracts.js";
import type { GoalTopicPlan, WikiCompilationResult } from "../../server/wiki/contracts.js";
import type { WikiPublicationResult } from "../../server/wiki/publication.js";
import { subscribe } from "../../server/events/event-bus.js";
import { createWikiUpdateTool } from "../../server/main-agent/tools/wiki-update.js";
import { GoalTopicPlanStore } from "../../server/goals/topic-plan/index.js";
import { serverRuntimeDirForGoal } from "../../server/workspaces/server-runtime-paths.js";
import {
	hasActiveWikiUpdate,
	markInterruptedWikiUpdates,
	resumeWikiUpdate,
	startWikiUpdateActivity,
	wikiUpdateArtifactDir,
	wikiUpdateRecordDir,
} from "../../server/wiki/update-runner.js";

const root = mkdtempSync(join(tmpdir(), "pi-wiki-resume-"));
const topicPlan: GoalTopicPlan = {
	schema_version: 1,
	goal_id: "goal-resume-test",
	revision: "test-topic-v1",
	status: "active",
	topics: [{ id: "models", title: "Models", intent: "Model knowledge.", questions: [], include: [], exclude: [] }],
};
try {
	await testWikiUpdateToolCurrentGoal();
	await testPartialGoalChangeRetry();
	await testCompilerStreamingIsolation();
	await testCompilerRejectsAllFailedBatches();
	await testCompilerBatchResume();
	await testCompilerClaimsPublishedKnowledge();
	testJobRecordLifecycle();
	await testInterruptedJobResume();
	await testStandaloneWikiUpdateActivity();
	await testStandaloneWikiUpdateIdempotency();
	await testStandaloneWikiUpdateRebuildAndRetry();
	await testPartialWikiUpdateActivity();
	console.log("Wiki update resume Interface passed");
} finally {
	rmSync(root, { recursive: true, force: true });
}

async function testPartialGoalChangeRetry(): Promise<void> {
	const workspace = prepareWorkspace("partial-goal-change", 20);
	workspace.request.rebuild = false;
	const published = join(workspace.request.goalDir, "wiki", "knowledge");
	let fail = false;
	let calls = 0;
	const compiler = new LlmWikiCompiler({ maintain: async ({ evidence, workRoot }) => {
		calls += 1;
		if (fail && batchIndex(evidence) === 1) throw new Error("partial failure");
		return writeBatchWiki(workRoot, batchIndex(evidence));
	}, curate: async (input) => {
		const result = await fakeCurateWiki(input);
		writeFileSync(join(result.knowledgeRoot, ".note-registry.json"), JSON.stringify({ entries: noteWikiEntries(buildEvidence(20)) }));
		writeFileSync(join(result.knowledgeRoot, ".topic-plan.json"), JSON.stringify(workspace.request.topicPlan));
		return result;
	} });
	const first = await compiler.compile({ ...workspace.request, goalContext: { title: "Goal A", description: "" } });
	cpSync(first.knowledge.absolutePath, published, { recursive: true });
	fail = true;
	const request = { ...workspace.request, goalContext: { title: "Goal B", description: "" } };
	const partial = await compiler.compile({ ...request, runId: "partial" });
	assert.equal(partial.failedBatches.length, 1);
	rmSync(published, { recursive: true, force: true });
	cpSync(partial.knowledge.absolutePath, published, { recursive: true });
	fail = false;
	const before = calls;
	const retried = await compiler.compile({ ...request, runId: "retry" });
	assert.equal(calls, before + 2, "partial Goal change must not cache incomplete semantic work as complete");
	assert.equal(retried.failedBatches.length, 0);
}

async function testWikiUpdateToolCurrentGoal(): Promise<void> {
	const workspaceDir = join(root, "tool-goal-hot-update");
	const goalId = "goal-tool-test";
	const runId = "source-run";
	const sourceControl = join(serverRuntimeDirForGoal(goalId, workspaceDir), "runs", runId);
	mkdirSync(sourceControl, { recursive: true });
	writeFileSync(join(sourceControl, "run-state.json"), JSON.stringify({ goal_id: goalId, run_id: runId,
		question: "NOT_A_GOAL_DESCRIPTION", language: "zh-CN", cornell_note_snapshots: [{ relative_path: "notes.json", sha256: "a".repeat(64), byte_length: 1 }] }));
	const store = new GoalTopicPlanStore(goalId, workspaceDir);
	const proposal = store.proposePatch({ source: "main_agent", patch: { schema_version: 1, base_revision: null,
		summary: "Test", operations: [{ op: "add", topic: topicPlan.topics[0]! }] } });
	store.activate(proposal.proposal_id);
	let title = "Initial title";
	let description = "Initial description";
	const observed: unknown[] = [];
	const tool = createWikiUpdateTool({ goalId, goalDir: join(workspaceDir, goalId), workspaceDir,
		goalTitle: "Stale title", goalDescription: "Stale description", getGoalTitle: () => title,
		getGoalDescription: () => description, getEnv: () => ({}) }, (input) => {
		observed.push(input.goalContext);
		return { wikiUpdateId: "test", reused: true, status: "succeeded" };
	});
	const invoke = () => tool.execute("test", { source_run_id: runId, reason: "Refresh Wiki", rebuild: false });
	await invoke();
	title = "New title";
	description = "New description";
	await invoke();
	description = "";
	await invoke();
	let preference: "auto" | "zh-CN" = "auto";
	const localized = createWikiUpdateTool({ goalId, goalDir: join(workspaceDir, goalId), workspaceDir,
		getGoalTitle: () => title, getGoalDescription: () => description, getOutputLanguage: () => preference,
		getEnv: () => ({}) }, (input) => {
		observed.push(input.goalContext);
		return { wikiUpdateId: "test", reused: true, status: "succeeded" };
	});
	title = "语音合成研究";
	await localized.execute("test", { source_run_id: runId, reason: "Refresh Wiki", rebuild: false });
	title = "English Goal";
	preference = "zh-CN";
	await localized.execute("test", { source_run_id: runId, reason: "Refresh Wiki", rebuild: false });
	// The Wiki language is Goal-level: `auto` follows the Goal's own wording, an explicit preference wins.
	assert.deepEqual(observed, [
		{ title: "Initial title", description: "Initial description", language: "en" },
		{ title: "New title", description: "New description", language: "en" },
		{ title: "New title", description: "", language: "en" },
		{ title: "语音合成研究", description: "", language: "zh-CN" },
		{ title: "English Goal", description: "", language: "zh-CN" },
	]);
}

async function testCompilerStreamingIsolation(): Promise<void> {
	const workspace = prepareWorkspace("streaming-isolation", 60);
	const events: string[] = [];
	const progress: Array<{ batchIndex: number; status: string; message?: string; traceRef?: string }> = [];
	const stages: Array<{ kind: string; stageIndex: number; status: string; traceRef?: string }> = [];
	const readTraceManifest = (traceRef: string | undefined) => {
		assert.ok(traceRef, "every running Wiki Agent must expose its native session roots before execution");
		const manifest = JSON.parse(readFileSync(join(workspace.request.controlDirectory, traceRef), "utf-8")) as {
			schemaVersion: number; sessions: Array<{ path: string; label: string }>;
		};
		assert.equal(manifest.schemaVersion, 1);
		assert.ok(manifest.sessions.length >= 2, "Wiki Trace must retain Root and child sessions");
		assert.ok(manifest.sessions.every((session) => session.label && !session.path.endsWith("sdk-events.jsonl")));
		return manifest;
	};
	let active = 0;
	let maxActive = 0;
	let releaseFirst!: () => void;
	let releaseLast!: () => void;
	let fourWorkersStarted!: () => void;
	const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
	const lastGate = new Promise<void>((resolve) => { releaseLast = resolve; });
	const fourWorkers = new Promise<void>((resolve) => { fourWorkersStarted = resolve; });
	const firstFallback = setTimeout(() => { releaseFirst(); releaseLast(); fourWorkersStarted(); }, 5_000);
	const compiler = new LlmWikiCompiler({
		maintain: async ({ evidence, workRoot, sessionRoot }) => {
			const index = batchIndex(evidence);
			const trace = readTraceManifest(progress.findLast((item) => item.batchIndex === index)?.traceRef);
			for (const role of ["entity", "concept"]) {
				assert.ok(trace.sessions.some((session) => join(workspace.request.controlDirectory, session.path) === join(sessionRoot, "sessions", role)));
				assert.ok(trace.sessions.some((session) => join(workspace.request.controlDirectory, session.path) === join(workRoot, "maintainer", "runtime", role, "session-artifacts")));
			}
			active += 1;
			maxActive = Math.max(maxActive, active);
			if (active === 4) fourWorkersStarted();
			events.push(`maintain:start:${index}`);
			try {
				if (index < 4) await firstGate;
				if (index === 5) await lastGate;
				if (index === 1) {
					for (const role of ["entity", "concept"]) {
						const trace = join(sessionRoot, "sessions", role);
						mkdirSync(trace, { recursive: true });
						writeFileSync(join(trace, "root.jsonl"), JSON.stringify({ type: "message",
							message: { role: "assistant", usage: { input: 7, output: 3, cost: { total: 0.01 } } } }) + "\n");
					}
					throw new Error("bad mini batch");
				}
				const result = writeBatchWiki(workRoot, index);
				const sessions = join(workRoot, "sessions");
				mkdirSync(join(sessions, "entity"), { recursive: true });
				writeFileSync(join(sessions, "entity", "root.jsonl"), "{}\n");
				result.sessionPaths.push(sessions);
				events.push(`maintain:end:${index}`);
				return result;
			} finally {
				active -= 1;
			}
		},
		curate: async (input) => {
			const trace = readTraceManifest(stages.at(-1)?.traceRef);
			assert.ok(trace.sessions.some((session) => join(workspace.request.controlDirectory, session.path) === join(input.sessionRoot, "sessions")));
			assert.ok(trace.sessions.some((session) => join(workspace.request.controlDirectory, session.path) === join(input.workRoot, "curator-runtime", "session-artifacts")));
			events.push(`curate:start:${input.draftRoots.length}`);
			releaseLast();
			return fakeCurateWiki(input);
		},
	});
	const compilation = compiler.compile({
		...workspace.request,
		onBatchProgress: (item) => progress.push({
			batchIndex: item.batchIndex,
			status: item.status,
			traceRef: item.traceRef,
			...(item.message ? { message: item.message } : {}),
		}),
		onStageProgress: (item) => stages.push({ kind: item.kind, stageIndex: item.stageIndex, status: item.status, traceRef: item.traceRef }),
	});
	await fourWorkers;
	releaseFirst();
	const result = await compilation;
	clearTimeout(firstFallback);
	assert.equal(maxActive, 4, "Wiki mini-batches must use four fair workers");
	assert.ok(events.indexOf("curate:start:1") < events.indexOf("maintain:end:5"),
		"rolling Curator must start before a later draft Shard settles");
	assert.deepEqual(result.failedBatches, [{
		batchIndex: 1,
		sourceIds: Array.from({ length: 10 }, (_, index) => `source:resume-${index + 10}`),
		message: "bad mini batch",
		usage: { inputTokens: 14, outputTokens: 6, costUsd: 0.02, calls: 2 },
	}]);
	for (const index of [0, 1]) {
		const first = progress.find((item) => item.batchIndex === index)!;
		const last = progress.findLast((item) => item.batchIndex === index)!;
		assert.equal(first.status, "running");
		assert.equal(first.traceRef, last.traceRef, "terminal status must retain the live Trace reference");
		readTraceManifest(last.traceRef);
	}
	assert.ok(readTraceManifest(progress.findLast((item) => item.batchIndex === 0)?.traceRef).sessions
		.some((session) => session.path.endsWith("batch-001/sessions")), "completed session roots returned by the Agent must remain included");
	assert.equal(progress.findLast((item) => item.batchIndex === 1)?.status, "failed");
	assert.match(progress.findLast((item) => item.batchIndex === 1)?.message ?? "", /bad mini batch/u);
	assert.equal(stages.filter((stage) => stage.kind === "curation" && stage.status === "succeeded").length, 5);
	assert.ok(!existsSync(join(result.knowledge.absolutePath, "concepts", "batch-1.md")));
	for (const index of [0, 2, 3, 4, 5]) {
		assert.ok(existsSync(join(result.knowledge.absolutePath, "concepts", `batch-${index}.md`)));
	}
	const record = JSON.parse(readFileSync(join(
		workspace.runDirectory,
		"artifacts",
		"wiki-compilations",
		result.compilationId,
		"compilation.json",
	), "utf-8")) as { failed_batches: unknown[] };
	assert.equal(record.failed_batches.length, 1, "failed mini-batches must remain auditable in the compilation artifact");
}

async function testCompilerRejectsAllFailedBatches(): Promise<void> {
	const workspace = prepareWorkspace("all-failed", 1);
	const knowledgeRoot = join(workspace.request.goalDir, "wiki", "knowledge");
	mkdirSync(join(knowledgeRoot, "concepts"), { recursive: true });
	mkdirSync(join(knowledgeRoot, "entities"), { recursive: true });
	writeFileSync(join(knowledgeRoot, ".note-registry.json"), JSON.stringify({ schema_version: 2, entries: [] }));
	const compiler = new LlmWikiCompiler({
		maintain: async () => { throw new Error("all failed"); },
		curate: async () => { throw new Error("Curator must not run without a successful Shard"); },
	});
	await assert.rejects(compiler.compile({ ...workspace.request, rebuild: false }), /All 1 Wiki mini-batches failed/u);
}

async function testStandaloneWikiUpdateActivity(): Promise<void> {
	const workspaceDir = join(root, "standalone-data");
	const goalId = "goal-standalone";
	const goalDir = join(workspaceDir, goalId);
	const sourceRunId = "run-source";
	const sourceRunDirectory = join(goalDir, "wiki", "runs", sourceRunId);
	const source = new RunArtifactStore(sourceRunDirectory)
		.publishText(`${JSON.stringify(buildEvidence(1), null, 2)}\n`, "artifacts/cornell-notes/snapshot.json");
	const started = startWikiUpdateActivity({
		workspaceDir,
		goalId,
		goalDir,
		goal: "Standalone Wiki Activity",
		goalContext: { title: "Goal title", description: "Goal description" },
		topicPlan,
		sourceRunId,
		sourceRunDirectory,
		cornellNotes: { relative_path: source.relativePath, sha256: source.sha256, byte_length: source.byteLength },
		parentActivityId: `research:${sourceRunId}`,
		trigger: { kind: "system" },
		reason: "validated Cornell Notes",
		env: {},
		dependencies: {
			compile: async (request) => {
				assert.equal(request.topicPlan?.revision, topicPlan.revision);
				assert.deepEqual(request.goalContext, { title: "Goal title", description: "Goal description" });
				request.onStarted?.(2);
				request.onBatchProgress?.({
					batchIndex: 0,
					totalBatches: 2,
					status: "succeeded",
					pageCount: 3,
					usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.01, calls: 1 },
					reused: false,
				});
				return fakeCompilation();
			},
			publish: async () => fakePublication(),
		},
	});
	assert.equal(started.reused, false);
	if (!started.reused) await started.execution;
	const controlDirectory = wikiUpdateRecordDir(workspaceDir, goalId, started.wikiUpdateId);
	const artifactDirectory = wikiUpdateArtifactDir(goalDir, started.wikiUpdateId);
	const job = new WikiUpdateJobStore(controlDirectory).load()!;
	assert.equal(job.status, "succeeded");
	assert.deepEqual(job.goal_context, { title: "Goal title", description: "Goal description" });
	assert.equal(job.wiki_update_id, started.wikiUpdateId);
	assert.equal(job.source_run_id, sourceRunId);
	assert.equal(job.parent_activity_id, `research:${sourceRunId}`);
	assert.equal(job.topic_plan?.revision, topicPlan.revision);
	assert.equal(job.progress?.completed_batches, 1);
	assert.equal(job.progress?.stages?.find((stage) => stage.kind === "publication")?.status, "succeeded");
	assert.ok(existsSync(join(artifactDirectory, "artifacts", "input", "cornell-notes.json")));
	assert.ok(existsSync(join(artifactDirectory, "artifacts", "wiki-update", "result.json")));
}

async function testStandaloneWikiUpdateIdempotency(): Promise<void> {
	const workspaceDir = join(root, "standalone-idempotent-data");
	const goalId = "goal-standalone-idempotent";
	const goalDir = join(workspaceDir, goalId);
	const sourceRunId = "run-source-idempotent";
	const sourceRunDirectory = join(goalDir, "wiki", "runs", sourceRunId);
	const source = new RunArtifactStore(sourceRunDirectory)
		.publishText(`${JSON.stringify(buildEvidence(1), null, 2)}\n`, "artifacts/cornell-notes/snapshot.json");
	let release!: () => void;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	const input = {
		workspaceDir,
		goalId,
		goalDir,
		goal: "Standalone Wiki idempotency",
		goalContext: { title: "Goal title", description: "Initial scope" },
		topicPlan,
		sourceRunId,
		sourceRunDirectory,
		cornellNotes: { relative_path: source.relativePath, sha256: source.sha256, byte_length: source.byteLength },
		parentActivityId: `research:${sourceRunId}`,
		trigger: { kind: "system" as const },
		reason: "validated Cornell Notes",
		env: {},
		dependencies: {
			compile: async () => { await gate; return fakeCompilation(); },
			publish: async () => fakePublication(),
		},
	};
	const started = startWikiUpdateActivity(input);
	const duplicate = startWikiUpdateActivity(input);
	assert.equal(started.reused, false);
	assert.equal(duplicate.reused, true);
	assert.equal(duplicate.wikiUpdateId, started.wikiUpdateId,
		"the same Research evidence must reuse one Wiki Update identity");
	release();
	if (!started.reused) await started.execution;
	const changedGoal = startWikiUpdateActivity({ ...input, goalContext: { title: "Goal title", description: "Changed scope" } });
	assert.equal(changedGoal.reused, false, "changed Goal metadata must not reuse the previous Wiki Update");
	assert.notEqual(changedGoal.wikiUpdateId, started.wikiUpdateId);
	if (!changedGoal.reused) await changedGoal.execution;
}

async function testStandaloneWikiUpdateRebuildAndRetry(): Promise<void> {
	const workspaceDir = join(root, "standalone-rebuild-data");
	const goalId = "goal-standalone-rebuild";
	const goalDir = join(workspaceDir, goalId);
	const sourceRunId = "run-source-rebuild";
	const sourceRunDirectory = join(goalDir, "wiki", "runs", sourceRunId);
	const source = new RunArtifactStore(sourceRunDirectory)
		.publishText(`${JSON.stringify(buildEvidence(1), null, 2)}\n`, "artifacts/cornell-notes/snapshot.json");
	const base = {
		workspaceDir,
		goalId,
		goalDir,
		goal: "Standalone Wiki rebuild",
		goalContext: { title: "Goal title", description: "Goal description" },
		topicPlan,
		sourceRunId,
		sourceRunDirectory,
		cornellNotes: { relative_path: source.relativePath, sha256: source.sha256, byte_length: source.byteLength },
		trigger: { kind: "system" as const },
		reason: "validated Cornell Notes",
		env: {},
		dependencies: {
			compile: async () => fakeCompilation(),
			publish: async () => fakePublication(),
		},
	};
	const first = startWikiUpdateActivity(base);
	assert.equal(first.reused, false);
	if (!first.reused) await first.execution;
	const rebuild = startWikiUpdateActivity({ ...base, rebuild: true });
	assert.equal(rebuild.reused, false, "an explicit rebuild must not reuse an incremental Wiki Update");
	if (!rebuild.reused) await rebuild.execution;

	const failedGoalId = "goal-standalone-retry";
	const failedControl = wikiUpdateRecordDir(workspaceDir, failedGoalId, "wiki-failed");
	const failed = new WikiUpdateJobStore(failedControl);
	failed.start({
		goalId: failedGoalId,
		runId: "wiki-failed",
		wikiUpdateId: "wiki-failed",
		sourceRunId,
		goal: "Failed Wiki",
		goalContext: { title: "Goal title", description: "Goal description" },
		topicPlan,
		cornellNotes: base.cornellNotes,
	});
	failed.settle("failed", { message: "provider failed" });
	const retry = startWikiUpdateActivity({ ...base, goalId: failedGoalId, goalDir: join(workspaceDir, failedGoalId) });
	assert.equal(retry.reused, false, "a failed Wiki Update must not swallow a retry");
	if (!retry.reused) await retry.execution;
}

async function testPartialWikiUpdateActivity(): Promise<void> {
	const workspaceDir = join(root, "partial-data");
	const goalId = "goal-partial-activity";
	const goalDir = join(workspaceDir, goalId);
	const sourceRunDirectory = join(goalDir, "wiki", "runs", "source-run");
	const source = new RunArtifactStore(sourceRunDirectory)
		.publishText(`${JSON.stringify(buildEvidence(1), null, 2)}\n`, "artifacts/cornell-notes/snapshot.json");
	const failure = {
		batchIndex: 2,
		sourceIds: ["source:failed"],
		message: "child failed",
		usage: { inputTokens: 12, outputTokens: 3, costUsd: 0.02, calls: 1 },
	};
	const input = {
		workspaceDir,
		goalId,
		goalDir,
		goal: "Partial Wiki Activity",
		goalContext: { title: "Goal title", description: "Goal description" },
		topicPlan,
		sourceRunId: "source-run",
		sourceRunDirectory,
		cornellNotes: { relative_path: source.relativePath, sha256: source.sha256, byte_length: source.byteLength },
		trigger: { kind: "system" },
		reason: "partial test",
		env: {},
		dependencies: {
			compile: async () => ({ ...fakeCompilation(), failedBatches: [failure] }),
			publish: async () => fakePublication(),
		},
	};
	const started = startWikiUpdateActivity(input);
	assert.equal(started.reused, false);
	if (started.reused) throw new Error("new partial Wiki Update was unexpectedly reused");
	const execution = await started.execution;
	assert.equal(execution.status, "partial");
	assert.deepEqual(execution.failedBatches, [failure]);
	const job = new WikiUpdateJobStore(wikiUpdateRecordDir(workspaceDir, goalId, started.wikiUpdateId)).load()!;
	assert.equal(job.status, "partial");
	assert.equal(job.progress?.stages?.find((stage) => stage.kind === "publication")?.status, "succeeded");
	assert.equal(job.failed_batches?.[0]?.source_ids[0], "source:failed");
	assert.match(job.message ?? "", /1 个 Source 批次失败/u);
	const result = JSON.parse(readFileSync(join(
		wikiUpdateArtifactDir(goalDir, started.wikiUpdateId),
		"artifacts", "wiki-update", "result.json",
	), "utf-8")) as { status: string; failed_batches: unknown[] };
	assert.equal(result.status, "partial");
	assert.equal(result.failed_batches.length, 1);
	const retry = startWikiUpdateActivity(input);
	assert.equal(retry.reused, false, "a partial Wiki Update must not swallow a retry");
	if (!retry.reused) await retry.execution;
}

/** 第二个 Shard 中断：续跑独立复用所有有效 Shard checkpoint。 */
async function testCompilerBatchResume(): Promise<void> {
	const workspace = prepareWorkspace("batch-resume");
	const executed: number[] = [];
	const sessionRoots = new Set<string>();
	const curatorSessionRoots = new Set<string>();
	let controller = new AbortController();
	let batchZeroDone!: () => void;
	const batchZero = new Promise<void>((resolve) => { batchZeroDone = resolve; });
	let failBatch: number | undefined = 1;
	const compiler = new LlmWikiCompiler({
		maintain: async ({ evidence, workRoot, sessionRoot, batch }) => {
			const index = batchIndex(evidence);
			sessionRoots.add(sessionRoot);
			assert.ok(batch.sourceIds.length <= 10);
			const partial = join(workRoot, "maintainer", "work", "results", "partial", "result.json");
			if (index === failBatch) {
				await batchZero;
				mkdirSync(join(workRoot, "maintainer", "work", "results", "partial"), { recursive: true });
				writeFileSync(partial, "[]\n");
				controller.abort(new Error("interrupted"));
				throw new Error("interrupted");
			}
			if (index === 1) assert.ok(existsSync(partial), "resume must preserve accepted child result files");
			executed.push(index);
			const result = writeBatchWiki(workRoot, index);
			if (index === 0) batchZeroDone();
			return result;
		},
		curate: async (input) => {
			curatorSessionRoots.add(input.sessionRoot);
			return fakeCurateWiki(input);
		},
	});
	await assert.rejects(compiler.compile({ ...workspace.request, signal: controller.signal }), /interrupted/u);
	const completedBeforeInterrupt = new Set(executed);
	assert.ok(completedBeforeInterrupt.has(0), "the first Source batch must checkpoint before interruption");
	const checkpoint = join(workspace.controlDirectory, "note-wiki");
	assert.ok(existsSync(checkpoint), "an interrupted Source batch keeps its file Workspace");

	failBatch = undefined;
	executed.length = 0;
	controller = new AbortController();
	const compiled = await compiler.compile({ ...workspace.request, signal: controller.signal });
	assert.ok(executed.every((index) => !completedBeforeInterrupt.has(index)),
		"resume must reuse every batch checkpoint completed before interruption");
	assert.deepEqual([...new Set([...completedBeforeInterrupt, ...executed])].sort((left, right) => left - right),
		Array.from({ length: 15 }, (_, index) => index), "resume must complete every Source batch");
	assert.equal(compiled.status, "compiled");
	assert.equal(compiled.usage.calls, 15);
	assert.equal(compiled.usage.inputTokens, 150);
	assert.equal(compiled.agentStages, 15);
	assert.equal(sessionRoots.size, 15, "every Batch Wiki Shard must use an independent Session root");
	assert.equal(curatorSessionRoots.size, 15, "each resumed draft Shard must use its own rolling Curator Session");
	assert.ok(existsSync(join(compiled.knowledge.absolutePath, "concepts", "batch-0.md")));
	assert.ok(existsSync(join(compiled.knowledge.absolutePath, "concepts", "batch-14.md")));

	// 第二个 Shard checkpoint 内容对不上时，只重跑该独立 Shard。
	const other = prepareWorkspace("batch-digest");
	const digestExecuted: number[] = [];
	const digestCompiler = new LlmWikiCompiler({
		maintain: async ({ evidence, workRoot }) => {
			const index = batchIndex(evidence);
			digestExecuted.push(index);
			return writeBatchWiki(workRoot, index);
		},
		curate: fakeCurateWiki,
	});
	await digestCompiler.compile(other.request);
	rmSync(join(other.runDirectory, "artifacts", "wiki-compilations"), { recursive: true, force: true });
	const checkpointPath = join(
		other.controlDirectory,
		"note-wiki",
		readdirOnly(join(other.controlDirectory, "note-wiki")),
		"batch-002",
		"checkpoint.json",
	);
	const record = JSON.parse(readFileSync(checkpointPath, "utf-8")) as { batch_digest: string };
	writeFileSync(checkpointPath, JSON.stringify({ ...record, batch_digest: "0".repeat(64) }, null, 2));
	digestExecuted.length = 0;
	await digestCompiler.compile(other.request);
	assert.deepEqual(digestExecuted, [1],
		"an invalid Shard checkpoint must not invalidate independent later Shards");
}

/** 中断落在"知识已发布、编译记录未写"之间：续跑认领已发布产物，不再烧一次 token。 */
async function testCompilerClaimsPublishedKnowledge(): Promise<void> {
	const workspace = prepareWorkspace("published-knowledge");
	let calls = 0;
	const compiler = new LlmWikiCompiler({
		maintain: async ({ evidence, workRoot }) => {
			calls += 1;
			return writeBatchWiki(workRoot, batchIndex(evidence));
		},
		curate: fakeCurateWiki,
	});
	const compiled = await compiler.compile(workspace.request);
	assert.equal(calls, 15);
	rmSync(join(workspace.runDirectory, "artifacts", "wiki-compilations", compiled.compilationId, "compilation.json"));
	rmSync(join(workspace.controlDirectory, "note-wiki"), { recursive: true, force: true });
	const resumed = await compiler.compile(workspace.request);
	assert.equal(calls, 15, "published knowledge must never be recompiled");
	assert.equal(resumed.compilationId, compiled.compilationId);
	assert.equal(resumed.pageCount, 15, "page count comes from the published Wiki itself");
}

function testJobRecordLifecycle(): void {
	const partial = new WikiUpdateJobStore(join(root, "job-partial-failure"));
	partial.start({
		goalId: "goal-partial",
		runId: "run-partial",
		goal: "Partial failure",
		goalContext: { title: "Goal title", description: "Goal description" },
		topicPlan,
		cornellNotes: { relative_path: "artifacts/evidence.json", sha256: "f".repeat(64), byte_length: 10 },
	});
	partial.markRunning(2);
	partial.recordBatch({
		batchIndex: 0,
		totalBatches: 2,
		status: "failed",
		pageCount: 0,
		usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, calls: 0 },
		message: "worker failed",
		reused: false,
	});
	assert.equal(partial.load()?.progress?.completed_batches, 1);
	assert.equal(partial.load()?.progress?.batches[0]?.message, "worker failed");

	const controlDirectory = join(root, "job-lifecycle");
	mkdirSync(controlDirectory, { recursive: true });
	const jobs = new WikiUpdateJobStore(controlDirectory);
	const wikiEvents: string[] = [];
	const unsubscribeWikiEvents = subscribe((event) => {
		if (event.type === "wiki-update:changed" && event.goalId === "goal-1") wikiEvents.push(event.status);
	});
	assert.equal(jobs.load(), undefined);
	const started = jobs.start({
		goalId: "goal-1",
		runId: "run-1",
		goal: "Research resume",
		goalContext: { title: "Goal title", description: "Goal description" },
		topicPlan,
		cornellNotes: { relative_path: "artifacts/evidence.json", sha256: "a".repeat(64), byte_length: 10 },
	});
	assert.equal(started.attempts, 1);
	assert.equal(jobs.markInterrupted(), true);
	assert.equal(jobs.markInterrupted(), false, "only a running job can be interrupted");
	assert.equal(canResumeWikiUpdateJob(jobs.load()!), true);
	for (let attempt = 2; attempt <= MAX_WIKI_UPDATE_ATTEMPTS; attempt += 1) {
		assert.equal(jobs.start({
			goalId: "goal-1",
			runId: "run-1",
			goal: "Research resume",
			goalContext: { title: "Goal title", description: "Goal description" },
			topicPlan,
			cornellNotes: { relative_path: "artifacts/evidence.json", sha256: "a".repeat(64), byte_length: 10 },
		}).attempts, attempt);
		jobs.markInterrupted();
	}
	assert.equal(
		canResumeWikiUpdateJob(jobs.load()!),
		false,
		`a job must stop resuming after ${MAX_WIKI_UPDATE_ATTEMPTS} attempts`,
	);
	jobs.settle("succeeded", { compilationId: "note-wiki-1" });
	assert.equal(jobs.load()?.status, "succeeded");
	assert.equal(jobs.markInterrupted(), false, "a settled job stays settled");
	unsubscribeWikiEvents();
	assert.ok(wikiEvents.includes("queued") && wikiEvents.includes("interrupted") && wikiEvents.includes("succeeded"));

	const traceStore = new WikiUpdateJobStore(join(root, "job-trace-lifecycle"));
	traceStore.start({
		goalId: "goal-trace",
		runId: "wiki-trace",
		goal: "Trace lifecycle",
		goalContext: { title: "Goal title", description: "Goal description" },
		topicPlan,
		cornellNotes: { relative_path: "artifacts/evidence.json", sha256: "d".repeat(64), byte_length: 10 },
	});
	traceStore.markRunning(1);
	traceStore.recordBatch({
		batchIndex: 0,
		totalBatches: 1,
		status: "running",
		pageCount: 0,
		usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, calls: 0 },
		traceRef: "wiki-trace-batch-001.json",
		reused: false,
	});
	traceStore.markInterrupted();
	assert.equal(traceStore.load()?.progress?.batches[0]?.status, "interrupted");
	traceStore.start({
		goalId: "goal-trace",
		runId: "wiki-trace",
		goal: "Trace lifecycle",
		goalContext: { title: "Goal title", description: "Goal description" },
		topicPlan,
		cornellNotes: { relative_path: "artifacts/evidence.json", sha256: "d".repeat(64), byte_length: 10 },
	});
	traceStore.markRunning(1);
	traceStore.recordBatch({
		batchIndex: 0,
		totalBatches: 1,
		status: "running",
		pageCount: 0,
		usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, calls: 0 },
		traceRef: "wiki-trace-batch-001-resumed.json",
		reused: false,
	});
	assert.equal(traceStore.load()?.progress?.batches[0]?.attempt, 2);
	traceStore.recordBatch({
		batchIndex: 0,
		totalBatches: 1,
		status: "succeeded",
		pageCount: 1,
		usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, calls: 0 },
		reused: false,
	});
	assert.equal(traceStore.load()?.progress?.batches[0]?.trace_ref, undefined,
		"a batch that skipped the Agent must not retain its provisional replay path");
}

/** 后端重启：running 的任务先收敛成可续跑，再自动跑完并结算。 */
async function testInterruptedJobResume(): Promise<void> {
	const workspaceDir = join(root, "data");
	const goalId = "goal-resume";
	const goalDir = join(workspaceDir, goalId);
	const runId = "run-resume";
	const controlDirectory = wikiUpdateRecordDir(workspaceDir, goalId, runId);
	const runDirectory = wikiUpdateArtifactDir(goalDir, runId);
	mkdirSync(controlDirectory, { recursive: true });
	mkdirSync(runDirectory, { recursive: true });
	const cornellNotes = {
		relative_path: "artifacts/evidence.json",
		sha256: "b".repeat(64),
		byte_length: 4,
	};
	new WikiUpdateJobStore(controlDirectory).start({ goalId, runId, goal: "Research resume", topicPlan, cornellNotes,
		goalContext: { title: "Frozen goal title", description: "Frozen goal description" } });
	const legacyDirectory = join(runRecordsDir(workspaceDir, goalId), "old-job");
	mkdirSync(legacyDirectory, { recursive: true });
	const legacyPath = join(legacyDirectory, WIKI_UPDATE_JOB_FILE);
	const legacy = JSON.parse(readFileSync(join(controlDirectory, WIKI_UPDATE_JOB_FILE), "utf-8"));
	legacy.status = "interrupted";
	const legacyBytes = JSON.stringify(legacy);
	writeFileSync(legacyPath, legacyBytes);
	assert.equal(hasActiveWikiUpdate(workspaceDir, goalId), true,
		"an incompatible historical job must not hide a current active job or crash the scheduler");

	assert.equal(canResumeWikiUpdateJob(new WikiUpdateJobStore(controlDirectory).load()!), false, "a running job is not resumable yet");
	assert.deepEqual(markInterruptedWikiUpdates(workspaceDir, goalId), [runId]);
	const interrupted = new WikiUpdateJobStore(controlDirectory).load()!;
	assert.equal(interrupted.status, "interrupted");
	assert.equal(canResumeWikiUpdateJob(interrupted), true, "an interrupted job can resume");
	assert.equal(hasActiveWikiUpdate(workspaceDir, goalId), false);
	assert.equal(readFileSync(legacyPath, "utf-8"), legacyBytes, "do not migrate historical jobs during observation");
	assert.equal(canResumeWikiUpdateJob(new WikiUpdateJobStore(legacyDirectory).load()!), true);
	await assert.rejects(resumeWikiUpdate({ workspaceDir, goalId, goalDir, runId: "old-job", env: {} }),
		/Unknown Wiki update/u, "a Run directory job must not be resumed even when its fields are valid");

	const compiled: string[] = [];
	const execution = await resumeWikiUpdate({
		workspaceDir,
		goalId,
		goalDir,
		runId,
		env: {},
		dependencies: {
			compile: async (request) => {
				compiled.push(request.runDirectory);
				assert.equal(request.goal, "Research resume");
				assert.deepEqual(request.goalContext, { title: "Frozen goal title", description: "Frozen goal description" });
				assert.deepEqual(request.cornellNotesSnapshot, cornellNotes);
				return fakeCompilation();
			},
			publish: async () => fakePublication(),
		},
	});
	assert.equal(execution.compilationId, "note-wiki-resumed");
	assert.deepEqual(compiled, [runDirectory], "resume must reopen the Wiki Update artifact directory");
	const job = new WikiUpdateJobStore(controlDirectory).load()!;
	assert.equal(job.status, "succeeded");
	assert.equal(job.attempts, 2, "resuming counts as another attempt");
	assert.equal(job.compilation_id, "note-wiki-resumed");
	const result = JSON.parse(readFileSync(join(runDirectory, "artifacts", "wiki-update", "result.json"), "utf-8")) as {
		status: string;
		compilation_id: string;
	};
	assert.equal(result.status, "succeeded");
	assert.equal(result.compilation_id, "note-wiki-resumed");
	assert.equal(canResumeWikiUpdateJob(job), false, "a settled job is never resumable again");
	await assert.rejects(
		resumeWikiUpdate({ workspaceDir, goalId, goalDir, runId, env: {} }),
		/no resumable checkpoint/u,
		"a settled job must refuse to run again",
	);
	await assert.rejects(
		resumeWikiUpdate({ workspaceDir, goalId, goalDir, runId: "run-missing", env: {} }),
		/Unknown Wiki update/u,
	);

	// 失败的续跑同样要留下可读的结论，而不是无声消失。
	const failingRunId = "run-failing";
	const failingControl = wikiUpdateRecordDir(workspaceDir, goalId, failingRunId);
	const failingRunDirectory = wikiUpdateArtifactDir(goalDir, failingRunId);
	mkdirSync(failingRunDirectory, { recursive: true });
	mkdirSync(failingControl, { recursive: true });
	new WikiUpdateJobStore(failingControl).start({ goalId, runId: failingRunId, goal: "Research resume", topicPlan, cornellNotes,
		goalContext: { title: "Frozen goal", description: "" } });
	assert.deepEqual(markInterruptedWikiUpdates(workspaceDir, goalId), [failingRunId]);
	await assert.rejects(resumeWikiUpdate({
		workspaceDir,
		goalId,
		goalDir,
		runId: failingRunId,
		env: {},
		dependencies: { compile: async () => { throw new Error("provider unavailable"); } },
	}), /provider unavailable/u);
	assert.equal(new WikiUpdateJobStore(failingControl).load()?.status, "failed");
	assert.match(
		readFileSync(join(failingRunDirectory, "artifacts", "wiki-update", "result.json"), "utf-8"),
		/provider unavailable/u,
	);

	// 用完续跑次数的任务不再接受继续，由调用方告诉用户为什么。
	const exhaustedRunId = "run-exhausted";
	const exhaustedControl = wikiUpdateRecordDir(workspaceDir, goalId, exhaustedRunId);
	mkdirSync(wikiUpdateArtifactDir(goalDir, exhaustedRunId), { recursive: true });
	mkdirSync(exhaustedControl, { recursive: true });
	const exhausted = new WikiUpdateJobStore(exhaustedControl);
	for (let attempt = 0; attempt < MAX_WIKI_UPDATE_ATTEMPTS; attempt += 1) {
		exhausted.start({ goalId, runId: exhaustedRunId, goal: "Research resume", goalContext: { title: "Goal title", description: "Goal description" }, topicPlan, cornellNotes });
		exhausted.markInterrupted();
	}
	await assert.rejects(
		resumeWikiUpdate({ workspaceDir, goalId, goalDir, runId: exhaustedRunId, env: {} }),
		/resume attempt limit/u,
	);
	const invalidRunId = "run-missing-goal-context";
	const invalidControl = wikiUpdateRecordDir(workspaceDir, goalId, invalidRunId);
	const invalid = new WikiUpdateJobStore(invalidControl);
	const valid = invalid.start({ goalId, runId: invalidRunId, goal: "Research resume",
		goalContext: { title: "Goal title", description: "Goal description" }, topicPlan, cornellNotes });
	const { goal_context: _context, ...missingContext } = valid;
	writeFileSync(join(invalidControl, "wiki-update-job.json"), JSON.stringify(missingContext));
	await assert.rejects(resumeWikiUpdate({ workspaceDir, goalId, goalDir, runId: invalidRunId, env: {},
		dependencies: { compile: async () => { assert.fail("missing metadata must fail before compilation"); } },
	}), /goal_context/u);

}

function prepareWorkspace(name: string, noteCount = 150): {
	request: Parameters<LlmWikiCompiler["compile"]>[0];
	runDirectory: string;
	controlDirectory: string;
} {
	const base = join(root, name);
	const goalDir = join(base, "goal");
	const runDirectory = join(base, "run");
	const controlDirectory = join(base, "control");
	mkdirSync(join(goalDir, "wiki", "knowledge"), { recursive: true });
	mkdirSync(controlDirectory, { recursive: true });
	const evidence = buildEvidence(noteCount);
	const cornellNotes = new RunArtifactStore(runDirectory)
		.publishText(`${JSON.stringify(evidence, null, 2)}\n`, "artifacts/evidence.json");
	return {
		runDirectory,
		controlDirectory,
		request: {
			env: { TELOMI_WIKI_MAINTAINER_MODEL: "test/root", TELOMI_PRIME_AGENT_CHILD_MODEL: "test/child" },
			goalDir,
			goal: "Research resume",
			goalContext: { title: "Goal title", description: "Goal description" },
			rebuild: true,
			runId: `run-${name}`,
			runDirectory,
			controlDirectory,
			cornellNotesSnapshot: {
				relative_path: cornellNotes.relativePath,
				sha256: cornellNotes.sha256,
				byte_length: cornellNotes.byteLength,
			},
			topicPlan,
			signal: new AbortController().signal,
		},
	};
}

/** 批次序号直接来自这批 Note 的来源编号，和执行次数无关，续跑时才认得出是哪一批。 */
function batchIndex(evidence: CornellNotesSnapshot): number {
	const first = evidence.notes[0]?.note.source_id ?? "";
	return Math.floor(Number(first.split("-").pop()) / 10);
}

function buildEvidence(noteCount: number): CornellNotesSnapshot {
	return {
		schema_version: 1,
		snapshot_id: "snapshot:resume",
		run_id: "run-resume",
		pipeline: { id: "pipeline:resume", version: "1", sha256: "a".repeat(64) },
		source_bundle_refs: [],
		notes: Array.from({ length: noteCount }, (_, index) => ({
			note: {
				schema_version: 1 as const,
				source_id: `source:resume-${index}`,
				sections: [{
					section_title: `Section ${index}`,
					summary: "A grounded summary.",
					cue_notes: [{
						cue: `Cue ${index}`,
						note: `Deterministic note ${index}.`,
						evidence: [{
							source_path: "document.md",
							content_sha256: "b".repeat(64),
							start_line: 1,
							end_line: 2,
						}],
					}],
				}],
			},
			title: `Source ${index}`,
			canonical_locator: `https://example.test/source-${index}`,
			provider_id: "test",
			provenance_ref: "provider:test",
			source_revision_sha256: "c".repeat(64),
			members: [],
		})),
	};
}

function writeBatchWiki(workRoot: string, index: number): {
	knowledgeRoot: string;
	pageCount: number;
	usage: { inputTokens: number; outputTokens: number; costUsd: number; calls: number };
	sessionPaths: string[];
} {
	const knowledgeRoot = join(workRoot, "knowledge");
	mkdirSync(join(knowledgeRoot, "concepts"), { recursive: true });
	mkdirSync(join(knowledgeRoot, "entities"), { recursive: true });
	writeFileSync(join(knowledgeRoot, "concepts", `batch-${index}.md`), `# Batch ${index}\n\nGrounded content.\n`);
	return {
		knowledgeRoot,
		pageCount: index + 1,
		usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.01, calls: 1 },
		sessionPaths: [join(workRoot, "sessions")],
	};
}

async function fakeCurateWiki(input: {
	operation: "initialize" | "update" | "reframe";
	previousEditionRoot?: string;
	draftRoots: readonly string[];
	workRoot: string;
}): Promise<{
	knowledgeRoot: string;
	pageCount: number;
	usage: { inputTokens: number; outputTokens: number; costUsd: number; calls: number };
	sessionPaths: string[];
}> {
	assert.notEqual(input.operation, "reframe", "these compiler fixtures add new evidence");
	const knowledgeRoot = join(input.workRoot, "merged-knowledge");
	rmSync(knowledgeRoot, { recursive: true, force: true });
	mkdirSync(join(knowledgeRoot, "concepts"), { recursive: true });
	mkdirSync(join(knowledgeRoot, "entities"), { recursive: true });
	for (const sourceRoot of [input.previousEditionRoot, ...input.draftRoots].filter((value): value is string => Boolean(value))) {
		for (const file of readdirSync(join(sourceRoot, "concepts")).filter((name) => name.endsWith(".md"))) {
			writeFileSync(join(knowledgeRoot, "concepts", file), readFileSync(join(sourceRoot, "concepts", file)));
		}
	}
	return {
		knowledgeRoot,
		pageCount: readdirSync(join(knowledgeRoot, "concepts")).filter((name) => name.endsWith(".md")).length,
		usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, calls: 0 },
		sessionPaths: [],
	};
}

function fakeCompilation(): WikiCompilationResult {
	return {
		status: "compiled",
		compilationId: "note-wiki-resumed",
		baseKnowledgeSha256: "d".repeat(64),
		knowledge: {
			relativePath: "artifacts/wiki-compilations/note-wiki-resumed/knowledge",
			absolutePath: join(root, "data", "knowledge"),
			sha256: "e".repeat(64),
			byteLength: 0,
			files: [],
		},
		pageCount: 3,
		usage: { inputTokens: 1, outputTokens: 1, costUsd: 0, calls: 1 },
		agentStages: 1,
		sessionPaths: [],
		failedBatches: [],
	};
}

function fakePublication(): WikiPublicationResult {
	return {
		status: "promoted",
		compilationId: "note-wiki-resumed",
		baseContentHash: "0".repeat(64),
		publishedContentHash: "1".repeat(64),
		changedPaths: ["wiki/knowledge/concepts/batch-0.md"],
	};
}

function readdirOnly(path: string): string {
	const entries = readdirSync(path);
	assert.equal(entries.length, 1, `expected exactly one entry under ${path}`);
	return entries[0]!;
}
