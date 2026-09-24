import { renderAgentPrompt } from "../agent-runtime/prompt-registry.js";

export type ScheduledResearchSkipReason =
	| "no_source_increment"
	| "no_qualifying_evidence";

export interface ScheduledResearchSource {
	sourceIdentity: string;
	contentSha256: string;
}

export interface ScheduledResearchContext {
	scheduleId: string;
	occurrenceId: string;
	monitoringScope: string;
	window: {
		startAt: string;
		endAt: string;
		timeZone: string;
	};
	processedSources: ScheduledResearchSource[];
}

export function appendScheduledResearchSystemPrompt(
	basePrompt: string,
	context: ScheduledResearchContext | undefined,
): string {
	if (!context) return basePrompt;
	return `${basePrompt}\n\n${renderAgentPrompt("research", "prime-search", "system-append", scheduledVariables(context),
		"scheduled").content}`;
}

export function renderScheduledResearchUserContext(
	context: ScheduledResearchContext,
): string {
	return renderAgentPrompt("research", "prime-search", "user", scheduledVariables(context),
		"scheduled-context").content;
}

function scheduledVariables(context: ScheduledResearchContext): Record<string, string | number> {
	return {
		monitoring_scope: context.monitoringScope.trim(),
		schedule_id: context.scheduleId,
		occurrence_id: context.occurrenceId,
		window_start: context.window.startAt,
		window_end: context.window.endAt,
		time_zone: context.window.timeZone,
		processed_source_count: context.processedSources.length,
	};
}
