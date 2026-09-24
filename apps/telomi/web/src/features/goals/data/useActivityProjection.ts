import { apiClient } from "@/shared/lib/api-client";
import { useCallback, useEffect, useRef, useState } from "react";

import type {
	ActivityOutput,
	ActivityProjection,
	GlobalActivityProjectionSummary,
} from "@shared/events/activity-projection";
import type { AppEvent } from "@shared/events/app-events.js";
import { subscribeGoalEvents, subscribeGoalsEvents } from "@/shared/lib/goalsEventsStream";
import { refreshOnReconnect } from "@/shared/lib/sharedEventSource";
import type { BackendConnectionStatus } from "@/features/goals/data/types";

export function subscribeActivityProjectionChanges(
	options: {
		goalId?: string;
		onChange: () => void;
		onConnectionChange: (connected: boolean) => void;
	},
): () => void {
	const onConnectionChange = refreshOnReconnect(options.onChange, options.onConnectionChange);
	return options.goalId
		? subscribeGoalEvents(options.goalId, (event) => {
			if (changesActivityProjection(event)) options.onChange();
		}, onConnectionChange)
		: subscribeGoalsEvents((event) => {
			if (changesActivityProjection(event)) options.onChange();
		}, onConnectionChange);
}

function changesActivityProjection(event: AppEvent): boolean {
	return event.type === "activity-projection:changed"
		|| event.type === "goal:run-started"
		|| event.type === "goal:run-completed"
		|| event.type === "research/schedules:changed"
		|| event.type === "research-run:changed"
		|| event.type === "wiki-update:changed"
		|| event.type === "topic-plan:changed"
		|| event.type === "media-product:status"
		|| event.type === "created"
		|| event.type === "deleted";
}

/** Well inside the five minutes after which a running Activity is shown as quiet. */
const RUNNING_REFRESH_MS = 30_000;

export function useGoalActivityProjection(goalId: string) {
	const [projection, setProjection] = useState<ActivityProjection | null>(null);
	const [loading, setLoading] = useState(true);
	const [loadingMore, setLoadingMore] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [connection, setConnection] = useState<BackendConnectionStatus>("connecting");
	const refreshRevision = useRef(0);

	const refresh = useCallback(async (silent = false) => {
		const revision = ++refreshRevision.current;
		if (!silent) setLoading(true);
		try {
			const body = await apiClient.get<ActivityProjection>(
				`/api/goals/${encodeURIComponent(goalId)}/events/activity-projection`,
			);
			if (revision !== refreshRevision.current) return;
			setProjection((previous) => {
				if (!previous || previous.history.items.length <= body.history.items.length) return body;
				const seen = new Set(body.history.items.map((item) => item.activityId));
				return {
					...body,
					history: {
						items: [
							...body.history.items,
							...previous.history.items.filter((item) => !seen.has(item.activityId)),
						],
						nextCursor: previous.history.nextCursor,
					},
				};
			});
			setError(null);
			setConnection("connected");
		} catch (cause) {
			if (revision !== refreshRevision.current) return;
			setError(cause instanceof Error ? cause.message : String(cause));
			setConnection("disconnected");
		} finally {
			if (revision === refreshRevision.current) setLoading(false);
		}
	}, [goalId]);

	useEffect(() => {
		setProjection(null);
		setConnection("connecting");
		void refresh();
		return subscribeActivityProjectionChanges({
			goalId,
			onChange: () => void refresh(true),
			onConnectionChange: (connected) => {
				setConnection(connected ? "connected" : "disconnected");
			},
		});
	}, [goalId, refresh]);

	// Change events mark Stage transitions only; the progress an Agent records inside a long Stage is
	// read from its files, so a running Activity is re-read or it would look stalled while it works.
	const running = projection?.liveActivities.some((item) => item.lifecycle === "running") ?? false;
	useEffect(() => {
		if (!running) return;
		const timer = window.setInterval(() => void refresh(true), RUNNING_REFRESH_MS);
		return () => window.clearInterval(timer);
	}, [running, refresh]);

	const loadMore = useCallback(async () => {
		const cursor = projection?.history.nextCursor;
		if (!cursor || loadingMore) return;
		setLoadingMore(true);
		try {
			const body = await apiClient.get<ActivityProjection>(
				`/api/goals/${encodeURIComponent(goalId)}/events/activity-projection?cursor=${encodeURIComponent(cursor)}`,
			);
			setProjection((previous) => previous ? {
				...previous,
				revision: body.revision,
				generatedAt: body.generatedAt,
				history: {
					items: [...previous.history.items, ...body.history.items],
					nextCursor: body.history.nextCursor,
				},
			} : body);
			setError(null);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setLoadingMore(false);
		}
	}, [goalId, loadingMore, projection?.history.nextCursor]);

	return { projection, loading, loadingMore, error, connection, loadMore };
}

export function useGlobalActivityProjection() {
	const [summary, setSummary] = useState<GlobalActivityProjectionSummary | null>(null);
	const [connection, setConnection] = useState<BackendConnectionStatus>("connecting");
	const refreshRevision = useRef(0);
	useEffect(() => {
		let cancelled = false;
		const refresh = async () => {
			const revision = ++refreshRevision.current;
			try {
				const body = await apiClient.get<GlobalActivityProjectionSummary>("/api/events/activity-projection/summary");
				if (!cancelled && revision === refreshRevision.current) {
					setSummary(body);
					setConnection("connected");
				}
			} catch {
				if (!cancelled && revision === refreshRevision.current) setConnection("disconnected");
			}
		};
		void refresh();
		const unsubscribe = subscribeActivityProjectionChanges({
			onChange: () => void refresh(),
			onConnectionChange: (connected) => {
				if (cancelled) return;
				setConnection(connected ? "connected" : "disconnected");
			},
		});
		return () => {
			cancelled = true;
			unsubscribe();
		};
	}, []);
	return { summary, connection };
}

/** Reads an Agent Activity's execution record; `line` reads that one line in full instead of the bounded list. */
export async function fetchActivityOutput(
	goalId: string,
	outputRef: string,
	line?: string,
): Promise<ActivityOutput> {
	const query = line === undefined ? "" : `?line=${encodeURIComponent(line)}`;
	const body = await apiClient.get<ActivityOutput>(
		`/api/goals/${encodeURIComponent(goalId)}/events/activity-projection/output/${encodeURIComponent(outputRef)}${query}`,
	);
	return body;
}
