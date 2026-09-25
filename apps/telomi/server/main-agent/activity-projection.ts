import type { ProjectionReducer } from "../events/activity-projection.js";
import type { ActivityLifecycle, ActivityMessage, ActivityOutcome, ActivityProjectionItem } from "../../shared/events/activity-projection.js";
import { chrome } from "../../shared/events/activity-text.js";
import type { GoalActivityItem } from "../../shared/types.js";
import { activityTiming } from "../events/projection-helpers.js";

function fromPodcast(item: GoalActivityItem, superseded: boolean): ActivityProjectionItem {
	const lifecycle: ActivityLifecycle = item.status === "queued"
		? "queued" : item.status === "running" ? "running" : "finished";
	const outcome: ActivityOutcome | undefined = item.status === "done"
		? "succeeded" : item.status === "skipped" ? "skipped"
			: item.status === "error" || item.status === "stale" ? "failed" : undefined;
	const startedAt = new Date(item.startedAt ?? item.updatedAt).toISOString();
	const updatedAt = new Date(item.updatedAt).toISOString();
	const finishedAt = lifecycle === "finished"
		? new Date(item.finishedAt ?? item.updatedAt).toISOString()
		: undefined;
	// item.action 与旧记录的 item.detail 是 Runtime 早先拼好的固定中文，不能当内容展示；
	// 状态只用已持久化的 status 事实表达。失败时的 item.detail 是上游诊断原文，只进详情视图。
	// item.sourceTitle 是报告自己写下的标题，属于内容：跟在本地化 chrome 后面展示，缺标题时只展示 chrome，
	// 绝不退回 cardId 或工件路径这类内部寻址标识。
	// ponytail: 成功摘要不带文稿模型；Projection 能读到 Media Meta 时可用 extra.scriptModel 补回。
	const sourceTitle = item.sourceTitle?.trim();
	const summary: ActivityMessage[] = [
		...chrome(lifecycle === "queued" ? "activityChrome.podcast.queued"
			: lifecycle === "running" ? "activityChrome.podcast.running"
				: outcome === "failed" ? "activityChrome.podcast.failed"
					: outcome === "skipped" ? "activityChrome.podcast.skipped" : "activityChrome.podcast.done"),
		...(sourceTitle ? [{ text: sourceTitle }] : []),
	];
	const failureDetail: ActivityMessage[] = outcome === "failed" && item.detail
		? [...summary, { text: item.detail }]
		: summary;
	return {
		activityId: `podcast:${item.id}`,
		kind: "podcast",
		scope: { kind: "goal", goalId: item.goalId },
		trigger: { kind: "agent", agentName: item.agent },
		title: chrome("activityChrome.podcast.title"),
		summary,
		lifecycle,
		...(outcome ? { outcome } : {}),
		// A failure a later attempt for the same report has replaced stays in history but asks nothing more.
		// Retrying without an instruction resumes from a finished script when the last attempt left one.
		// Records from before `cardId` was kept cannot name their report, so they can only be dismissed.
		...(outcome === "failed" && !superseded ? {
			attention: {
				kind: "failure" as const, summary,
				actions: item.cardId ? [{
					actionId: `retry-podcast:${item.id}`, kind: "retry" as const,
					label: chrome("activityChrome.podcast.retry"), enabled: true, requiresConfirmation: false,
					href: `/api/goals/${encodeURIComponent(item.goalId)}/media-products/${encodeURIComponent(item.cardId)}/generate`,
				}] : [],
			},
		} : {}),
		timing: activityTiming(startedAt, updatedAt, finishedAt),
		resultLinks: outcome === "succeeded" ? [{
			kind: "artifact",
			label: chrome("activityChrome.podcast.open"),
			href: `/goal/${encodeURIComponent(item.goalId)}`,
			available: true,
			primary: true,
		}] : [],
		steps: [{
			stepId: "podcast-generation",
			title: chrome("activityChrome.podcast.step"),
			// 详情视图是唯一展示上游失败原文的位置；首页卡片与下拉只看事实摘要。
			summary: failureDetail,
			lifecycle,
			...(outcome ? { outcome } : {}),
			timing: activityTiming(startedAt, updatedAt, finishedAt),
			dependsOnStepIds: [],
			parallelSteps: [],
			agentActivities: [],
		}],
		sourceRef: `podcast:${item.id}`,
	};
}

export function mainAgentProjection(listActivities: (goalId: string) => GoalActivityItem[]): ProjectionReducer {
	return (goalId) => {
		const podcasts = listActivities(goalId).filter((item) => item.kind === "podcast");
		const latestStart = new Map<string, number>();
		for (const item of podcasts) {
			if (item.cardId) latestStart.set(item.cardId, Math.max(latestStart.get(item.cardId) ?? 0, item.startedAt ?? 0));
		}
		return [{
			source: "podcast",
			items: podcasts.map((item) => fromPodcast(item,
				Boolean(item.cardId) && (item.startedAt ?? 0) < (latestStart.get(item.cardId!) ?? 0))),
		}];
	};
}
