import assert from "node:assert/strict";

import type { ActivityProjectionItem, ActivityStep } from "../../shared/events/activity-projection.js";
import { activityState, activityStateLabel, activityTimeline, type ActivityFilter, type TimelineEntry } from "../../web/src/features/goals/activity-timeline.js";
import i18n from "../../web/src/app/i18n.js";

await i18n.changeLanguage("zh-CN");

// Local wall-clock fixtures keep day boundaries independent of the machine time zone.
const now = new Date(2026, 8, 14, 15, 0).getTime();
const today = (hour: number) => new Date(2026, 8, 14, hour, 0).toISOString();
const yesterday = (hour: number) => new Date(2026, 8, 13, hour, 0).toISOString();
const earlier = (hour: number) => new Date(2026, 8, 10, hour, 0).toISOString();

function activity(
	fields: Pick<ActivityProjectionItem, "activityId"> & Partial<ActivityProjectionItem>,
): ActivityProjectionItem {
	const updatedAt = fields.timing?.updatedAt ?? today(12);
	return {
		kind: "research",
		scope: { kind: "goal", goalId: "goal_timeline" },
		trigger: { kind: "manual" },
		title: fields.activityId,
		summary: "",
		lifecycle: "finished",
		outcome: "succeeded",
		resultLinks: [],
		steps: [],
		sourceRef: `research:${fields.activityId}`,
		...fields,
		timing: fields.timing ?? { createdAt: updatedAt, updatedAt },
	};
}

const at = (updatedAt: string) => ({ createdAt: updatedAt, updatedAt });
const attention = (count: number): ActivityProjectionItem["attention"] => ({
	kind: "decision",
	summary: "choose",
	actions: Array.from({ length: count }, (_, index) => ({
		actionId: `action_${index}`,
		kind: "decision",
		label: `Action ${index}`,
		enabled: true,
		requiresConfirmation: false,
	})),
});

const live = [
	activity({ activityId: "queued_new", lifecycle: "queued", outcome: undefined, timing: at(today(14)) }),
	activity({ activityId: "running_old", lifecycle: "running", outcome: undefined, timing: at(today(9)), progress: { completed: 4, total: 7 } }),
	activity({ activityId: "waiting", lifecycle: "waiting", outcome: undefined, timing: at(today(13)) }),
	activity({ activityId: "running_new", lifecycle: "running", outcome: undefined, timing: at(today(11)) }),
	activity({ activityId: "running_attention", lifecycle: "running", outcome: undefined, timing: at(today(8)), attention: attention(1) }),
	// Started a while back, still reporting: ordinary running work, nothing to point out.
	activity({
		activityId: "running_fresh",
		lifecycle: "running",
		outcome: undefined,
		timing: { createdAt: today(12), startedAt: today(12), updatedAt: new Date(now - 90_000).toISOString() },
		progress: { completed: 1, total: 4 },
	}),
];
const history = [
	activity({ activityId: "older_failed", kind: "podcast", outcome: "failed", timing: at(earlier(10)) }),
	activity({ activityId: "today_wiki", kind: "wiki-update", timing: at(today(10)) }),
	activity({ activityId: "yesterday_skipped", kind: "topic-plan", outcome: "skipped", timing: at(yesterday(20)) }),
	activity({ activityId: "yesterday_attention", kind: "topic-plan", outcome: "partial", timing: at(yesterday(8)), attention: attention(2) }),
	activity({ activityId: "today_no_change", kind: "wiki-update", outcome: "no-change", timing: at(today(12)) }),
	activity({ activityId: "yesterday_cancelled", kind: "podcast", outcome: "cancelled", timing: at(yesterday(9)) }),
	activity({ activityId: "partial_without_attention", kind: "signal-evaluation", outcome: "partial", timing: at(earlier(9)) }),
];

const timeline = (filter: ActivityFilter = "all") => activityTimeline(live, history, { filter, now, locale: "zh-CN" });
const shape = (entries: TimelineEntry[]) => entries.map((entry) => entry.kind === "row" ? entry.item.activityId : `-- ${entry.label}`);
const row = (entries: TimelineEntry[], id: string) => {
	const entry = entries.find((candidate) => candidate.kind === "row" && candidate.item.activityId === id);
	assert.ok(entry?.kind === "row", `missing row ${id}`);
	return entry;
};

// Running, waiting, queued, then finished; attention floats to the top of its group.
// Finished rows get day dividers, and floated attention rows sit above the first divider.
const all = timeline();
assert.deepEqual(shape(all), [
	"running_attention",
	"running_fresh",
	"running_new",
	"running_old",
	"waiting",
	"queued_new",
	"yesterday_attention",
	"-- 今天",
	"today_no_change",
	"today_wiki",
	"-- 昨天",
	"yesterday_skipped",
	"yesterday_cancelled",
	"-- 9月10日",
	"older_failed",
	"partial_without_attention",
]);

assert.deepEqual(
	["running_attention", "running_new", "waiting", "queued_new", "yesterday_attention", "today_wiki", "older_failed", "today_no_change", "yesterday_skipped", "yesterday_cancelled", "partial_without_attention"]
		.map((id) => row(all, id).state),
	["attention", "running", "waiting", "waiting", "attention", "succeeded", "failed", "quiet", "quiet", "quiet", "attention"],
);

assert.deepEqual(row(all, "running_fresh").annotation, { kind: "progress", completed: 1, total: 4 });
// Six hours without a single update is worth saying plainly, and says more than the step count.
assert.deepEqual(row(all, "running_old").annotation, { kind: "label", text: "已 6 小时无更新" });
assert.deepEqual(row(all, "running_new").annotation, { kind: "label", text: "已 4 小时无更新" });
const step = (stepId: string, lifecycle: ActivityStep["lifecycle"]): ActivityStep => ({
	stepId,
	title: stepId,
	summary: "",
	lifecycle,
	timing: at(today(9)),
	dependsOnStepIds: [],
	parallelSteps: [],
	agentActivities: [],
});
const stepsOnly = activityTimeline([activity({
	activityId: "running_steps",
	lifecycle: "running",
	outcome: undefined,
	timing: { createdAt: today(9), startedAt: today(9), updatedAt: new Date(now - 30_000).toISOString() },
	steps: [step("plan", "finished"), step("search", "running"), step("report", "queued")],
})], [], { filter: "all", now, locale: "zh-CN" });
assert.deepEqual(row(stepsOnly, "running_steps").annotation, { kind: "progress", completed: 1, total: 3 });
assert.deepEqual(row(all, "running_attention").annotation, { kind: "actions", count: 1 });
assert.deepEqual(row(all, "yesterday_attention").annotation, { kind: "actions", count: 2 });
assert.equal(row(all, "waiting").annotation, null);
assert.deepEqual(row(all, "today_wiki").annotation, { kind: "label", text: "Wiki 更新" });
assert.deepEqual(row(all, "older_failed").annotation, { kind: "label", text: "Podcast" });

// A day divider already names the date, so rows below an earlier day's divider show only the clock time.
// Rows without a divider above them (live and floated attention rows) keep a date once they are a day old.
assert.equal(row(all, "yesterday_skipped").timeLabel, "20:00");
assert.equal(row(all, "older_failed").timeLabel, "10:00");
assert.match(row(all, "today_wiki").timeLabel, /^5\s*小时前$/u);
assert.equal(row(all, "yesterday_attention").timeLabel, "09/13");
assert.ok(all.every((entry) => entry.kind === "divider" || !entry.timeLabel.includes("月")));

// A running row reads as elapsed time, which keeps growing while its last update does not.
assert.equal(row(all, "running_old").timeLabel, "已运行 6 小时");
assert.equal(row(all, "running_fresh").timeLabel, "已运行 3 小时");
const later = activityTimeline(live, history, { filter: "all", now: now + 95 * 60_000, locale: "zh-CN" });
assert.equal(row(later, "running_old").timeLabel, "已运行 7 小时 35 分钟");
assert.equal(row(later, "running_fresh").timeLabel, "已运行 4 小时 35 分钟");
assert.deepEqual(row(later, "running_fresh").annotation, { kind: "label", text: "已 1 小时 36 分钟无更新" },
	"a row that stops reporting says so, and says nothing about whether it failed");
// Only running work counts elapsed time; waiting, queued and finished rows keep naming their last update.
for (const id of ["today_wiki", "waiting", "queued_new"]) {
	assert.match(row(later, id).timeLabel, /前$/u);
	assert.deepEqual(row(later, id).annotation, row(all, id).annotation);
}
// A start in the future or an unreadable timestamp reads as zero, never as negative time.
const odd = activityTimeline([
	activity({ activityId: "future", lifecycle: "running", outcome: undefined, timing: at(today(23)) }),
	activity({ activityId: "broken", lifecycle: "running", outcome: undefined, timing: { createdAt: "nope", updatedAt: "nope" } }),
], [], { filter: "all", now, locale: "zh-CN" });
assert.equal(row(odd, "future").timeLabel, "已运行 0 秒");
assert.equal(row(odd, "future").annotation, null);
assert.equal(row(odd, "broken").timeLabel, "");
assert.equal(row(odd, "broken").annotation, null);

// Filters apply before grouping, so dividers only describe rows that remain visible.
assert.deepEqual(shape(timeline("attention")), ["running_attention", "yesterday_attention"]);
assert.deepEqual(shape(timeline("wiki")), ["-- 今天", "today_no_change", "today_wiki"]);
assert.deepEqual(shape(timeline("research")), ["running_attention", "running_fresh", "running_new", "running_old", "waiting", "queued_new"]);
assert.deepEqual(shape(timeline("system")), [
	"yesterday_attention",
	"-- 昨天",
	"yesterday_skipped",
	"yesterday_cancelled",
	"-- 9月10日",
	"older_failed",
	"partial_without_attention",
]);

assert.deepEqual(activityTimeline([], [], { filter: "all", now, locale: "zh-CN" }), []);

// Activity Steps and Agent Activities in the detail pane use the same state mapping as rows.
const detailStates: Array<Parameters<typeof activityState>[0]> = [
	{ lifecycle: "finished", outcome: "no-change" },
	{ lifecycle: "finished", outcome: "skipped" },
	{ lifecycle: "finished", outcome: "cancelled" },
	{ lifecycle: "finished", outcome: "partial" },
	{ lifecycle: "finished", outcome: "failed" },
	{ lifecycle: "finished", outcome: "succeeded" },
	{ lifecycle: "queued" },
	{ lifecycle: "running" },
];
assert.deepEqual(
	detailStates.map(activityState),
	["quiet", "quiet", "quiet", "attention", "failed", "succeeded", "waiting", "running"],
);
// Where one glyph covers several outcomes, its label names the outcome.
assert.deepEqual(
	detailStates.map((item) => i18n.t(activityStateLabel(item))),
	["未产生变更", "已跳过", "已取消", "部分完成", "失败", "已完成", "等待中", "运行中"],
);

console.log("Activity timeline test passed");
