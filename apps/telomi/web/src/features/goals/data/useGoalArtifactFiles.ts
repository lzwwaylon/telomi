import { useCallback, useEffect, useRef, useState } from "react";
import { bustSharedFetch, sharedFetch } from "@/shared/lib/use-shared-fetch";
import { startWorkspaceFilesRefresh } from "@/features/goals/data/workspaceFilesRefresh";

export interface ArtifactFileMeta {
	name: string;
	size: number;
	modifiedAt: string;
	mtimeMs: number;
	title?: string;
	summary?: string;
	product?: boolean;
	cardId?: string;
	cover?: { sourceId: string; path: string };
}

interface State {
	files: ArtifactFileMeta[];
	loading: boolean;
	error: string | null;
}

interface ApiResponse {
	files?: {
		name: string;
		size: number;
		modifiedAt: string;
		title?: string;
		summary?: string;
		product?: boolean;
		cardId?: string;
		cover?: { sourceId: string; path: string };
	}[];
}

const SHARED_TTL_MS = 1500;

function urlFor(goalId: string): string {
	return `/api/goals/${encodeURIComponent(goalId)}/artifacts/list`;
}

/**
 * Loads /api/goals/:id/artifacts/list after workspace-producing events. Multiple consumers
 * (GoalProductsColumn + ArtifactsOverlay) share the same fetch via
 * `sharedFetch` so a single mount cycle only burns one HTTP request.
 *
 * Stale responses are ignored when the selected Goal changes.
 */
export function useGoalArtifactFiles(goalId: string | null) {
	const [state, setState] = useState<State>({ files: [], loading: false, error: null });
	const activeGoalRef = useRef<string | null>(goalId);

	const fetchOnce = useCallback(async (id: string, opts: { silent?: boolean; force?: boolean } = {}) => {
		if (!opts.silent) setState((s) => ({ ...s, loading: true, error: null }));
		const url = urlFor(id);
		if (opts.force) bustSharedFetch(url);
		try {
			const body = await sharedFetch<ApiResponse>(url, { ttlMs: SHARED_TTL_MS });
			if (activeGoalRef.current !== id) return;
			const files: ArtifactFileMeta[] = (body.files ?? [])
				.map((f) => ({ ...f, mtimeMs: new Date(f.modifiedAt).getTime() }))
				.sort((a, b) => b.mtimeMs - a.mtimeMs);
			setState({ files, loading: false, error: null });
		} catch (err) {
			if (activeGoalRef.current !== id) return;
			setState((s) => ({ ...s, loading: false, error: err instanceof Error ? err.message : String(err) }));
		}
	}, []);

	const refresh = useCallback(() => {
		if (goalId) void fetchOnce(goalId, { silent: true, force: true });
	}, [goalId, fetchOnce]);

	useEffect(() => {
		activeGoalRef.current = goalId;
		if (!goalId) {
			setState({ files: [], loading: false, error: null });
			return;
		}
		let initialLoad = true;
		const stopRefresh = startWorkspaceFilesRefresh({
			goalId,
			refresh: () => {
				void fetchOnce(goalId, { silent: !initialLoad, force: !initialLoad });
				initialLoad = false;
			},
		});
		return () => {
			activeGoalRef.current = null;
			stopRefresh();
		};
	}, [goalId, fetchOnce]);

	return { ...state, refresh };
}
