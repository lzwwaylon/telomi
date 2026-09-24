import type { GlobalActivityProjectionSummary } from "../../shared/events/activity-projection.js";

/**
 * Scheduled Research due within this window keeps the instance busy, so maintenance does not
 * stop the server just before an occurrence would start.
 */
export const SCHEDULED_RESEARCH_HORIZON_MS = 15 * 60_000;

export type IdleReason =
	| { kind: "goal-work"; goalId: string }
	| { kind: "activity"; goalId: string; running: number; queued: number }
	/** A claimed occurrence is starting or running, or the next one is due within the horizon. */
	| { kind: "scheduled-research"; nextScheduledAt?: string }
	| { kind: "schedule-review" }
	| { kind: "evolution" }
	| { kind: "user-memory"; activeOperations: number | null }
	/** The user is logging in to a source in the browser login dialog. */
	| { kind: "browser-login" }
	/** The user has taken control of Browser Sessions in the Browser Monitor. */
	| { kind: "browser-control"; sessions: number };

export interface IdleVerdict {
	idle: boolean;
	reasons: IdleReason[];
	/** Earliest time an active Research Schedule is next due, even when outside the horizon. */
	nextScheduledAt?: string;
	checkedAt: string;
}

export interface IdleSources {
	listGoalIds: () => string[];
	/** Research Runs, Wiki Updates, Main Agent turns, Runner startup and deletion of one Goal. */
	isGoalActive: (goalId: string) => boolean;
	activitySummary: () => GlobalActivityProjectionSummary;
	hasClaimedScheduledResearch: () => boolean;
	nextScheduledAt: () => string | undefined;
	hasRunningScheduleReview: () => boolean;
	hasExecutingEvolutionRun: () => boolean;
	userMemoryActiveOperations: () => Promise<number | null>;
	browserLoginOpen: () => boolean;
	userControlledBrowserSessions: () => number;
}

/**
 * Whether stopping the server now would interrupt work. Read-only: it never pauses, cancels or
 * delays anything, so work can start right after an idle verdict; callers re-check after stopping
 * new admissions if they need a stronger guarantee.
 */
export async function readIdleVerdict(sources: IdleSources, now = Date.now()): Promise<IdleVerdict> {
	const reasons: IdleReason[] = [];
	for (const goalId of sources.listGoalIds()) {
		if (sources.isGoalActive(goalId)) reasons.push({ kind: "goal-work", goalId });
	}
	// A waiting Activity is persisted and already stopped until the user acts: an interrupted Run
	// or Wiki Update awaiting resume, or a Topic Plan Proposal awaiting review. Counting it would
	// hold maintenance for as long as the user takes to decide.
	for (const { goalId, summary: { running, queued } } of sources.activitySummary().goals) {
		if (running + queued > 0) reasons.push({ kind: "activity", goalId, running, queued });
	}
	const nextScheduledAt = sources.nextScheduledAt();
	const dueSoon = nextScheduledAt !== undefined && Date.parse(nextScheduledAt) - now <= SCHEDULED_RESEARCH_HORIZON_MS;
	if (sources.hasClaimedScheduledResearch() || dueSoon) {
		reasons.push({ kind: "scheduled-research", ...(nextScheduledAt ? { nextScheduledAt } : {}) });
	}
	if (sources.hasRunningScheduleReview()) reasons.push({ kind: "schedule-review" });
	if (sources.hasExecutingEvolutionRun()) reasons.push({ kind: "evolution" });
	const activeOperations = await sources.userMemoryActiveOperations();
	if (activeOperations !== 0) reasons.push({ kind: "user-memory", activeOperations });
	// A restart ends an interactive browser session mid-login or mid-task. Watching an Agent's
	// browser without control does not count: the Agent's own work already does, and a monitor left
	// open would otherwise hold maintenance indefinitely.
	if (sources.browserLoginOpen()) reasons.push({ kind: "browser-login" });
	const sessions = sources.userControlledBrowserSessions();
	if (sessions > 0) reasons.push({ kind: "browser-control", sessions });
	return {
		idle: reasons.length === 0,
		reasons,
		...(nextScheduledAt ? { nextScheduledAt } : {}),
		checkedAt: new Date(now).toISOString(),
	};
}
