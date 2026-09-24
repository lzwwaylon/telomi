import type { ActivityKind, ActivityOutput, ActivityProjection, ActivityProjectionItem, ActivityProjectionSummary, GlobalActivityProjectionSummary } from "../../shared/events/activity-projection.js";
import { compareHistory, revisionFor, withLiveElapsed, withRecordedActivity } from "./projection-helpers.js";

export interface ProjectionContribution {
	source: ActivityKind;
	items: ActivityProjectionItem[];
	revisionData?: unknown;
}

export type ProjectionReducer = (goalId: string) => ProjectionContribution[];

export interface ActivityProjectionServiceOptions {
	listGoalIds: () => string[];
	itemSources?: ActivityKind[];
	readOutput?: (goalId: string, outputRef: string, options?: { line?: string }) => ActivityOutput | null;
	/** Clock behind `generatedAt` and the elapsed time of running items; one reading per projection. */
	now?: () => number;
}

const HISTORY_PAGE_SIZE = 20;

export class ActivityProjectionService {
	private readonly reducers: ProjectionReducer[] = [];

	constructor(private readonly options: ActivityProjectionServiceOptions) {}

	registerProjection(reducer: ProjectionReducer): void {
		this.reducers.push(reducer);
	}

	readOutput(goalId: string, outputRef: string, options: { line?: string } = {}): ActivityOutput | null {
		return this.options.readOutput?.(goalId, outputRef, options) ?? null;
	}

	getGoal(goalId: string, cursor?: string): ActivityProjection {
		const now = this.options.now?.() ?? Date.now();
		const generatedAt = new Date(now).toISOString();
		const contributions = this.reducers.flatMap((reducer) => reducer(goalId));
		const ordered = [...contributions].sort((left, right) => {
			const rank = (source: ActivityKind) => {
				const index = this.options.itemSources?.indexOf(source) ?? -1;
				return index < 0 ? Number.MAX_SAFE_INTEGER : index;
			};
			return rank(left.source) - rank(right.source);
		});
		const items = ordered.flatMap((contribution) => contribution.items).map(withRecordedActivity);
		const liveActivities = items
			.filter((item) => item.lifecycle !== "finished")
			.sort(compareLive);
		const historyItems = items
			.filter((item) => item.lifecycle === "finished")
			.sort(compareHistory);
		const anchor = decodeCursor(cursor);
		const eligibleHistory = anchor
			? historyItems.filter((item) =>
				item.timing.updatedAt < anchor.updatedAt
				|| (item.timing.updatedAt === anchor.updatedAt && item.activityId < anchor.activityId))
			: historyItems;
		const history = eligibleHistory.slice(0, HISTORY_PAGE_SIZE);
		const lastHistoryItem = history.at(-1);
		// The revision covers the recorded facts, before elapsed time is measured against the clock,
		// so a projection that only kept counting is not reported as a change.
		const revision = revisionFor(items);
		return {
			schemaVersion: 2,
			revision,
			generatedAt,
			scope: { kind: "goal", goalId },
			freshness: contributions.map(({ source, items, revisionData }) => ({
				source,
				observedAt: generatedAt,
				sourceRevision: revisionFor(revisionData ?? items),
				freshness: "fresh",
			})),
			summary: summarize(items),
			liveActivities: liveActivities.map((item) => withLiveElapsed(item, now)),
			history: {
				items: history,
				...(lastHistoryItem && history.length < eligibleHistory.length
					? { nextCursor: encodeCursor(lastHistoryItem) }
					: {}),
			},
		};
	}

	getGlobalSummary(): GlobalActivityProjectionSummary {
		const projections = this.options.listGoalIds().map((goalId) => ({ goalId, projection: this.getGoal(goalId) }));
		const goals = projections.map(({ goalId, projection }) => {
			const attentionItem = [...projection.liveActivities, ...projection.history.items]
				.find((item) => item.attention);
			return {
				goalId,
				summary: projection.summary,
				...(attentionItem?.attention ? { attentionSummary: attentionItem.attention.summary } : {}),
			};
		});
		const summary = addSummaries(goals.map((goal) => goal.summary));
		const activities = projections
			.flatMap(({ projection }) => [...projection.liveActivities, ...projection.history.items])
			.sort((a, b) => Date.parse(b.timing.updatedAt) - Date.parse(a.timing.updatedAt))
			.slice(0, 300);
		return {
			schemaVersion: 2,
			revision: revisionFor(goals),
			generatedAt: new Date().toISOString(),
			summary,
			activities,
			goals: goals.filter((goal) => totalSummary(goal.summary) > 0),
			system: emptySummary(),
		};
	}
}

function summarize(items: ActivityProjectionItem[]): ActivityProjectionSummary {
	return {
		attention: items.filter((item) => Boolean(item.attention)).length,
		running: items.filter((item) => item.lifecycle === "running").length,
		queued: items.filter((item) => item.lifecycle === "queued").length,
		waiting: items.filter((item) => item.lifecycle === "waiting").length,
	};
}

function emptySummary(): ActivityProjectionSummary {
	return { attention: 0, running: 0, queued: 0, waiting: 0 };
}

function addSummaries(summaries: ActivityProjectionSummary[]): ActivityProjectionSummary {
	return summaries.reduce((total, summary) => ({
		attention: total.attention + summary.attention,
		running: total.running + summary.running,
		queued: total.queued + summary.queued,
		waiting: total.waiting + summary.waiting,
	}), emptySummary());
}

function totalSummary(summary: ActivityProjectionSummary): number {
	return summary.attention + summary.running + summary.queued + summary.waiting;
}

function compareLive(left: ActivityProjectionItem, right: ActivityProjectionItem): number {
	const score = (item: ActivityProjectionItem) =>
		(item.attention ? 4 : item.lifecycle === "waiting" ? 3 : item.lifecycle === "running" ? 2 : 1);
	return score(right) - score(left) || right.timing.updatedAt.localeCompare(left.timing.updatedAt);
}

function encodeCursor(item: ActivityProjectionItem): string {
	return Buffer.from(JSON.stringify({
		v: 1,
		updatedAt: item.timing.updatedAt,
		activityId: item.activityId,
	}), "utf8").toString("base64url");
}

function decodeCursor(cursor?: string): { updatedAt: string; activityId: string } | null {
	if (!cursor) return null;
	try {
		const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as {
			v?: unknown;
			updatedAt?: unknown;
			activityId?: unknown;
		};
		if (
			parsed.v !== 1
			|| typeof parsed.updatedAt !== "string"
			|| !Number.isFinite(Date.parse(parsed.updatedAt))
			|| typeof parsed.activityId !== "string"
			|| !parsed.activityId
		) throw new Error();
		return { updatedAt: parsed.updatedAt, activityId: parsed.activityId };
	} catch {
		throw new Error("Invalid activity history cursor");
	}
}
