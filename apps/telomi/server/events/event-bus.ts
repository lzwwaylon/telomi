import type { AppEvent } from "../../shared/events/app-events.js";

export type { AppEvent } from "../../shared/events/app-events.js";

type Listener = (event: AppEvent) => void;
const listeners = new Set<Listener>();

export function publish(event: AppEvent): void {
	for (const listener of [...listeners]) {
		try {
			listener(event);
		} catch (error) {
			console.warn("[telomi][app-events] listener failed", error);
		}
	}
}

export function subscribe(listener: Listener): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}
