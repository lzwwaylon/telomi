import type { ResearchModelUsage } from "../../agent-runtime/model-usage.js";
import type { ResearchTemporalContext, LogicalSource } from "../research-types.js";
import type {
	PublishedArtifactDirectoryRef,
	PublishedArtifactRef,
	RunArtifactStore,
} from "../../agent-runtime/artifact-store.js";
import type { GoalTopicPlan } from "../../goals/topic-plan/index.js";
import type { ScheduledResearchContext } from "../scheduled-research-context.js";
import type { SearchExecutionRecord } from "../../providers/search-contracts.js";
import type { AgentStageActivity } from "../../agent-runtime/agent-stage-runtime.js";
import type { WorkspaceSnapshotRecord } from "../../observability/run-records.js";

export interface SearchBatchRequest {
	goalId: string;
	runId: string;
	sequence: number;
	/** Runtime execution identity shared by Case capture and Provider call records. */
	attemptId?: string;
	question: string;
	topicPlan?: GoalTopicPlan;
	scheduledResearch?: ScheduledResearchContext;
	availableProviderIds: readonly string[];
	workspaceDirectory: string;
	controlDirectory: string;
	artifactStore: RunArtifactStore;
	temporalContext: ResearchTemporalContext;
	organizerStorageRoot?: string;
	signal: AbortSignal;
	onActivity?: (activity: AgentStageActivity) => void;
	/** Shared with Node Evaluation capture so one snapshot record is persisted in both artifacts. */
	workspaceSnapshot?: WorkspaceSnapshotRecord;
	/** Evaluation-only destination for per-session guest-visible Workspace snapshots. */
	logicalWorkspaceCaptureRoot?: string;
}

export interface SearchBatchResult {
	logicalSources: LogicalSource[];
	sourceBundles: PublishedArtifactDirectoryRef[];
	findOutSources: PublishedArtifactDirectoryRef;
	executionRecords: Array<{
		record: SearchExecutionRecord;
		artifact: PublishedArtifactRef;
	}>;
	usage: ResearchModelUsage;
	agentStages: number;
	toolCalls: number;
}

export interface SearchBatchExecutor {
	execute(request: SearchBatchRequest): Promise<SearchBatchResult>;
}
