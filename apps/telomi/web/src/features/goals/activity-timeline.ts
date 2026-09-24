import type { ActivityLifecycle, ActivityOutcome, ActivityProjectionItem, ActivityTiming } from "@shared/events/activity-projection";
import { uiText } from "@/app/ui-text";
import { formatDate, formatElapsed, formatRelativeTime, formatRelativeUnit } from "@/shared/lib/format";

export type ActivityFilter = "all" | "attention" | "research" | "wiki" | "system";

export type ActivityState = "running" | "waiting" | "attention" | "succeeded" | "failed" | "quiet";

const ACTIVITY_STATE_LABEL = {
	running: "goalActivity.stateRunning",
	waiting: "goalActivity.stateWaiting",
	attention: "goalActivity.stateAttention",
	succeeded: "goalActivity.stateSucceeded",
	failed: "goalActivity.stateFailed",
	quiet: "goalActivity.stateQuiet",
} as const satisfies Record<ActivityState, string>;

export const OUTCOME_LABEL = {
	succeeded: "goalActivity.stateSucceeded",
	partial: "goalActivity.statusPartial",
	"no-change": "goalActivity.stateQuiet",
	skipped: "goalActivity.statusSkipped",
	cancelled: "goalActivity.statusCancelled",
	failed: "goalActivity.stateFailed",
} as const satisfies Record<ActivityOutcome, string>;

export type TimelineAnnotation =
	| { kind: "progress"; completed: number; total: number }
	| { kind: "actions"; count: number }
	| { kind: "label"; text: string }
	| null;

export type TimelineEntry =
	| { kind: "row"; item: ActivityProjectionItem; state: ActivityState; annotation: TimelineAnnotation; timeLabel: string }
	| { kind: "divider"; label: string };

const LIFECYCLE_ORDER: ActivityLifecycle[] = ["running", "waiting", "queued", "finished"];

export function activityTimeline(
	liveActivities: ActivityProjectionItem[],
	history: ActivityProjectionItem[],
	{ filter, now, locale }: { filter: ActivityFilter; now: number; locale: string },
): TimelineEntry[] {
	const items = [...liveActivities, ...history].filter((item) => matchesFilter(item, filter));
	const entries: TimelineEntry[] = [];
	for (const lifecycle of LIFECYCLE_ORDER) {
		const group = items
			.filter((item) => item.lifecycle === lifecycle)
			.sort((left, right) => Number(Boolean(right.attention)) - Number(Boolean(left.attention))
				|| Date.parse(right.timing.updatedAt) - Date.parse(left.timing.updatedAt));
		let day: string | undefined;
		for (const item of group) {
			const date = new Date(item.timing.updatedAt);
			const underDivider = lifecycle === "finished" && !item.attention;
			if (underDivider) {
				if (date.toDateString() !== day) {
					day = date.toDateString();
					entries.push({ kind: "divider", label: dayLabel(date, now, locale) });
				}
			}
			entries.push({
				kind: "row",
				item,
				state: activityState(item),
				annotation: rowAnnotation(item, now),
				timeLabel: rowTimeLabel(item, date, underDivider, now, locale),
			});
		}
	}
	return entries;
}

// A day divider already names the date, so rows below an earlier day's divider show only the clock time.
function rowTimeLabel(item: ActivityProjectionItem, date: Date, underDivider: boolean, now: number, locale: string): string {
	// A running row reads as how long the work has been going, which a last-update time hides
	// exactly when it stops moving; the row's quiet note still carries the last update.
	if (item.lifecycle === "running") return elapsedLabel(item.timing, now) || formatRelativeTime(date.getTime(), undefined, now, true);
	if (underDivider && date.toDateString() !== new Date(now).toDateString()) {
		return formatDate(date, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }, locale);
	}
	return formatRelativeTime(date.getTime(), undefined, now, true);
}

/** Below this a pause in a running Activity is ordinary Agent work, not something to point out. */
export const QUIET_AFTER_MS = 5 * 60_000;

/** How long a running Activity, Activity Step or Agent Activity has been going, against the current time. */
export function elapsedLabel(timing: ActivityTiming, now: number): string {
	const startedAt = Date.parse(timing.startedAt ?? timing.createdAt);
	if (!Number.isFinite(startedAt)) return "";
	const elapsed = formatElapsed(Math.max(0, now - startedAt));
	return elapsed ? uiText("goalActivity.elapsedRunning", { duration: elapsed }) : "";
}

/**
 * Says that a running item has recorded nothing for a while, and nothing more: long Agent steps are
 * normal, so this states the silence as a fact and leaves the judgment to the reader.
 */
export function quietLabel(timing: ActivityTiming, now: number): string | null {
	const updatedAt = Date.parse(timing.updatedAt);
	if (!Number.isFinite(updatedAt)) return null;
	const silent = now - updatedAt;
	if (silent < QUIET_AFTER_MS) return null;
	const duration = formatElapsed(silent);
	return duration ? uiText("goalActivity.noUpdates", { duration }) : null;
}

/** The last update of a running item, named as such beside its elapsed time. */
export function lastUpdateLabel(timing: ActivityTiming, now: number): string {
	const relative = formatRelativeTime(timing.updatedAt, undefined, now, true);
	return relative ? uiText("goalActivity.lastUpdate", { time: relative }) : "";
}

function matchesFilter(item: ActivityProjectionItem, filter: ActivityFilter): boolean {
	if (filter === "all") return true;
	if (filter === "attention") return Boolean(item.attention);
	if (filter === "research") return item.kind === "research" || item.kind === "scheduled-research";
	if (filter === "wiki") return item.kind === "wiki-update";
	return item.kind !== "research" && item.kind !== "scheduled-research" && item.kind !== "wiki-update";
}

/** The fields of an Activity, Activity Step or Agent Activity that decide its state glyph. */
export type ActivityStateSource = { lifecycle: ActivityLifecycle; outcome?: ActivityOutcome; attention?: unknown };

/** Maps an Activity, Activity Step or Agent Activity to its timeline state. */
export function activityState(item: ActivityStateSource): ActivityState {
	if (item.attention || item.outcome === "partial") return "attention";
	if (item.lifecycle === "running") return "running";
	if (item.lifecycle !== "finished") return "waiting";
	if (item.outcome === "failed") return "failed";
	if (item.outcome === "no-change" || item.outcome === "skipped" || item.outcome === "cancelled") return "quiet";
	return "succeeded";
}

/** Names a state glyph for screen readers, naming the outcome where one glyph covers several. */
export function activityStateLabel(item: ActivityStateSource) {
	const state = activityState(item);
	// Quiet covers no-change, skipped and cancelled; partial without Activity Attention borrows the attention glyph.
	if (item.outcome && (state === "quiet" || (item.outcome === "partial" && !item.attention))) return OUTCOME_LABEL[item.outcome];
	return ACTIVITY_STATE_LABEL[state];
}

function rowAnnotation(item: ActivityProjectionItem, now: number): TimelineAnnotation {
	if (item.attention?.actions.length) return { kind: "actions", count: item.attention.actions.length };
	if (item.lifecycle === "running") {
		// Once the work has gone quiet, how long it has been quiet says more than its step count.
		const quiet = quietLabel(item.timing, now);
		if (quiet) return { kind: "label", text: quiet };
		if (item.progress?.total) return { kind: "progress", completed: item.progress.completed, total: item.progress.total };
		return item.steps.length
			? { kind: "progress", completed: item.steps.filter((step) => step.lifecycle === "finished").length, total: item.steps.length }
			: null;
	}
	return item.lifecycle === "finished" ? { kind: "label", text: activityKindLabel(item.kind) } : null;
}

function dayLabel(date: Date, now: number, locale: string): string {
	const today = new Date(now);
	const yesterday = new Date(now);
	yesterday.setDate(today.getDate() - 1);
	if (date.toDateString() === today.toDateString()) return formatRelativeUnit(0, "day", locale);
	if (date.toDateString() === yesterday.toDateString()) return formatRelativeUnit(-1, "day", locale);
	return formatDate(date, { month: "long", day: "numeric" }, locale);
}

export function activityKindLabel(kind: ActivityProjectionItem["kind"]): string {
	switch (kind) {
		case "research": return uiText("goalActivity.research");
		case "scheduled-research": return uiText("goals.goalresearchschedulepanel.researchSchedule");
		case "wiki-update": return uiText("common.wikiUpdate");
		case "signal-evaluation": return uiText("common.signalEvaluation");
		case "topic-plan": return "Topic Plan";
		case "podcast": return "Podcast";
	}
}
