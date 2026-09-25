import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GoalSnapshot } from "../../shared/types.js";
import { canResumeRunState, RUN_WORKFLOW_ID, RUN_WORKFLOW_VERSION, RunStateStore } from "../../server/research/run-state.js";
import type { GoalScheduledResearchRequest, GoalSession } from "../../server/goals/execution.js";
import { GoalService } from "../../server/goals/service.js";
import { saveSettings } from "../../server/config/settings.js";
import { runRecordsDir } from "../../server/observability/run-records.js";
import { loadResearchHarnessSnapshot } from "../../server/research/harness/snapshot.js";
import { buildRunContextSnapshotFromHarness } from "../../server/research/run-context.js";
import { ResearchRuntime } from "../../server/research/runtime.js";
import type { ResearchRunResult } from "../../server/research/execute-run.js";
import { unusedGoalExecution } from "./unused-execution.js";

const workspaceDir = mkdtempSync(join(tmpdir(), "telomi-run-liveness-"));
// A turn needs the user's global default; there is no built-in model to start on.
saveSettings({ defaultProvider: "test", defaultModel: "main" });
try {
	const goalId = "goal_liveness";
	const runId = "run_scheduled";
	const goalDir = join(workspaceDir, goalId);
	const controlDirectory = join(runRecordsDir(workspaceDir, goalId), runId);
	const store = new RunStateStore(controlDirectory);
	const search = Promise.withResolvers<void>();
	const reachedSearch = Promise.withResolvers<void>();
	const resumed = Promise.withResolvers<void>();
	const snapshot: GoalSnapshot = {
		goalId, title: "Liveness", description: "", messages: [], isStreaming: false,
		pendingToolCalls: [], stopState: "idle",
	};
	let onSnapshot!: (snapshot: GoalSnapshot) => void;
	const prompts: unknown[] = [];
	const appended: Array<{ text: string; mainRoute?: Record<string, unknown> }> = [];
	const events: string[] = [];
	const session: GoalSession = {
		getSnapshot: () => snapshot,
		getPreview: () => "",
		isRunning: () => snapshot.isStreaming,
		start(input) { snapshot.isStreaming = true; prompts.push(input); onSnapshot(snapshot); },
		async steer() {}, abort() {}, dispose() {}, updateConfig() {}, async refreshModelCatalog() {},
		setTitle() {}, setDescription() {},
		async appendExternalAssistantMessage(text, mainRoute) { appended.push({ text, mainRoute }); },
		async recordEvent(text) { events.push(text); return true; }, subscribe: () => () => {}, async projectUserMemory() {},
	};
	const runtime = new ResearchRuntime({
		stageRunner: { async runStage() { throw new Error("This test must not invoke an Agent"); } },
		searchBatchExecutor: { async execute() {
			reachedSearch.resolve();
			await search.promise;
			throw new Error("Deterministic search interruption");
		} },
	});
	const service = new GoalService(workspaceDir, {
		...unusedGoalExecution,
		async createRunner(input) { onSnapshot = input.onSnapshot; return session; },
		executeResearchRun() {
			const harness = loadResearchHarnessSnapshot(goalDir);
			const context = buildRunContextSnapshotFromHarness({ goalId, goalDir, dataDir: workspaceDir, harness });
			return runtime.run({
			env: { TELOMI_PRIME_AGENT_ROOT_MODEL: "test/root", TELOMI_PRIME_AGENT_CHILD_MODEL: "test/child", TELOMI_RESEARCH_CORNELL_NOTE_MODEL: "test/note", TELOMI_WIKI_MAINTAINER_MODEL: "test/root" },
				goalId, runId, question: "Check Run admission", reportContext: "Verify deterministic Run lifecycle",
				discoveryEnabled: true, workspaceDirectory: join(goalDir, "wiki/runs", runId), controlDirectory,
				goalWorkspaceDirectory: goalDir, workspaceRootDirectory: workspaceDir,
				researchHarnessSnapshot: harness, runContextSnapshot: context.snapshot,
			}).then(() => { throw new Error("Scheduled research failed"); });
		},
		resumeResearchRun() {
			store.resume();
			return resumed.promise.then((): ResearchRunResult => {
				store.recoverInterrupted();
				return {
					runId, taskId: `${runId}_route`, runDir: controlDirectory,
					wikiRunDir: join(goalDir, "wiki/runs", runId),
					status: "published", receiptText: "Report published.\nReport: /reports/run/final.md",
					userResponse: "报告已生成，可以通过报告卡片查看。", reportTitle: "Resumed report",
					stableFinalReportPath: `/workspace/wiki/runs/${runId}/report/final.md`,
					traceSummaryPath: join(controlDirectory, "runtime-context.jsonl"),
					execution: {
						runId, status: "succeeded", workflowId: RUN_WORKFLOW_ID, workflowVersion: RUN_WORKFLOW_VERSION,
						startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
						nodeStatuses: {}, usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, items: 0 },
					},
					qualityGate: { failed: false },
				};
			});
		},
	});
	service.ensureImportedGoal(goalId, "Liveness");
	const request: GoalScheduledResearchRequest = {
		goalId, title: "Scheduled research", question: "Check Run admission", reportContext: "Verify lifecycle",
		context: { scheduleId: "schedule", occurrenceId: "occurrence", monitoringScope: "Lifecycle",
			window: { startAt: "2026-09-01T00:00:00Z", endAt: "2026-09-02T00:00:00Z", timeZone: "UTC" },
			processedSources: [] },
	};
	const scheduled = service.runScheduledResearch(request);
	const scheduledResult = assert.rejects(scheduled, /Deterministic search interruption/u);
	assert.equal(store.load()?.status, "initialized", "Run admission must be durable before async dependency initialization");
	assert.equal(service.isGoalActive(goalId), true);
	await assert.rejects(service.runScheduledResearch(request), /active Run/u);
	await assert.rejects(service.deleteGoal(goalId), /running/u);
	assert.equal((await service.startRun(goalId, "queued during research")).queued, true);
	onSnapshot(snapshot);
	assert.deepEqual(prompts, [], "Idle session snapshots must not drain prompts during Research");
	await reachedSearch.promise;
	search.resolve();
	await scheduledResult;
	assert.equal(store.load()?.status, "failed");
	assert.deepEqual(prompts, ["queued during research"], "Settled Research must drain queued prompts");
	snapshot.isStreaming = false;
	onSnapshot(snapshot);
	assert.equal(service.isGoalActive(goalId), false);

	writeFileSync(join(controlDirectory, "resume-request.json"), `${JSON.stringify({ outputLanguage: "zh-CN" })}\n`);
	service.startResearchRunResume(goalId, runId);
	assert.equal(service.isGoalActive(goalId), true, "Resume must synchronously claim the checkpoint");
	assert.throws(() => service.startResearchRunResume(goalId, runId), /active Run/u);
	await assert.rejects(service.runScheduledResearch(request), /active Run/u);
	assert.equal((await service.startRun(goalId, "queued during resume")).queued, true);
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(appended.length, 1, "Resume must reach chat before Research finishes");
	assert.match(appended[0]!.text, /继续运行/u, "The notice uses the language the Run resolved, not the English search question");
	resumed.resolve();
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.deepEqual(prompts, ["queued during research", "queued during resume"]);
	assert.deepEqual(events, ["[EVENT:research_run_resumed] Report published.\nReport: /reports/run/final.md"],
		"the receipt reaches the Main Agent as a lifecycle event, not as chat");
	assert.deepEqual(appended.slice(1), [{
		text: "报告已生成，可以通过报告卡片查看。",
		mainRoute: { executionKind: "research_runtime", runId, resumed: true,
			report: { runId, title: "Resumed report" } },
	}], "a resumed Run delivers the same reply and report reference as a terminal Tool");
	snapshot.isStreaming = false;
	onSnapshot(snapshot);
	assert.equal(service.isGoalActive(goalId), false);

	// The scheduled Research seam validates what an executor actually returned, not what its type promises.
	const executorResult = (overrides: Partial<ResearchRunResult>): ResearchRunResult => ({
		runId: "run_reported", taskId: "run_reported_route", runDir: controlDirectory,
		wikiRunDir: join(goalDir, "wiki/runs/run_reported"),
		status: "published", receiptText: "Report published.", userResponse: "报告已生成，可以通过报告卡片查看。",
		stableFinalReportPath: "/workspace/wiki/runs/run_reported/report/final.md",
		traceSummaryPath: join(controlDirectory, "runtime-context.jsonl"),
		execution: {
			runId: "run_reported", status: "succeeded", workflowId: RUN_WORKFLOW_ID, workflowVersion: RUN_WORKFLOW_VERSION,
			startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
			nodeStatuses: {}, usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, items: 0 },
		},
		qualityGate: { failed: false },
		...overrides,
	});
	const resumableState = store.load()!;
	for (const deliveryFailure of [false, true]) {
		writeFileSync(store.statePath, JSON.stringify({ ...resumableState, resume_attempts: 0 }));
		const notices: string[] = [];
		const failingResume = new GoalService(workspaceDir, {
			...unusedGoalExecution,
			async createRunner() {
				return { ...session, async appendExternalAssistantMessage(text) {
					notices.push(text);
					// Let an immediately rejected Research settle while delivery is still pending.
					await new Promise<void>((resolve) => setImmediate(resolve));
					if (deliveryFailure) throw new Error("Chat storage unavailable");
				} };
			},
			resumeResearchRun() {
				store.resume();
				return Promise.reject(new Error("Search provider unavailable"));
			},
		});
		failingResume.updateGoalOutputLanguage(goalId, "zh-CN");
		failingResume.startResearchRunResume(goalId, runId);
		for (let turn = 0; turn < 8; turn++) await new Promise<void>((resolve) => setImmediate(resolve));
		assert.equal(notices.length, 2, "A failed resume attempts both start and failure chat delivery");
		assert.match(notices[0]!, /继续/u);
		assert.match(notices[1]!, /Activity/u, "Failure directs the user to the authoritative reason and actions");
		assert.doesNotMatch(notices[1]!, /启动失败/u, "A failure after execution must not be called a startup failure");
		assert.equal(failingResume.isGoalActive(goalId), false);
	}
	writeFileSync(store.statePath, JSON.stringify({ ...resumableState, resume_attempts: 0 }));
	const deliveryNotices: string[] = [];
	const failedDelivery = new GoalService(workspaceDir, {
		...unusedGoalExecution,
		async createRunner() {
			return { ...session, async appendExternalAssistantMessage(text) {
				deliveryNotices.push(text);
				if (deliveryNotices.length > 1) throw new Error("Report chat delivery failed");
			} };
		},
		async resumeResearchRun() {
			store.resume();
			writeFileSync(store.statePath, JSON.stringify({ ...store.load(), status: "published",
				canonical_report: { relative_path: "report/final.md", sha256: "a".repeat(64), byte_length: 12 },
			}));
			return executorResult({ runId });
		},
	});
	failedDelivery.startResearchRunResume(goalId, runId);
	for (let turn = 0; turn < 8; turn++) await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(store.load()?.status, "published", "Chat delivery failure must preserve Research success");
	assert.equal(deliveryNotices.length, 2, "Report delivery failure must not send a Research failure notice");
	writeFileSync(store.statePath, JSON.stringify(resumableState));
	for (const [expected, overrides] of [
		[/did not return a Run id/u, { runId: "" }],
		[/invalid skip reason/u, { status: "skipped", skipReason: "unsupported_reason" }],
		[/did not publish a report/u, { stableFinalReportPath: undefined }],
	] as Array<[RegExp, Partial<ResearchRunResult>]>) {
		const reporting = new GoalService(workspaceDir, {
			...unusedGoalExecution,
			async createRunner(input) { onSnapshot = input.onSnapshot; return session; },
			async executeResearchRun() { return executorResult(overrides); },
		});
		await assert.rejects(reporting.runScheduledResearch(request), expected);
	}

	const starts = await Promise.all([service.startRun(goalId, "first"), service.startRun(goalId, "second")]);
	assert.deepEqual(starts.map((result) => result.queued), [false, true], "Concurrent Main Agent starts must remain serialized");
	snapshot.isStreaming = false;
	onSnapshot(snapshot);
	assert.deepEqual(prompts.slice(-2), ["first", "second"]);
	snapshot.isStreaming = false;
	onSnapshot(snapshot);

	const harness = loadResearchHarnessSnapshot(goalDir);
	harness.primeSearch.policy.allowedSources = [];
	await service.startRun(goalId, "[EVENT:GOAL_CREATED]\nPrepare the Topic Plan");
	assert.ok(service.getTopicPlanGeneration(goalId)?.startedAt, "Lifecycle Topic generation is visible while the session runs");
	snapshot.isStreaming = false;
	onSnapshot(snapshot);
	assert.equal(service.getTopicPlanGeneration(goalId), undefined, "Finished or aborted sessions cannot leave a running Topic Activity");
	await service.startRun(goalId, "ordinary question");
	assert.equal(service.getTopicPlanGeneration(goalId), undefined, "Ordinary chat is not Topic generation");
	assert.equal((await service.startRun(goalId, "[EVENT:GOAL_UPDATED]\nRevise the Topic Plan")).queued, true);
	assert.equal(service.getTopicPlanGeneration(goalId), undefined, "Queued Topic work is not yet running");
	snapshot.isStreaming = false;
	onSnapshot(snapshot);
	assert.ok(service.getTopicPlanGeneration(goalId)?.startedAt, "Queued Topic work becomes visible when execution starts");
	snapshot.isStreaming = false;
	onSnapshot(snapshot);
	assert.equal(service.getTopicPlanGeneration(goalId), undefined);
	const context = buildRunContextSnapshotFromHarness({ goalId, goalDir, dataDir: workspaceDir, harness });
	const failedSetupStore = new RunStateStore(join(runRecordsDir(workspaceDir, goalId), "run_setup_failure"));
	const failedSetup = runtime.run({
			env: { TELOMI_PRIME_AGENT_ROOT_MODEL: "test/root", TELOMI_PRIME_AGENT_CHILD_MODEL: "test/child", TELOMI_RESEARCH_CORNELL_NOTE_MODEL: "test/note", TELOMI_WIKI_MAINTAINER_MODEL: "test/root" },
		goalId, runId: "run_setup_failure", question: "Check setup failure", reportContext: "Verify failure releases admission",
		discoveryEnabled: true, workspaceDirectory: join(goalDir, "wiki/runs/run_setup_failure"),
		controlDirectory: failedSetupStore.controlDirectory, goalWorkspaceDirectory: goalDir,
		workspaceRootDirectory: workspaceDir, researchHarnessSnapshot: harness, runContextSnapshot: context.snapshot,
	});
	assert.equal(failedSetupStore.load()?.status, "initialized");
	await assert.rejects(failedSetup, /Prime Search has no allowed Provider/u);
	assert.equal(failedSetupStore.load()?.status, "interrupted", "Async setup failure must release the persisted admission");
	assert.equal(failedSetupStore.load()?.failure?.failed_stage, "initialized");
	assert.equal(service.isGoalActive(goalId), false);

	const controller = new AbortController();
	const cancelledStore = new RunStateStore(join(runRecordsDir(workspaceDir, goalId), "run_setup_cancelled"));
	const cancelledSetup = runtime.run({
			env: { TELOMI_PRIME_AGENT_ROOT_MODEL: "test/root", TELOMI_PRIME_AGENT_CHILD_MODEL: "test/child", TELOMI_RESEARCH_CORNELL_NOTE_MODEL: "test/note", TELOMI_WIKI_MAINTAINER_MODEL: "test/root" },
		goalId, runId: "run_setup_cancelled", question: "Check setup cancellation", reportContext: "Verify cancellation stays terminal",
		discoveryEnabled: true, workspaceDirectory: join(goalDir, "wiki/runs/run_setup_cancelled"),
		controlDirectory: cancelledStore.controlDirectory, goalWorkspaceDirectory: goalDir,
		workspaceRootDirectory: workspaceDir, researchHarnessSnapshot: harness, runContextSnapshot: context.snapshot,
		signal: controller.signal,
	});
	controller.abort();
	await assert.rejects(cancelledSetup, /Prime Search has no allowed Provider/u);
	assert.equal(cancelledStore.load()?.status, "cancelled", "Cancellation during setup must not become resumable");
	assert.equal(service.isGoalActive(goalId), false);

	// Unsupported checkpoints are rejected without rewriting their persisted contents.
	const current = store.load()!;
	for (const version of [
		{ schema_version: 2, workflow_version: 1 },
		{ schema_version: 1, workflow_version: RUN_WORKFLOW_VERSION },
	]) {
		const unsupported = { ...current, ...version, status: "search_batch_running" };
		writeFileSync(store.statePath, JSON.stringify(unsupported));
		const restarted = new GoalService(workspaceDir, {
			...unusedGoalExecution,
			async createRunner(input) { onSnapshot = input.onSnapshot; return session; },
		});
		assert.deepEqual(JSON.parse(readFileSync(store.statePath, "utf-8")), unsupported,
			"Startup must preserve unsupported checkpoints for diagnosis");
		assert.equal(canResumeRunState(unsupported as typeof current), false);
		assert.throws(() => restarted.isGoalActive(goalId), /Unsupported Research Run checkpoint/u);
		assert.throws(() => restarted.startResearchRunResume(goalId, runId), /Unsupported Research Run checkpoint/u);
		assert.throws(() => store.recoverInterrupted(), /Unsupported Research Run checkpoint/u);
		assert.throws(() => store.resume(), /Unsupported Research Run checkpoint/u);
		assert.deepEqual(JSON.parse(readFileSync(store.statePath, "utf-8")), unsupported);
	}
	writeFileSync(store.statePath, JSON.stringify(current));
	assert.equal(service.isGoalActive(goalId), false);
	console.log("Persisted Run liveness excludes duplicate starts through initialization, scheduling and resume");
} finally {
	rmSync(workspaceDir, { recursive: true, force: true });
}
