import assert from "node:assert/strict";
import React, { type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { ActivityOutput, ActivityProjection, ActivityProjectionItem, ActivityStep } from "../../shared/events/activity-projection.js";
import { ActivityReplayContent, findAgentActivity } from "../../web/src/features/goals/GoalActivityDetail.js";
import { GoalActivityPanelView } from "../../web/src/features/goals/GoalActivityPanelView.js";
import { Dialog } from "../../web/src/shared/ui/dialog.js";
import i18n from "../../web/src/app/i18n.js";

await i18n.changeLanguage("zh-CN");

// Local noon keeps each fixture on its calendar day whatever the clock and time zone.
function noon(daysAgo: number): string {
	const date = new Date();
	date.setDate(date.getDate() - daysAgo);
	date.setHours(12, 0, 0, 0);
	return date.toISOString();
}

const scope = { kind: "goal", goalId: "goal_activity" } as const;

function activity(
	fields: Pick<ActivityProjectionItem, "activityId" | "title"> & Partial<ActivityProjectionItem>,
): ActivityProjectionItem {
	const item: ActivityProjectionItem = {
		kind: "research",
		scope,
		trigger: { kind: "manual" },
		summary: `${fields.title} 的摘要`,
		lifecycle: "finished",
		outcome: "succeeded",
		timing: { createdAt: noon(0), updatedAt: noon(0) },
		resultLinks: [],
		steps: [],
		sourceRef: `research:${fields.activityId}`,
		...fields,
	};
	// A running row annotates how long it has been quiet once it passes that threshold, and only
	// otherwise its progress. Local noon is in the past for most of the day, so a running fixture
	// reports just now unless it sets its own timing; without this the same assertions pass in the
	// morning and fail in the afternoon.
	if (item.lifecycle === "running" && !fields.timing) {
		item.timing = { createdAt: noon(0), updatedAt: new Date().toISOString() };
	}
	return item;
}

function projectionOf(
	liveActivities: ActivityProjectionItem[],
	history: ActivityProjection["history"],
	summary: ActivityProjection["summary"] = { attention: 0, running: 0, queued: 0, waiting: 0 },
): ActivityProjection {
	return {
		schemaVersion: 1,
		revision: "rev_1",
		generatedAt: noon(0),
		scope,
		freshness: [],
		summary,
		liveActivities,
		history,
	};
}

const projection = projectionOf(
	[activity({
		activityId: "run_live",
		title: "调研中文流式 TTS",
		lifecycle: "running",
		outcome: undefined,
		progress: { completed: 2, total: 5 },
	})],
	{
		items: [
			activity({ activityId: "podcast_old", kind: "podcast", title: "生成声码器播客", timing: { createdAt: noon(2), updatedAt: noon(2) } }),
			activity({ activityId: "wiki_done", kind: "wiki-update", title: "更新语音 Wiki", sourceRef: "wiki:wiki_done" }),
			activity({
				activityId: "plan_attention",
				kind: "topic-plan",
				title: "确认主题计划",
				outcome: "partial",
				timing: { createdAt: noon(1), updatedAt: noon(1) },
				attention: {
					kind: "decision",
					summary: "选择一个方向",
					actions: ["选择方向", "查看候选"].map((label, index) => ({
						actionId: `action_${index}`,
						kind: "decision" as const,
						label,
						enabled: true,
						requiresConfirmation: false,
					})),
				},
			}),
		],
		nextCursor: "cursor_1",
	},
	{ attention: 1, running: 1, queued: 0, waiting: 0 },
);

function render(props: Partial<ComponentProps<typeof GoalActivityPanelView>> = {}): string {
	return renderToStaticMarkup(
		<GoalActivityPanelView
			projection={projection}
			connection="connected"
			error={null}
			loading={false}
			loadingMore={false}
			onLoadMore={() => undefined}
			liveAgentOutputs={new Map()}
			selectedActivityId={null}
			onSelectActivity={() => undefined}
			{...props}
		/>,
	);
}

const rowCount = (markup: string) => (markup.match(/data-testid="activity-row"/gu) ?? []).length;
// Row titles and divider labels in document order; dividers are prefixed with "--".
const timeline = (markup: string) => [...markup.matchAll(/title="([^"]+)"|data-testid="activity-timeline-divider"><span>([^<]+)/gu)]
	.map((match) => match[1] ?? `-- ${match[2]}`);

const connected = render();
assert.equal(rowCount(connected), 4);
assert.match(connected, /1 需处理/u);
assert.match(connected, /1 运行中/u);
assert.match(connected, />2\/5</u);
assert.match(connected, />2 项操作</u);
assert.match(connected, />Wiki 更新</u);
assert.match(connected, />Podcast</u);
const connectedTimeline = timeline(connected);
assert.deepEqual(connectedTimeline.slice(0, 5), ["调研中文流式 TTS", "确认主题计划", "-- 今天", "更新语音 Wiki", connectedTimeline[4]]);
assert.match(connectedTimeline[4]!, /^-- /u);
assert.deepEqual(connectedTimeline.slice(5), ["生成声码器播客"]);
// The older row sits under its day divider, so its time omits the date the divider already shows.
assert.match(connected, /<time[^>]*>12:00<\/time>/u);
assert.doesNotMatch(connected, /的摘要/u);
assert.doesNotMatch(connected, /实时 Activity|历史 Activity|活动概览|当前无运行/u);
assert.doesNotMatch(connected, /aria-expanded|data-testid="activity-detail"/u);
assert.match(connected, /加载更早记录/u);
assert.doesNotMatch(connected, /role="alert"/u);

const quiet = render({
	projection: projectionOf([], { items: [activity({ activityId: "wiki_done", kind: "wiki-update", title: "更新语音 Wiki" })] }),
});
assert.doesNotMatch(quiet, /\d+ 需处理|\d+ 运行中/u);
assert.equal(rowCount(quiet), 1);
assert.doesNotMatch(quiet, /加载更早记录/u);

const disconnected = render({ connection: "disconnected" });
assert.match(disconnected, /role="alert">后端连接已断开，实时状态已暂停/u);
assert.doesNotMatch(disconnected, /调研中文流式 TTS/u);
assert.doesNotMatch(disconnected, /\d+ 需处理|\d+ 运行中/u);
assert.match(disconnected, /更新语音 Wiki/u);

const failed = render({ connection: "disconnected", error: "读取 Activity 失败" });
assert.match(failed, /role="alert">读取 Activity 失败</u);
assert.doesNotMatch(failed, /实时状态已暂停/u);

const empty = render({ projection: projectionOf([], { items: [] }) });
assert.equal(rowCount(empty), 0);
assert.match(empty, /还没有 Activity/u);
assert.doesNotMatch(empty, /加载更早记录/u);

const loading = render({ projection: null, loading: true });
assert.match(loading, /正在读取活动…/u);

const at = { createdAt: noon(0), updatedAt: noon(0) };
function noteStep(id: string, lifecycle: ActivityStep["lifecycle"], outcome?: ActivityStep["outcome"]): ActivityStep {
	return {
		stepId: `note:${id}`,
		title: `笔记 ${id}`,
		summary: "",
		lifecycle,
		outcome,
		timing: at,
		dependsOnStepIds: [],
		parallelSteps: [],
		agentActivities: [{
			agentActivityId: `agent_${id}`,
			agentName: "cornell_note",
			summary: `整理 ${id}`,
			lifecycle,
			outcome,
			timing: at,
			outputRef: `output:${id}`,
			attempts: [],
		}],
	};
}

// A running Agent Activity receives a different ID when its execution record is projected.
const liveReplayStep = noteStep("replay", "running");
const completedReplayStep = noteStep("replay", "finished", "succeeded");
completedReplayStep.stepId = "node:42";
completedReplayStep.agentActivities[0]!.agentActivityId = "agent:42";
const selectedOutput = liveReplayStep.agentActivities[0]!.outputRef!;
assert.equal(findAgentActivity([liveReplayStep], selectedOutput)?.agent.lifecycle, "running");
assert.equal(findAgentActivity([{ ...noteStep("parent", "finished"), parallelSteps: [completedReplayStep] }], selectedOutput)?.agent.lifecycle, "finished",
	"an open replay must follow its stable output reference and stop polling after completion");
assert.equal(findAgentActivity([noteStep("next-attempt", "running")], selectedOutput), undefined,
	"a new execution must not replace the selected replay");

const searchAgent = (id: string) => ({ ...noteStep(id, "finished", "succeeded").agentActivities[0]!, agentName: "prime_search" });

const detailProjection = projectionOf(
	[
		activity({
			activityId: "research_detail",
			title: "调研声码器方案",
			summary: "正在对比三种声码器的延迟与音质。",
			lifecycle: "running",
			outcome: undefined,
			progress: { completed: 2, total: 5 },
			attention: {
				kind: "decision",
				summary: "需要确认是否扩大检索范围",
				actions: [
					{ actionId: "continue", kind: "continue", label: "继续调研", enabled: true, requiresConfirmation: true, href: "/api/research/continue" },
					{ actionId: "open", kind: "open", label: "打开计划", enabled: true, requiresConfirmation: false, href: "/goal/plan" },
				],
			},
			resultLinks: [{ kind: "report", label: "声码器对比报告", href: "/api/files/report.md", available: true, primary: true }],
			steps: [
				{ ...noteStep("plan", "finished", "succeeded"), stepId: "plan", title: "制定检索计划", agentActivities: [searchAgent("plan")] },
				{ ...noteStep("compare", "finished", "succeeded"), stepId: "compare", title: "对比方案", agentActivities: [searchAgent("a"), searchAgent("b")] },
				{
					...noteStep("notes", "running"),
					stepId: "notes",
					title: "整理笔记",
					agentActivities: [],
					parallelSteps: [
						noteStep("1", "running"),
						noteStep("2", "running"),
						noteStep("3", "queued"),
						noteStep("4", "finished", "failed"),
						noteStep("5", "finished", "succeeded"),
						noteStep("6", "finished", "succeeded"),
					],
				},
			],
		}),
		activity({ activityId: "research_live", title: "检索流式 TTS", lifecycle: "running", outcome: undefined, sourceRef: "research:run_live" }),
	],
	{
		items: [
			activity({ activityId: "wiki_quiet", kind: "wiki-update", title: "整理 Wiki", outcome: "no-change" }),
			activity({ activityId: "podcast_cancelled", kind: "podcast", title: "生成播客", outcome: "cancelled" }),
		],
	},
);
// The list stays mounted behind the detail pane, so split the markup at the pane.
const detailPane = (markup: string) => {
	const index = markup.indexOf('data-testid="activity-detail"');
	assert.ok(index >= 0, "missing detail pane");
	return { list: markup.slice(0, index), pane: markup.slice(index) };
};

for (const length of [60, 61]) {
	const title = "研".repeat(59) + "🔎" + (length === 61 ? "究" : "");
	const pane = detailPane(render({
		projection: projectionOf([], { items: [activity({ activityId: "long_title", title, summary: "" })] }),
		selectedActivityId: "long_title",
	})).pane;
	if (length === 61) {
		assert.match(pane, /研🔎…<\/h3>/u, "preview preserves Unicode characters at the cutoff");
		assert.match(pane, /aria-expanded="false"[^>]*aria-controls="[^"]+"[^>]*>展开全文</u);
		assert.doesNotMatch(pane, /🔎究/u, "long title starts collapsed");
	} else {
		assert.ok(pane.includes(title));
		assert.doesNotMatch(pane, /展开全文/u, "short titles need no toggle");
	}
}

const detail = detailPane(render({ projection: detailProjection, selectedActivityId: "research_detail" }));
assert.match(detail.list, /aria-hidden="true"/u);
assert.equal(rowCount(detail.pane), 0);
assert.match(detail.pane, /data-testid="activity-detail-back"/u);
assert.match(detail.pane, /<h3[^>]*>调研声码器方案<\/h3>/u);
assert.match(detail.pane, />运行中</u);
assert.match(detail.pane, /正在对比三种声码器的延迟与音质。/u);
assert.match(detail.pane, /需要确认是否扩大检索范围/u);
assert.match(detail.pane, /<button[^>]*>继续调研<\/button>/u);
assert.match(detail.pane, /<a[^>]*href="\/goal\/plan"[^>]*>打开计划<\/a>/u);
assert.match(detail.pane, /role="progressbar"[^>]*aria-valuenow="2"[^>]*aria-valuemax="5"/u);
assert.match(detail.pane, /制定检索计划/u);
assert.equal((detail.pane.match(/data-testid="activity-worker-pool"/gu) ?? []).length, 1);
// Four active workers fill the default cards, so both completed workers fold behind "view all".
assert.match(detail.pane, /2 运行 · 1 等待 · 2 完成 · 1 异常/u);
assert.equal((detail.pane.match(/data-testid="activity-worker-row"/gu) ?? []).length, 4);
assert.match(detail.pane, /查看全部 6/u);
assert.match(detail.pane, /<a[^>]*href="\/api\/files\/report.md"[^>]*>.*声码器对比报告<\/a>/u);
assert.doesNotMatch(detail.pane, /data-testid="live-agent-stage"/u);
// Activity Steps and workers open their execution record overlay; each Agent of a multi-Agent Step gets its own entry.
assert.match(detail.pane, /aria-haspopup="dialog"[^>]*aria-label="查看 制定检索计划 · Prime Search 的执行记录"/u);
assert.match(detail.pane, /aria-label="查看 对比方案 · Prime Search 1 的执行记录"[^>]*>Prime Search 1</u);
assert.match(detail.pane, /aria-label="查看 对比方案 · Prime Search 2 的执行记录"[^>]*>Prime Search 2</u);
assert.equal((detail.pane.match(/data-testid="activity-worker-row"[^>]*aria-haspopup="dialog"[^>]*aria-label="查看 笔记 \d · Cornell Note 的执行记录"/gu) ?? []).length, 4);
assert.doesNotMatch(detail.pane, /aria-pressed/u);
// Quiet rows share a glyph, so the list labels each by its outcome.
assert.match(detail.list, /aria-label="未产生变更"/u);
assert.match(detail.list, /aria-label="已取消"/u);

const liveDetail = detailPane(render({
	projection: detailProjection,
	selectedActivityId: "research_live",
	liveAgentOutputs: new Map([["run_live", [{
		stageId: "search",
		attemptId: "attempt_1",
		role: "prime_search",
		updatedAt: 1,
		status: "running",
		kind: "text",
		text: "检索中文 TTS 论文",
	}]]]),
}));
assert.match(liveDetail.pane, /data-testid="live-agent-stage"[\s\S]*Prime Search[\s\S]*检索中文 TTS 论文/u);
assert.doesNotMatch(liveDetail.pane, /role="progressbar"/u);

const resumed = activity({
	activityId: "resumed", title: "继续研究", lifecycle: "running", outcome: undefined,
	recovery: { reason: "继续运行", recoveredAt: noon(0), round: 2 },
	steps: [1, 2].map((executionRound) => ({
		stepId: `round-${executionRound}`, title: `步骤 ${executionRound}`, summary: "",
		lifecycle: "finished", outcome: executionRound === 1 ? "failed" : "succeeded",
		timing: { createdAt: noon(0), updatedAt: noon(0) }, executionRound,
		dependsOnStepIds: [], parallelSteps: [], agentActivities: [],
	})),
});
const resumedDetail = detailPane(render({
	projection: projectionOf([resumed], { items: [] }), selectedActivityId: "resumed",
})).pane;
assert.match(resumedDetail, /本次运行（第 2 次）/u);
assert.match(resumedDetail, /第 1 次运行/u);
assert.match(resumedDetail, /1 个步骤/u);
assert.doesNotMatch(resumedDetail, />2\/2</u, "finished historical steps are not a live progress total");

// No-change is quiet in the detail pane, as on its timeline row.
const quietDetail = detailPane(render({ projection: detailProjection, selectedActivityId: "wiki_quiet" }));
assert.match(quietDetail.pane, />未产生变更</u);
assert.match(quietDetail.pane, />Wiki 更新</u);
// The status line names the outcome even where rows share the quiet glyph.
assert.match(detailPane(render({ projection: detailProjection, selectedActivityId: "podcast_cancelled" })).pane, />已取消</u);

const missing = detailPane(render({ selectedActivityId: "gone" }));
assert.match(missing.pane, /data-testid="activity-detail-back"/u);
assert.match(missing.pane, /这条 Activity 已不在当前列表/u);

// The reported case: a Cornell Note pool where one Worker stopped reporting while the others work.
const poolNow = Date.now();
const poolAt = (startedMinutesAgo: number, updatedMinutesAgo: number) => ({
	createdAt: new Date(poolNow - startedMinutesAgo * 60_000).toISOString(),
	startedAt: new Date(poolNow - startedMinutesAgo * 60_000).toISOString(),
	updatedAt: new Date(poolNow - updatedMinutesAgo * 60_000).toISOString(),
});
function poolWorker(id: string, timing: ActivityStep["timing"], lifecycle: ActivityStep["lifecycle"] = "running"): ActivityStep {
	const worker = noteStep(id, lifecycle);
	worker.timing = timing;
	worker.agentActivities[0]!.timing = timing;
	// A real Agent summary runs to the card's limit, and a worker card clips it to one line.
	worker.agentActivities[0]!.summary = `正在使用 Read Source 读取来源 ${id}，${"逐段整理证据与引用".repeat(20)}`;
	return worker;
}
const poolStep: ActivityStep = {
	...noteStep("pool", "running"),
	stepId: "pool",
	title: "整理笔记",
	agentActivities: [],
	parallelSteps: [
		poolWorker("0029", poolAt(39, 31)),
		poolWorker("0030", poolAt(12, 0)),
	],
};
// An ordinary Step row alongside the pool, so both shapes carry the same reading.
const writerStep: ActivityStep = {
	...noteStep("writer", "running"),
	stepId: "writer",
	title: "撰写报告",
	summary: "正在整理章节",
	agentActivities: [],
	timing: poolAt(20, 7),
};
const poolSteps = [poolStep, writerStep];
const poolPane = (lifecycle: ActivityProjectionItem["lifecycle"]) => detailPane(render({
	projection: projectionOf(
		lifecycle === "finished" ? [] : [activity({ activityId: "pool_detail", title: "整理来源笔记", lifecycle, outcome: undefined, steps: poolSteps })],
		lifecycle === "finished"
			? { items: [activity({ activityId: "pool_detail", title: "整理来源笔记", steps: poolSteps })] }
			: { items: [] },
	),
	selectedActivityId: "pool_detail",
})).pane;

const pooled = poolPane("running");
const workerCards = [...pooled.matchAll(/data-testid="activity-worker-row"[\s\S]*?<\/span><\/span>/gu)].map((match) => match[0]!);
assert.equal(workerCards.length, 2);
const quietCard = workerCards.find((card) => card.includes("笔记 0029"));
const busyCard = workerCards.find((card) => card.includes("笔记 0030"));
assert.ok(quietCard && busyCard, "both pooled Workers render");
assert.match(quietCard, /已运行 39 分钟/u, "a pooled Worker shows how long it has been running");
assert.match(quietCard, /已 31 分钟无更新/u, "the Worker that stopped reporting says so on its own card");
assert.match(busyCard, /已运行 12 分钟/u);
assert.doesNotMatch(busyCard, /无更新/u, "a Worker that keeps reporting gets no quiet note");
assert.doesNotMatch(pooled, /失败|异常|超时/u, "the quiet note states silence, it does not claim a failure");
// The card clips its Agent summary to one line, so the reading may not ride along inside it.
for (const card of [quietCard, busyCard]) {
	const summary = /<small>([\s\S]*?)<\/small>/u.exec(card)?.[1] ?? "";
	assert.ok(summary.length > 200, "the fixture keeps a summary long enough to be clipped");
	assert.doesNotMatch(summary, /已运行|无更新/u);
	assert.match(card, /<span class="goal-activity-times">[^<]*已运行/u,
		"elapsed and quiet time render on their own line under the summary");
}

// An ordinary Step row keeps its summary and adds the same reading under it.
assert.match(pooled, /撰写报告<\/b><small>正在整理章节<\/small><span class="goal-activity-times">已运行 20 分钟 · 已 7 分钟无更新<\/span>/u);

// The same Steps under a finished Activity are history: nothing there is still counting.
const pooledHistory = poolPane("finished");
assert.match(pooledHistory, /笔记 0029/u);
assert.doesNotMatch(pooledHistory, /已运行|无更新/u);

const providerNow = Date.now();
const providerStep = (kind: "cooling" | "unavailable" | "fallback"): ActivityStep => ({
	stepId: `provider:${kind}`,
	title: kind === "fallback" ? "改用 Hugging Face Papers" : "arXiv 限流重试",
	summary: "server fallback copy",
	lifecycle: kind === "cooling" ? "running" : "finished",
	...(kind === "cooling" ? {} : { outcome: "partial" as const }),
	timing: { createdAt: new Date(providerNow - 8_000).toISOString(), updatedAt: new Date(providerNow).toISOString() },
	dependsOnStepIds: [], parallelSteps: [], agentActivities: [],
	providerAccess: kind === "cooling" ? {
		kind, providerId: "arxiv", failureClass: "rate_limit",
		waitStartedAt: new Date(providerNow - 8_000).toISOString(),
		budgetDeadlineAt: new Date(providerNow + 52_000).toISOString(),
		nextAttemptAt: new Date(providerNow + 12_000).toISOString(),
	} : kind === "unavailable" ? {
		kind, providerId: "arxiv", reason: "retry_after_exceeds_budget",
	} : {
		kind, providerId: "huggingface", fromProviderId: "arxiv", fallbackOutcome: "succeeded",
	},
});
const providerProjection = projectionOf([activity({
	activityId: "provider_detail", title: "调研论文源回退", lifecycle: "running", outcome: undefined,
	steps: [providerStep("cooling"), providerStep("unavailable"), providerStep("fallback")],
})], { items: [] }, { attention: 0, running: 1, queued: 0, waiting: 0 });
const providerDetail = detailPane(render({ projection: providerProjection, selectedActivityId: "provider_detail" })).pane;
assert.match(providerDetail, /上游限流 · 已等待 \d+ 秒 · 剩余 \d+ 秒 · 下次尝试/u);
assert.match(providerDetail, /arXiv 本轮已停止重试 · 上游等待时间超过本轮重试预算/u);
assert.match(providerDetail, /Hugging Face Papers 已补充 arXiv 未覆盖的论文证据/u);

const recoveredProjection = projectionOf([activity({
	activityId: "recovered_provider", title: "限流恢复", lifecycle: "running", outcome: undefined,
	steps: [{ ...providerStep("cooling"), lifecycle: "finished", outcome: "succeeded",
		providerAccess: { kind: "recovered", providerId: "arxiv" } }],
})], { items: [] });
const recoveredDetail = detailPane(render({ projection: recoveredProjection, selectedActivityId: "recovered_provider" })).pane;
assert.match(recoveredDetail, /arXiv 重试成功，已恢复访问/u);
assert.doesNotMatch(recoveredDetail, /下次尝试|剩余/u);
recoveredProjection.liveActivities[0]!.steps = [{ ...providerStep("cooling"), lifecycle: "finished", outcome: "partial" }];
const endedCooling = detailPane(render({ projection: recoveredProjection, selectedActivityId: "recovered_provider" })).pane;
assert.match(endedCooling, /等待已随本次运行结束/u);
assert.doesNotMatch(endedCooling, /已等待|下次尝试/u);

await i18n.changeLanguage("en");
const englishProviderDetail = detailPane(render({ projection: providerProjection, selectedActivityId: "provider_detail" })).pane;
assert.match(englishProviderDetail, /Upstream rate limit · waited \d+s · \d+s left · next attempt/u);
assert.match(englishProviderDetail, /arXiv stopped for this run · upstream wait exceeded this run&#x27;s retry budget/u);
await i18n.changeLanguage("zh-CN");

const replayOutput: ActivityOutput = {
	outputRef: "output:plan",
	lifecycle: "finished",
	outcome: "succeeded",
	lines: [
		{ sequence: 1, kind: "status", text: "开始检索" },
		{ sequence: 2, kind: "tool", text: "", toolCallId: "call_1", toolName: "web_search", toolInput: { query: "声码器" }, toolOutput: "12 results" },
		{ sequence: 3, kind: "text", text: "中间结论\n三种声码器各有取舍" },
	],
};
function renderReplay(props: Partial<ComponentProps<typeof ActivityReplayContent>> = {}): string {
	return renderToStaticMarkup(
		<Dialog open>
			<ActivityReplayContent
				subtitle="制定检索计划 · Prime Search"
				output={replayOutput}
				error={null}
				onClose={() => undefined}
				{...props}
			/>
		</Dialog>,
	);
}

const replay = renderReplay();
assert.match(replay, /<h2[^>]*>执行记录<\/h2>/u);
assert.match(replay, /制定检索计划 · Prime Search · 3 条/u);
assert.match(replay, /<button[^>]*aria-label="关闭"/u);
assert.match(replay, /aria-live="polite"[\s\S]*开始检索[\s\S]*三种声码器各有取舍/u);
const loadingReplay = renderReplay({ output: null });
assert.match(loadingReplay, /<button[^>]*aria-label="关闭"/u);
assert.match(loadingReplay, /正在读取回放…/u);
assert.doesNotMatch(loadingReplay, /\d+ 条/u);
assert.match(renderReplay({ output: { ...replayOutput, lines: [] } }), /暂无执行记录/u);
assert.match(renderReplay({ error: "读取执行记录失败" }), /role="alert">读取执行记录失败</u);
const sectioned = renderReplay({
	output: {
		...replayOutput,
		lines: [
			{ sequence: 1, ref: "runtime#1", kind: "status", text: "Prime Search 正在检索资料" },
			{ sequence: 2, ref: "root:a#1", section: "Prime Search Root", sectionDepth: 0, model: "gpt-root", kind: "tool", text: "", toolCallId: "call_root", toolName: "ipython", toolInput: { code: "dispatch()" }, toolOutput: "dispatched" },
			{ sequence: 3, ref: "sub-1:b#1", section: "Provider child · github-models · github", sectionDepth: 1, model: "gpt-child", kind: "tool", text: "", toolCallId: "call_child", toolName: "ipython", toolInput: { code: "search()" }, toolOutput: "rows…", truncated: true },
			{ sequence: 4, ref: "sub-1:b#2", section: "Provider child · github-models · github", sectionDepth: 1, model: "gpt-child", kind: "thinking", text: "思考\n长摘要…", truncated: true },
		],
	},
});
assert.match(sectioned, /制定检索计划 · Prime Search · 4 条/u);
assert.equal((sectioned.match(/class="goal-activity-replay-section"/gu) ?? []).length, 2, "each session gets one header");
assert.match(sectioned, /Prime Search Root[\s\S]*Provider child · github-models · github/u);
assert.match(sectioned, /data-depth="0"[^>]*><span>Prime Search Root<\/span><code class="goal-activity-replay-model">gpt-root<\/code>/u,
	"the Root header names its model");
assert.match(sectioned, /<button type="button" class="goal-activity-replay-section" data-depth="1" aria-expanded="false"[^>]*><span>Provider child · github-models · github<\/span><code class="goal-activity-replay-model">gpt-child<\/code><small>2 条<\/small>/u,
	"a delegated child header sits one level deeper, names its own model and starts collapsed with its line count");
assert.match(sectioned, /dispatch\(\)|dispatched/u, "the Root's own rows render");
assert.doesNotMatch(sectioned, /search\(\)|长摘要/u, "a collapsed child's rows are not rendered until opened");
assert.doesNotMatch(sectioned, /· 4 条 · <code/u, "with session headers the overlay header does not repeat the models");
const singleSession = renderReplay({ output: { ...replayOutput, lines: replayOutput.lines.map((line) => ({ ...line, model: "gpt-solo" })) } });
assert.match(singleSession, /· 3 条 · <code class="goal-activity-replay-model">gpt-solo<\/code>/u, "a single session names its model in the overlay header");
assert.doesNotMatch(sectioned, /已截断/u, "rows stay clean; opening a truncated row loads its full content");

// A decision cannot be dismissed, so a panel whose only attention is one offers no dismissal.
assert.doesNotMatch(connected, /activity-dismiss-all/u);
const dismissAction = {
	actionId: "dismiss:podcast_failed", kind: "dismiss" as const, label: "忽略", enabled: true, requiresConfirmation: false,
	href: "/api/goals/goal_activity/events/activity-projection/dismissals",
	requestBody: { activities: [{ activityId: "podcast_failed", updatedAt: noon(0) }] },
};
const failedPodcast = activity({
	activityId: "podcast_failed",
	kind: "podcast",
	title: "生成播客",
	outcome: "failed",
	attention: {
		kind: "failure",
		summary: "Podcast 生成失败",
		actions: [{ actionId: "retry", kind: "retry", label: "重试", enabled: true, requiresConfirmation: false, href: "/api/retry" }],
		dismiss: dismissAction,
	},
});
const withFailure = projectionOf([], { items: [failedPodcast] }, { attention: 1, running: 0, queued: 0, waiting: 0 });
const failureList = render({ projection: withFailure });
assert.match(failureList, /data-testid="activity-dismiss-all"[^>]*>全部忽略</u);
// The dismissal is its own control, so the row still counts only the actions that fix the failure.
assert.match(failureList, />1 项操作</u);
const failureDetail = render({ projection: withFailure, selectedActivityId: "podcast_failed" });
assert.match(failureDetail, /<button type="button"[^>]*>重试<\/button><button type="button" class="is-quiet" data-testid="activity-attention-dismiss"[^>]*>忽略<\/button>/u,
	"the dismissal follows the actions that fix the failure");
// Attention on a history page not loaded yet may be a failure, so the panel still offers to dismiss it.
assert.match(render({ projection: projectionOf([], { items: [] }, { attention: 2, running: 0, queued: 0, waiting: 0 }) }), /activity-dismiss-all/u);

console.log("Goal activity panel view test passed");
