import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@sinclair/typebox";

import { executeInvestigation, readInvestigationResult } from "../../research/investigate.js";
import { publishInvestigationHandoff } from "../investigation-handoff.js";
import type { CreateMainAgentToolsOptions } from "./index.js";

const schema = Type.Object({
	question: Type.String({ minLength: 1, maxLength: 20_000,
		description: "The user's complete Goal knowledge question and source restrictions. Do not guess specialist search terms or an answer." }),
	context: Type.Optional(Type.String({ maxLength: 40_000,
		description: "Current constraints and relevant conversation. A continued thread restores its own investigation progress; do not repeat its full history." })),
	thread_id: Type.Optional(Type.String({ pattern: "^[a-f0-9]{24}$",
		description: "Continue a saved investigation thread using its returned id or the Goal's investigation thread catalog. Omit for a new subject. Never invent an id." })),
	title: Type.Optional(Type.String({ minLength: 1, maxLength: 120,
		description: "A concise title describing the investigation thread. Prefer a recognizable topic over the full question." })),
	source_scope: Type.Optional(Type.Union([Type.Literal("external_allowed"), Type.Literal("local_only")], {
		description: "Use local_only when the user restricts the answer to saved Goal materials; otherwise use external_allowed after local evidence is checked. Omission grants local-only access.",
	})),
}, { additionalProperties: false });

export function createInvestigateTool(goalDir: string, options: CreateMainAgentToolsOptions): AgentTool<typeof schema> {
	return {
		name: "investigate",
		label: "investigate",
		description: "Start or continue a Goal investigation thread. Prime checks saved knowledge and original materials, then external evidence when allowed. Returns thread_id and a saved result receipt. Read result_ref before deliver_investigation.",
		parameters: schema,
		executionMode: "sequential",
		async execute(toolCallId, input, signal, onUpdate) {
			const result = await executeInvestigation({
				goalDir, goalId: options.goalId, invocationId: toolCallId,
				question: input.question, context: input.context,
				threadId: input.thread_id, title: input.title,
				allowExternal: input.source_scope === "external_allowed",
				outputLanguage: options.getOutputLanguage?.(), env: options.getExtraEnv?.(), signal,
				onActivity: (activity) => onUpdate?.({
					content: [{ type: "text", text: activity.text || "Prime is checking saved Goal knowledge" }],
					details: { agentOutput: activity },
				}),
			});
			const { artifact, receipt } = publishInvestigationHandoff(goalDir, result);
			options.exposeInvestigationResult?.(artifact);
			return { content: [{ type: "text", text: JSON.stringify(receipt) }], details: receipt };
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
