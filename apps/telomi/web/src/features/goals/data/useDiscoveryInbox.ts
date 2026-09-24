import { apiClient } from "@/shared/lib/api-client";
import { useCallback, useEffect, useRef, useState } from "react";

import { subscribeGoalEvents } from "@/shared/lib/goalsEventsStream";
import { refreshOnReconnect } from "@/shared/lib/sharedEventSource";

export interface DiscoveryInboxItem {
	id: string;
	goal_id: string;
	finding: string;
	run_id: string;
	source_id: string;
	section_index: number;
	cue_index: number;
	cue: string;
	note: string;
	evidence: Array<{ source_path: string; start_line: number; end_line: number; content_sha256: string }>;
	status: "open" | "closed";
	created_at: string;
	updated_at?: string;
	resolution?: {
		kind: "ignored" | "covered_by_topic";
		resolved_by: "user" | "runtime";
		resolved_at: string;
	};
}

export function useDiscoveryInbox(goalId: string) {
	const [items, setItems] = useState<DiscoveryInboxItem[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [decidingId, setDecidingId] = useState<string | null>(null);
	const refreshRevision = useRef(0);

	const refresh = useCallback(async () => {
		const revision = ++refreshRevision.current;
		try {
			const body = await apiClient.get<DiscoveryInboxItem[] | { error?: string }>(`/api/goals/${encodeURIComponent(goalId)}/discoveries`);
			if (!Array.isArray(body)) throw new Error(body.error || "HTTP 200");
			if (revision !== refreshRevision.current) return;
			setItems(body);
			setError(null);
		} catch (cause) {
			if (revision === refreshRevision.current) setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			if (revision === refreshRevision.current) setLoading(false);
		}
	}, [goalId]);

	useEffect(() => {
		setItems([]);
		setLoading(true);
		void refresh();
		return subscribeGoalEvents(goalId, (event) => {
			if (event.type === "discovery:changed") void refresh();
		}, refreshOnReconnect(() => void refresh()));
	}, [goalId, refresh]);

	const ignore = useCallback(async (item: DiscoveryInboxItem): Promise<boolean> => {
		if (decidingId) return false;
		setDecidingId(item.id);
		setError(null);
		try {
			await apiClient.post(`/api/goals/${encodeURIComponent(goalId)}/discoveries/${encodeURIComponent(item.id)}/ignore`);
			setItems((current) => current.filter((candidate) => candidate.id !== item.id));
			return true;
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
			return false;
		} finally {
			setDecidingId(null);
		}
	}, [decidingId, goalId]);

	const reopen = useCallback(async (candidateId: string): Promise<boolean> => {
		setError(null);
		try {
			await apiClient.post(`/api/goals/${encodeURIComponent(goalId)}/discoveries/${encodeURIComponent(candidateId)}/reopen`);
			await refresh();
			return true;
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
			return false;
		}
	}, [goalId, refresh]);

	return { items, loading, error, decidingId, ignore, reopen };
}

export function useDiscoveryCandidate(goalId: string | null, candidateId: string | null) {
	const [candidate, setCandidate] = useState<DiscoveryInboxItem | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(Boolean(goalId && candidateId));
	useEffect(() => {
		if (!goalId || !candidateId) {
			setCandidate(null);
			setError(null);
			setLoading(false);
			return;
		}
		let cancelled = false;
		setCandidate(null);
		setError(null);
		setLoading(true);
		const refresh = async () => {
			try {
				const body = await apiClient.get<DiscoveryInboxItem>(
					`/api/goals/${encodeURIComponent(goalId)}/discoveries/${encodeURIComponent(candidateId)}`,
				);
				if (!cancelled) {
					setCandidate(body);
					setError(null);
				}
			} catch (cause) {
				if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
			} finally {
				if (!cancelled) setLoading(false);
			}
		};
		void refresh();
		const unsubscribe = subscribeGoalEvents(goalId, (event) => {
			if (event.type === "discovery:changed" && event.candidateId === candidateId) void refresh();
		});
		return () => {
			cancelled = true;
			unsubscribe();
		};
	}, [candidateId, goalId]);
	return { candidate, error, loading };
}
