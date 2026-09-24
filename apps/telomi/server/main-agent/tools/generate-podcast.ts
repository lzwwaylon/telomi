import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@sinclair/typebox";

const schema = Type.Object({
	artifact_name: Type.String({
		minLength: 1,
		description: "Exact Markdown artifact path for the Canonical Report, relative to the Goal artifacts root.",
	}),
	instruction: Type.Optional(Type.String({
		minLength: 1,
		maxLength: 2_000,
		description: "Optional instruction for this Podcast generation only. It overrides conflicting durable Podcast Preferences.",
	})),
}, { additionalProperties: false });

export interface PodcastGenerationDispatchRequest {
	goalId: string;
	artifactName: string;
	generationInstruction?: string;
}

export type PodcastGenerationDispatchHandler = (
	request: PodcastGenerationDispatchRequest,
) => Promise<{ jobId: string; cardId: string }> | { jobId: string; cardId: string };

export function createGeneratePodcastTool(
	goalId: string,
	dispatch: PodcastGenerationDispatchHandler,
): AgentTool<typeof schema> {
	return {
		name: "generate_podcast",
		label: "generate_podcast",
		description: "Generate a Podcast from one existing Canonical Report. Durable Podcast Preferences are resolved automatically; instruction applies only to this generation.",
		parameters: schema,
		execute: async (_toolCallId, input) => {
			const result = await dispatch({
				goalId,
				artifactName: input.artifact_name.trim(),
				...(input.instruction?.trim() ? { generationInstruction: input.instruction.trim() } : {}),
			});
			return {
				content: [{ type: "text", text: `Podcast generation started for ${input.artifact_name.trim()} (job ${result.jobId}).` }],
				details: {
					jobId: result.jobId,
					cardId: result.cardId,
					userResponse: "播客已开始生成，完成后会出现在对应报告中。",
				},
			};
		},
	};
}
