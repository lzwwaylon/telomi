import { useEffect, useState } from "react";

/**
 * Current time that re-renders the caller on a fixed interval, so relative labels such as
 * "5 minutes ago" and "due" states stay correct while the page is left open.
 */
export function useNow(intervalMs = 30_000): number {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
		return () => window.clearInterval(timer);
	}, [intervalMs]);
	return now;
}
