import type { ActivityAttention, ActivityKind, ActivityOutcome, ActivityProjectionItem } from "@shared/events/activity-projection";

/** What a Goal's avatar reacts to, distilled from the Activity projection. */
export interface GoalAvatarSignals {
	/** The most pressing thing waiting on the user, if any. */
	attention: ActivityAttention["kind"] | null;
	/** Kinds of Activities currently running. */
	running: ActivityKind[];
	/** Something is queued or waiting on the outside world. */
	pending: boolean;
	/** The Activity that finished most recently, so the moment work ends can read as done or cancelled. */
	lastFinished: { activityId: string; outcome: ActivityOutcome | null } | null;
	/** When any Activity last changed, so a Goal nobody has touched in a while can doze off. */
	lastActiveAt: string | null;
}

export const IDLE_SIGNALS: GoalAvatarSignals = { attention: null, running: [], pending: false, lastFinished: null, lastActiveAt: null };

const ATTENTION_RANK: Record<ActivityAttention["kind"], number> = { failure: 0, decision: 1, credential: 2, input: 3 };

export function goalAvatarSignals(activities: readonly ActivityProjectionItem[], goalId: string): GoalAvatarSignals {
	const own = activities.filter((item) => item.scope.kind === "goal" && item.scope.goalId === goalId);
	const attention = own
		.map((item) => item.attention?.kind)
		.filter((kind): kind is ActivityAttention["kind"] => kind !== undefined)
		.sort((left, right) => ATTENTION_RANK[left] - ATTENTION_RANK[right])[0] ?? null;
	const finished = own
		.filter((item) => item.lifecycle === "finished")
		.sort((left, right) => (right.timing.finishedAt ?? right.timing.updatedAt).localeCompare(left.timing.finishedAt ?? left.timing.updatedAt))[0];
	const lastActiveAt = own.map((item) => item.timing.updatedAt).sort().at(-1) ?? null;
	return {
		attention,
		running: own.filter((item) => item.lifecycle === "running").map((item) => item.kind),
		pending: own.some((item) => item.lifecycle === "queued" || item.lifecycle === "waiting"),
		lastFinished: finished ? { activityId: finished.activityId, outcome: finished.outcome ?? null } : null,
		lastActiveAt,
	};
}

export function sameSignals(left: GoalAvatarSignals, right: GoalAvatarSignals): boolean {
	return left.attention === right.attention
		&& left.pending === right.pending
		&& left.running.length === right.running.length
		&& left.running.every((kind, index) => kind === right.running[index])
		&& left.lastFinished?.activityId === right.lastFinished?.activityId
		&& left.lastFinished?.outcome === right.lastFinished?.outcome
		&& left.lastActiveAt === right.lastActiveAt;
}

/**
 * The emotions the avatar can show, named for what the Goal is doing; the engine draws one
 * pose per id. The birds have no mouth, so every one of these reads through eyes, colour
 * and body motion alone.
 */
export const EMOTION = {
	/** At rest, glancing about now and then and nothing more. */
	idle: "idle",
	asleep: "asleep",
	thinking: "thinking",
	researching: "researching",
	/** Eyes turning upward as if leafing through memory: the Wiki being tidied. */
	updatingWiki: "updating-wiki",
	/** Eyes nodding to a beat: the podcast being spoken. */
	recording: "recording",
	failed: "failed",
	/** Eyes popping wide plus a small bounce: the bird needs the user. */
	waitingForUser: "waiting-for-user",
	/** Half-closed eyes drifting about: queued, or waiting on the outside world. */
	waitingOutside: "waiting-outside",
	// moments, shown for a second or two before the state takes over again
	born: "born",
	/** Wide eyes and a head tilt as work is picked up, deliberately not a smile: a smile reads as done. */
	started: "started",
	done: "done",
	cancelled: "cancelled",
} as const;
export type GoalAvatarEmotion = (typeof EMOTION)[keyof typeof EMOTION];

/** A short scene played once when something just happened, on top of whatever state follows. */
export type GoalAvatarMoment = "born" | "started" | "done" | "cancelled";

/**
 * Each kind of background work has its own emotion, so the rail tells at a glance what a
 * Goal is doing. Order is the display priority when several run at once.
 */
const WORK_EMOTIONS: Array<[ActivityKind, GoalAvatarEmotion]> = [
	["research", EMOTION.researching],
	["scheduled-research", EMOTION.researching],
	["signal-evaluation", EMOTION.researching],
	["wiki-update", EMOTION.updatingWiki],
	["podcast", EMOTION.recording],
	["topic-plan", EMOTION.thinking],
];

/**
 * The avatar shows one thing at a time, the most pressing first: a failure, then
 * anything else that waits on the user, then a moment that just happened, then
 * background work, then the user's own conversation, then queues, then dozing, then
 * idle. Work outranks the conversation because a turn that started a research run stays
 * open while the run lasts, and "researching" says more than "thinking".
 */
export function goalAvatarEmotion(input: {
	signals: GoalAvatarSignals;
	isStreaming: boolean;
	moment: GoalAvatarMoment | null;
	asleep: boolean;
}): GoalAvatarEmotion {
	const { signals } = input;
	if (signals.attention === "failure") return EMOTION.failed;
	if (signals.attention) return EMOTION.waitingForUser;
	if (input.moment) return EMOTION[input.moment];
	const work = WORK_EMOTIONS.find(([kind]) => signals.running.includes(kind));
	if (work) return work[1];
	if (input.isStreaming) return EMOTION.thinking;
	if (signals.pending) return EMOTION.waitingOutside;
	if (input.asleep) return EMOTION.asleep;
	return EMOTION.idle;
}
