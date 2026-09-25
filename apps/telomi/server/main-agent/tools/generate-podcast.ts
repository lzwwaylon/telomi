import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@sinclair/typebox";
import { publishedReportForPath, REPORTS_GUEST_PATH } from "../../media/report-view.js";

const schema = Type.Object({
	report: Type.String({
		minLength: 1,
		description: `The Canonical Report's directory under ${REPORTS_GUEST_PATH}, as listed by \`ls ${REPORTS_GUEST_PATH}\` (its report.md path is accepted too).`,
	}),
	instruction: Type.Optional(Type.String({
		minLength: 1,
		maxLength: 2_000,
		description: "Optional instruction for this Podcast generation only. It overrides conflicting durable Podcast Preferences. Omit it when retrying a failed generation: the retry then continues from its finished Podcast Script, while a new instruction writes the script again.",
	})),
}, { additionalProperties: false });

export interface PodcastGenerationDispatchRequest {
	goalId: string;
	cardId: string;
	generationInstruction?: string;
}

export type PodcastGenerationDispatchHandler = (
	request: PodcastGenerationDispatchRequest,
) => Promise<{ jobId: string }> | { jobId: string };

export function createGeneratePodcastTool(
	goalId: string,
	goalDir: string,
	dispatch: PodcastGenerationDispatchHandler,
): AgentTool<typeof schema> {
	return {
		name: "generate_podcast",
		label: "generate_podcast",
		description: "Generate a Podcast from one Canonical Report, replacing the report's current Podcast. Durable Podcast Preferences are resolved automatically; instruction applies only to this generation.",
		parameters: schema,
		execute: async (_toolCallId, input) => {
			const requested = input.report.trim();
			const report = publishedReportForPath(goalDir, requested);
			if (!report) {
				throw new Error(`${requested} is not a published report. Run \`ls ${REPORTS_GUEST_PATH}\` to see the published reports.`);
			}
			const result = await dispatch({
				goalId,
				cardId: report.cardId,
				...(input.instruction?.trim() ? { generationInstruction: input.instruction.trim() } : {}),
			});
			const directory = `${REPORTS_GUEST_PATH}/${report.name}`;
			return {
				content: [{ type: "text", text: `Podcast generation started for ${directory} (job ${result.jobId}). When it succeeds, its Podcast Script appears at ${directory}/podcast.md.` }],
				details: {
					jobId: result.jobId,
					cardId: report.cardId,
					userResponse: "播客已开始生成，完成后会出现在对应报告中。",
				},
			};
		},
	};
}
