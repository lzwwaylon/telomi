import { subscribeGoalsEvents, type GoalsEvent } from "@/shared/lib/goalsEventsStream";

const latestByProvider = new Map<string, unknown>();

function accountStates(event: GoalsEvent): Array<[string, unknown]> {
	if (event.type === "snapshot") return Object.entries(event.accounts ?? {});
	if (event.type === "account:changed") return [[event.provider, event.state]];
	return [];
}

/**
 * Reuses the global control-plane SSE across the badge, notification monitor,
 * and Settings UI. Delivers only the given provider's account chain.
 */
export function subscribeProviderAccountsEvents<T>(provider: string, listener: (state: T) => void): () => void {
	let delivered = false;
	const unsubscribe = subscribeGoalsEvents((event) => {
		for (const [eventProvider, state] of accountStates(event)) {
			latestByProvider.set(eventProvider, state);
			if (eventProvider !== provider) continue;
			delivered = true;
			listener(state as T);
		}
	});
	if (!delivered && latestByProvider.has(provider)) listener(latestByProvider.get(provider) as T);
	return unsubscribe;
}
