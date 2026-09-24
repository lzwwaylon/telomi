import { apiClient } from "@/shared/lib/api-client";
import { useCallback, useEffect, useRef, useState } from "react";
import { startWorkspaceFilesRefresh } from "@/features/goals/data/workspaceFilesRefresh";

export interface WorkspaceFileMeta {
	path: string;
	/** Label path from the server; storage keys already replaced by the user's own names. */
	displayPath?: string;
	size: number;
	modifiedAt: string;
	mtimeMs: number;
	title?: string;
	summary?: string;
}

interface State {
	files: WorkspaceFileMeta[];
	loading: boolean;
	error: string | null;
	truncated: boolean;
}

interface InFlightRequest {
	goalId: string;
	promise: Promise<void>;
	refreshAgain: boolean;
}

/**
 * List of Main Agent business files under their guest paths. The initial
 * scan is refreshed after workspace-producing Goal events or by explicit user
 * action, avoiding repeated full-directory scans while a Goal is idle.
 */
export function useGoalWorkspaceFiles(goalId: string | null) {
	const [state, setState] = useState<State>({
		files: [],
		loading: false,
		error: null,
		truncated: false,
	});
	const activeGoalRef = useRef<string | null>(goalId);
	const inFlightRef = useRef<InFlightRequest | null>(null);

	const fetchOnce = useCallback(
		(id: string, opts: { silent?: boolean } = {}): Promise<void> => {
			const current = inFlightRef.current;
			if (current?.goalId === id) {
				current.refreshAgain = true;
				return current.promise;
			}

			const request: InFlightRequest = {
				goalId: id,
				promise: Promise.resolve(),
				refreshAgain: false,
			};
			request.promise = (async () => {
				if (!opts.silent && activeGoalRef.current === id) {
					setState((s) => ({ ...s, loading: true, error: null }));
				}
				try {
					const body = await apiClient.get<{
						files?: {
							path: string;
							displayPath?: string;
							size: number;
							modifiedAt: string;
							title?: string;
							summary?: string;
						}[];
						truncated?: boolean;
					}>(`/api/goals/${encodeURIComponent(id)}/workspace/list`);
					if (activeGoalRef.current !== id) return;
					const files: WorkspaceFileMeta[] = (body.files ?? [])
						.map((f) => ({ ...f, mtimeMs: new Date(f.modifiedAt).getTime() }))
						.sort((a, b) => b.mtimeMs - a.mtimeMs);
					setState({ files, loading: false, error: null, truncated: !!body.truncated });
				} catch (err) {
					if (activeGoalRef.current !== id) return;
					setState((s) => ({
						...s,
						loading: false,
						error: err instanceof Error ? err.message : String(err),
					}));
				} finally {
					if (inFlightRef.current !== request) return;
					inFlightRef.current = null;
					if (request.refreshAgain && activeGoalRef.current === id) {
						void fetchOnce(id, { silent: true });
					}
				}
			})();
			inFlightRef.current = request;
			return request.promise;
		},
		[],
	);

	const refresh = useCallback(() => {
		if (goalId) void fetchOnce(goalId, { silent: true });
	}, [goalId, fetchOnce]);

	useEffect(() => {
		activeGoalRef.current = goalId;
		if (!goalId) {
			setState({ files: [], loading: false, error: null, truncated: false });
			return;
		}
		let initialLoad = true;
		const stopRefresh = startWorkspaceFilesRefresh({
			goalId,
			refresh: () => {
				void fetchOnce(goalId, { silent: !initialLoad });
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
