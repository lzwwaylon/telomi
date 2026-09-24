import { apiClient } from "./api-client.js";
/**
 * In-memory request deduper for read-only `/api/*` endpoints that several
 * components (or several mount cycles in StrictMode dev) hit simultaneously.
 *
 * Within `ttlMs` of the last successful response, repeat callers receive the
 * cached value synchronously. Callers issued while a request is in flight
 * share the same Promise. Aborts only abort that single caller's await — the
 * underlying fetch keeps going so other callers still settle.
 *
 * No tag-based invalidation; tune `ttlMs` low (≤ 30s) for endpoints that need
 * fresh data, or call `bustSharedFetch(url)` to manually drop a cached value.
 */
type Entry<T> = {
	value?: T;
	cachedAt: number;
	pending?: Promise<T>;
};

const cache = new Map<string, Entry<unknown>>();
const bustedThisTurn = new Set<string>();

interface SharedFetchOptions {
	ttlMs: number;
	signal?: AbortSignal;
}

export async function sharedFetch<T>(url: string, opts: SharedFetchOptions): Promise<T> {
	const now = Date.now();
	const existing = cache.get(url) as Entry<T> | undefined;
	if (existing) {
		if (existing.pending) {
			// Mid-flight: piggyback on the in-flight promise.
			return raceWithSignal(existing.pending, opts.signal);
		}
		if (existing.value !== undefined && now - existing.cachedAt < opts.ttlMs) {
			return existing.value;
		}
	}
	let pending!: Promise<T>;
	pending = (async () => {
		const value = await apiClient.get<T>(url);
		if ((cache.get(url) as Entry<T> | undefined)?.pending === pending) {
			cache.set(url, { value, cachedAt: Date.now() });
		}
		return value;
	})();
	cache.set(url, { ...(existing ?? { cachedAt: 0 }), pending });
	pending.catch(() => {
		// On error, drop pending so the next caller retries.
		const cur = cache.get(url) as Entry<T> | undefined;
		if (cur && cur.pending === pending) {
			cache.set(url, { ...(cur.value !== undefined ? { value: cur.value, cachedAt: cur.cachedAt } : { cachedAt: 0 }) });
		}
	});
	return raceWithSignal(pending, opts.signal);
}

function raceWithSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
	if (!signal) return promise;
	if (signal.aborted) return Promise.reject(new DOMException("Aborted", "AbortError"));
	return new Promise<T>((resolve, reject) => {
		const onAbort = () => {
			signal.removeEventListener("abort", onAbort);
			reject(new DOMException("Aborted", "AbortError"));
		};
		signal.addEventListener("abort", onAbort);
		promise.then(
			(v) => {
				signal.removeEventListener("abort", onAbort);
				resolve(v);
			},
			(e) => {
				signal.removeEventListener("abort", onAbort);
				reject(e);
			},
		);
	});
}

/** Drop a cached value so the next `sharedFetch` caller re-issues. */
export function bustSharedFetch(url: string): void {
	if (bustedThisTurn.has(url)) return;
	bustedThisTurn.add(url);
	queueMicrotask(() => bustedThisTurn.delete(url));
	cache.delete(url);
}
