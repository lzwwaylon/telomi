import type { WikiStageKind, WikiInvestigationReview, WikiReportContext } from "./wiki-stage-contract.js";
export type { WikiInvestigationReview } from "./wiki-stage-contract.js";
import { inferOutputLanguage, type ResolvedOutputLanguage } from "../../shared/languages.js";
import type { PublishedArtifactDirectoryRef, RunArtifactRef } from "../agent-runtime/artifact-store.js";
import type { ResearchModelUsage } from "../agent-runtime/model-usage.js";
import type { WikiCueOrigin } from "./wiki-update-job.js";
import type { GoalTopicPlan } from "../goals/topic-plan/contracts.js";
import type { WikiDeferredEvidence } from './deferred-evidence.js';
import type { WikiMainSessionContext } from '../main-agent/wiki-context.js';
import type { NodeEvaluationInteraction } from '../agent-runtime/node-evaluation.js';

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
	notesSnapshot: RunArtifactRef;
	/** Frozen investigation origins, retained for Case lineage rather than Agent instructions. */
	cueOrigins?: WikiCueOrigin[];
	/** Main's delivered findings and exclusions are editorial context, never Source evidence. */
	curationReviews?: WikiInvestigationReview[];
	/** Explicit maintenance intent is editorial context and cannot establish facts. */
	curationInstructions?: string;
	/** The published report provides editorial context, never new Source evidence. */
	reportContext?: WikiReportContext;
	/** Frozen Main conversation used only by the background selection branch. */
	mainSession?: WikiMainSessionContext;
	/** Replay resolves memory only from recorded reads, never live user memory. */
	memoryReplay?: NodeEvaluationInteraction[];
	/** Pending Cues are reconsidered alongside fresh evidence, without changing their identities. */
	deferredEvidence?: WikiDeferredEvidence;
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
	kind: WikiStageKind;
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
	/** Partial candidates remain inspectable but cannot replace the published Edition. */
	publicationReady?: boolean;
	compilationId: string;
	baseKnowledgeSha256: string;
	knowledge: PublishedArtifactDirectoryRef;
	pageCount: number;
	usage: ResearchModelUsage;
	agentStages: number;
	sessionPaths: string[];
	failedBatches: WikiCompilationBatchFailure[];
	curation?: { adopted: number; deferred: number; skipped: number };
	deferredEvidence?: WikiDeferredEvidence;
}
