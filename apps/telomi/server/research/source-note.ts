import type { RunArtifactStore } from "../agent-runtime/artifact-store.js";
import type { LogicalSource } from "./research-types.js";
import type { ResearchModelUsage } from "../agent-runtime/model-usage.js";
import type { GoalTopicPlan } from "../goals/topic-plan/index.js";

/** Semantic output from one complete logical Source. */
export interface SourceNoteEvidence {
	source_path: string;
	start_line: number;
	end_line: number;
	content_sha256: string;
}

export interface SourceNote {
	schema_version: 1;
	source_id: string;
	sections: Array<{
		section_title: string;
		summary: string;
		cue_notes: Array<{
			cue: string;
			note: string;
			evidence: SourceNoteEvidence[];
			topic_refs?: string[];
			discovery?: {
				finding: string;
			};
		}>;
	}>;
}

export interface SourceNoteInput {
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

export interface ProcessedSourceNote {
	source: LogicalSource;
	note: SourceNote;
	artifactRef: string;
}

export interface SourceNoteFailure {
	source: LogicalSource;
	message: string;
}

export interface SourceNoteBatchResult {
	notes: ProcessedSourceNote[];
	failures: SourceNoteFailure[];
}

export interface SourceNoteProcessor {
	process(input: SourceNoteInput): Promise<SourceNoteBatchResult>;
}
