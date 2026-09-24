import { useEffect, useState } from "react";
import { CAPABILITY_SETTINGS_SECTION, type CapabilityAlert, type CapabilityAlertsResponse } from "@shared/capability-alerts.js";
import { apiClient } from "@/shared/lib/api-client";
import { readableErrorText } from "@/shared/lib/activity-text";
import { subscribeGoalsEvents } from "@/shared/lib/goalsEventsStream";
import { uiText } from "@/app/ui-text";

export interface CapabilityInboxAlert {
	id: string;
	kind: CapabilityAlert["kind"];
	title: string;
	description: string;
	target: (typeof CAPABILITY_SETTINGS_SECTION)[CapabilityAlert["area"]];
}

/** Service states the Runtime does not announce, such as Memory failing to start, still reach the inbox within this. */
const REFRESH_MS = 60_000;

/**
 * Capabilities that cannot work until the user changes a setting: nothing chosen, a model its
 * Provider refused, or a service that failed. Each alert opens the settings page that fixes it.
 */
export function useCapabilityAlerts(): CapabilityInboxAlert[] {
	const [alerts, setAlerts] = useState<CapabilityAlert[]>([]);

	useEffect(() => {
		let stopped = false;
		const load = () => {
			void apiClient.get<CapabilityAlertsResponse>("/api/capability-alerts")
				.then((next) => { if (!stopped) setAlerts(next.alerts); })
				.catch(() => undefined);
		};
		load();
		const interval = window.setInterval(load, REFRESH_MS);
		const unsubscribe = subscribeGoalsEvents((event) => {
			if (event.type === "capability-alerts:changed" || event.type === "source-status:changed") load();
		});
		return () => {
			stopped = true;
			window.clearInterval(interval);
			unsubscribe();
		};
	}, []);

	return alerts.map(inboxAlert);
}

function inboxAlert(alert: CapabilityAlert): CapabilityInboxAlert {
	const target = CAPABILITY_SETTINGS_SECTION[alert.area];
	if (alert.kind === "unset") {
		return {
			id: `capability-unset-${alert.area}`,
			kind: alert.kind,
			title: uiText(`inbox.capability.unset.${alert.area}`),
			description: uiText(`inbox.capability.unset.${alert.area}.description`),
			target,
		};
	}
	if (alert.kind === "rejected") {
		return {
			id: `capability-rejected-${alert.area}-${alert.model}`,
			kind: alert.kind,
			title: uiText(`inbox.capability.rejected.${alert.area}`),
			description: uiText("inbox.capability.rejected.description", { error: readableErrorText(alert.error), model: alert.model }),
			target,
		};
	}
	return {
		id: `capability-failed-${alert.area}`,
		kind: alert.kind,
		title: uiText(`inbox.capability.failed.${alert.area}`),
		description: alert.error ?? uiText(`inbox.capability.failed.${alert.area}.description`),
		target,
	};
}
