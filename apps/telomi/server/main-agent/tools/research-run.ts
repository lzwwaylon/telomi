import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type, type Static } from "@sinclair/typebox";

import {
	executeResearchRun,
	type ResearchRunRequest,
	type ResearchRunResult,
} from "../../research/execute-run.js";
import type { ExtraEnvGetter } from "../extra-env.js";
import type { OutputLanguage } from "../../../shared/languages.js";

export const researchScheduleSchema = Type.Object({
	title: Type.String({ description: "Title for the recurring Research Schedule." }),
	monitoringScope: Type.String({
		description: "Occurrence-specific scope describing what future runs must check for new or materially updated content.",
	}),
	cron: Type.String({ description: "Five-field cron expression requested by the user." }),
	timeZone: Type.String({ description: "IANA time zone requested by the user." }),
}, {
	additionalProperties: false,
	description: "For a recurring research request on a fresh Goal, publish this Run as the baseline and create the Schedule in the same terminal action.",
});

const researchRunSchema = Type.Object({
	reason: Type.String(),
	search_question: Type.String({ minLength: 1, description: "Standalone incremental search question, including search constraints and what prior research already covered. Request only missing or updated evidence." }),
	report_context: Type.String({ minLength: 1, description: "Complete report brief: user objective, audience, preferences, prior knowledge, desired depth, format and language. Include relevant conversation context; downstream writers cannot see the conversation." }),
	reportTitle: Type.Optional(Type.String()),
	schedule: Type.Optional(researchScheduleSchema),
}, { additionalProperties: false });

export interface ResearchRunToolOptions {
	goalId: string;
	title?: string;
	description?: string;
	getGoalTitle?: () => string;
	getGoalDescription?: () => string;
	getDiscoveryEnabled?: () => boolean;
	getOutputLanguage?: () => OutputLanguage;
	discoveryEnabled?: boolean;
	workspaceDir?: string;
	getExtraEnv?: ExtraEnvGetter;
	getSourceUserQuestion?: () => string | undefined;
	taskSource: ResearchRunRequest["taskSource"];
}

function researchRunDetails(result: ResearchRunResult): Record<string, unknown> {
	if (result.status === "skipped") {
		return {
			runId: result.runId,
			taskId: result.taskId,
			runDir: result.runDir,
			wikiRunDir: result.wikiRunDir,
			executionKind: "research_runtime",
			status: "skipped",
			skipReason: result.skipReason,
			researchExecution: result.execution,
			traceSummaryPath: result.traceSummaryPath,
			qualityGate: result.qualityGate,
			outcomeWarning: result.outcomeWarning,
		};
	}
	return {
		runId: result.runId,
		status: "published",
		reportTitle: result.reportTitle,
		userResponse: result.userResponse,
		stableFinalReportPath: result.stableFinalReportPath,
		renderFormats: result.renderFormats,
		traceSummaryPath: result.traceSummaryPath,
		executionKind: "research_runtime",
		...(result.schedule ? { schedule: result.schedule } : {}),
		...(result.outcomeWarning ? { outcomeWarning: result.outcomeWarning } : {}),
	};
}

/** Adapter translating the Main Agent Tool protocol into one Research Run. */
export function createResearchRunTool(goalDir: string, opts: ResearchRunToolOptions): AgentTool<typeof researchRunSchema> {
	return {
		name: "research",
		label: "research",
		description: "Run a canonical research task through the server-owned TypeScript Telomi Research Runtime.",
		parameters: researchRunSchema,
		execute: async (toolCallId, args: Static<typeof researchRunSchema>, signal, onUpdate) => {
			const result = await executeResearchRun({
				goalDir,
				goalId: opts.goalId,
				...(opts.workspaceDir ? { workspaceDir: opts.workspaceDir } : {}),
				goalTitle: opts.getGoalTitle?.().trim() || opts.title,
				goalDescription: opts.getGoalDescription?.().trim() || opts.description,
				discoveryEnabled: opts.discoveryEnabled ?? opts.getDiscoveryEnabled?.(),
				outputLanguage: opts.getOutputLanguage?.(),
				sourceUserQuestion: opts.getSourceUserQuestion?.(),
				extraEnv: opts.getExtraEnv?.(),
				taskSource: opts.taskSource,
				reason: args.reason,
				question: args.search_question,
				reportContext: args.report_context,
				...(args.reportTitle ? { reportTitle: args.reportTitle } : {}),
				...(args.schedule ? { schedule: args.schedule } : {}),
				routerRunId: toolCallId,
				...(signal ? { signal } : {}),
				onNodeState: (runId, event) => onUpdate?.({
					content: [{ type: "text", text: `Run node ${event.nodeId} | ${event.status} | visit ${event.visit} | attempt ${event.attempt}` }],
					details: { runId, executionKind: "research_runtime", node: event },
				}),
				onAgentOutput: (runId, activity) => onUpdate?.({
					content: [{ type: "text", text: `Stage Agent ${activity.stageId} | ${activity.status}` }],
					details: { runId, executionKind: "research_runtime", agentOutput: { ...activity, updatedAt: Date.now() } },
				}),
			});
			return {
				content: [{ type: "text", text: result.receiptText }],
				details: researchRunDetails(result),
			};
		},
	};
}
