import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ensureGoalWorkspace } from "../../server/workspaces/goal-project.js";
import { GoalTopicPlanStore } from "../../server/goals/topic-plan/index.js";
import { GoalService } from "../../server/goals/service.js";
import { unusedGoalExecution } from "../goals/unused-execution.js";
import { executeResearchRun, resumeResearchRun } from "../../server/research/execute-run.js";
import type { ResearchWorkspaceRunRequest, ResearchWorkspaceRunResult } from "../../server/research/workspace-adapter.js";
import { RUN_WORKFLOW_ID, RUN_WORKFLOW_VERSION, RunStateStore, type RunIdentityPins } from "../../server/research/run-state.js";
import { runtimeContextPath } from "../../server/observability/run-records.js";

const childMode = process.argv[2] === "--child";
const workspaceDir = childMode ? process.argv[3]! : mkdtempSync(join(tmpdir(), "telomi-process-resume-"));
const markerPath = join(workspaceDir, "interrupted-run.json");
const goalId = "goal_process_resume";
const goalDir = join(workspaceDir, goalId);

const pins: RunIdentityPins = {
	harness_snapshot: "harness:test",
	workspace_content_hash: "a".repeat(64),
	knowledge_memory_hash: "knowledge:test",
	run_context_snapshot: "1".repeat(64),
	pipeline: "pipeline:test",
	prompt_bundle: "prompts:test",
	schema_bundle: "schemas:test",
	model_policy: "model:test",
	skill_bundle: "skills:test",
	tool_schema: "tools:test",
};

if (childMode) {
	await executeResearchRun({
		goalDir,
		goalId,
		workspaceDir,
		taskSource: "main_agent",
		goalTitle: "Frozen Goal title",
		goalDescription: "Frozen Goal description",
		reason: "Verify process restart recovery",
		question: "验证 Agent 粒度的断点续跑",
		reportContext: "面向熟悉现有流程的工程师，解释断点续跑的可靠性。",
		researchExecutor: async (request) => {
			const store = new RunStateStore(request.controlDirectory);
			const initialized = store.create({
				runId: request.runId,
				goalId,
				question: request.question,
				language: "zh-CN",
				pins,
			});
			store.save(initialized, { ...initialized, status: "evidence_materializing", updated_at: new Date().toISOString() });
			const checkpoint = { type: "checkpoint", runId: request.runId, controlDir: request.controlDirectory };
			writeFileSync(markerPath, `${JSON.stringify(checkpoint)}\n`, "utf-8");
			process.send?.(checkpoint);
			await new Promise<never>(() => undefined);
			throw new Error("unreachable");
		},
	});
	process.exit(1);
}

ensureGoalWorkspace({ goalDir, goalId, title: "Process resume integration" });
const topicStore = new GoalTopicPlanStore(goalId, workspaceDir);
const topicProposal = topicStore.proposePatch({
	source: "main_agent",
	patch: {
		schema_version: 1,
		base_revision: null,
		summary: "Confirm the integration Topic",
		operations: [{
			op: "add",
			topic: {
				id: "research",
				title: "Research Runtime",
				intent: "Test resumable research execution",
				questions: [],
				include: [],
				exclude: [],
			},
		}],
	},
});
topicStore.activate(topicProposal.proposal_id);
writeFileSync(join(workspaceDir, "goals.json"), `${JSON.stringify([{
	id: goalId,
	title: "Process resume integration",
	description: "",
	createdAt: new Date().toISOString(),
	updatedAt: new Date().toISOString(),
	preview: "",
	messageCount: 0,
	avatar: { head: "tufts", eye: "round", color: "sky" },
	discoveryEnabled: true,
	outputLanguage: "auto",
}], null, 2)}\n`, "utf-8");

const observer = new GoalService(workspaceDir, unusedGoalExecution);
const child = spawn(process.execPath, ["--import", "tsx", process.argv[1]!, "--child", workspaceDir], {
	cwd: process.cwd(),
	stdio: ["ignore", "pipe", "pipe", "ipc"],
});
let childStdout = "";
let childStderr = "";
child.stdout!.on("data", (chunk) => { childStdout += chunk.toString(); });
child.stderr!.on("data", (chunk) => { childStderr += chunk.toString(); });
const marker = await waitForChildCheckpoint();
assert.equal(JSON.parse(readFileSync(join(marker.controlDir, "resume-request.json"), "utf-8")).reportContext, "面向熟悉现有流程的工程师，解释断点续跑的可靠性。");
assert.deepEqual(JSON.parse(readFileSync(markerPath, "utf-8")), { type: "checkpoint", ...marker });
const activeBeforeCrash = observer.isGoalActive(goalId);
const childClosed = once(child, "close");
child.kill("SIGKILL");
await childClosed;

async function waitForChildCheckpoint(): Promise<{ runId: string; controlDir: string }> {
	return new Promise((resolve, reject) => {
		const finish = (error?: Error, marker?: { runId: string; controlDir: string }) => {
			clearTimeout(timeout);
			child.off("message", onMessage);
			child.off("close", onClose);
			child.off("error", onError);
			if (error) reject(error);
			else resolve(marker!);
		};
		const onMessage = (message: unknown) => {
			if (!message || typeof message !== "object") return;
			const value = message as Record<string, unknown>;
			if (value.type !== "checkpoint" || typeof value.runId !== "string" || typeof value.controlDir !== "string") return;
			finish(undefined, { runId: value.runId, controlDir: value.controlDir });
		};
		const onClose = (code: number | null, signal: NodeJS.Signals | null) => {
			finish(new Error(`child exited before the Agent checkpoint boundary (code=${code}, signal=${signal}):\n${childDiagnostics()}`));
		};
		const onError = (error: Error) => finish(new Error(`child process failed before the Agent checkpoint boundary: ${error.message}\n${childDiagnostics()}`));
		const timeout = setTimeout(() => {
			child.kill("SIGKILL");
			finish(new Error(`child did not reach the Agent checkpoint boundary within 30 seconds:\n${childDiagnostics()}`));
		}, 30_000);
		child.on("message", onMessage);
		child.once("close", onClose);
		child.once("error", onError);
	});
}

function childDiagnostics(): string {
	return `stdout:\n${childStdout}\nstderr:\n${childStderr}`;
}

assert.equal(activeBeforeCrash, true, "Goal liveness must include a persisted Run driven by another process");
const restarted = new GoalService(workspaceDir, unusedGoalExecution);
assert.equal(restarted.isGoalActive(goalId), false, "Interrupted Runs must release Goal admission");
const interrupted = new RunStateStore(marker.controlDir).load();
assert.equal(interrupted?.status, "interrupted", "server restart must preserve the Run as resumable");
assert.equal(interrupted?.failure?.failed_stage, "evidence_materializing");

let resumedExecutorCalls = 0;
const result = await resumeResearchRun({
	goalDir,
	goalId,
	workspaceDir,
	runId: marker.runId,
	researchExecutor: async (request: ResearchWorkspaceRunRequest): Promise<ResearchWorkspaceRunResult> => {
		resumedExecutorCalls += 1;
		assert.equal(request.runId, marker.runId, "resume must reuse the original Run id");
		assert.equal(request.goalTitle, "Frozen Goal title");
		assert.equal(request.reportContext, "面向熟悉现有流程的工程师，解释断点续跑的可靠性。");
		assert.equal(request.goalDescription, "Frozen Goal description");
		assert.equal(new RunStateStore(request.controlDirectory).load()?.status, "evidence_materializing");
		mkdirSync(join(request.workspaceDirectory, "report"), { recursive: true });
		const finalReportPath = join(request.workspaceDirectory, "report", "final.md");
		const finalReportContent = "# Resumed report\n\nCompleted from the interrupted Agent.\n";
		writeFileSync(finalReportPath, finalReportContent, "utf-8");
		const statePath = join(request.controlDirectory, "run-state.json");
		const state = new RunStateStore(request.controlDirectory).load()!;
		const finishedAt = new Date().toISOString();
		const published = {
			...state,
			status: "published" as const,
			canonical_report: { relative_path: "report/final.md", sha256: "2".repeat(64), byte_length: finalReportContent.length },
			updated_at: finishedAt,
			finished_at: finishedAt,
		};
		writeFileSync(statePath, `${JSON.stringify(published, null, 2)}\n`, "utf-8");
		return {
			execution: {
				runId: request.runId,
				status: "succeeded",
				workflowId: RUN_WORKFLOW_ID,
				workflowVersion: RUN_WORKFLOW_VERSION,
				startedAt: state.started_at,
				finishedAt,
				nodeStatuses: { resumed: "succeeded" },
				usage: { inputTokens: 1, outputTokens: 1, costUsd: 0, items: 1 },
			},
			model: "test/provider-model",
			traceSummary: {
				version: 2,
				source: "research_runtime",
				workflowId: RUN_WORKFLOW_ID,
				workflowVersion: RUN_WORKFLOW_VERSION,
				controlStatePath: join(request.controlDirectory, "run-state.json"),
				messageCount: 0,
				userMessages: 0,
				assistantMessages: 0,
				toolCalls: 0,
				toolResults: 0,
				toolErrors: 0,
				nodeAttempts: 1,
				nodeFailures: 0,
				bashExecutions: 0,
				modelChanges: 0,
				thinkingLevelChanges: 0,
				compactions: 0,
				stopReasons: { succeeded: 1 },
				tools: {},
				usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: 0 },
				nodes: [],
				repairRoutes: [],
				run: { status: "succeeded", durationMs: 1, items: 1 },
			},
			traceSummaryPath: runtimeContextPath(request.controlDirectory, "research"),
			finalReportPath,
			finalReportContent,
			renderFormats: ["markdown"],
			renderArtifacts: [{
				format: "markdown",
				kind: "report",
				relativePath: "report/final.md",
				absolutePath: finalReportPath,
				mediaType: "text/markdown",
			}],
			researchHarnessSnapshot: {} as ResearchWorkspaceRunResult["researchHarnessSnapshot"],
			stageReports: [],
			state: published,
		};
	},
});

assert.equal(resumedExecutorCalls, 1);
assert.equal(result.runId, marker.runId);
assert.equal(result.status, "published");
for (const leaked of ["traceSummary", "researchHarnessSnapshot", "stageReports", "renderArtifacts"]) {
	assert.equal(leaked in result, false, `Research Run result must not retransmit '${leaked}'`);
}
assert.equal(result.stableFinalReportPath, `/workspace/wiki/runs/${marker.runId}/report/final.md`);
assert.match(result.receiptText, /Report: \/reports\/\d{4}-\d{2}-\d{2} Resumed report\/report\.md /u,
	"the receipt names the resumed report as `ls /reports` shows it");
assert.doesNotMatch(result.receiptText, /Completed from the interrupted Agent/u,
	"the Research Run receipt must not retransmit the published report body");
assert.equal(new RunStateStore(marker.controlDir).load()?.status, "published");
console.log("Research Run process interruption resume test passed");
