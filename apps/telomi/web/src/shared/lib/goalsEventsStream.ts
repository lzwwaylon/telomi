import type { AppEvent } from "@shared/events/app-events.js";
import type { GoalSnapshot } from "@shared/types.js";
import { eventSourceUrl } from "@/shared/lib/api";
import { subscribeSharedEventSource } from "@/shared/lib/sharedEventSource";

type GoalSessionEvent = Extract<AppEvent, { type: "goal-session:snapshot" }>;
export type GoalsEvent = Exclude<AppEvent, GoalSessionEvent>;

interface GoalsSubscriber {
	listener: (event: GoalsEvent) => void;
	onConnectionChange?: (connected: boolean) => void;
}

interface GoalSessionSubscriber {
	goalId: string;
	listener: (state: GoalSnapshot) => void;
	onConnectionChange?: (connected: boolean) => void;
}

let latestSnapshot: GoalsEvent | undefined;
const goalsSubscribers = new Set<GoalsSubscriber>();
const goalSessionSubscribers = new Set<GoalSessionSubscriber>();
let sourceUrl: string | undefined;
let unsubscribeSource: ((immediate?: boolean) => void) | undefined;
let connected = false;

/** Shares one App SSE across control-plane and active Goal consumers. */
export function subscribeGoalsEvents(
	listener: (event: GoalsEvent) => void,
	onConnectionChange?: (connected: boolean) => void,
): () => void {
	if (latestSnapshot) listener(latestSnapshot);
	const subscriber = { listener, onConnectionChange };
	goalsSubscribers.add(subscriber);
	syncSource();
	if (connected) onConnectionChange?.(true);
	return () => {
		goalsSubscribers.delete(subscriber);
		syncSource();
	};
}

export function subscribeGoalSessionEvents(
	goalId: string,
	listener: (state: GoalSnapshot) => void,
	onConnectionChange?: (connected: boolean) => void,
): () => void {
	const subscriber = { goalId, listener, onConnectionChange };
	goalSessionSubscribers.add(subscriber);
	syncSource();
	if (connected) onConnectionChange?.(true);
	return () => {
		goalSessionSubscribers.delete(subscriber);
		syncSource();
	};
}

export function subscribeGoalEvents(
	goalId: string,
	listener: (event: GoalsEvent) => void,
	onConnectionChange?: (connected: boolean) => void,
): () => void {
	return subscribeGoalsEvents((event) => {
		if ("goalId" in event && event.goalId === goalId) listener(event);
	}, onConnectionChange);
}

export function subscribeWikiEvents(
	goalId: string,
	listener: (event: GoalsEvent) => void,
	onConnectionChange?: (connected: boolean) => void,
): () => void {
	return subscribeGoalEvents(goalId, (event) => {
		if (event.type === "wiki-update:changed" || event.type === "topic-plan:changed") listener(event);
	}, onConnectionChange);
}

function syncSource(): void {
	if (goalsSubscribers.size === 0 && goalSessionSubscribers.size === 0) {
		unsubscribeSource?.(true);
		unsubscribeSource = undefined;
		sourceUrl = undefined;
		connected = false;
		return;
	}
	let goalId: string | undefined;
	for (const subscriber of goalSessionSubscribers) goalId = subscriber.goalId;
	const nextUrl = eventSourceUrl(`/api/events${goalId ? `?goalId=${encodeURIComponent(goalId)}` : ""}`);
	if (sourceUrl === nextUrl && unsubscribeSource) return;
	unsubscribeSource?.(true);
	sourceUrl = nextUrl;
	connected = false;
	unsubscribeSource = subscribeSharedEventSource(nextUrl, {
		onOpen: () => notifyConnection(true),
		onError: () => notifyConnection(false),
		onMessage: dispatchMessage,
	});
}

function notifyConnection(next: boolean): void {
	connected = next;
	for (const subscriber of [...goalsSubscribers, ...goalSessionSubscribers]) {
		try {
			subscriber.onConnectionChange?.(next);
		} catch (error) {
			console.warn("[goals-events-stream] connection handler threw", error);
		}
	}
}

function dispatchMessage(message: MessageEvent<string>): void {
	let event: AppEvent;
	try {
		event = JSON.parse(message.data) as AppEvent;
	} catch {
		return;
	}
	if (event.type === "goal-session:snapshot") {
		for (const subscriber of goalSessionSubscribers) {
			if (subscriber.goalId !== event.goalId) continue;
			try {
				subscriber.listener(event.state);
			} catch (error) {
				console.warn("[goals-events-stream] Goal handler threw", error);
			}
		}
		return;
	}
	if (event.type === "snapshot") latestSnapshot = event;
	for (const subscriber of goalsSubscribers) {
		try {
			subscriber.listener(event);
		} catch (error) {
			console.warn("[goals-events-stream] control-plane handler threw", error);
		}
	}
}
