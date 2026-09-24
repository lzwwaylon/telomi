import { subscribeGoalEvents, type GoalsEvent } from "@/shared/lib/goalsEventsStream";
import { refreshOnReconnect } from "@/shared/lib/sharedEventSource";

type SubscribeGoalEvents = (
	goalId: string,
	listener: (event: GoalsEvent) => void,
	onConnectionChange?: (connected: boolean) => void,
) => () => void;

export interface WorkspaceFilesRefreshOptions {
	goalId: string;
	refresh: () => void;
	subscribe?: SubscribeGoalEvents;
}

export function startWorkspaceFilesRefresh({
	goalId,
	refresh,
	subscribe = subscribeGoalEvents,
}: WorkspaceFilesRefreshOptions): () => void {
	refresh();
	return subscribe(goalId, (event) => {
		if (event.type === "goal:run-completed") {
			refresh();
			return;
		}
		if (event.type === "research-run:changed" && event.status === "settled") {
			refresh();
			return;
		}
		if (event.type === "media-product:status" && event.status === "done") refresh();
	}, refreshOnReconnect(refresh));
}
