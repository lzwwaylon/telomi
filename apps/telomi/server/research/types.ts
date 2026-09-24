export type ResearchNodeStatus =
	| "pending"
	| "ready"
	| "running"
	| "succeeded"
	| "retryable_failed"
	| "repair_required"
	| "blocked"
	| "failed"
	| "cancelled";

export interface ResearchExecutionUsage {
	inputTokens: number;
	outputTokens: number;
	costUsd: number;
	items: number;
}

export interface ResearchExecutionResult {
	runId: string;
	status: "succeeded" | "skipped" | "blocked" | "failed" | "cancelled";
	workflowId: string;
	workflowVersion: number;
	startedAt: string;
	finishedAt: string;
	nodeStatuses: Record<string, ResearchNodeStatus>;
	usage: ResearchExecutionUsage;
	error?: string;
}
