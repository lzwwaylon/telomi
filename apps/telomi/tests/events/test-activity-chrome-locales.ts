import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { chrome, type ActivityMessage } from "../../shared/events/activity-text.js";
import type { ActivityStep, ActivityText, AgentActivity } from "../../shared/events/activity-projection.js";
import { stageTitle } from "../../server/events/projection-helpers.js";
import { mainAgentProjection } from "../../server/main-agent/activity-projection.js";
import { ObservabilityActivityProjection } from "../../server/observability/activity-projection.js";
import { WikiActivityProjection } from "../../server/wiki/activity-projection.js";
import { MAX_WIKI_UPDATE_ATTEMPTS, WikiUpdateJobStore, WIKI_UPDATE_JOB_FILE } from "../../server/wiki/wiki-update-job.js";
import { wikiUpdateRecordDir } from "../../server/wiki/update-runner.js";
import i18n from "../../web/src/app/i18n.js";
import { activityText } from "../../web/src/shared/lib/activity-text.js";
import { groupActivitySteps } from "../../web/src/features/goals/activity-step-groups.js";

const CHINESE = /[一-鿿]/u;
const en = () => i18n.changeLanguage("en");
const zh = () => i18n.changeLanguage("zh-CN");
const render = (value: ActivityText) => activityText(value);

// Every projected part is either a registered message id or explicit content; nothing renders as an object.
function assertRendered(value: ActivityText, where: string): string {
	const text = render(value);
	assert.doesNotMatch(text, /\[object Object\]|\{\{/u, `${where} rendered an unresolved value: ${text}`);
	return text;
}

// A Runtime Stage shows what it achieves, and an unknown internal Stage never shows its machine name.
await en();
assert.equal(render(stageTitle("input-resolution")), "Prepare research input");
assert.equal(render(stageTitle("final-runtime-gate")), "Check the research result");
assert.equal(render(stageTitle("workspace-run")), "Complete the research run");
assert.equal(render(stageTitle("writer-report")), "Write the report");
assert.equal(render(stageTitle("report_writer")), "Write the report");
assert.equal(render(stageTitle("prime-search-batch-2")), "Prime Search batch 2");
assert.equal(render(stageTitle("search-batch-3")), "Prime Search batch 3");
assert.equal(render(stageTitle("cornell-note-0046-source_fd0013")), "Cornell Note 0046 · source_fd0013");
assert.equal(render(stageTitle("cornell-note")), "Cornell Note");
assert.equal(render(stageTitle("evidence-screening-source-a")), "Internal step");
await zh();
assert.equal(render(stageTitle("input-resolution")), "准备研究输入");
assert.equal(render(stageTitle("final-runtime-gate")), "检查研究结果");
assert.equal(render(stageTitle("evidence-screening-source-a")), "内部步骤");
assert.equal(render(stageTitle("prime-search-batch-2")), "Prime Search 第 2 批");

// Counted chrome reads correctly for 0, 1 and many in both locales.
await en();
assert.equal(render(chrome("activityChrome.usage.modelCalls", { count: 1 })), "Model calls: 1");
assert.equal(render(chrome("activityChrome.usage.toolCalls", { count: 0 })), "Tool calls: 0");
assert.equal(render(chrome("activityChrome.step.parallel", { count: 1 })), "1 Activity Step in parallel");
assert.equal(render(chrome("activityChrome.step.parallel", { count: 4 })), "4 Activity Steps in parallel");
assert.equal(render(chrome("activityChrome.research.sourceNoteFailures", { count: 1 })), "1 Source Note failed");
assert.equal(render(chrome("activityChrome.research.sourceNoteFailures", { count: 3 })), "3 Source Notes failed");
assert.equal(
	render(chrome("activityChrome.topicPlan.confirmed", { count: 1 })),
	"Confirmed 1 long-term focus area",
);
// The Activity Step count in a detail header reads the same way for one Step and for many.
assert.equal(i18n.t("goalActivity.stepCount", { count: 1 }), "1 step");
assert.equal(i18n.t("goalActivity.stepCount", { count: 51 }), "51 steps");
await zh();
assert.equal(render(chrome("activityChrome.step.parallel", { count: 4 })), "并行执行 4 个步骤");
assert.equal(render(chrome("activityChrome.usage.modelCalls", { count: 556 })), "556 次模型调用");
assert.equal(render(chrome("activityChrome.research.sourceNoteFailures", { count: 1 })), "1 个 Source Note 失败");
assert.equal(i18n.t("goalActivity.stepCount", { count: 1 }), "1 个步骤");

// Composed chrome joins its parts in projection order, and content keeps its own language.
await en();
const composed: ActivityMessage[] = [
	...chrome("activityChrome.research.published"),
	...chrome("activityChrome.usage.modelCalls", { count: 556 }),
	{ text: "上游返回 500" },
];
assert.equal(assertRendered(composed, "composed summary"), "Research report published · Model calls: 556 · 上游返回 500");
assert.equal(render("检索并核验 2026 年发布的 TTS 模型"), "检索并核验 2026 年发布的 TTS 模型");

// A failed Podcast keeps its upstream diagnostic in the detail view only; home surfaces stay bounded.
const stack = "Error: TTS provider rejected the script\n    at /Users/host/telomi/server/media/products-api.ts:120:9";
const podcastItem = (detail: string, status: "error" | "done") => mainAgentProjection(() => [{
	id: `podcast_${status}`,
	goalId: "goal_locale",
	kind: "podcast" as const,
	agent: "Podcast AI",
	action: status === "error" ? "生成播客失败" : "播客生成完成",
	status,
	detail,
	updatedAt: Date.parse("2026-09-16T12:00:00.000Z"),
	startedAt: Date.parse("2026-09-16T11:59:00.000Z"),
}])("goal_locale")[0]!.items[0]!;

const failedPodcast = podcastItem(stack, "error");
assert.equal(assertRendered(failedPodcast.title, "podcast title"), "Generate Podcast");
for (const [where, value] of [
	["summary", failedPodcast.summary],
	["attention summary", failedPodcast.attention!.summary],
] as const) {
	const text = assertRendered(value, `failed podcast ${where}`);
	assert.equal(text, "Podcast generation failed");
	assert.doesNotMatch(text, /[/\\]|Error:|products-api/u, `a home surface must not carry the raw diagnostic: ${text}`);
	assert.doesNotMatch(text, CHINESE, `English UI must not keep Runtime Chinese: ${text}`);
}
assert.ok(
	assertRendered(failedPodcast.steps[0]!.summary, "failed podcast step").includes(stack),
	"the detailed failure view keeps the upstream diagnostic",
);

// A completed Podcast recorded its detail as Runtime chrome, so the English UI must not replay it.
const donePodcast = podcastItem("TTS 模型清单播客 · 文稿模型 gpt-5", "done");
for (const [where, value] of [
	["summary", donePodcast.summary],
	["step summary", donePodcast.steps[0]!.summary],
] as const) {
	const text = assertRendered(value, `completed podcast ${where}`);
	assert.equal(text, "Podcast generated");
	assert.doesNotMatch(text, CHINESE, `English UI must not keep Runtime Chinese: ${text}`);
}
await zh();
assert.equal(render(donePodcast.summary), "Podcast 已生成");

// An interrupted or partial Wiki update stores fixed Chinese in its Job record; the UI renders facts.
const workspaceDir = mkdtempSync(join(tmpdir(), "telomi-activity-chrome-"));
const goalId = "goal_locale";
const topicPlan = {
	schema_version: 1 as const,
	goal_id: goalId,
	revision: "topic-plan-locale",
	status: "active" as const,
	topics: [{ id: "focus", title: "Focus", intent: "Track the Goal focus", questions: [], include: [], exclude: [] }],
};
const startJob = (wikiUpdateId: string, attempts = 1) => {
	const controlDirectory = wikiUpdateRecordDir(workspaceDir, goalId, wikiUpdateId);
	mkdirSync(controlDirectory, { recursive: true });
	const jobs = new WikiUpdateJobStore(controlDirectory);
	for (let attempt = 0; attempt < attempts; attempt += 1) {
		jobs.start({
			goalId,
			runId: wikiUpdateId,
			wikiUpdateId,
			goal: "Wiki 更新",
			goalContext: { title: "Goal title", description: "Goal description" },
			topicPlan,
			cornellNotes: { relative_path: "artifacts/cornell-notes/evidence.json", sha256: "a".repeat(64), byte_length: 12 },
		});
	}
	return { controlDirectory, jobs };
};
const interrupted = startJob("wiki_interrupted");
interrupted.jobs.markInterrupted(new Date("2026-09-16T12:10:00.000Z"));
const partial = startJob("wiki_partial");
partial.jobs.settle("partial", {
	message: "Wiki 已发布，但 1 个 Source 批次失败。",
	publicationStatus: "promoted",
	failedBatches: [{
		batch_index: 0,
		source_ids: ["source_a", "source_b"],
		message: "Wiki Curator rejected the Workset",
		usage: { input_tokens: 1, output_tokens: 1, cost_usd: 0, model_calls: 1 },
	}],
	now: new Date("2026-09-16T12:11:00.000Z"),
});
// Past the resume limit the action is disabled, so the interruption stops being attention: nothing
// the user can still do remains, and it keeps reporting the interruption as a waiting Outcome.
const exhausted = startJob("wiki_exhausted", MAX_WIKI_UPDATE_ATTEMPTS);
exhausted.jobs.markInterrupted(new Date("2026-09-16T12:12:00.000Z"));
// Both stored sentences are fixed Runtime copy, not content: they stay in the Job record for diagnosis.
for (const { controlDirectory } of [interrupted, partial]) {
	assert.match(readFileSync(join(controlDirectory, WIKI_UPDATE_JOB_FILE), "utf8"), CHINESE);
}

const wikiItems = new WikiActivityProjection({ workspaceDir }, new ObservabilityActivityProjection())
	.project(goalId)[0]!.items;
const interruptedItem = wikiItems.find((item) => item.sourceRef === "wiki-update:wiki_interrupted")!;
const partialItem = wikiItems.find((item) => item.sourceRef === "wiki-update:wiki_partial")!;
await en();
assert.equal(assertRendered(interruptedItem.title, "wiki title"), "Update Goal Wiki");
assert.equal(
	assertRendered(interruptedItem.summary, "interrupted wiki summary"),
	"The Wiki update was interrupted and can continue",
);
assert.equal(
	assertRendered(interruptedItem.waiting!.reason, "interrupted wiki waiting reason"),
	"The Wiki update was interrupted because the backend stopped",
);
assert.equal(
	assertRendered(interruptedItem.attention!.summary, "interrupted wiki attention"),
	"The Wiki update saved a batch checkpoint and can continue.",
);
assert.equal(
	assertRendered(interruptedItem.waiting!.actions[0]!.label, "resume action label"),
	"Continue Wiki update",
);
assert.equal(
	assertRendered(partialItem.summary, "partial wiki summary"),
	"Goal Wiki partially updated · Unprocessed batches: 1 · Unprocessed Sources: 2",
);
// A partial Wiki has nothing left to resume, so it reports an Outcome and never an attention the
// user could neither act on nor clear. The unprocessed counts stay in the summary above.
assert.equal(partialItem.attention, undefined, "a partial Wiki update must not raise attention");
const exhaustedItem = wikiItems.find((item) => item.sourceRef === "wiki-update:wiki_exhausted")!;
assert.equal(exhaustedItem.attention, undefined, "an interruption past the resume limit must not raise attention");
assert.equal(exhaustedItem.waiting?.actions[0]?.enabled, false, "the spent resume action stays visible as waiting");
for (const value of [
	interruptedItem.summary,
	interruptedItem.waiting!.reason,
	interruptedItem.attention!.summary,
	partialItem.summary,
	partialItem.resultLinks[0]!.label,
]) {
	assert.doesNotMatch(render(value), CHINESE, `English UI must not keep Runtime Chinese: ${render(value)}`);
}
await zh();
assert.equal(render(interruptedItem.summary), "Wiki 更新已中断，可以继续运行");
assert.equal(render(partialItem.summary), "Goal Wiki 已部分更新 · 1 个批次未处理 · 2 个 Source 未处理");
assert.equal(render(partialItem.resultLinks[0]!.label), "打开 Wiki");

// Grouping carries message ids, so the same grouped result follows a later uiLocale change.
const agent = (id: string, name: string): AgentActivity => ({
	agentActivityId: id,
	agentName: name,
	summary: chrome("activityChrome.usage.modelCalls", { count: 2 }),
	lifecycle: "finished",
	outcome: "succeeded",
	timing: { createdAt: "2026-09-16T12:00:00.000Z", updatedAt: "2026-09-16T12:00:00.000Z" },
	outputRef: `output:${id}`,
	attempts: [],
});
const step = (id: string, activity: AgentActivity): ActivityStep => ({
	stepId: id,
	title: stageTitle("cornell-note-1-source_a"),
	summary: chrome("activityChrome.usage.modelCalls", { count: 2 }),
	lifecycle: "finished",
	outcome: "succeeded",
	timing: { createdAt: "2026-09-16T12:00:00.000Z", updatedAt: "2026-09-16T12:00:00.000Z" },
	dependsOnStepIds: [],
	parallelSteps: [],
	agentActivities: [activity],
});
const groups = groupActivitySteps([
	step("note:a", agent("cornell:a", "cornell_note")),
	step("wiki-batch:1", agent("wiki:1", "wiki_maintainer")),
]);
const pools = groups.flatMap((group) => group.entries.flatMap((entry) => entry.kind === "worker-pool" ? [entry] : []));
assert.equal(pools.length, 2);
await en();
assert.deepEqual(groups.map((group) => render(group.label)), ["Execution phase", "SHARD organization"]);
assert.deepEqual(pools.map((pool) => render(pool.label)), ["Cornell Note", "Wiki workers"]);
assert.equal(render(pools[0]!.workers[0]!.title), "Cornell Note 1 · source_a");
await zh();
assert.deepEqual(groups.map((group) => render(group.label)), ["执行阶段", "SHARD 整理"]);
assert.deepEqual(pools.map((pool) => render(pool.label)), ["Cornell Note", "Wiki Worker"]);

// A failed Stage says why on the Stage itself; a Provider's HTTP error reads as its status and its
// own words in either locale, and Stages the failure was relayed to do not repeat it.
const providerFailure = "Report Root model call failed: 402: {\"message\":\"Insufficient Balance\",\"type\":\"unknown_error\"}";
const failedNode = (eventId: number, nodeId: string, error: string) => ({
	event_id: eventId, node_id: nodeId, node_type: "runtime" as const, status: "failed" as const,
	depends_on: eventId > 1 ? [eventId - 1] : [], input: {}, output: { error },
	time: { started_at: "2026-09-16T12:00:00.000Z", finished_at: "2026-09-16T12:01:00.000Z", duration_ms: 60_000 },
});
const failedStages = new ObservabilityActivityProjection().fromNodes("goal_locale", "run", workspaceDir, [
	failedNode(1, "writer-report", providerFailure),
	failedNode(2, "final-runtime-gate", providerFailure),
	failedNode(3, "workspace-run", "Final gate halted: trace integrity"),
]);
await en();
assert.deepEqual(failedStages.map((failed) => render(failed.summary)), [
	"The model provider returned an error (HTTP 402): Insufficient Balance",
	"Failed",
	"Final gate halted: trace integrity",
]);
await zh();
assert.equal(render(failedStages[0]!.summary), "模型服务返回错误（HTTP 402）：Insufficient Balance");

console.log("Activity chrome locale rendering test passed");
