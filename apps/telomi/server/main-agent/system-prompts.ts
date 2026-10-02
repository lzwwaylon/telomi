import { readUserTaskHistory } from "../observability/task-history.js";
import { serverRuntimeDirForGoal } from "../workspaces/server-runtime-paths.js";
import { composeAgentSystemPrompt } from "../agent-runtime/global-system-prompt.js";
import { GoalTopicPlanStore } from "../goals/topic-plan/index.js";
import { renderAgentPrompt } from "../agent-runtime/prompt-registry.js";
import type { OutputLanguage } from "../../shared/languages.js";

export interface MainAgentPromptContext {
	title: string;
	description: string;
	outputLanguage: OutputLanguage;
	topicReady: boolean;
	topicActive: boolean;
	previousSearches: unknown[];
	/** Frozen user preference context, separate from project instructions. */
	globalPreferences: string | null;
}

export function readMainAgentPromptContext(
	workspacePath: string, goalId: string, title: string, description: string, outputLanguage: OutputLanguage = "auto",
): MainAgentPromptContext {
	const topicStore = new GoalTopicPlanStore(goalId, workspacePath);
	const activeTopicPlan = topicStore.readActive();
	return { title, description, outputLanguage,
		topicReady: Boolean(activeTopicPlan) && !topicStore.hasPendingRequiredConfirmation(),
		topicActive: Boolean(activeTopicPlan), globalPreferences: null,
		previousSearches: readUserTaskHistory(serverRuntimeDirForGoal(goalId, workspacePath))
			.filter((task) => task.route?.executionKind === "research_runtime").slice(-10)
			.map((task) => ({ run_id: task.route?.workspaceRunId, search_question: task.canonicalResearchTask,
				status: task.researchRun?.status, completed_at: task.updatedAt })),
	};
}

// Main-agent routing contract.
// Passed as ResourceLoader.getSystemPrompt() → buildSystemPrompt(customPrompt).
export function buildMainAgentPrompt(
	workspacePath: string,
	goalId: string,
	title: string,
	description: string,
	outputLanguage: OutputLanguage = "auto",
): string {
	return renderMainAgentPrompt(readMainAgentPromptContext(workspacePath, goalId, title, description, outputLanguage));
}

/** Current instructions over frozen structured business state. */
export function renderMainAgentPrompt(context: MainAgentPromptContext): string {
	const goalBlock = [context.title.trim(), context.description.trim()].filter(Boolean).join("\n\n") || "(not yet defined)";
	const agentPrompt = renderAgentPrompt("main", "router", "system", {
		goal: goalBlock,
		previous_searches: JSON.stringify(context.previousSearches),
		output_language: context.outputLanguage,
		topic_ready: context.topicReady,
		topic_active: context.topicActive,
	}).content;
	return composeAgentSystemPrompt(agentPrompt, { showFilePaths: false });
}
