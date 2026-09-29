import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@sinclair/typebox";

import { executeInvestigation, readInvestigationResult } from "../../research/investigate.js";
import type { CreateMainAgentToolsOptions } from "./index.js";

const schema = Type.Object({
	question: Type.String({ minLength: 1, maxLength: 20_000,
		description: "The user's complete Goal knowledge question and source restrictions. Do not guess specialist search terms or an answer." }),
	context: Type.Optional(Type.String({ maxLength: 40_000,
		description: "Relevant conversation and any already checked evidence. Prime cannot see the Main conversation." })),
	source_scope: Type.Optional(Type.Union([Type.Literal("external_allowed"), Type.Literal("local_only")], {
		description: "Use local_only when the user restricts the answer to saved Goal materials; otherwise use external_allowed after local evidence is checked. Omission grants local-only access.",
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
				allowExternal: input.source_scope === "external_allowed",
				outputLanguage: options.getOutputLanguage?.(), env: options.getExtraEnv?.(), signal,
				onActivity: (activity) => onUpdate?.({
					content: [{ type: "text", text: activity.text || "Prime is checking saved Goal knowledge" }],
					details: { agentOutput: activity },
				}),
			});
			const visible = { answer: result.answer, citation_refs: result.citation_refs, gaps: result.gaps,
				investigation_id: result.id };
			return { content: [{ type: "text", text: JSON.stringify(visible) }], details: visible };
		},
	};
}

const deliverySchema = Type.Object({ investigation_id: Type.String({ pattern: "^[a-f0-9]{24}$" }) }, { additionalProperties: false });

export function createDeliverInvestigationTool(goalDir: string): AgentTool<typeof deliverySchema> {
	return {
		name: "deliver_investigation",
		label: "deliver_investigation",
		description: "Deliver a completed Prime investigation's cited answer verbatim after checking that it addresses the user's request. Use investigate again if evidence is still missing.",
		parameters: deliverySchema,
		execute: async (_toolCallId, input) => {
			const result = readInvestigationResult(goalDir, input.investigation_id);
			return { content: [{ type: "text", text: result.answer }],
				details: { userResponse: result.answer, investigation_id: result.id } };
		},
	};
}
