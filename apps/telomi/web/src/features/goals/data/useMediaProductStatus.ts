import { apiClient } from "@/shared/lib/api-client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { MediaProductStatus } from "@shared/types.js";
import { subscribeGoalEvents } from "@/shared/lib/goalsEventsStream";

export type { MediaProductStatus } from "@shared/types.js";

export interface PodcastState {
	status: MediaProductStatus;
	jobId?: string;
	error?: string;
	bytes?: number;
	durationSec?: number;
	generatedAt?: string;
	mediaUrl?: string;
	implemented: boolean;
	extra?: Record<string, unknown>;
	progress?: string;
	/** The server has not answered yet, so nothing, availability included, is known. */
	loading?: boolean;
}

const IDLE: PodcastState = { status: "idle", implemented: false };
const LOADING: PodcastState = { ...IDLE, loading: true };

interface ServerStatusResponse {
	podcast?: PodcastState;
}

let mediaStatusRequestTail = Promise.resolve();

function mediaProductPath(goalId: string, cardId: string, action: "status" | "media" | "generate"): string {
	return `/api/goals/${encodeURIComponent(goalId)}/media-products/${encodeURIComponent(cardId)}/${action}`;
}

export function fetchMediaProductStatus(url: string): Promise<ServerStatusResponse> {
	const request = mediaStatusRequestTail.then(() => apiClient.get<ServerStatusResponse>(url, {
		errorMessage: (status, body) => `status ${status}: ${body.slice(0, 200)}`,
	}));
	mediaStatusRequestTail = request.then(() => undefined, () => undefined);
	return request;
}

interface StatusEvent {
	type: "media-product:status";
	cardId: string;
	status?: MediaProductStatus;
	jobId?: string;
	error?: string;
	bytes?: number;
	durationSec?: number;
	generatedAt?: string;
	mediaUrl?: string;
	extra?: Record<string, unknown>;
	progress?: string;
}

export function useMediaProductStatus(goalId: string, cardId: string) {
	const [state, setState] = useState<PodcastState>(LOADING);
	const [error, setError] = useState<string | null>(null);
	const revision = useRef(0);

	useEffect(() => {
		if (!goalId || !cardId) return;
		let cancelled = false;
		let initialSnapshotSettled = false;
		setError(null);
		const loadSnapshot = async () => {
			const currentRevision = revision.current;
			try {
				const data = await fetchMediaProductStatus(mediaProductPath(goalId, cardId, "status"));
				if (!cancelled && currentRevision === revision.current) setState(data.podcast ?? IDLE);
			} catch (cause) {
				if (!cancelled && currentRevision === revision.current) {
					setError(cause instanceof Error ? cause.message : String(cause));
				}
			}
		};

		const unsubscribe = subscribeGoalEvents(
			goalId,
			(payload) => {
				const event = payload as unknown as StatusEvent;
				if (event.type !== "media-product:status" || event.cardId !== cardId || !event.status) return;
				revision.current += 1;
				setState((current) => ({
					...current,
					status: event.status!,
					jobId: event.jobId,
					error: event.error,
					bytes: event.bytes ?? current.bytes,
					durationSec: event.durationSec ?? current.durationSec,
					generatedAt: event.generatedAt ?? current.generatedAt,
					mediaUrl: event.mediaUrl ?? (event.status === "done"
						? mediaProductPath(goalId, cardId, "media")
						: current.mediaUrl),
					implemented: true,
					loading: false,
					extra: event.extra ?? current.extra,
					progress: event.status === "running" ? event.progress ?? current.progress : undefined,
				}));
			},
			(connected) => {
				if (connected && initialSnapshotSettled) void loadSnapshot();
			},
		);

		void loadSnapshot().finally(() => {
			initialSnapshotSettled = true;
		});
		return () => {
			cancelled = true;
			unsubscribe();
		};
	}, [goalId, cardId]);

	const triggerGenerate = useCallback(async () => {
		revision.current += 1;
		setState((current) => ({ ...current, status: "running", error: undefined }));
		try {
			const payload = await apiClient.post<{ jobId?: unknown; status?: unknown }>(
				mediaProductPath(goalId, cardId, "generate"), undefined,
				{ errorMessage: (status, body) => `generate ${status}: ${body.slice(0, 200)}` },
			);
			if (payload.status !== "running") throw new Error("generate response did not start a job");
			revision.current += 1;
			setState((current) => ({
				...current,
				status: "running",
				jobId: typeof payload.jobId === "string" ? payload.jobId : current.jobId,
				error: undefined,
			}));
		} catch (cause) {
			revision.current += 1;
			setState((current) => ({
				...current,
				status: "failed",
				error: cause instanceof Error ? cause.message : String(cause),
			}));
		}
	}, [goalId, cardId]);

	return { state, error, triggerGenerate };
}
