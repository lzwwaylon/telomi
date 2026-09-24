// In dev, vite proxies `/api/*` from :5174 to :8787. The proxy is fine for
// short-lived fetches but leaks sockets on long-lived SSE streams — they pile
// up on the vite side and quickly exhaust the browser's per-host HTTP/1.1
// 6-connection cap, which manifests as page refreshes hanging indefinitely.
//
// Dev opens the single App EventSource straight at the backend host so Vite
// never owns the long-lived socket. Production remains same-origin.
const env = (import.meta as unknown as { env?: Record<string, string | boolean | undefined> }).env;
const configuredEventSourceBase = typeof env?.VITE_API_BASE === "string" ? env.VITE_API_BASE : "";

const EVENT_SOURCE_BASE: string =
	configuredEventSourceBase || (env?.DEV === true ? "http://localhost:8787" : "");

export function apiUrl(path: string): string {
	return path.startsWith("/") ? path : `/${path}`;
}

export function eventSourceUrl(path: string): string {
	if (!EVENT_SOURCE_BASE) return apiUrl(path);
	return path.startsWith("/") ? `${EVENT_SOURCE_BASE}${path}` : `${EVENT_SOURCE_BASE}/${path}`;
}

export function webSocketUrl(path: string): string {
	const url = new URL(eventSourceUrl(path), window.location.href);
	url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
	return url.toString();
}
