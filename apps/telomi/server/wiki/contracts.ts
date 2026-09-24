import { inferOutputLanguage, type ResolvedOutputLanguage } from "../../shared/languages.js";
import type { PublishedArtifactDirectoryRef, RunArtifactRef } from "../agent-runtime/artifact-store.js";
import type { ResearchModelUsage } from "../agent-runtime/model-usage.js";
import type { GoalTopicPlan } from "../goals/topic-plan/contracts.js";

/**
 * `language` is the Goal-level output language the Wiki is written in. It is resolved once per Goal
 * rather than per Run, because Wiki pages outlive the Run that wrote them.
 */
export interface WikiGoalContext { title: string; description: string; language?: ResolvedOutputLanguage }

/** Cases and queued jobs recorded before `language` existed fall back to the Goal's own wording. */
export function wikiLanguage(goal: WikiGoalContext): ResolvedOutputLanguage {
	return goal.language ?? inferOutputLanguage(`${goal.title}\n${goal.description}`);
}

/** A research question must never be used as a fallback for missing Goal metadata. */
export function requireWikiGoalContext(value: unknown): WikiGoalContext {
	if (!value || typeof value !== "object" || Array.isArray(value)
		|| !("title" in value) || typeof value.title !== "string" || !value.title.trim()
		|| !("description" in value) || typeof value.description !== "string"
		|| ("language" in value && value.language !== "zh-CN" && value.language !== "en")
		|| Object.keys(value).some((key) => key !== "title" && key !== "description" && key !== "language")) {
		throw new Error("Wiki Shard requires structured Goal title and description; capture a new Case with current Goal metadata");
	}
	return {
		title: value.title,
		description: value.description,
		...("language" in value ? { language: value.language as ResolvedOutputLanguage } : {}),
	};
}

export type { GoalTopicPlan } from "../goals/topic-plan/contracts.js";

export { validateGoalTopicPlan } from "../goals/topic-plan/validation.js";

export interface WikiCompilationRequest {
	env?: NodeJS.ProcessEnv;
	goalDir: string;
	runId: string;
	goal?: string;
	goalContext: WikiGoalContext;
	runDirectory: string;
	controlDirectory: string;
	cornellNotesSnapshot: RunArtifactRef;
	/** Frozen Goal Topic Plan used to organize the resulting Wiki. */
	topicPlan: GoalTopicPlan;
	/** Build from an empty candidate Wiki, while still publishing against the current Wiki revision. */
	rebuild?: boolean;
	signal: AbortSignal;
	onStarted?: (totalBatches: number) => void;
	onBatchProgress?: (progress: WikiCompilationBatchProgress) => void;
	onStageProgress?: (progress: WikiCompilationStageProgress) => void;
}

export interface WikiCompilationBatchProgress {
	batchIndex: number;
	totalBatches: number;
	status: "running" | "succeeded" | "failed";
	pageCount: number;
	usage: ResearchModelUsage;
	traceRef?: string;
	message?: string;
	reused: boolean;
}

export interface WikiCompilationBatchFailure {
	batchIndex: number;
	sourceIds: string[];
	message: string;
	usage: ResearchModelUsage;
}

export interface WikiCompilationStageProgress {
	kind: "curation";
	stageIndex: number;
	totalStages: number;
	status: "running" | "succeeded" | "failed";
	pageCount: number;
	usage: ResearchModelUsage;
	traceRef?: string;
	message?: string;
}

export interface WikiCompilationResult {
	status: "compiled" | "reused";
	compilationId: string;
	baseKnowledgeSha256: string;
	knowledge: PublishedArtifactDirectoryRef;
	pageCount: number;
	usage: ResearchModelUsage;
	agentStages: number;
	sessionPaths: string[];
	failedBatches: WikiCompilationBatchFailure[];
}
