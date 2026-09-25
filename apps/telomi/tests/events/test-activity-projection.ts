import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { RUN_WORKFLOW_ID, RUN_WORKFLOW_VERSION } from "../../server/research/run-state.js";
import { hashJson } from "../../server/lib/hash.js";
import { createActivityProjection } from "../../server/app/activity-projection.js";
import {
	agentSessionPath,
	appendRuntimeContext,
	appendResearchNodeRecord,
	runRecordDir,
} from "../../server/observability/run-records.js";
import { WikiUpdateJobStore } from "../../server/wiki/wiki-update-job.js";
import { wikiUpdateRecordDir } from "../../server/wiki/update-runner.js";
import { TopicPlanActivityProjection } from "../../server/goals/topic-plan/activity-projection.js";
import { GoalTopicPlanStore } from "../../server/goals/topic-plan/index.js";
import type { ActivityText } from "../../shared/events/activity-projection.js";
import i18n from "../../web/src/app/i18n.js";
import { activityText } from "../../web/src/shared/lib/activity-text.js";

// The projection carries message ids; these assertions read the copy the zh-CN UI renders.
await i18n.changeLanguage("zh-CN");
const text = (value: ActivityText | undefined) => value === undefined ? "" : activityText(value);

const workspaceDir = mkdtempSync(join(tmpdir(), "telomi-activity-projection-"));
const goalId = "goal_activity_test";
const wikiTopicPlan = {
	schema_version: 1 as const,
	goal_id: goalId,
	revision: "topic-plan-test",
	status: "active" as const,
	topics: [{ id: "research-focus", title: "Research Focus", intent: "Track the Goal focus", questions: [], include: [], exclude: [] }],
};
const runId = "2026-07-31T10-00-00.000Z";
const runDir = runRecordDir(workspaceDir, goalId, runId);
mkdirSync(runDir, { recursive: true });
writeFileSync(join(runDir, "run-state.json"), JSON.stringify({
	schema_version: 2,
	workflow_id: "research-run",
	workflow_version: 19,
	run_id: runId,
	goal_id: goalId,
	question: "统一 Activity 展示",
	language: "zh-CN",
	status: "published",
	state_revision: 2,
	pins: {},
	source_bundles: [],
	search_execution_records: [],
	cornell_note_snapshots: [],
	writer_outputs: [],
	accepted_chapters: [],
	canonical_report: { relative_path: "report/final.md", sha256: "a".repeat(64), byte_length: 12 },
	usage: {
		input_tokens: 20,
		output_tokens: 10,
		cost_usd: 0.01,
		model_calls: 1,
		agent_stages: 1,
		search_attempts: 1,
	},
	started_at: "2026-07-31T10:00:00.000Z",
	updated_at: "2026-07-31T10:01:00.000Z",
	finished_at: "2026-07-31T10:01:00.000Z",
}), "utf8");

appendResearchNodeRecord(runDir, {
	node_id: "cornell-note",
	node_type: "agent",
	agent: "cornell_note",
	execution_id: "planner",
	attempt: 1,
	status: "succeeded",
	group_id: null,
	depends_on: [],
	input: { privatePrompt: "must not reach the browser" },
	output: { metrics: { model_calls: 1, tool_calls: 2 } },
	time: {
		started_at: "2026-07-31T10:00:00.000Z",
		finished_at: "2026-07-31T10:01:00.000Z",
		duration_ms: 60_000,
	},
	trace_ref: "cornell_note--planner.jsonl",
});
for (const nodeId of ["screen-source-a", "screen-source-b"]) {
	appendResearchNodeRecord(runDir, {
		node_id: nodeId,
		node_type: "agent",
		agent: "cornell_note",
		execution_id: `execution-${nodeId}`,
		status: "succeeded",
		group_id: "screening-round-1",
		depends_on: [1],
		input: {},
		output: {},
		time: {
			started_at: "2026-07-31T10:01:00.000Z",
			finished_at: "2026-07-31T10:01:10.000Z",
			duration_ms: 10_000,
		},
	});
}
for (const providerId of ["github", "huggingface"]) {
	appendResearchNodeRecord(runDir, {
		node_id: `prime-search-job:1:${providerId}`,
		node_type: "agent",
		agent: "prime_search",
		execution_id: `execution-${providerId}`,
		status: "succeeded",
		group_id: "search-batch-1",
		depends_on: [1],
		input: {},
		output: {},
		time: {
			started_at: "2026-07-31T10:01:10.000Z",
			finished_at: "2026-07-31T10:01:20.000Z",
			duration_ms: 10_000,
		},
	});
}
for (const attempt of [1, 2]) {
	appendResearchNodeRecord(runDir, {
		node_id: "prime-search-job:1:arxiv",
		node_type: "agent",
		agent: "prime_search",
		execution_id: `execution-arxiv-${attempt}`,
		attempt,
		status: attempt === 1 ? "failed" : "succeeded",
		group_id: attempt === 1 ? "search-batch-1" : "search-batch-1-retry",
		depends_on: [1],
		input: {},
		output: attempt === 1 ? { error: "temporary Provider failure" } : {},
		time: {
			started_at: `2026-07-31T10:01:${attempt === 1 ? "10" : "20"}.000Z`,
			finished_at: `2026-07-31T10:01:${attempt === 1 ? "20" : "30"}.000Z`,
			duration_ms: 10_000,
		},
	});
}
writeFileSync(agentSessionPath(runDir, "cornell_note", "planner"), [
	JSON.stringify({
		type: "message",
		timestamp: Date.parse("2026-07-31T10:00:30.000Z"),
		message: {
			role: "user",
			content: [{ type: "text", text: "private user prompt" }],
		},
	}),
	JSON.stringify({
		type: "message",
		timestamp: Date.parse("2026-07-31T10:00:45.000Z"),
		message: {
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "分析输入" },
				{ type: "toolCall", name: "search_general_web", arguments: { query: "activity projection" } },
			],
		},
	}),
	JSON.stringify({
		type: "message",
		timestamp: Date.parse("2026-07-31T10:00:46.000Z"),
		message: {
			role: "toolResult",
			toolName: "search_general_web",
			content: [{ type: "text", text: "first result" }],
		},
	}),
	JSON.stringify({
		type: "message",
		timestamp: Date.parse("2026-07-31T10:00:47.000Z"),
		message: {
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "整理结果" },
				{ type: "toolCall", name: "write", arguments: { path: "report.md", apiKey: "must-not-leak" } },
			],
		},
	}),
	JSON.stringify({
		type: "message",
		timestamp: Date.parse("2026-07-31T10:00:48.000Z"),
		message: {
			role: "toolResult",
			toolName: "write",
			content: [{ type: "text", text: "wrote report.md" }],
		},
	}),
	JSON.stringify({
		type: "message",
		timestamp: Date.parse("2026-07-31T10:00:49.000Z"),
		message: {
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "提交结果" },
				{ type: "toolCall", name: "submit_stage_output", arguments: { result: "done" } },
			],
		},
	}),
	JSON.stringify({
		type: "message",
		timestamp: Date.parse("2026-07-31T10:00:50.000Z"),
		message: {
			role: "toolResult",
			toolName: "submit_stage_output",
			content: [{ type: "text", text: "submitted" }],
		},
	}),
].join("\n") + "\n", "utf8");

const liveRunId = "2026-07-31T09-00-00.000Z";
const liveRunDir = runRecordDir(workspaceDir, goalId, liveRunId);
mkdirSync(liveRunDir, { recursive: true });
writeFileSync(join(liveRunDir, "run-state.json"), JSON.stringify({
	schema_version: 2,
	run_id: liveRunId,
	goal_id: goalId,
	question: "动态 Research 不展示伪进度",
	status: "search_batch_running",
	usage: { model_calls: 1 },
	started_at: "2026-07-31T09:00:00.000Z",
	updated_at: "2026-07-31T09:01:00.000Z",
}), "utf8");
appendRuntimeContext(liveRunDir, "research", {
	type: "runtime.agent_bound",
	stage_id: "prime-search-job:1:arxiv",
	execution_id: "worker-interrupted-before-resume",
	agent: "prime_search",
	created_at: "2026-07-31T09:01:50.000Z",
});
appendResearchNodeRecord(liveRunDir, {
	node_id: "cornell-note",
	node_type: "agent",
	agent: "cornell_note",
	execution_id: "live-planner",
	attempt: 1,
	status: "succeeded",
	group_id: null,
	depends_on: [],
	input: {},
	output: {},
	time: {
		started_at: "2026-07-31T09:00:00.000Z",
		finished_at: "2026-07-31T09:01:59.000Z",
		duration_ms: 119_000,
	},
});
appendRuntimeContext(liveRunDir, "research", {
	type: "runtime.run_resumed",
	created_at: "2026-07-31T09:01:59.000Z",
});
const liveSession = agentSessionPath(liveRunDir, "prime_search", "live-worker");
writeFileSync(liveSession, `${JSON.stringify({
	type: "message",
	timestamp: Date.parse("2026-07-31T09:02:01.000Z"),
	message: {
		role: "assistant",
		content: [{ type: "toolCall", name: "github_search", arguments: { query: "activity projection" } }],
	},
})}\n`, "utf8");
appendRuntimeContext(liveRunDir, "research", {
	type: "runtime.agent_bound",
	stage_id: "prime-search-job:1:github",
	execution_id: "live-worker",
	agent: "prime_search",
	session_file: basename(liveSession),
	created_at: "2026-07-31T09:01:59.000Z",
});
appendRuntimeContext(liveRunDir, "research", {
	type: "runtime.agent_bound",
	stage_id: "writer-report",
	execution_id: "stale-writer-before-restart",
	agent: "report_writer",
	created_at: "2026-07-31T09:01:30.000Z",
});
appendRuntimeContext(liveRunDir, "research", {
	type: "runtime.stage_checkpoint_reused",
	stage_id: "writer-report",
	execution_id: "resume-writer",
	created_at: "2026-07-31T09:02:01.000Z",
});

const interruptedRunId = "2026-07-31T09-30-00.000Z";
const interruptedRunDir = runRecordDir(workspaceDir, goalId, interruptedRunId);
mkdirSync(interruptedRunDir, { recursive: true });
writeFileSync(join(interruptedRunDir, "run-state.json"), JSON.stringify({
	schema_version: 2,
	workflow_id: RUN_WORKFLOW_ID,
	workflow_version: RUN_WORKFLOW_VERSION,
	run_id: interruptedRunId,
	goal_id: goalId,
	question: "可继续的 Research",
	status: "interrupted",
	usage: { model_calls: 1 },
	started_at: "2026-07-31T09:30:00.000Z",
	updated_at: "2026-07-31T09:31:00.000Z",
	failure: {
		failure_class: "infrastructure",
		failed_stage: "evidence_materializing",
		message: "Research Run 因后端进程停止而中断，可以继续运行。",
	},
}), "utf8");
writeFileSync(join(interruptedRunDir, "resume-request.json"), "{}\n", "utf8");
const interruptedWikiJobs = new WikiUpdateJobStore(interruptedRunDir);
interruptedWikiJobs.start({
	goalId,
	runId: interruptedRunId,
	goal: "可继续的 Wiki 更新",
	goalContext: { title: "Goal title", description: "Goal description" },
	topicPlan: wikiTopicPlan,
	cornellNotes: { relative_path: "artifacts/cornell-notes/evidence.json", sha256: "a".repeat(64), byte_length: 12 },
});
interruptedWikiJobs.markInterrupted();
appendRuntimeContext(interruptedRunDir, "research", {
	type: "runtime.agent_bound",
	stage_id: "evidence-screening-source-a",
	execution_id: "interrupted-screening",
	agent: "cornell_note",
	created_at: "2026-07-31T09:30:30.000Z",
});

const cancelledRunId = "2026-07-31T10-03-00.000Z";
const cancelledRunDir = runRecordDir(workspaceDir, goalId, cancelledRunId);
mkdirSync(cancelledRunDir, { recursive: true });
writeFileSync(join(cancelledRunDir, "run-state.json"), JSON.stringify({
	schema_version: 2,
	run_id: cancelledRunId,
	goal_id: goalId,
	question: "用户取消的 Research",
	status: "cancelled",
	usage: {},
	started_at: "2026-07-31T10:02:00.000Z",
	updated_at: "2026-07-31T10:03:00.000Z",
	finished_at: "2026-07-31T10:03:00.000Z",
}), "utf8");
const exhaustedWikiJobs = new WikiUpdateJobStore(cancelledRunDir);
for (let attempt = 0; attempt < 3; attempt += 1) {
	exhaustedWikiJobs.start({
		goalId,
		runId: cancelledRunId,
		goal: "用完续跑次数的 Wiki 更新",
		goalContext: { title: "Goal title", description: "Goal description" },
		topicPlan: wikiTopicPlan,
		cornellNotes: { relative_path: "artifacts/cornell-notes/evidence.json", sha256: "b".repeat(64), byte_length: 12 },
	});
	exhaustedWikiJobs.markInterrupted();
}

for (const nodeId of ["evidence-screening-a", "evidence-screening-b"]) {
	appendResearchNodeRecord(cancelledRunDir, {
		node_id: nodeId,
		node_type: "agent",
		agent: "cornell_note",
		execution_id: `execution-${nodeId}`,
		status: "cancelled",
		group_id: "cancelled-evidence-screening",
		depends_on: [],
		input: {},
		output: { error: "Agent stage cancelled" },
		time: {
			started_at: "2026-07-31T10:02:40.000Z",
			finished_at: "2026-07-31T10:02:59.000Z",
			duration_ms: 19_000,
		},
	});
}
for (const nodeId of ["final-runtime-gate", "workspace-run"]) {
	appendResearchNodeRecord(cancelledRunDir, {
		node_id: nodeId,
		node_type: "runtime",
		status: "cancelled",
		group_id: null,
		depends_on: [],
		input: {},
		output: { error: "Agent stage cancelled" },
		time: {
			started_at: "2026-07-31T10:02:59.000Z",
			finished_at: "2026-07-31T10:03:00.000Z",
			duration_ms: 1_000,
		},
	});
}
appendRuntimeContext(cancelledRunDir, "research", {
	type: "runtime.agent_bound",
	stage_id: "evidence-screening-orphaned",
	execution_id: "cancelled-orphaned-agent",
	agent: "cornell_note",
	created_at: "2026-07-31T10:02:58.000Z",
});

const wikiUpdateId = "wiki_activity_test";
const wikiControl = wikiUpdateRecordDir(workspaceDir, goalId, wikiUpdateId);
mkdirSync(join(wikiControl, "traces"), { recursive: true });
const wikiJobs = new WikiUpdateJobStore(wikiControl);
wikiJobs.start({
	goalId,
	runId: wikiUpdateId,
	wikiUpdateId,
	sourceRunId: runId,
	parentActivityId: `research:${runId}`,
	trigger: { kind: "system" },
	reason: "Research produced Cornell Notes",
	goal: "独立 Wiki Activity",
	goalContext: { title: "Goal title", description: "Goal description" },
	topicPlan: wikiTopicPlan,
	cornellNotes: { relative_path: "artifacts/input/cornell-notes.json", sha256: "c".repeat(64), byte_length: 12 },
});
wikiJobs.markRunning(2, new Date("2026-07-31T10:01:10.000Z"));
wikiJobs.recordBatch({
	batchIndex: 0,
	totalBatches: 2,
	status: "succeeded",
	pageCount: 3,
	usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.01, calls: 1 },
	reused: false,
	now: new Date("2026-07-31T10:01:20.000Z"),
});
writeFileSync(join(wikiControl, "traces", "batch-2.jsonl"), `${JSON.stringify({
	role: "assistant",
	content: [{ type: "text", text: "正在合并 Wiki 实体页面" }],
})}\n`, "utf8");
writeFileSync(join(wikiControl, "wiki-trace-batch-2.json"), JSON.stringify({
	schemaVersion: 1,
	sessions: [{ path: "traces/batch-2.jsonl", label: "Wiki Session" }],
}), "utf8");
wikiJobs.recordBatch({
	batchIndex: 1,
	totalBatches: 2,
	status: "running",
	pageCount: 3,
	usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, calls: 0 },
	traceRef: "wiki-trace-batch-2.json",
	reused: false,
	now: new Date("2026-07-31T10:01:30.000Z"),
});
	wikiJobs.recordStage({
		kind: "curation",
		stageIndex: 0,
		totalStages: 2,
	status: "running",
	pageCount: 3,
	usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, calls: 0 },
	traceRef: "wiki-trace-batch-2.json",
	now: new Date("2026-07-31T10:01:31.000Z"),
});

const service = createActivityProjection({
	workspaceDir,
	listGoalIds: () => [goalId],
	listPodcastActivities: () => [{
		id: "goal_activity_test:podcast:job-1",
		goalId,
		kind: "podcast",
		agent: "Podcast AI",
		action: "播客生成：整理播客偏好",
		status: "running",
		runId: "job-1",
		detail: "report",
		startedAt: Date.parse("2026-07-31T10:04:00.000Z"),
		updatedAt: Date.parse("2026-07-31T10:04:10.000Z"),
	}],
});

try {
	const first = service.getGoal(goalId);
	assert.equal(hashJson({ kind: "podcast", timing: { createdAt: "a", updatedAt: "b" } }),
		hashJson({ timing: { updatedAt: "b", createdAt: "a" }, kind: "podcast" }),
		"Activity revisions use canonical JSON independent of object insertion order");
	const podcastRevision = (projection: typeof first) =>
		projection.freshness.find((source) => source.source === "podcast")?.sourceRevision;
	assert.match(podcastRevision(first) ?? "", /^[0-9a-f]{20}$/u);
	const podcast = first.liveActivities.find((item) => item.activityId === "podcast:goal_activity_test:podcast:job-1");
	assert.equal(podcast?.kind, "podcast");
	assert.equal(podcast?.lifecycle, "running");
	// The running Podcast keeps counting against the current time, which is not a change of its facts.
	assert.ok(podcast.timing.durationMs! > Date.parse("2026-07-31T10:04:10.000Z") - Date.parse("2026-07-31T10:04:00.000Z"));
	assert.equal(podcastRevision(service.getGoal(goalId)), podcastRevision(first));
	const research = first.history.items.find((item) => item.activityId === `research:${runId}`);
	assert.ok(research, "Research Run must be projected");
	assert.equal(research.lifecycle, "finished");
	assert.equal(research.outcome, "succeeded");
	const cancelledResearch = first.history.items.find((item) => item.activityId === `research:${cancelledRunId}`);
	const exhaustedWiki = cancelledResearch?.attention?.actions
		.find((action) => action.actionId === `resume-wiki:${cancelledRunId}`);
	assert.equal(exhaustedWiki, undefined, "Run-directory Wiki jobs must not offer recovery actions");
	assert.equal(cancelledResearch?.outcome, "cancelled");
	const cancelledScreening = cancelledResearch?.steps.find(
		(step) => step.stepId === "group:cancelled-evidence-screening",
	);
	assert.equal(cancelledScreening?.outcome, "cancelled",
		"a parallel checkpoint must be cancelled when all of its nodes are cancelled");
	assert.deepEqual(cancelledScreening?.parallelSteps.map((step) => step.outcome), ["cancelled", "cancelled"]);
	assert.deepEqual(cancelledResearch?.steps.map((step) => step.outcome), ["cancelled", "cancelled", "cancelled", "cancelled"],
		"cancelled terminal records must remain cancelled in Activity");
	const cancelledOrphan = cancelledResearch?.steps
		.flatMap((step) => step.agentActivities)
		.find((agent) => agent.agentActivityId === "active-agent:cancelled-orphaned-agent");
	assert.equal(cancelledOrphan?.lifecycle, "finished",
		"an unmatched Agent binding must close when its parent Research Run is terminal");
	assert.equal(cancelledOrphan?.outcome, "cancelled");
	assert.equal(cancelledOrphan?.timing.finishedAt, "2026-07-31T10:03:00.000Z");
	assert.equal(
		research.resultLinks[0]?.workspacePath,
		`wiki/runs/${runId}/report/final.md`,
		"Research report results must open through the workspace document viewer",
	);
	const searchWorkers = research.steps.flatMap((step) => step.agentActivities)
		.filter((activity) => activity.agentName === "prime_search");
	assert.equal(searchWorkers.length, 3, "a retry must preserve the Prime Search Agent Activity identity");
	assert.deepEqual(searchWorkers.find((activity) => activity.attempts.length === 2)
		?.attempts.map((attempt) => attempt.number), [1, 2]);
	assert.equal(research.steps.length, 3);
	assert.equal(research.steps[0]?.agentActivities.length, 1);
	assert.equal(research.steps[1]?.parallelSteps.length, 2, "parallel nodes must share one Activity Step");
	assert.equal(first.history.items.length, 2);
	assert.equal(first.history.nextCursor, undefined);
	assert.equal(first.liveActivities.length, 4);
	const liveResearch = first.liveActivities.find((item) => item.activityId === `research:${liveRunId}`);
	assert.equal(liveResearch?.steps[0]?.agentActivities.length, 1);
	assert.equal(text(liveResearch?.summary), "正在检索资料");
	assert.deepEqual(liveResearch?.steps.map((step) => step.executionRound), [1, 2],
		"resumed Research separates historical checkpoints from current execution");
	assert.equal(liveResearch?.recovery?.round, 2);

	assert.equal(liveResearch?.progress, undefined, "dynamic Research must not expose a false total");
	assert.equal(
		liveResearch?.steps.flatMap((step) => step.agentActivities).some((agent) => agent.agentName === "report_writer"),
		false,
		"a reused checkpoint must close the pre-restart orphaned Agent binding",
	);
	const interruptedResearch = first.liveActivities.find((item) => item.activityId === `research:${interruptedRunId}`);
	assert.ok(interruptedResearch, "interrupted Research must remain visible as waiting");
	assert.equal(interruptedResearch.lifecycle, "waiting");
	assert.equal(interruptedResearch.attention?.actions[0]?.kind, "continue");
	assert.equal(
		interruptedResearch.attention?.actions[0]?.href,
		`/api/goals/${goalId}/research-runs/${interruptedRunId}/resume`,
	);
	const wikiResume = interruptedResearch.attention?.actions
		.find((action) => action.actionId === `resume-wiki:${interruptedRunId}`);
	assert.equal(wikiResume, undefined, "an old Run-directory Wiki job is not resumable");
	assert.doesNotMatch(text(interruptedResearch.attention?.summary), /Wiki 更新/u);
	assert.equal(interruptedResearch.steps.at(-1)?.lifecycle, "waiting");
	const wikiActivity = first.liveActivities.find((item) => item.activityId === `wiki-update:${wikiUpdateId}`);
	assert.ok(wikiActivity, "a standalone Wiki Update must be projected as a live Activity");
	assert.equal(wikiActivity.kind, "wiki-update");
	assert.equal(wikiActivity.parentActivityId, `research:${runId}`);
	assert.equal(wikiActivity.progress?.completed, 1);
	assert.equal(wikiActivity.progress?.total, 2);
	assert.equal(text(wikiActivity.progress?.label), "Wiki 批次");
	assert.equal(wikiActivity.steps.length, 3);
	assert.equal(wikiActivity.steps.find((step) => step.stepId === "wiki-stage:curation:0")
		?.agentActivities[0]?.agentName, "wiki_curator");
	assert.deepEqual(wikiActivity.steps.find((step) => step.stepId === "wiki-stage:curation:0")
		?.dependsOnStepIds, ["wiki-batch:1"]);
	const wikiOutputRef = wikiActivity.steps.find((step) => step.stepId === "wiki-batch:2")
		?.agentActivities[0]?.outputRef;
	assert.ok(wikiOutputRef, "a running Wiki Maintainer must expose replay output");
	assert.match(JSON.stringify(service.readOutput(goalId, wikiOutputRef)), /正在合并 Wiki 实体页面/u);
	wikiJobs.recordBatch({
		batchIndex: 1, totalBatches: 2, status: "succeeded", pageCount: 11,
		usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.01, calls: 1 }, reused: false,
	});
	wikiJobs.recordStage({
		kind: "curation", stageIndex: 0, totalStages: 2, status: "succeeded", pageCount: 4,
		usage: { inputTokens: 20, outputTokens: 10, costUsd: 0.02, calls: 2 },
	});
	wikiJobs.recordStage({
		kind: "curation", stageIndex: 1, totalStages: 2, status: "succeeded", pageCount: 6,
		usage: { inputTokens: 20, outputTokens: 10, costUsd: 0.02, calls: 2 },
	});
	wikiJobs.recordStage({
		kind: "publication", stageIndex: 0, totalStages: 1, status: "succeeded", pageCount: 6,
		usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, calls: 0 },
	});
	wikiJobs.settle("succeeded", { publicationStatus: "promoted" });
	const publishedWiki = service.getGoal(goalId).history.items
		.find((item) => item.activityId === `wiki-update:${wikiUpdateId}`);
	assert.equal(text(publishedWiki?.summary), "Goal Wiki 已更新 · 6 个页面 · 6 次模型调用");
	assert.deepEqual(publishedWiki?.steps.find((step) => step.stepId === "wiki-stage:curation:1")
		?.dependsOnStepIds, ["wiki-batch:2", "wiki-stage:curation:0"]);
	assert.deepEqual(publishedWiki?.steps.find((step) => step.stepId === "wiki-stage:publication:0")
		?.dependsOnStepIds, ["wiki-stage:curation:0", "wiki-stage:curation:1"]);
	// 首页活动卡片直接渲染 Activity 摘要：Runtime 的 stack trace、宿主机绝对路径和行号不能出现在里面。
	const failedWikiId = "wiki_activity_failed";
	const failedWikiControl = wikiUpdateRecordDir(workspaceDir, goalId, failedWikiId);
	mkdirSync(failedWikiControl, { recursive: true });
	const failedWikiJobs = new WikiUpdateJobStore(failedWikiControl);
	failedWikiJobs.start({
		goalId,
		runId: failedWikiId,
		wikiUpdateId: failedWikiId,
		trigger: { kind: "manual" },
		reason: "Curator 校验失败",
		goal: "失败的 Wiki Activity",
		goalContext: { title: "Goal title", description: "Goal description" },
		topicPlan: wikiTopicPlan,
		cornellNotes: { relative_path: "artifacts/input/cornell-notes.json", sha256: "d".repeat(64), byte_length: 12 },
	});
	const curatorTrace = [
		"Wiki Curator exited with code 1: /Users/maintainer/My Checkout/apps/telomi/server/wiki/wiki-shard-merge.ts:590",
		"\treturn new Error(`[wiki-curator:worksets] file '${file}', field '${field}': ${issue}`);",
		"\t       ^",
		"",
		"Error: [wiki-curator:worksets] file 'state/groups/ws-concept-2ea7.json': contains unknown Goal Topic",
		"    at curatorResultViolation (C:\\Users\\maintainer\\checkout\\server\\wiki\\wiki-shard-merge.ts:590:9)",
		"    at validateGroupResult (/srv/telomi/server/wiki/wiki-shard-merge.ts:566:27)",
		"",
		"Node.js v24.20.0",
	].join("\n");
	failedWikiJobs.recordStage({
		kind: "curation", stageIndex: 0, totalStages: 1, status: "failed", pageCount: 0,
		usage: { inputTokens: 1, outputTokens: 1, costUsd: 0.01, calls: 1 }, message: curatorTrace,
	});
	failedWikiJobs.settle("failed", { message: curatorTrace });
	const failedWiki = service.getGoal(goalId).history.items
		.find((item) => item.activityId === `wiki-update:${failedWikiId}`);
	assert.equal(text(failedWiki?.summary), "Wiki 更新失败：Wiki Curator 未完成，原因见 Activity 详情");
	assert.ok(
		text(failedWiki?.steps.find((step) => step.stepId === "wiki-stage:curation:0")?.summary).includes(curatorTrace),
		"the Activity Step keeps the full runtime text for Activity detail and Node Trace",
	);

	// 任意宿主机的失败文本都不能进入用户可见摘要，摘要也不做逐条路径清洗。
	const cancelledWikiId = "wiki_activity_cancelled";
	const cancelledWikiControl = wikiUpdateRecordDir(workspaceDir, goalId, cancelledWikiId);
	mkdirSync(cancelledWikiControl, { recursive: true });
	const cancelledWikiJobs = new WikiUpdateJobStore(cancelledWikiControl);
	cancelledWikiJobs.start({
		goalId,
		runId: cancelledWikiId,
		wikiUpdateId: cancelledWikiId,
		trigger: { kind: "manual" },
		reason: "用户取消",
		goal: "取消的 Wiki Activity",
		goalContext: { title: "Goal title", description: "Goal description" },
		topicPlan: wikiTopicPlan,
		cornellNotes: { relative_path: "artifacts/input/cornell-notes.json", sha256: "e".repeat(64), byte_length: 12 },
	});
	cancelledWikiJobs.settle("cancelled", { message: "Wiki Curator cancelled: D:\\Projects\\telomi\\server\\wiki.ts:12:3" });
	const cancelledWiki = service.getGoal(goalId).history.items
		.find((item) => item.activityId === `wiki-update:${cancelledWikiId}`);
	assert.equal(text(cancelledWiki?.summary), "Wiki 更新已取消");
	const failedRunId = "2026-07-31T10-05-00.000Z";
	const failedRunDir = runRecordDir(workspaceDir, goalId, failedRunId);
	mkdirSync(failedRunDir, { recursive: true });
	writeFileSync(join(failedRunDir, "run-state.json"), JSON.stringify({
		schema_version: 2,
		run_id: failedRunId,
		goal_id: goalId,
		question: "失败的 Research",
		status: "failed",
		usage: {},
		started_at: "2026-07-31T10:04:00.000Z",
		updated_at: "2026-07-31T10:05:00.000Z",
		finished_at: "2026-07-31T10:05:00.000Z",
		failure: {
			failure_class: "provider",
			failed_stage: "search_batch_running",
			message: "Prime Search exited with code 1: /Users/maintainer/checkout/server/research/run.ts:42\nError: provider exploded\n    at run (/Users/maintainer/checkout/server/research/run.ts:42:7)",
		},
	}), "utf8");
	const failedResearch = service.getGoal(goalId).history.items
		.find((item) => item.activityId === `research:${failedRunId}`);
	assert.equal(text(failedResearch?.summary), "研究失败，原因见失败的执行阶段");
	// A model Provider's rejection is a fact the user acts on (top up or switch models), so the summary states it.
	const providerFailedRunId = "2026-07-31T10-06-00.000Z";
	const providerFailedRunDir = runRecordDir(workspaceDir, goalId, providerFailedRunId);
	mkdirSync(providerFailedRunDir, { recursive: true });
	writeFileSync(join(providerFailedRunDir, "run-state.json"), JSON.stringify({
		schema_version: 2,
		run_id: providerFailedRunId,
		goal_id: goalId,
		question: "余额不足的 Research",
		status: "failed",
		usage: {},
		started_at: "2026-07-31T10:05:30.000Z",
		updated_at: "2026-07-31T10:06:00.000Z",
		finished_at: "2026-07-31T10:06:00.000Z",
		failure: {
			failure_class: "runtime_invariant",
			failed_stage: "chapters_writing",
			message: "Report Root model call failed: 402: {\"message\":\"Insufficient Balance\",\"type\":\"unknown_error\",\"param\":null,\"code\":\"invalid_request_error\"}",
		},
	}), "utf8");
	const providerFailedResearch = service.getGoal(goalId).history.items
		.find((item) => item.activityId === `research:${providerFailedRunId}`);
	assert.equal(text(providerFailedResearch?.summary), "研究失败 · 模型服务返回错误（HTTP 402）：Insufficient Balance");
	for (const item of [failedWiki!, cancelledWiki!, failedResearch!, providerFailedResearch!]) {
		assert.doesNotMatch(text(item.summary), /[/\\]|\d+:\d+|exited with code|Error|Node\.js/u,
			"a user-facing summary carries no runtime diagnostics, path shape or source position");
	}

	const firstLiveWorker = liveResearch?.steps
		.flatMap((step) => step.agentActivities)
		.find((agent) => agent.agentName === "prime_search");
	assert.ok(firstLiveWorker);
	assert.match(text(firstLiveWorker.summary), /^正在使用 Github Search/u);
	assert.ok(
		Date.parse(firstLiveWorker.timing.updatedAt) >= Date.parse(firstLiveWorker.timing.startedAt!),
		"a running Agent Activity must not end before it starts",
	);
	appendRuntimeContext(liveRunDir, "research", {
		type: "runtime.agent_bound",
		stage_id: "prime-search-job:1:huggingface",
		execution_id: "live-worker-2",
		agent: "prime_search",
		created_at: "2026-07-31T09:02:10.000Z",
	});
	const afterWorkerStart = service.getGoal(goalId);
	assert.notEqual(
		afterWorkerStart.revision,
		first.revision,
		"starting another Worker must invalidate the Activity projection",
	);
	const liveWorkerActivity = afterWorkerStart.liveActivities.find(
		(item) => item.activityId === `research:${liveRunId}`,
	);
	appendResearchNodeRecord(liveRunDir, {
		node_id: "prime-search-job:1:huggingface",
		node_type: "agent",
		agent: "prime_search",
		execution_id: "live-worker-2",
		status: "succeeded",
		group_id: "search-batch-live",
		depends_on: [1],
		input: {},
		output: { metrics: { model_calls: 2, tool_calls: 3 } },
		time: {
			started_at: "2026-07-31T09:02:00.000Z",
			finished_at: "2026-07-31T09:03:00.000Z",
			duration_ms: 60_000,
		},
	});
	const afterWorkerFinish = service.getGoal(goalId);
	assert.notEqual(
		afterWorkerFinish.revision,
		afterWorkerStart.revision,
		"finishing a Worker must invalidate the Activity projection",
	);
	const serialized = JSON.stringify(first);
	assert.doesNotMatch(serialized, /privatePrompt|must not reach|trace_ref|jsonlPath|system.prompt/u);
	assert.doesNotMatch(serialized, /已形成检索计划/u, "Projection must not inline Agent output");

	const outputRef = research.steps[0]!.agentActivities[0]!.outputRef;
	assert.ok(outputRef);
	const output = service.readOutput(goalId, outputRef);
	assert.ok(output);
	assert.deepEqual(output.lines.map((item) => item.sequence), [1, 2, 3, 4, 5, 6], "the execution record shows every entry of the session");
	assert.deepEqual(output.lines.map((item) => item.kind), [
		"thinking", "tool", "thinking", "tool", "thinking", "tool",
	]);
	assert.equal(output.lines[1]?.toolName, "search_general_web");
	assert.equal(output.lines[1]?.toolOutput, "first result");
	assert.deepEqual(output.lines[3]?.toolInput, { path: "report.md", apiKey: "[REDACTED]" });
	assert.match(JSON.stringify(output), /整理结果|wrote report\.md|submitted/u);
	assert.doesNotMatch(JSON.stringify(output), /private user prompt|must-not-leak/u);
	assert.equal(service.readOutput("goal_other", outputRef), null, "outputRef must be Goal scoped");
	let generation: { startedAt: string; failedAt?: string; error?: string } | undefined = { startedAt: "2026-07-31T10:00:00.000Z" };
	const topicProjection = new TopicPlanActivityProjection({ workspaceDir, readTopicPlanGeneration: () => generation });
	const generating = topicProjection.project(goalId)[0]!.items;
	assert.equal(generating.length, 1);
	assert.equal(generating[0]?.lifecycle, "running");
	assert.equal(generating[0]?.timing.startedAt, generation.startedAt);
	generation = undefined;
	assert.deepEqual(topicProjection.project(goalId)[0]!.items, [], "completed generation must not leave a running Activity");
	// A Provider that rejects the model ends the generation as a visible failure carrying its words.
	generation = { startedAt: "2026-07-31T10:00:00.000Z", failedAt: "2026-07-31T10:00:05.000Z", error: "Codex error: The 'retired-model' model is not supported" };
	const failedGeneration = topicProjection.project(goalId)[0]!.items;
	assert.equal(failedGeneration.length, 1);
	assert.equal(failedGeneration[0]?.lifecycle, "finished");
	assert.equal(failedGeneration[0]?.outcome, "failed");
	assert.equal(failedGeneration[0]?.timing.finishedAt, generation.failedAt);
	assert.match(JSON.stringify(failedGeneration[0]?.summary), /retired-model/u);
	generation = undefined;
	const topicProposal = new GoalTopicPlanStore(goalId, workspaceDir).proposePatch({
		source: "main_agent",
		patch: {
			schema_version: 1,
			base_revision: null,
			summary: "建立初始 Topic Plan",
			operations: [{ op: "add", topic: {
				id: "research-focus", title: "Research Focus", intent: "Track the Goal focus",
				questions: [], include: [], exclude: [],
			} }],
		},
	});
	generation = { startedAt: "2026-07-31T10:00:00.000Z" };
	assert.equal(topicProjection.project(goalId)[0]!.items.length, 1, "the pending proposal replaces the generating Activity");
	assert.equal(topicProjection.project(goalId)[0]!.items[0]?.lifecycle, "waiting");
	generation = undefined;
	const pendingTopicActivity = service.getGoal(goalId).liveActivities
		.find((item) => item.activityId === `topic-plan:${topicProposal.proposal_id}`);
	assert.equal(pendingTopicActivity?.lifecycle, "waiting");
	assert.equal(pendingTopicActivity?.waiting?.kind, "decision");
	assert.ok(pendingTopicActivity?.waiting?.reason);
	assert.equal(pendingTopicActivity?.attention?.actions[0]?.href, `/chat/${goalId}#topic-plan-proposal`);
	assert.equal(text(pendingTopicActivity?.summary), "1 个长期关注方向等待确认");
	const confirmedTopicProposal = new GoalTopicPlanStore(goalId, workspaceDir).reviseProposal(
		topicProposal.proposal_id,
		{
			source: "main_agent",
			patch: {
				schema_version: 1,
				base_revision: topicProposal.candidate_plan.revision,
				summary: "Confirm the refined Topic Plan",
				operations: [{
					op: "update",
					topic_id: "research-focus",
					set: { intent: "Track the confirmed Goal focus" },
				}],
			},
		},
	);
	const confirmedTopicStore = new GoalTopicPlanStore(goalId, workspaceDir);
	confirmedTopicStore.activate(confirmedTopicProposal.proposal_id);
	const activeTopicPlan = confirmedTopicStore.readActive()!;
	confirmedTopicStore.submitDiscovery({
		schema_version: 1,
		id: "discovery_activity_separation",
		goal_id: goalId,
		topic_plan_revision: activeTopicPlan.revision,
		finding: "This candidate belongs in Discovery Inbox, not Activity.",
		run_id: "run-activity",
		source_id: "source-activity",
		section_index: 0,
		cue_index: 0,
		cue: "Activity separation",
		note: "Discovery remains outside the Activity stream.",
		evidence: [{ source_path: "document.md", start_line: 1, end_line: 2, content_sha256: "a".repeat(64) }],
		status: "open",
		created_at: new Date().toISOString(),
	});
	assert.equal(
		service.getGoal(goalId).liveActivities.some((item) => item.sourceRef.startsWith("discovery:")),
		false,
		"Discovery Inbox candidates must not be duplicated in Activity",
	);
	confirmedTopicStore.recordReframe(confirmedTopicProposal.proposal_id, {
		status: "no_wiki",
		updated_at: new Date().toISOString(),
	});
	const confirmedTopicHistory = service.getGoal(goalId).history.items
		.filter((item) => item.kind === "topic-plan");
	assert.deepEqual(
		confirmedTopicHistory.map((item) => item.activityId),
		[`topic-plan:${confirmedTopicProposal.proposal_id}`],
		"Topic Plan history must contain confirmed snapshots, not superseded drafts",
	);
	assert.equal(text(confirmedTopicHistory[0]?.title), "确认 Goal Topic Plan");
	assert.equal(text(confirmedTopicHistory[0]?.summary), "已确认 1 个长期关注方向");
	assert.doesNotMatch(text(confirmedTopicHistory[0]?.summary), /Confirm the refined|没有.*Wiki/u);
	const interruptedStatePath = join(interruptedRunDir, "run-state.json");
	const interruptedState = readFileSync(interruptedStatePath, "utf8");
	writeFileSync(interruptedStatePath, JSON.stringify({ ...JSON.parse(interruptedState), workflow_version: 1 }));
	const unsupportedResearch = service.getGoal(goalId).liveActivities.find((item) => item.activityId === `research:${interruptedRunId}`);
	assert.ok(unsupportedResearch, "Unsupported interrupted Research remains visible");
	assert.equal(unsupportedResearch.attention?.actions.some((action) => action.actionId === `resume:${interruptedRunId}`) ?? false, false,
		"Unsupported checkpoints must not offer Research resume");
	assert.equal(unsupportedResearch.attention?.actions.some((action) => action.actionId === `resume-wiki:${interruptedRunId}`) ?? false, false,
		"Old Run-directory Wiki jobs must not offer a recovery action");
	writeFileSync(interruptedStatePath, interruptedState);

	appendResearchNodeRecord(liveRunDir, {
		node_id: "cornell-note", node_type: "agent", agent: "cornell_note",
		execution_id: "resumed-cornell", attempt: 2, status: "succeeded", group_id: null,
		depends_on: [], input: {}, output: {},
		time: { started_at: "2026-07-31T09:03:00.000Z", finished_at: "2026-07-31T09:04:00.000Z", duration_ms: 60_000 },
	});
	appendResearchNodeRecord(liveRunDir, {
		node_id: "workspace-run", node_type: "runtime", status: "failed", group_id: null,
		depends_on: [], input: {}, output: {},
		time: { started_at: "2026-07-31T09:00:00.000Z", finished_at: "2026-07-31T09:04:00.000Z", duration_ms: 240_000 },
	});
	const resumedSteps = service.getGoal(goalId).liveActivities.find((item) => item.activityId === `research:${liveRunId}`)?.steps ?? [];
	assert.deepEqual(resumedSteps.filter((step) => text(step.title) === "Cornell Note").map((step) => step.executionRound), [1, 2],
		"same Agent retried after Run resume must not swallow the historical execution");

	assert.equal(resumedSteps.find((step) => text(step.title) === "完成本次研究")?.executionRound, 2,
		"Run-wide terminal records belong to the execution that finished them, not the original start");

	const unavailableWorkspace = join(workspaceDir, "not-a-directory");
	writeFileSync(unavailableWorkspace, "occupied");
	const resilientService = createActivityProjection({
		workspaceDir: unavailableWorkspace,
		listGoalIds: () => [goalId],
	});
	assert.doesNotThrow(() => resilientService.getGoal(goalId),
		"Schedule storage failure must not hide unrelated Goal activity");

	assert.throws(() => service.getGoal(goalId, "invalid"), /Invalid activity history cursor/u);
	const failedPodcasts = createActivityProjection({
		workspaceDir, listGoalIds: () => [goalId],
		listPodcastActivities: () => [{
			id: "podcast-failed", goalId, kind: "podcast", agent: "Podcast AI",
			action: "生成播客失败", detail: "语音服务暂不可用", status: "error", updatedAt: Date.now(),
		}],
	}).getGoal(goalId).history.items.find((item) => item.kind === "podcast");
	// A record that cannot name its report has no retry, yet its failure can still be settled.
	assert.deepEqual(failedPodcasts?.attention?.actions, []);
	assert.equal(failedPodcasts?.attention?.dismiss?.href, `/api/goals/${goalId}/events/activity-projection/dismissals`,
		"a failure nothing can retry must still be dismissible");
	const global = service.getGlobalSummary();
	assert.equal(global.schemaVersion, 2, "the Activity Text wire shape carries its own schema version");
	console.log("activity projection tests passed");
} finally {
	rmSync(workspaceDir, { recursive: true, force: true });
}
