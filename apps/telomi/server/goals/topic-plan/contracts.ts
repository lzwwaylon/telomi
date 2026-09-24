export interface GoalTopic {
	id: string;
	title: string;
	intent: string;
	questions: string[];
	include: string[];
	exclude: string[];
}

export type GoalTopicInput = Omit<GoalTopic, "id"> & { id?: string };

export interface GoalTopicPlan {
	schema_version: 1;
	goal_id: string;
	revision: string;
	status: "active";
	topics: GoalTopic[];
}

export type GoalTopicPatchOperation =
	| { op: "add"; topic: GoalTopicInput }
	| {
		op: "update";
		topic_id: string;
		set: Partial<Pick<GoalTopic, "title" | "intent" | "questions" | "include" | "exclude">>;
	}
	| { op: "remove"; topic_id: string };

export interface GoalTopicPatch {
	schema_version: 1;
	base_revision: string | null;
	summary: string;
	operations: GoalTopicPatchOperation[];
	mode?: "replace";
}

export interface GoalTopicPlanProposal {
	schema_version: 1;
	proposal_id: string;
	goal_id: string;
	base_revision: string | null;
	status: "proposed" | "activated" | "superseded";
	created_at: string;
	activated_at?: string;
	superseded_at?: string;
	superseded_by?: string;
	source: "main_agent";
	draft_sha256?: string;
	source_discovery_ids?: string[];
	confirmed_version?: string;
	patch: GoalTopicPatch;
	candidate_plan: GoalTopicPlan;
	diff: string[];
	reframe?: {
		status: "running" | "succeeded" | "failed" | "no_wiki";
		updated_at: string;
		message?: string;
		usage?: { input_tokens: number; output_tokens: number; cost_usd: number; model_calls: number };
	};
}

export interface DiscoveryCandidate {
	schema_version: 1;
	id: string;
	goal_id: string;
	topic_plan_revision: string;
	finding: string;
	run_id: string;
	source_id: string;
	section_index: number;
	cue_index: number;
	cue: string;
	note: string;
	evidence: Array<{
		source_path: string;
		start_line: number;
		end_line: number;
		content_sha256: string;
	}>;
	status: "open" | "closed";
	created_at: string;
	updated_at?: string;
	resolution?: DiscoveryResolution;
}

export interface DiscoveryResolution {
	kind: "ignored" | "covered_by_topic";
	resolved_by: "user" | "runtime";
	resolved_at: string;
	proposal_id?: string;
	topic_plan_revision?: string;
}

export interface GoalTopicRefResolution {
	input_ref: string;
	status: "exact" | "unresolved";
	canonical_refs: string[];
}

export interface DiscoveryInboxItem extends DiscoveryCandidate {
}
