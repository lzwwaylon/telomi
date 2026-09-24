export type ResearchScheduleStatus = "active" | "paused" | "archived";

export type ResearchScheduleRunStatus =
	| "scheduled"
	| "running"
	| "published"
	| "skipped_no_source_increment"
	| "skipped_no_qualifying_evidence"
	| "failed"
	| "cancelled";

export interface ResearchScheduleSource {
	sourceIdentity: string;
	contentSha256: string;
}

/** One Source revision a Research Run published without a Cornell Note, kept out of the processed set. */
export interface ResearchScheduleSourceGap extends ResearchScheduleSource {
	/** The Research Run that recorded the failed Cornell Note. */
	runId: string;
	recordedAt: string;
}

export interface ResearchScheduleRun {
	id: string;
	scheduleId: string;
	scheduledFor: string;
	windowStart: string;
	windowEnd: string;
	status: ResearchScheduleRunStatus;
	researchRunId?: string;
	reportPath?: string;
	error?: string;
	discoveredSources: number;
	incrementalSources: number;
	cornellNotes: number;
	startedAt?: string;
	finishedAt?: string;
	createdAt: string;
}

export interface ResearchSchedule {
	id: string;
	goalId: string;
	title: string;
	question: string;
	monitoringScope: string;
	reportContext: string;
	cron: string;
	timeZone: string;
	status: ResearchScheduleStatus;
	initializedFromRunId: string;
	coveredThrough: string;
	nextRunAt?: string;
	createdAt: string;
	updatedAt: string;
	/** When this Schedule was last reviewed. Defaults to its creation time. */
	lastReviewedAt: string;
	/** User messages counted in the Goal at the last Research Schedule Review. */
	lastReviewedUserMessageCount: number;
	/** The most recent Research Schedule Review of this Schedule, when it has been reviewed. */
	lastReview?: ResearchScheduleReview;
	/** The Research Schedule Proposal still waiting for the user, when there is one. */
	openProposal?: ResearchScheduleProposal;
	/**
	 * The latest Source revision, per Source, whose Cornell Note a Run of this Schedule recorded as
	 * failed and no Run has since read. Reading another revision of the same Source does not resolve
	 * it: revisions are not ordered, so only that exact revision proves those bytes were read.
	 */
	sourceGaps: ResearchScheduleSourceGap[];
	runs: ResearchScheduleRun[];
}

export interface ClaimedResearchScheduleRun {
	schedule: ResearchSchedule;
	run: ResearchScheduleRun;
	processedSources: Array<{
		sourceIdentity: string;
		contentSha256: string;
	}>;
}

export type ResearchScheduleReviewStatus = "no_change" | "proposed" | "failed";

export type ResearchScheduleProposalStatus =
	| "proposed"
	| "confirmed_as_is"
	| "confirmed_with_edits"
	| "rejected"
	| "superseded";

export interface ResearchScheduleProposal {
	id: string;
	scheduleId: string;
	reviewId: string;
	status: ResearchScheduleProposalStatus;
	/** The Schedule's confirmed values when this Proposal was made. */
	previousMonitoringScope: string;
	previousReportContext: string;
	monitoringScope: string;
	reportContext: string;
	summary: string;
	rationale: string;
	evidence: string[];
	createdAt: string;
	resolvedAt?: string;
	rejectionReason?: string;
}

export interface ResearchScheduleReview {
	id: string;
	scheduleId: string;
	status: ResearchScheduleReviewStatus;
	/** Why a Review failed, or why the Reviewer saw no reason to change anything. */
	reason?: string;
	proposalId?: string;
	/** Where this Reviewer execution left its Trace, relative to the Goal's server runtime directory. */
	traceRef?: string;
	startedAt: string;
	finishedAt: string;
}
