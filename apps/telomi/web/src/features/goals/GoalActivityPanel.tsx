import { useMemo, useState } from "react";

import type { GoalSnapshot, ResearchAgentOutput } from "@shared/types";
import { useGoalActivityProjection } from "@/features/goals/data/useActivityProjection";
import { GoalActivityPanelView } from "@/features/goals/GoalActivityPanelView";

export function GoalActivityPanel({
	goalId,
	snapshot,
}: {
	goalId: string;
	snapshot?: GoalSnapshot | null;
}) {
	const { projection, loading, loadingMore, error, connection, loadMore } =
		useGoalActivityProjection(goalId);
	const liveAgentOutputs = useMemo(() => agentOutputsByExecution(snapshot), [snapshot]);
	const [selection, setSelection] = useState<{ goalId: string; activityId: string } | null>(null);
	// Switching Goal clears the selection; the tag also hides it from the render that notices the switch.
	if (selection && selection.goalId !== goalId) setSelection(null);

	return (
		<GoalActivityPanelView
			projection={projection}
			connection={connection}
			error={error}
			loading={loading}
			loadingMore={loadingMore}
			onLoadMore={() => void loadMore()}
			liveAgentOutputs={liveAgentOutputs}
			selectedActivityId={selection?.goalId === goalId ? selection.activityId : null}
			onSelectActivity={(activityId) => setSelection(activityId ? { goalId, activityId } : null)}
		/>
	);
}

export function agentOutputsByExecution(snapshot?: Pick<GoalSnapshot, "messages"> | null): Map<string, ResearchAgentOutput[]> {
	const byExecution = new Map<string, ResearchAgentOutput[]>();
	for (const message of snapshot?.messages ?? []) {
		if (message.role !== "toolResult" || !["research", "generate_report", "investigate"].includes(message.toolName)) continue;
		const details = message.details && typeof message.details === "object"
			? message.details as Record<string, unknown>
			: undefined;
		const executionId = message.toolName === "investigate" ? details?.investigationId : details?.runId;
		if (typeof executionId !== "string") continue;
		if (message.toolName === "investigate") {
			if (!details?.agentOutput || typeof details.agentOutput !== "object") continue;
			const output = { updatedAt: message.timestamp, ...details.agentOutput };
			if (isResearchAgentOutput(output)) byExecution.set(executionId, [output]);
		} else if (Array.isArray(details?.agentOutputs)) {
			byExecution.set(executionId, details.agentOutputs.filter(isResearchAgentOutput));
		}
	}
	return byExecution;
}

function isResearchAgentOutput(value: unknown): value is ResearchAgentOutput {
	if (!value || typeof value !== "object") return false;
	const output = value as Record<string, unknown>;
	return typeof output.stageId === "string"
		&& typeof output.attemptId === "string"
		&& typeof output.role === "string"
		&& typeof output.updatedAt === "number"
		&& (output.status === "running" || output.status === "succeeded" || output.status === "failed")
		&& (output.kind === "status" || output.kind === "text" || output.kind === "tool");
}
