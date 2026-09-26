import type { RunArtifactStore } from "../agent-runtime/artifact-store.js";
import type { LogicalSource } from "./research-types.js";
import type { ResearchModelUsage } from "../agent-runtime/model-usage.js";
import type { GoalTopicPlan } from "../goals/topic-plan/index.js";

/** Semantic output from one complete logical Source. */
export interface CornellEvidence {
	source_path: string;
	start_line: number;
	end_line: number;
	content_sha256: string;
}

export interface CornellNote {
	schema_version: 1;
	source_id: string;
	sections: Array<{
		section_title: string;
		summary: string;
		cue_notes: Array<{
			cue: string;
			note: string;
			evidence: CornellEvidence[];
			topic_refs?: string[];
			discovery?: {
				finding: string;
			};
		}>;
	}>;
}

export interface CornellNoteInput {
	runId: string;
	sequence: number;
	question: string;
	goal: { title: string; description: string };
	discoveryEnabled: boolean;
	sources: LogicalSource[];
	signal: AbortSignal;
	workspaceDir: string;
	controlDir: string;
	artifactStore?: RunArtifactStore;
	topicPlan?: GoalTopicPlan;
	noteFocus?: string;
	onAgentStageCompleted?: (usage: ResearchModelUsage) => void;
}

export interface CornellSourceNote {
	source: LogicalSource;
	note: CornellNote;
	artifactRef: string;
}

export interface CornellSourceFailure {
	source: LogicalSource;
	message: string;
}

export interface CornellNoteBatchResult {
	notes: CornellSourceNote[];
	failures: CornellSourceFailure[];
}

export interface CornellNoteProcessor {
	process(input: CornellNoteInput): Promise<CornellNoteBatchResult>;
}
