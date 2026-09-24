import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { bustSharedFetch, sharedFetch } from "@/shared/lib/use-shared-fetch";
import type { GoalSummary, TodayRollup } from "@shared/types";

const REFETCH_THROTTLE_MS = 1500;
const TODAY_URL = "/api/today";
// Window during which redundant in-component triggers reuse the same response.
// SSE storms + StrictMode double-mount can fire many
// `trigger()`s in tens of milliseconds; the local 1.5s throttle still applies,
// and `sharedFetch` collapses any survivors that slip through.
const SHARED_TTL_MS = 1500;

function emptyRollup(): TodayRollup {
	const d = new Date();
	const y = d.getFullYear();
	const m = String(d.getMonth() + 1).padStart(2, "0");
	const day = String(d.getDate()).padStart(2, "0");
	return {
		date: `${y}-${m}-${day}`,
		liveGoals: 0,
		productsToday: 0,
	};
}

/**
 * 拉 /api/today 的真聚合(liveGoals/productsToday)。
 * goals 列表更新(任一 goal 的 lastActivityAt 跳变)时自动 refetch。
 * 节流 1.5s 防 SSE 风暴 + sharedFetch 模块级 TTL dedupe 防 StrictMode 双挂载/多组件并发。
 * 初始值是零(避免 mock 数字闪一下),首次拉到真值时切换。
 */
export function useTodayRollup(goals: GoalSummary[] | null): TodayRollup {
	const [rollup, setRollup] = useState<TodayRollup>(emptyRollup);
	const lastFetchRef = useRef(0);
	const inFlightRef = useRef<AbortController | null>(null);
	const mountedRef = useRef(true);

	const trigger = useCallback((opts?: { force?: boolean }) => {
		const now = Date.now();
		if (!opts?.force && now - lastFetchRef.current < REFETCH_THROTTLE_MS) return;
		lastFetchRef.current = now;
		inFlightRef.current?.abort();
		const ctrl = new AbortController();
		inFlightRef.current = ctrl;
		// Goal events must bypass a snapshot cached immediately before the event.
		if (opts?.force) bustSharedFetch(TODAY_URL);
		sharedFetch<TodayRollup>(TODAY_URL, { ttlMs: SHARED_TTL_MS, signal: ctrl.signal })
			.then((data) => {
				if (data && mountedRef.current) setRollup(data);
			})
			.catch(() => {
				/* aborted or network — keep last value */
			});
	}, []);

	// Lifecycle: mark mounted=true on every (re-)mount; only flip false on real
	// teardown. StrictMode dev mounts → cleanup → mounts again — without resetting
	// mountedRef on the second mount, late-arriving fetches would silently drop
	// their setRollup call and the banner would be stuck on the zero seed.
	useEffect(() => {
		mountedRef.current = true;
		return () => {
			mountedRef.current = false;
		};
	}, []);

	useEffect(() => {
		trigger();
		return () => {
			// Don't abort in-flight: in StrictMode dev the first fetch would be
			// killed by the immediate cleanup, and the throttled second-mount
			// trigger wouldn't fire — banner would stay on the zero seed forever.
			// Stale fetches still no-op via mountedRef once we truly unmount.
		};
	}, [trigger]);

	const sig = useMemo(() => {
		if (!goals) return "";
		return goals.map((g) => `${g.id}:${g.lastActivityAt}`).join(",");
	}, [goals]);

	useEffect(() => {
		if (sig) trigger({ force: true });
	}, [sig, trigger]);

	return rollup;
}
