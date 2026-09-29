import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@sinclair/typebox";

import { executeInvestigation } from "../../research/investigate.js";
import type { CreateMainAgentToolsOptions } from "./index.js";

const schema = Type.Object({
	question: Type.String({ minLength: 1, maxLength: 20_000,
		description: "The user's complete Goal knowledge question and source restrictions. Do not guess specialist search terms or an answer." }),
	context: Type.Optional(Type.String({ maxLength: 40_000,
		description: "Relevant conversation and any already checked evidence. Prime cannot see the Main conversation." })),
	source_scope: Type.Optional(Type.Union([Type.Literal("external_allowed"), Type.Literal("local_only")], {
		description: "Use local_only only when the user explicitly restricts the answer to saved Goal materials; otherwise allow external sources after local evidence is checked.",
	})),
}, { additionalProperties: false });

export function createInvestigateTool(goalDir: string, options: CreateMainAgentToolsOptions): AgentTool<typeof schema> {
	return {
		name: "investigate",
		label: "investigate",
		description: "Ask Prime to check this Goal's saved knowledge and original materials, then use an external Provider for a remaining gap when allowed. Returns a cited answer without generating a report.",
		parameters: schema,
		executionMode: "sequential",
		async execute(toolCallId, input, signal, onUpdate) {
			const result = await executeInvestigation({
				goalDir, goalId: options.goalId, invocationId: toolCallId,
				question: input.question, context: input.context,
				allowExternal: input.source_scope !== "local_only",
				outputLanguage: options.getOutputLanguage?.(), env: options.getExtraEnv?.(), signal,
				onActivity: (activity) => onUpdate?.({
					content: [{ type: "text", text: activity.text || "Prime is checking saved Goal knowledge" }],
					details: { agentOutput: activity },
				}),
			});
			const visible = { answer: result.answer, citation_refs: result.citation_refs, gaps: result.gaps,
				investigation_id: result.id,
				userResponse: result.answer };
			return { content: [{ type: "text", text: JSON.stringify(visible) }], details: visible };
		},
	};
}
