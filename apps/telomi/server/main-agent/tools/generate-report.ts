import { dirname } from "node:path";

import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@sinclair/typebox";

import { ReportOnlyRuntime } from "../../research/reports/standalone-runtime.js";
import { reportPublishedResponse, reportReceiptText, reportTitle } from "../../research/reports/delivery.js";
import { inferOutputLanguage, resolveOutputLanguage, type OutputLanguage } from "../../../shared/languages.js";

const schema = Type.Object({
	report_context: Type.String({ minLength: 1, description: "Complete report brief grounded in the current Goal Wiki, including user objective, audience, preferences, prior knowledge, desired depth, format and language." }),
	title: Type.Optional(Type.String({ minLength: 1, description: "Optional exact report title." })),
}, { additionalProperties: false });

export function createGenerateReportTool(goalDir: string, options: {
	goalId: string;
	workspaceDir?: string;
	reportRuntime?: Pick<ReportOnlyRuntime, "generate">;
	getOutputLanguage?: () => OutputLanguage;
	getOriginalQuestion?: () => string | undefined;
}): AgentTool<typeof schema> {
	const workspaceDir = options.workspaceDir ?? dirname(goalDir);
	const reports = options.reportRuntime ?? new ReportOnlyRuntime(workspaceDir);
	return {
		name: "generate_report",
		label: "generate_report",
		description: "Generate and publish a report from a frozen snapshot of this Goal's current Wiki. Does not search for new external evidence.",
		parameters: schema,
		execute: async (_toolCallId, input, signal) => {
			const completed = await reports.generate(options.goalId, {
				reportContext: input.report_context.trim(),
				outputLanguage: resolveOutputLanguage(
					options.getOutputLanguage?.() ?? "auto",
					options.getOriginalQuestion?.()?.trim() || input.report_context,
				),
				...(input.title?.trim() ? { title: input.title.trim() } : {}),
			}, signal);
			const title = reportTitle(completed.content, input.title);
			const stableFinalReportPath = `/workspace/wiki/runs/${completed.runId}/${completed.reportRef}`;
			return {
				content: [{ type: "text", text: reportReceiptText(title, completed.runId) }],
				details: {
					runId: completed.runId,
					status: "published",
					stableFinalReportPath,
					reportTitle: title,
					renderFormats: ["markdown"],
					userResponse: reportPublishedResponse(inferOutputLanguage(completed.content)),
					executionKind: "report_only",
				},
			};
		},
	};
}
