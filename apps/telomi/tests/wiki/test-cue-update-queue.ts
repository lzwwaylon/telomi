import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { RunArtifactStore } from "../../server/agent-runtime/artifact-store.js";
import { sha256 } from "../../server/lib/hash.js";
import { enqueueCueWikiUpdate, drainCueWikiUpdates, getCueWikiQueueStatus } from "../../server/research/cue-wiki-queue.js";
import { WikiUpdateJobStore } from "../../server/wiki/wiki-update-job.js";
import { executeWikiUpdate, resumeWikiUpdate, wikiUpdateRecordDir, type WikiUpdateDependencies } from "../../server/wiki/update-runner.js";
import type { GoalTopicPlan, WikiCompilationResult } from "../../server/wiki/contracts.js";
import { serverRuntimeDirForGoal } from "../../server/workspaces/server-runtime-paths.js";
import { writeGoalWikiMainContext, type WikiMainSessionContext } from '../../server/main-agent/wiki-context.js';

const root = mkdtempSync(join(tmpdir(), "cue-wiki-queue-"));
const context = { title: "Model training", description: "Understand original training code", language: "en" as const };
try {
	await testConfirmedBatchAndNextBatch();
	await testMainBranchFrozenAtBatchStart();
	await testQuietWindowMergesDeliveredInvestigations();
	await testUnreviewedLegacyEntriesStayUnreleased();
	await testFailureNeedsExplicitRetryAndUiResume();
	await testNewCandidatesBypassStoppedBatches();
	await testInterruptedAndOrphanRecovery();
	await testExplicitRetryRefreshesChangedTopicPlan();
	await testRefreshReadinessBetweenBatches();
	await testSharedExecutionSerialization();
	console.log("Cue Wiki queue durability, batching, recovery and shared serialization passed");
} finally { rmSync(root, { recursive: true, force: true }); }

function fixture(name: string) {
	const workspaceDir = join(root, name);
	const goalId = `goal-${name}`;
	const goalDir = join(workspaceDir, goalId);
	const sequence = join(goalDir, "wiki", "runs", "run-1", "artifacts", "find-out-sources", "sequence-1");
	const member = "members/github/candidate-one";
	const source = join(sequence, "sources", "source-one");
	mkdirSync(join(source, member), { recursive: true });
	writeFileSync(join(source, member, "train.py"), "loss = cross_entropy(labels)\noptimizer.step()\n");
	writeFileSync(join(sequence, "manifest.json"), JSON.stringify({ schema_version: 3, sequence: 1, sources: [{
		source_id: "source:one", title: "Training code", path: "sources/source-one", organization_kind: "ungrouped",
		organization_reason: "single repo", revision_sha256: sha256("source-one"),
		members: [{ candidate_id: "candidate:one", source_id: "source:member-one", provider_id: "github", title: "Training code",
			canonical_locator: "https://github.com/example/train", path: member, summary: "training" }],
	}] }));
	const topicPlan: GoalTopicPlan = { schema_version: 1, goal_id: goalId, revision: "plan-1", status: "active",
		topics: [{ id: "training", title: "Training", intent: "Explain training", questions: [], include: [], exclude: [] }] };
	let now = Date.now();
	const clock = { now: () => now, wait: async (milliseconds: number) => { now += milliseconds; } };
	return { workspaceDir, goalId, goalDir, goalContext: context, topicPlan, env: {}, clock };
}

async function testMainBranchFrozenAtBatchStart() {
	const input = fixture('main-branch');
	const main: WikiMainSessionContext = { schema_version: 1, goalId: input.goalId, sessionId: 'main-history',
		systemPrompt: 'Understand training', model: 'provider/main-model', thinking: 'medium',
		messages: [{ role: 'user', content: 'Keep mechanisms, exclude temporary benchmark numbers.', timestamp: 1 }] };
	writeGoalWikiMainContext(input.workspaceDir, main);
	enqueueCueWikiUpdate(cue(input, 'main-branch-cue'));
	await drainCueWikiUpdates({ ...input, dependencies: dependencies(async request => {
		assert.deepEqual(request.mainSession, main, 'new background work receives the completed Main context');
		writeGoalWikiMainContext(input.workspaceDir, { ...main, messages: [{ role: 'user', content: 'Later unrelated turn', timestamp: 2 }] });
		throw new Error('interrupted after context capture');
	}) });
	const failed = getCueWikiQueueStatus(input);
	await resumeWikiUpdate({ ...input, runId: failed.wikiUpdateId!, dependencies: dependencies(async request => {
		assert.deepEqual(request.mainSession, main, 'resume keeps its original branch instead of reading newer chat');
		return compilation();
	}) });
	assert.equal(getCueWikiQueueStatus(input).status, 'idle');
}
function cue(input: ReturnType<typeof fixture>, id: string, line: 1 | 2 = 1) {
	const excerpt = line === 1 ? "loss = cross_entropy(labels)" : "optimizer.step()";
	const result = { schema_version: 1, question: "How does training work?", status: "partial", summary: "Read code", gaps: ["Learning rate unknown"],
		cues: [{ ref: `deep-search:${id}:cue-1`, section_title: "Training", cue: `Training step ${line}`, note: excerpt,
			evidence: [{ source_run_id: "run-1", source_id: "source:one", source_revision_sha256: sha256("source-one"),
				source_path: "members/github/candidate-one/train.py", start_line: line, end_line: line,
				content_sha256: sha256(`${excerpt}\n`), excerpt }] }] };
	const artifact = new RunArtifactStore(input.goalDir).publishText(`${JSON.stringify(result, null, 2)}\n`, `artifacts/deep-search/${id}.json`);
	const investigationId = sha256(`investigation-${id}`).slice(0, 24);
	return { ...input, artifactRef: { path: artifact.relativePath, sha256: artifact.sha256 }, investigationId, threadId: "thread-1",
		curationReview: { investigationId, question: result.question, answer: result.summary,
			usefulFindings: [excerpt], excludedFindings: [] } };
}
function dependencies(compile?: WikiUpdateDependencies["compile"]): WikiUpdateDependencies {
	return { compile: compile ?? (async () => compilation()), publish: async () => ({ status: "promoted", compilationId: "compiled",
		baseContentHash: "0".repeat(64), publishedContentHash: "1".repeat(64), changedPaths: ["wiki/knowledge/objects/training.md"] }) };
}
function compilation(): WikiCompilationResult {
	return { status: "compiled", compilationId: "compiled", baseKnowledgeSha256: "a".repeat(64),
		knowledge: { relativePath: "artifacts/wiki/knowledge", absolutePath: join(root, "knowledge"), sha256: "b".repeat(64), byteLength: 0, files: [] },
		pageCount: 1, usage: { inputTokens: 1, outputTokens: 1, costUsd: 0, calls: 1 }, agentStages: 1, sessionPaths: [], failedBatches: [] };
}
async function testConfirmedBatchAndNextBatch() {
	const input = fixture("batching");
	const first = cue(input, "first");
	assert.equal(enqueueCueWikiUpdate(first).pendingCount, 1);
	assert.equal(enqueueCueWikiUpdate(first).pendingCount, 1, "same committed artifact is idempotent across recovery");
	let calls = 0;
	assert.equal((await drainCueWikiUpdates({ ...input, topicPlan: undefined, dependencies: dependencies() })).status, "pending");
	let release!: () => void;
	let entered!: () => void;
	const gate = new Promise<void>(resolve => { release = resolve; });
	const compiling = new Promise<void>(resolve => { entered = resolve; });
	const snapshots: unknown[] = [];
	const execution = drainCueWikiUpdates({ ...input, dependencies: dependencies(async request => {
		calls++;
		snapshots.push(JSON.parse(readFileSync(new RunArtifactStore(request.runDirectory).openFile(request.notesSnapshot).absolutePath, "utf-8")));
		if (calls === 1) { entered(); await gate; }
		return compilation();
	}) });
	await compiling;
	const receipt = getCueWikiQueueStatus(input);
	assert.equal(receipt.status, "running");
	assert.ok(receipt.wikiUpdateId, "activity receipt exists before model execution finishes");
	const firstJob = new WikiUpdateJobStore(wikiUpdateRecordDir(input.workspaceDir, input.goalId, receipt.wikiUpdateId!)).load()!;
	assert.equal(firstJob.source_run_id, undefined, "Cue updates never impersonate a Research Run");
	assert.equal(firstJob.cue_origins?.[0]?.investigation_id, first.investigationId);
	assert.equal(firstJob.cue_origins?.[0]?.thread_id, "thread-1");
	assert.equal(firstJob.curation_reviews?.[0]?.investigationId, first.investigationId);
	enqueueCueWikiUpdate(cue(input, "second", 2));
	release();
	assert.equal((await execution).status, "idle");
	assert.equal(calls, 2, "new Cues while compilation runs form a separate frozen batch");
	assert.equal((snapshots[0] as { notes: unknown[] }).notes.length, 1);
	assert.equal((snapshots[1] as { notes: unknown[] }).notes.length, 1);
	await drainCueWikiUpdates({ ...input, dependencies: dependencies(async () => { calls++; return compilation(); }) });
	assert.equal(calls, 2, "restart observation does not rerun published Cues");
	assert.throws(() => enqueueCueWikiUpdate({ ...first, artifactRef: { ...first.artifactRef, sha256: "f".repeat(64) } }), /hash changed/u);
}
async function testQuietWindowMergesDeliveredInvestigations() {
	const base = fixture("quiet-batching");
	let now = base.clock.now();
	let release!: () => void;
	let entered!: () => void;
	const waiting = new Promise<void>(resolve => { entered = resolve; });
	let waits = 0;
	const input = { ...base, clock: { now: () => now, wait: async (milliseconds: number) => {
		waits++;
		if (waits === 1) { entered(); await new Promise<void>(resolve => { release = resolve; }); }
		now += milliseconds;
	} } };
	enqueueCueWikiUpdate(cue(input, "quiet-first"));
	let calls = 0;
	const execution = drainCueWikiUpdates({ ...input, dependencies: dependencies(async request => {
		calls++;
		assert.equal(request.curationReviews?.length, 2, "one frozen Wiki batch carries both delivered reviews");
		const snapshot = JSON.parse(readFileSync(new RunArtifactStore(request.runDirectory).openFile(request.notesSnapshot).absolutePath, "utf8"));
		assert.equal(snapshot.notes[0].note.sections.length, 2, "both complete Cue inputs survive batching");
		return compilation();
	}) });
	await waiting;
	now += 1_000;
	enqueueCueWikiUpdate(cue(input, "quiet-second", 2));
	assert.equal(getCueWikiQueueStatus(input).status, "pending");
	assert.equal(calls, 0, "no job is frozen while the durable quiet window is open");
	release();
	assert.equal((await execution).status, "idle");
	assert.equal(calls, 1, "two delivered investigations coalesce before compilation starts");
}
async function testUnreviewedLegacyEntriesStayUnreleased() {
	const input = fixture("legacy-unreviewed");
	const released = cue(input, "legacy");
	enqueueCueWikiUpdate(released);
	const path = join(serverRuntimeDirForGoal(input.goalId, input.workspaceDir), "cue-wiki-queue.json");
	const old = JSON.parse(readFileSync(path, "utf8"));
	delete old.entries[0].curation_review;
	delete old.entries[0].ready_at;
	old.entries[0].key = sha256(`${old.entries[0].origin.artifact_ref.relative_path}\n${old.entries[0].origin.artifact_ref.sha256}`);
	const batchId = sha256(JSON.stringify([old.entries[0].key]));
	old.entries[0].batch_id = batchId;
	old.batches = [{ id: batchId, keys: [old.entries[0].key], status: "pending", wiki_update_id: `wiki_cue_${batchId}` }];
	writeFileSync(path, JSON.stringify(old));
	let calls = 0;
	assert.equal((await drainCueWikiUpdates({ ...input, dependencies: dependencies(async () => { calls++; return compilation(); }) })).status, "idle");
	assert.equal(calls, 0, "old saved but unreviewed entries cannot bypass the delivery admission gate");
	assert.equal(enqueueCueWikiUpdate(released).pendingCount, 1, "a later proven delivery releases the existing artifact once");
	assert.equal((await drainCueWikiUpdates({ ...input, dependencies: dependencies(async () => { calls++; return compilation(); }) })).status, "idle");
	assert.equal(calls, 1, "the old unreviewed frozen batch stays dormant while a proven delivery makes a new reviewed batch");
}
async function testFailureNeedsExplicitRetryAndUiResume() {
	const input = fixture("failure");
	enqueueCueWikiUpdate(cue(input, "failed"));
	let calls = 0;
	const failed = await drainCueWikiUpdates({ ...input, dependencies: dependencies(async () => { calls++; throw new Error("offline"); }) });
	assert.equal(failed.status, "failed");
	await drainCueWikiUpdates({ ...input, dependencies: dependencies(async () => { calls++; return compilation(); }) });
	assert.equal(calls, 1, "automatic recovery must not retry failed model work");
	enqueueCueWikiUpdate(cue(input, "later", 2));
	const retry = await drainCueWikiUpdates({ ...input, retry: true, dependencies: dependencies(async () => { calls++; return compilation(); }) });
	assert.equal(retry.status, "idle");
	assert.equal(calls, 3, "explicit retry restores the frozen failed batch, then drains next pending batch");
	assert.equal(new WikiUpdateJobStore(wikiUpdateRecordDir(input.workspaceDir, input.goalId, failed.wikiUpdateId!)).load()!.attempts, 2);
}
async function testNewCandidatesBypassStoppedBatches() {
	for (const status of ['failed', 'interrupted'] as const) {
		const input = fixture(`past-${status}`);
		const old = cue(input, `past-${status}`);
		enqueueCueWikiUpdate(old);
		let calls = 0;
		const stopped = await drainCueWikiUpdates({ ...input, dependencies: dependencies(async () => { calls++; throw new Error('old failure'); }) });
		const jobs = new WikiUpdateJobStore(wikiUpdateRecordDir(input.workspaceDir, input.goalId, stopped.wikiUpdateId!));
		if (status === 'interrupted') {
			const saved = jobs.load()!;
			jobs.start({ ...input, runId: saved.run_id, goal: saved.goal, sourceNotes: saved.notes, cueOrigins: saved.cue_origins });
			jobs.markInterrupted();
		}
		const attempts = jobs.load()!.attempts;
		const fresh = cue(input, `fresh-after-${status}`, 2);
		enqueueCueWikiUpdate(fresh);
		const ready = getCueWikiQueueStatus(input);
		assert.equal(ready.status, 'pending');
		assert.equal(ready.wikiUpdateId, undefined, 'unfrozen new candidates do not point users at an unrelated stopped Activity');
		let newId = '';
		await drainCueWikiUpdates({ ...input, dependencies: dependencies(async request => {
			calls++;
			assert.deepEqual(request.cueOrigins?.map(origin => origin.investigation_id), [fresh.investigationId], 'automatic maintenance uses only the new delivered batch');
			newId = request.runId;
			return compilation();
		}) });
		assert.equal(calls, 2, `${status} history must not block a later independent delivered batch`);
		assert.notEqual(newId, stopped.wikiUpdateId);
		assert.equal(new WikiUpdateJobStore(wikiUpdateRecordDir(input.workspaceDir, input.goalId, newId)).load()!.status, 'succeeded');
		assert.equal(jobs.load()!.status, status, 'the stopped historical Activity stays inspectable');
		assert.equal(jobs.load()!.attempts, attempts, 'the historical execution is never automatically retried');
		assert.equal(getCueWikiQueueStatus(input).pendingCount, 1, 'only the old unresolved evidence remains');
		await drainCueWikiUpdates({ ...input, dependencies: dependencies(async () => { calls++; return compilation(); }) });
		assert.equal(calls, 2, 'an automatic rescan reruns neither the old stopped batch nor the new completed batch');
		assert.equal((await drainCueWikiUpdates({ ...input, retry: true, dependencies: dependencies(async () => { calls++; return compilation(); }) })).status, 'idle');
		assert.equal(calls, 3, 'explicit retry can still recover the original stopped batch');
	}
}
async function testInterruptedAndOrphanRecovery() {
	const input = fixture("interrupted");
	enqueueCueWikiUpdate(cue(input, "interrupted-first"));
	const failed = await drainCueWikiUpdates({ ...input, dependencies: dependencies(async () => { throw new Error("offline"); }) });
	const directory = wikiUpdateRecordDir(input.workspaceDir, input.goalId, failed.wikiUpdateId!);
	const jobs = new WikiUpdateJobStore(directory);
	const previous = jobs.load()!;
	jobs.start({ compiler: "wiki-compilation", goalId: input.goalId, runId: previous.run_id, wikiUpdateId: previous.wiki_update_id,
		goal: previous.goal, goalContext: previous.goal_context, topicPlan: previous.topic_plan,
		sourceNotes: previous.notes, cueOrigins: previous.cue_origins });
	jobs.markInterrupted();
	assert.equal((await drainCueWikiUpdates({ ...input, dependencies: dependencies() })).status, "interrupted",
		"a restart discovers interrupted work but never spends tokens retrying it");
	await resumeWikiUpdate({ ...input, runId: failed.wikiUpdateId!, dependencies: dependencies() });
	enqueueCueWikiUpdate(cue(input, "after-ui-resume", 2));
	assert.equal((await drainCueWikiUpdates({ ...input, dependencies: dependencies() })).status, "idle",
		"manual Activity resume synchronizes batch completion and admits later pending Cues");

	const orphan = fixture("orphan");
	enqueueCueWikiUpdate(cue(orphan, "orphan-first"));
	const orphanFailed = await drainCueWikiUpdates({ ...orphan, dependencies: dependencies(async () => { throw new Error("offline"); }) });
	// Simulate a stop after frozen input copy but before the job write. Own temporary fixture only.
	unlinkSync(join(wikiUpdateRecordDir(orphan.workspaceDir, orphan.goalId, orphanFailed.wikiUpdateId!), "wiki-update-job.json"));
	assert.equal((await drainCueWikiUpdates({ ...orphan, retry: true, dependencies: dependencies() })).status, "idle",
		"copied immutable input without a job is verified and adopted, rather than failing forever");
}

async function testExplicitRetryRefreshesChangedTopicPlan() {
	const input = fixture("topic-drift");
	enqueueCueWikiUpdate(cue(input, "topic-drift-first"));
	const failed = await drainCueWikiUpdates({ ...input, dependencies: dependencies(async () => { throw new Error("Topic Plan changed before publication"); }) });
	const nextPlan = { ...input.topicPlan, revision: "plan-2" };
	assert.equal((await drainCueWikiUpdates({ ...input, topicPlan: nextPlan, dependencies: dependencies() })).status, "failed",
		"a changed Topic revision alone never silently retries model work");
	let newId = "";
	const succeeded = await drainCueWikiUpdates({ ...input, topicPlan: nextPlan, retry: true, dependencies: dependencies(async request => {
		newId = request.runId;
		assert.equal(request.topicPlan.revision, "plan-2");
		return compilation();
	}) });
	assert.equal(succeeded.status, "idle");
	assert.notEqual(newId, failed.wikiUpdateId, "explicit retry starts a fresh Activity with current Topic input");
	const old = new WikiUpdateJobStore(wikiUpdateRecordDir(input.workspaceDir, input.goalId, failed.wikiUpdateId!)).load()!;
	const fresh = new WikiUpdateJobStore(wikiUpdateRecordDir(input.workspaceDir, input.goalId, newId)).load()!;
	assert.equal(old.status, "failed", "obsolete Activity remains recorded");
	assert.equal(old.attempts, 1);
	assert.equal(fresh.attempts, 1);
	assert.equal(fresh.notes.sha256, old.notes.sha256, "rebasing does not replace the frozen Cue evidence");
	assert.deepEqual(fresh.cue_origins, old.cue_origins);
}

async function testRefreshReadinessBetweenBatches() {
	const input = fixture("readiness-refresh");
	enqueueCueWikiUpdate(cue(input, "readiness-first"));
	let plan: GoalTopicPlan | undefined = input.topicPlan;
	let calls = 0;
	const paused = await drainCueWikiUpdates({ ...input, getContext: () => ({ goalContext: context, topicPlan: plan }),
		dependencies: dependencies(async () => {
			calls++;
			enqueueCueWikiUpdate(cue(input, "readiness-second", 2));
			plan = undefined;
			return compilation();
		}) });
	assert.equal(paused.status, "pending");
	assert.equal(paused.pendingCount, 1);
	assert.equal(calls, 1, "pending Topic confirmation stops the next batch before model spending");
	plan = { ...input.topicPlan, revision: "confirmed-plan-2" };
	assert.equal((await drainCueWikiUpdates({ ...input, getContext: () => ({ goalContext: context, topicPlan: plan }),
		dependencies: dependencies(async request => { calls++; assert.equal(request.topicPlan.revision, "confirmed-plan-2"); return compilation(); }) })).status, "idle");
	assert.equal(calls, 2);
	const damaged = cue(input, "damaged");
	const invalid = JSON.parse(readFileSync(join(input.goalDir, damaged.artifactRef.path), "utf8"));
	invalid.cues[0].evidence[0].content_sha256 = "f".repeat(64);
	writeFileSync(join(input.goalDir, damaged.artifactRef.path), JSON.stringify(invalid));
	const bad = new RunArtifactStore(input.goalDir).describeFile(damaged.artifactRef.path);
	assert.throws(() => enqueueCueWikiUpdate({ ...damaged, artifactRef: { path: bad.relativePath, sha256: bad.sha256 } }),
		"a damaged historical Source/Cue is rejected before batch admission");
	assert.equal(getCueWikiQueueStatus(input).pendingCount, 0);
}

async function testSharedExecutionSerialization() {
	const input = fixture("serialize");
	const original = new RunArtifactStore(input.goalDir).publishText("{}", "test-cornell.json");
	let release!: () => void;
	let entered!: () => void;
	const gate = new Promise<void>(resolve => { release = resolve; });
	const compiling = new Promise<void>(resolve => { entered = resolve; });
	let calls = 0;
	const deps = dependencies(async () => { calls++; if (calls === 1) { entered(); await gate; } return compilation(); });
	const execute = (id: string) => executeWikiUpdate({ ...input, runId: id, goal: context.title, sourceNotes: {
		relative_path: original.relativePath, sha256: original.sha256, byte_length: original.byteLength }, runDirectory: input.goalDir,
		controlDirectory: join(root, id), signal: new AbortController().signal, dependencies: deps });
	const oldResearch = execute("old-research");
	await compiling;
	const manual = execute("manual-update");
	await Promise.resolve();
	assert.equal(calls, 1, "manual and old Research updates share one Goal compilation turn");
	assert.equal(new WikiUpdateJobStore(join(root, "manual-update")).load()!.status, "queued");
	release();
	await Promise.all([oldResearch, manual]);
	assert.equal(calls, 2);
}
