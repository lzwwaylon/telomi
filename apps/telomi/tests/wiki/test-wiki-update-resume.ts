import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	canResumeWikiUpdateJob,
	MAX_WIKI_UPDATE_ATTEMPTS,
	WikiUpdateJobStore,
	WIKI_UPDATE_JOB_FILE,
} from "../../server/wiki/wiki-update-job.js";
import { runRecordsDir } from "../../server/observability/run-records.js";
import { RunArtifactStore } from "../../server/agent-runtime/artifact-store.js";
import type { SourceNotesSnapshot } from "../../server/notes/contracts.js";
import type { GoalTopicPlan, WikiCompilationRequest, WikiCompilationResult } from "../../server/wiki/contracts.js";
import type { WikiPublicationResult } from "../../server/wiki/publication.js";
import { subscribe } from "../../server/events/event-bus.js";
import { createWikiUpdateTool } from "../../server/main-agent/tools/wiki-update.js";
import { GoalTopicPlanStore } from "../../server/goals/topic-plan/index.js";
import { serverRuntimeDirForGoal } from "../../server/workspaces/server-runtime-paths.js";
import {
	executeWikiUpdate,
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
	testJobRecordLifecycle();
	await testInterruptedJobResume();
	await testRetiredCompilerResume();
	await testStandaloneWikiUpdateActivity();
	await testReportContextFrozenForRetry();
	await testStandaloneWikiUpdateIdempotency();
	await testStandaloneWikiUpdateRebuildAndRetry();
	await testPartialWikiUpdateActivity();
	console.log("Wiki update resume Interface passed");
} finally {
	rmSync(root, { recursive: true, force: true });
}

async function testWikiUpdateToolCurrentGoal(): Promise<void> {
	const workspaceDir = join(root, "tool-goal-hot-update");
	const goalId = "goal-tool-test";
	const runId = "source-run";
	const sourceControl = join(serverRuntimeDirForGoal(goalId, workspaceDir), "runs", runId);
	mkdirSync(sourceControl, { recursive: true });
	writeFileSync(join(sourceControl, "run-state.json"), JSON.stringify({ goal_id: goalId, run_id: runId,
		question: "NOT_A_GOAL_DESCRIPTION", language: "zh-CN", note_snapshots: [{ relative_path: "notes.json", sha256: "a".repeat(64), byte_length: 1 }] }));
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

async function testStandaloneWikiUpdateActivity(): Promise<void> {
	const workspaceDir = join(root, "standalone-data");
	const goalId = "goal-standalone";
	const goalDir = join(workspaceDir, goalId);
	const sourceRunId = "run-source";
	const sourceRunDirectory = join(goalDir, "wiki", "runs", sourceRunId);
	const source = new RunArtifactStore(sourceRunDirectory)
		.publishText(`${JSON.stringify(buildEvidence(1), null, 2)}\n`, "artifacts/notes/snapshot.json");
	const report = '## Published report\nA supported result and its limitations.\n';
	new RunArtifactStore(sourceRunDirectory).publishText(report, 'report/final.md');
	const started = startWikiUpdateActivity({
		workspaceDir,
		goalId,
		goalDir,
		goal: "Standalone Wiki Activity",
		goalContext: { title: "Goal title", description: "Goal description" },
		topicPlan,
		sourceRunId,
		sourceRunDirectory,
		sourceNotes: { relative_path: source.relativePath, sha256: source.sha256, byte_length: source.byteLength },
		parentActivityId: `research:${sourceRunId}`,
		trigger: { kind: "system" },
		reason: "validated Cornell Notes",
		env: {},
		dependencies: {
			compile: async (request) => {
				assert.deepEqual(request.reportContext, { runId: sourceRunId, markdown: report }, 'Background selection receives the actual published report');
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
	assert.deepEqual(job.report_context, { runId: sourceRunId, markdown: report });
	assert.equal(job.parent_activity_id, `research:${sourceRunId}`);
	assert.equal(job.topic_plan?.revision, topicPlan.revision);
	assert.equal(job.progress?.completed_batches, 1);
	assert.equal(job.progress?.stages?.find((stage) => stage.kind === "publication")?.status, "succeeded");
	assert.ok(existsSync(join(artifactDirectory, "artifacts", "input", "notes.json")));
	assert.ok(existsSync(join(artifactDirectory, "artifacts", "wiki-update", "result.json")));
}

async function testReportContextFrozenForRetry(): Promise<void> {
	const workspaceDir = join(root, 'report-retry'), goalId = 'goal-report-retry', goalDir = join(workspaceDir, goalId);
	const sourceRunId = 'report-source', sourceRunDirectory = join(goalDir, 'wiki/runs', sourceRunId);
	const store = new RunArtifactStore(sourceRunDirectory);
	const notes = store.publishText(JSON.stringify(buildEvidence(1)), 'notes.json');
	const reportContext = { runId: sourceRunId, markdown: 'The original published report.' };
	store.publishText(reportContext.markdown, 'report/final.md');
	let attempts = 0;
	const dependencies = { compile: async (request: WikiCompilationRequest) => {
		assert.deepEqual(request.reportContext, reportContext, 'Retry retains the first report bytes rather than reading later live files');
		if (++attempts === 1) throw new Error('Controlled retry');
		return fakeCompilation();
	}, publish: async () => fakePublication() };
	const input = { workspaceDir, goalId, goalDir, sourceRunId, sourceRunDirectory, goal: 'Report retry',
		goalContext: { title: 'Report goal', description: '' }, topicPlan,
		sourceNotes: { relative_path: notes.relativePath, sha256: notes.sha256, byte_length: notes.byteLength },
		trigger: { kind: 'schedule' as const, schedule_id: 'schedule-report' }, reason: 'Published report', env: {}, dependencies };
	assert.throws(() => startWikiUpdateActivity({ ...input, reportContext: { ...reportContext, runId: 'another-run' } }), /another Source Run/u);
	const started = startWikiUpdateActivity(input);
	assert.equal(started.reused, false);
	if (started.reused) throw new Error('Expected a new report update');
	await assert.rejects(started.execution, /Controlled retry/u);
	writeFileSync(join(sourceRunDirectory, 'report/final.md'), 'Later live report bytes.');
	await resumeWikiUpdate({ workspaceDir, goalId, goalDir, runId: started.wikiUpdateId, env: {}, dependencies });
	assert.deepEqual(new WikiUpdateJobStore(wikiUpdateRecordDir(workspaceDir, goalId, started.wikiUpdateId)).load()?.report_context, reportContext);
}

async function testStandaloneWikiUpdateIdempotency(): Promise<void> {
	const workspaceDir = join(root, "standalone-idempotent-data");
	const goalId = "goal-standalone-idempotent";
	const goalDir = join(workspaceDir, goalId);
	const sourceRunId = "run-source-idempotent";
	const sourceRunDirectory = join(goalDir, "wiki", "runs", sourceRunId);
	const source = new RunArtifactStore(sourceRunDirectory)
		.publishText(`${JSON.stringify(buildEvidence(1), null, 2)}\n`, "artifacts/notes/snapshot.json");
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
		sourceNotes: { relative_path: source.relativePath, sha256: source.sha256, byte_length: source.byteLength },
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
		.publishText(`${JSON.stringify(buildEvidence(1), null, 2)}\n`, "artifacts/notes/snapshot.json");
	const base = {
		workspaceDir,
		goalId,
		goalDir,
		goal: "Standalone Wiki rebuild",
		goalContext: { title: "Goal title", description: "Goal description" },
		topicPlan,
		sourceRunId,
		sourceRunDirectory,
		sourceNotes: { relative_path: source.relativePath, sha256: source.sha256, byte_length: source.byteLength },
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
		sourceNotes: base.sourceNotes,
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
		.publishText(`${JSON.stringify(buildEvidence(1), null, 2)}\n`, "artifacts/notes/snapshot.json");
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
		sourceNotes: { relative_path: source.relativePath, sha256: source.sha256, byte_length: source.byteLength },
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
function testJobRecordLifecycle(): void {
	const partial = new WikiUpdateJobStore(join(root, "job-partial-failure"));
	partial.start({
		goalId: "goal-partial",
		runId: "run-partial",
		goal: "Partial failure",
		goalContext: { title: "Goal title", description: "Goal description" },
		topicPlan,
		sourceNotes: { relative_path: "artifacts/evidence.json", sha256: "f".repeat(64), byte_length: 10 },
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
		sourceNotes: { relative_path: "artifacts/evidence.json", sha256: "a".repeat(64), byte_length: 10 },
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
			sourceNotes: { relative_path: "artifacts/evidence.json", sha256: "a".repeat(64), byte_length: 10 },
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
		sourceNotes: { relative_path: "artifacts/evidence.json", sha256: "d".repeat(64), byte_length: 10 },
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
		sourceNotes: { relative_path: "artifacts/evidence.json", sha256: "d".repeat(64), byte_length: 10 },
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

/** Legacy checkpoints remain readable but must never execute or change compiler identity. */
async function testRetiredCompilerResume(): Promise<void> {
	const workspaceDir = join(root, "retired-data");
	const goalId = "goal-retired";
	const goalDir = join(workspaceDir, goalId);
	for (const compiler of ["shards", undefined]) {
		const runId = `wiki-retired-${compiler ?? "unversioned"}`;
		const controlDirectory = wikiUpdateRecordDir(workspaceDir, goalId, runId);
		const jobs = new WikiUpdateJobStore(controlDirectory);
		const input = { goalId, runId, goal: "Retired update", goalContext: { title: "Goal", description: "" },
			topicPlan, sourceNotes: { relative_path: "artifacts/evidence.json", sha256: "b".repeat(64), byte_length: 4 } };
		const job = { ...jobs.start(input), compiler, status: "interrupted" };
		const path = join(controlDirectory, WIKI_UPDATE_JOB_FILE);
		const bytes = JSON.stringify(job);
		writeFileSync(path, bytes);
		assert.throws(() => jobs.load(), /schema validation/u);
		const dependencies = { compile: async () => { assert.fail("retired compiler must not execute"); } };
		await assert.rejects(resumeWikiUpdate({ workspaceDir, goalId, goalDir, runId, env: {}, dependencies }), /schema validation/u);
		await assert.rejects(executeWikiUpdate({ ...input, workspaceDir, goalDir, controlDirectory,
			runDirectory: wikiUpdateArtifactDir(goalDir, runId), env: {}, signal: new AbortController().signal, dependencies }), /schema validation/u);
		assert.throws(() => jobs.start(input), /schema validation/u);
		assert.equal(readFileSync(path, "utf8"), bytes, "rejecting legacy resume preserves all recorded bytes");
	}
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
	const sourceNotes = {
		relative_path: "artifacts/evidence.json",
		sha256: "b".repeat(64),
		byte_length: 4,
	};
	new WikiUpdateJobStore(controlDirectory).start({ goalId, runId, goal: "Research resume", topicPlan, sourceNotes,
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
				assert.deepEqual(request.notesSnapshot, sourceNotes);
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
	new WikiUpdateJobStore(failingControl).start({ goalId, runId: failingRunId, goal: "Research resume", topicPlan, sourceNotes,
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
		exhausted.start({ goalId, runId: exhaustedRunId, goal: "Research resume", goalContext: { title: "Goal title", description: "Goal description" }, topicPlan, sourceNotes });
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
		goalContext: { title: "Goal title", description: "Goal description" }, topicPlan, sourceNotes });
	const { goal_context: _context, ...missingContext } = valid;
	writeFileSync(join(invalidControl, "wiki-update-job.json"), JSON.stringify(missingContext));
	await assert.rejects(resumeWikiUpdate({ workspaceDir, goalId, goalDir, runId: invalidRunId, env: {},
		dependencies: { compile: async () => { assert.fail("missing metadata must fail before compilation"); } },
	}), /goal_context/u);

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

function buildEvidence(noteCount: number): SourceNotesSnapshot {
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
