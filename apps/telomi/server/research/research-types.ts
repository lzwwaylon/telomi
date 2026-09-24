export interface LogicalSource {
	id: string;
	title: string;
	url: string;
	providerId: string;
	sourceIdentity: string;
	revisionSha256: string;
	directoryPath: string;
	organizationKind: "cross_provider" | "ungrouped";
	groupId?: string;
	updateContext?: {
		newMemberPaths: string[];
		changedMemberPaths: string[];
	};
	members: Array<{
		sourceId: string;
		providerId: string;
		title: string;
		canonicalLocator: string;
		path?: string;
	}>;
}

export interface ResearchTemporalContext {
	schemaVersion: 1;
	currentDate: string;
	timeZone: string;
	resolvedRange?: {
		kind: "year_to_date" | "scheduled_interval";
		startDate: string;
		endDate: string;
		inclusive: true;
		sourceText: string;
		startAt?: string;
		endAt?: string;
	};
}

export interface RunStageReport {
	schemaVersion: 1;
	runId: string;
	stageId: string;
	status: "running" | "succeeded" | "degraded" | "failed" | "cancelled" | "interrupted";
	startedAt: string;
	finishedAt?: string;
	durationMs?: number;
	expected: Record<string, unknown>;
	actual: Record<string, unknown>;
	metrics: {
		inputCount?: number;
		outputCount?: number;
		modelCalls?: number;
		inputTokens?: number;
		outputTokens?: number;
	};
}

export type ResearchRenderFormat = "markdown";

export interface ResearchRuntimeConfig {
	outputLanguage: import("../../shared/languages.js").ResolvedOutputLanguage;
	documentConcurrency: number;
	cornellNoteModel: string;
	/** Frozen with the model: the Evidence Note Stage reasons at the depth the Run started with. */
	cornellNoteThinkingLevel: import("../agent-runtime/model-config/resolve.js").ThinkingLevel;
}

export interface ResearchProgressEvent {
	stage: "search_batch" | "cornell_notes" | "wiki_compiler" | "report_writer" | "citation_compiler" | "wiki_publish" | "complete";
	status: "running" | "succeeded" | "failed" | "cancelled";
	sequence?: number;
	detail?: string;
}
