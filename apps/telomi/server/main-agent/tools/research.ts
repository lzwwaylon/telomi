import { readUserTaskHistory } from "../../observability/task-history.js";
import { serverRuntimeDirForGoal } from "../../workspaces/server-runtime-paths.js";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@sinclair/typebox";

import type { CreateMainAgentToolsOptions } from "./index.js";
import { createResearchRunTool, researchScheduleSchema } from "./research-run.js";

const schema = Type.Object({
	search_question: Type.String({
		minLength: 1,
		description: "Standalone question for missing or updated evidence, including search constraints and what previous research already covered.",
	}),
	report_context: Type.String({ minLength: 1, description: "Complete report brief: user objective, audience, preferences, prior knowledge, relevant conversation, desired depth, format and language. Downstream writers cannot see the conversation." }),
	report_title: Type.Optional(Type.String({ minLength: 1 })),
	schedule: Type.Optional(Type.Union([researchScheduleSchema, Type.Null()])),
}, { additionalProperties: false });

export function createMainResearchTool(goalDir: string, options: CreateMainAgentToolsOptions): AgentTool<typeof schema> {
	const run = createResearchRunTool(goalDir, {
		...options,
		getSourceUserQuestion: options.getOriginalQuestion,
		taskSource: "main_agent",
	});
	return {
		name: "research",
		label: "research",
		description: "Acquire new external evidence, screen it, incrementally update the Goal Wiki, and publish the resulting report.",
		parameters: schema,
		execute: (toolCallId, input, signal, onUpdate) => run.execute(toolCallId, {
			reason: "Main Agent requested new external evidence.",
			search_question: input.search_question.trim(),
			report_context: input.report_context.trim(),
			...(input.report_title?.trim() ? { reportTitle: input.report_title.trim() } : {}),
			...(input.schedule ? { schedule: input.schedule } : {}),
		}, signal, onUpdate),
	};
}

const historySchema = Type.Object({
	offset: Type.Integer({ minimum: 0, description: "Offset from the newest Research Run; start at zero." }),
	limit: Type.Integer({ minimum: 1, maximum: 20 }),
}, { additionalProperties: false });

export function createResearchHistoryTool(options: CreateMainAgentToolsOptions): AgentTool<typeof historySchema> {
	return {
		name: "research_history",
		label: "research_history",
		description: "Read previous search questions and outcomes for this Goal, newest first. Page through relevant history to avoid repeating successful research and identify failed or stale searches.",
		parameters: historySchema,
		async execute(_id, input) {
			const runs = readUserTaskHistory(serverRuntimeDirForGoal(options.goalId, options.workspaceDir))
				.filter((task) => task.route?.executionKind === "research_runtime").reverse();
			const end = input.offset + input.limit;
			const result = {
				runs: runs.slice(input.offset, end).map((task) => ({
					run_id: task.route?.workspaceRunId,
					search_question: task.canonicalResearchTask,
					status: task.researchRun?.status,
					completed_at: task.updatedAt,
					error: task.researchRun?.errorMessage,
				})),
				next_offset: end < runs.length ? end : null,
			};
			return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
		},
	};
}
