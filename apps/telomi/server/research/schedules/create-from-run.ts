import { join } from "node:path";

import { GoalTopicPlanStore } from "../../goals/topic-plan/index.js";
import { serverRuntimeDirForGoal } from "../../workspaces/server-runtime-paths.js";
import { readBaselineReportContext } from "./baseline-report-context.js";
import { readProcessedResearchRun } from "./source-processing.js";
import { ResearchScheduleStore } from "./store.js";

export function createResearchScheduleFromRun(args: {
	workspaceDir: string;
	goalId: string;
	title: string;
	monitoringScope: string;
	sourceRunId: string;
	cron: string;
	timeZone: string;
}) {
	const sourceRunId = args.sourceRunId.trim();
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/u.test(sourceRunId)) {
		throw new Error("Research Schedule sourceRunId is invalid");
	}
	new GoalTopicPlanStore(args.goalId, args.workspaceDir).requireResearchReady();
	const goalDir = join(args.workspaceDir, args.goalId);
	const baseline = readProcessedResearchRun({
		goalDir,
		controlRunDir: join(
			serverRuntimeDirForGoal(args.goalId, args.workspaceDir),
			"runs",
			sourceRunId,
		),
		runId: sourceRunId,
	});
	if (baseline.status !== "published") {
		throw new Error("Research Schedule must initialize from a published Research Run");
	}
	// Recorded Cornell Note gaps are tolerated, an empty baseline is not: with nothing read there is
	// no processed set to compare the next occurrence against.
	if (baseline.sources.length === 0) {
		throw new Error(
			`Research Run '${baseline.runId}' has a Cornell Note for none of its ${baseline.discoveredSources}`
			+ " Sources. Use another published Research Run, or run this research again.",
		);
	}
	const store = new ResearchScheduleStore(args.goalId, args.workspaceDir);
	try {
		return store.create({
			title: args.title,
			monitoringScope: args.monitoringScope,
			reportContext: readBaselineReportContext({
				goalId: args.goalId,
				workspaceDir: args.workspaceDir,
				runId: baseline.runId,
			}),
			question: baseline.question,
			cron: args.cron,
			timeZone: args.timeZone,
			initializedFromRunId: baseline.runId,
			coveredThrough: baseline.startedAt,
			sources: baseline.sources,
			sourceGaps: baseline.unprocessedSources,
		});
	} finally {
		store.close();
	}
}
