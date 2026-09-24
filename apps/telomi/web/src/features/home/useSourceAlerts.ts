import { useEffect, useState } from "react";
import { sourceUnavailable, type SourcesResponse } from "@shared/sources.js";
import { apiClient } from "@/shared/lib/api-client";
import { subscribeGoalsEvents } from "@/shared/lib/goalsEventsStream";
import { uiText } from "@/app/ui-text";
import type { MessageId } from "@/app/locales/zh-CN";

export interface SourceAlert {
	id: string;
	sourceId: string;
	kind: "needs_login" | "error";
	title: string;
	description: string;
}

/**
 * External sources that research runs currently skip: switched-on sources whose last verification
 * found no login or failed. Reloaded whenever the Runtime reports a source's state changed.
 */
export function useSourceAlerts(): SourceAlert[] {
	const [sources, setSources] = useState<SourcesResponse["sources"]>([]);

	useEffect(() => {
		let stopped = false;
		const load = () => {
			void apiClient.get<SourcesResponse>("/api/sources")
				.then((next) => { if (!stopped) setSources(next.sources); })
				.catch(() => undefined);
		};
		load();
		const unsubscribe = subscribeGoalsEvents((event) => {
			if (event.type === "source-status:changed") load();
		});
		return () => {
			stopped = true;
			unsubscribe();
		};
	}, []);

	return sources.flatMap((source) => {
		if (!source.enabled || !sourceUnavailable(source.status)) return [];
		const kind = source.status!.state as "needs_login" | "error";
		const name = uiText(`settings.source.name.${source.id}` as MessageId);
		return [{
			id: `source-alert-${source.id}`,
			sourceId: source.id,
			kind,
			title: uiText(kind === "needs_login" ? "inbox.sourceNeedsLogin" : "inbox.sourceFailed", { source: name }),
			description: uiText(kind === "needs_login" ? "inbox.sourceNeedsLoginDescription" : "inbox.sourceFailedDescription", { source: name }),
		}];
	});
}
