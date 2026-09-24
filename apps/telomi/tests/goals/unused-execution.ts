import type { GoalExecution } from "../../server/goals/execution.js";

async function unexpectedExecution(): Promise<never> {
	throw new Error("This test must not start Agent execution");
}

export const unusedGoalExecution: GoalExecution = {
	resumeWikiUpdate: unexpectedExecution,
	createRunner: unexpectedExecution,
	executeResearchRun: unexpectedExecution,
	resumeResearchRun: unexpectedExecution,
};
