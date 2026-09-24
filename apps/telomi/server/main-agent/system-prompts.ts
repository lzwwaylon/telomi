import { readUserTaskHistory } from "../observability/task-history.js";
import { serverRuntimeDirForGoal } from "../workspaces/server-runtime-paths.js";
import { composeAgentSystemPrompt } from "../agent-runtime/global-system-prompt.js";
import { GoalTopicPlanStore } from "../goals/topic-plan/index.js";
import { renderAgentPrompt } from "../agent-runtime/prompt-registry.js";
import type { OutputLanguage } from "../../shared/languages.js";

// Main-agent routing contract.
// Passed as ResourceLoader.getSystemPrompt() → buildSystemPrompt(customPrompt).
export function buildMainAgentPrompt(
	workspacePath: string,
	goalId: string,
	title: string,
	description: string,
	outputLanguage: OutputLanguage = "auto",
): string {
	const goalBlock = [title.trim(), description.trim()].filter(Boolean).join("\n\n")
		|| "(not yet defined)";
	const topicStore = new GoalTopicPlanStore(goalId, workspacePath);
	const activeTopicPlan = topicStore.readActive();
	const researchReady = Boolean(activeTopicPlan) && !topicStore.hasPendingRequiredConfirmation();
	const agentPrompt = renderAgentPrompt("main", "router", "system", {
		goal: goalBlock,
		previous_searches: JSON.stringify(readUserTaskHistory(serverRuntimeDirForGoal(goalId, workspacePath))
			.filter((task) => task.route?.executionKind === "research_runtime").slice(-10)
			.map((task) => ({ run_id: task.route?.workspaceRunId, search_question: task.canonicalResearchTask, status: task.researchRun?.status, completed_at: task.updatedAt }))),
		output_language: outputLanguage,
		topic_ready: researchReady,
		topic_active: Boolean(activeTopicPlan),
	}).content;
	return composeAgentSystemPrompt(agentPrompt, { showFilePaths: false });
}
