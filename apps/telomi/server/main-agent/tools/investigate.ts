import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@sinclair/typebox";

import { executeInvestigation, readInvestigationResult } from "../../research/investigate.js";
import { publishInvestigationHandoff } from "../investigation-handoff.js";
import { publishInvestigationReport } from "../../research/investigation-report.js";
import { reportPublishedResponse, reportReceiptText } from "../../research/reports/delivery.js";
import { publishedReportGuestPath } from "../../media/report-view.js";
import { inferOutputLanguage } from "../../../shared/languages.js";
import { resolveGoalOutputLanguage } from "../../../shared/languages.js";
import { dirname } from "node:path";
import { registerSavedInvestigationCues, startGoalCueWikiUpdates } from "../../research/cue-wiki-trigger.js";
import type { CreateMainAgentToolsOptions } from "./index.js";

const schema = Type.Object({
	question: Type.String({ minLength: 1, maxLength: 20_000,
		description: "The user's complete Goal knowledge question and source restrictions. Do not guess specialist search terms or an answer." }),
	context: Type.Optional(Type.String({ maxLength: 40_000,
		description: "Complete current brief: relevant user background, preferences, reading priorities, format, depth and language. Downstream Agents read its saved context file. In a continued thread, omission retains the previous brief; a supplied brief replaces it, and an empty string clears it." })),
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
		description: "Start or continue a Goal investigation thread, including read-only Wiki Topic discovery and Topic-filtered searches. Investigate Root can list the frozen Wiki's Topics, search their pages and read cited evidence. It checks original materials and external evidence only within the user's source restrictions. Returns thread_id and a saved result receipt. Read result_ref before deliver_investigation.",
		parameters: schema,
		executionMode: "sequential",
		async execute(toolCallId, input, signal, onUpdate) {
			const result = await executeInvestigation({
				goalDir, goalId: options.goalId, invocationId: toolCallId,
				question: input.question, context: input.context,
				threadId: input.thread_id, title: input.title,
				allowExternal: input.source_scope === "external_allowed",
				outputLanguage: options.getOutputLanguage?.(), env: options.getExtraEnv?.(), signal,
				onCuesPersisted: (origin) => {
					const title = options.getGoalTitle?.() ?? options.title ?? options.goalId;
					const description = options.getGoalDescription?.() ?? options.description ?? "";
					const target = { goalDir, goalId: options.goalId, workspaceDir: options.workspaceDir ?? dirname(goalDir) };
					registerSavedInvestigationCues(target, origin);
					if (options.deferCueWikiUpdates) return;
					try {
						startGoalCueWikiUpdates({ ...target, goalContext: { title, description,
							language: resolveGoalOutputLanguage(options.getOutputLanguage?.() ?? "auto", { title, description }) },
							getGoalContext: () => {
								const title = options.getGoalTitle?.() ?? options.title ?? options.goalId;
								const description = options.getGoalDescription?.() ?? options.description ?? "";
								return { title, description, language: resolveGoalOutputLanguage(options.getOutputLanguage?.() ?? "auto", { title, description }) };
							},
							env: { ...process.env, ...options.getExtraEnv?.() } });
					} catch (error) { console.warn(`[telomi][cue-wiki] could not start background update`, error); }
				},
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

const deliverySchema = Type.Object({
	investigation_id: Type.String({ pattern: "^[a-f0-9]{24}$" }),
	report_title: Type.Optional(Type.String({ minLength: 1, maxLength: 120, pattern: "^[^\\r\\n]+$",
		description: "Publish the reviewed saved answer as a report with this title when the user requests a report. Omit for ordinary chat delivery." })),
}, { additionalProperties: false });

export function createDeliverInvestigationTool(goalDir: string): AgentTool<typeof deliverySchema> {
	return {
		name: "deliver_investigation",
		label: "deliver_investigation",
		description: "Deliver a reviewed investigation answer. For a requested report, include report_title to publish that same cited answer as a report card and Podcast source. Use investigate again for missing evidence; ordinary answers omit report_title.",
		parameters: deliverySchema,
		execute: async (_toolCallId, input, signal) => {
			const result = readInvestigationResult(goalDir, input.investigation_id);
			if (input.report_title !== undefined) {
				const published = await publishInvestigationReport(goalDir, input.investigation_id, input.report_title, signal);
				return { content: [{ type: "text", text: reportReceiptText(published.reportTitle, publishedReportGuestPath(goalDir, published.runId)) }],
					details: { ...published, investigation_id: result.id, userResponse: reportPublishedResponse(inferOutputLanguage(result.answer)) } };
			}
			return { content: [{ type: "text", text: result.answer }],
				details: { userResponse: result.answer, investigation_id: result.id } };
		},
	};
}
