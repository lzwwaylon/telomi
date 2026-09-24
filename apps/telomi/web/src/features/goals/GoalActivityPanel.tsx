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
	const liveAgentOutputs = useMemo(() => researchAgentOutputsByRun(snapshot), [snapshot]);
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

function researchAgentOutputsByRun(snapshot?: GoalSnapshot | null): Map<string, ResearchAgentOutput[]> {
	const byRun = new Map<string, ResearchAgentOutput[]>();
	for (const message of snapshot?.messages ?? []) {
		if (message.role !== "toolResult" || (message.toolName !== "research" && message.toolName !== "generate_report")) continue;
		const details = message.details && typeof message.details === "object"
			? message.details as Record<string, unknown>
			: undefined;
		const runId = typeof details?.runId === "string" ? details.runId : undefined;
		if (!runId || !Array.isArray(details?.agentOutputs)) continue;
		byRun.set(runId, details.agentOutputs.filter(isResearchAgentOutput));
	}
	return byRun;
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
