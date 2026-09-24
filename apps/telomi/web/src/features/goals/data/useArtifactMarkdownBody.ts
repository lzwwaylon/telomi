import { apiClient } from "@/shared/lib/api-client";
import { useEffect, useState } from "react";

interface State {
	markdown: string;
	loading: boolean;
	error: string | null;
}

/**
 * Lazy-loads `<goalDir>/artifacts/<name>` as text. Used by MediaCard to fetch
 * the markdown body only when the user opens the overlay.
 */
export function useArtifactMarkdownBody(goalId: string, name: string, enabled: boolean) {
	const [state, setState] = useState<State>({ markdown: "", loading: false, error: null });

	useEffect(() => {
		if (!enabled || !goalId || !name) return;
		let cancelled = false;
		setState({ markdown: "", loading: true, error: null });

		(async () => {
			try {
				// The artifact body is Markdown text; retain its text error diagnostics.
				const r = await apiClient.response(
					`/api/goals/${encodeURIComponent(goalId)}/artifacts/blob?name=${encodeURIComponent(name)}`,
				);
				if (!r.ok) {
					const body = await r.text().catch(() => "");
					throw new Error(`HTTP ${r.status}: ${body.slice(0, 200)}`);
				}
				const text = await r.text();
				if (!cancelled) setState({ markdown: text, loading: false, error: null });
			} catch (err) {
				if (!cancelled) {
					setState({
						markdown: "",
						loading: false,
						error: err instanceof Error ? err.message : String(err),
					});
				}
			}
		})();

		return () => {
			cancelled = true;
		};
	}, [goalId, name, enabled]);

	return state;
}
