import type {
	DiscoveryCandidate,
	DiscoveryResolution,
	GoalTopic,
	GoalTopicInput,
	GoalTopicPatch,
	GoalTopicPatchOperation,
	GoalTopicPlan,
	GoalTopicRefResolution,
} from "./contracts.js";

const ID = /^[a-z0-9][a-z0-9_-]*$/u;
const PLAN_FIELDS = new Set(["schema_version", "goal_id", "revision", "status", "topics"]);
const PATCH_FIELDS = new Set(["schema_version", "base_revision", "summary", "operations", "mode"]);
const DISCOVERY_FIELDS = new Set([
	"schema_version", "id", "goal_id", "topic_plan_revision", "finding", "run_id", "source_id",
	"section_index", "cue_index", "cue", "note", "evidence", "status", "created_at", "updated_at", "resolution",
]);
const DISCOVERY_EVIDENCE_FIELDS = new Set(["source_path", "start_line", "end_line", "content_sha256"]);
const RESOLUTION_FIELDS = new Set(["kind", "resolved_by", "resolved_at", "proposal_id", "topic_plan_revision"]);
const TOPIC_FIELDS = new Set(["id", "title", "intent", "questions", "include", "exclude"]);

export function validateGoalTopicPlan(value: GoalTopicPlan): GoalTopicPlan {
	if (value && typeof value === "object") assertNoUnknownFields(value, PLAN_FIELDS, "Goal Topic Plan");
	if (!value || value.schema_version !== 1 || !text(value.goal_id) || !text(value.revision)
		|| value.status !== "active" || !Array.isArray(value.topics) || value.topics.length === 0) {
		throw new Error("Goal Topic Plan is invalid");
	}
	const ids = new Set<string>();
	const titles = new Set<string>();
	for (const topic of value.topics) {
		validateTopic(topic, true);
		if (ids.has(topic.id)) throw new Error(`Goal Topic '${topic.id}' is duplicated`);
		if (titles.has(topic.title.trim())) throw new Error(`Goal Topic title '${topic.title}' is duplicated`);
		ids.add(topic.id);
		titles.add(topic.title.trim());
	}
	return value;
}

export function resolveGoalTopicRefs(plan: GoalTopicPlan, refs: readonly string[]): GoalTopicRefResolution[] {
	validateGoalTopicPlan(plan);
	const ids = new Set(plan.topics.map((topic) => topic.id));
	return [...new Set(refs)].map((ref) => ids.has(ref)
		? { input_ref: ref, status: "exact", canonical_refs: [ref] }
		: { input_ref: ref, status: "unresolved", canonical_refs: [] });
}

/**
 * Agents reference Topics by short ref instead of the canonical Topic ID: a 20 hex character ID
 * cannot be transcribed reliably, and one wrong character costs a whole Agent repair round.
 * Runtime maps the refs back to canonical IDs when it reads an Agent result.
 */
export function goalTopicReferences(plan: GoalTopicPlan): Array<{ ref: string; topic: GoalTopic }> {
	return plan.topics.map((topic, index) => ({ ref: `T${index + 1}`, topic }));
}

export function validateGoalTopicPatch(value: GoalTopicPatch): GoalTopicPatch {
	if (value && typeof value === "object") assertNoUnknownFields(value, PATCH_FIELDS, "Goal Topic Patch");
	if (!value || value.schema_version !== 1 || (value.base_revision !== null && !text(value.base_revision))
		|| !text(value.summary) || !Array.isArray(value.operations) || value.operations.length === 0) {
		throw new Error("Goal Topic Patch is invalid");
	}
	if (value.mode !== undefined && value.mode !== "replace") throw new Error("Goal Topic Patch mode is invalid");
	for (const operation of value.operations) validateOperation(operation);
	return value;
}

export function validateDiscoveryCandidate(value: DiscoveryCandidate, plan: GoalTopicPlan): DiscoveryCandidate {
	if (value && typeof value === "object") assertNoUnknownFields(value, DISCOVERY_FIELDS, "Discovery Candidate");
	if (!value || value.schema_version !== 1 || !text(value.id) || value.goal_id !== plan.goal_id
		|| value.topic_plan_revision !== plan.revision || !text(value.finding) || !text(value.run_id)
		|| !text(value.source_id) || !Number.isInteger(value.section_index) || value.section_index < 0
		|| !Number.isInteger(value.cue_index) || value.cue_index < 0 || !text(value.cue) || !text(value.note)
		|| !Array.isArray(value.evidence) || value.evidence.length === 0
		|| value.evidence.some((entry) => !validDiscoveryEvidence(entry))
		|| !["open", "closed"].includes(value.status)
		|| !Number.isFinite(Date.parse(value.created_at))
		|| (value.updated_at !== undefined && !Number.isFinite(Date.parse(value.updated_at)))) {
		throw new Error("Discovery Candidate is invalid");
	}
	if (value.status === "open" && value.resolution !== undefined) throw new Error("Open Discovery Candidate cannot have a resolution");
	if (value.status === "closed") validateDiscoveryResolution(value.resolution);
	return value;
}

function validDiscoveryEvidence(value: DiscoveryCandidate["evidence"][number]): boolean {
	if (!value || typeof value !== "object") return false;
	assertNoUnknownFields(value, DISCOVERY_EVIDENCE_FIELDS, "Discovery evidence");
	return text(value.source_path)
		&& Number.isInteger(value.start_line) && value.start_line >= 1
		&& Number.isInteger(value.end_line) && value.end_line >= value.start_line
		&& /^[a-f0-9]{64}$/u.test(value.content_sha256);
}

function validateDiscoveryResolution(value: DiscoveryResolution | undefined): void {
	if (value && typeof value === "object") assertNoUnknownFields(value, RESOLUTION_FIELDS, "Discovery resolution");
	if (!value || !["ignored", "covered_by_topic"].includes(value.kind)
		|| !["user", "runtime"].includes(value.resolved_by)
		|| !Number.isFinite(Date.parse(value.resolved_at))
		|| (value.proposal_id !== undefined && !text(value.proposal_id))
		|| (value.topic_plan_revision !== undefined && !text(value.topic_plan_revision))) {
		throw new Error("Discovery resolution is invalid");
	}
	if (value.kind === "ignored" && value.resolved_by !== "user") throw new Error("Ignored Discovery must be resolved by the user");
	if (value.kind === "covered_by_topic" && (value.resolved_by !== "runtime" || !value.proposal_id || !value.topic_plan_revision)) {
		throw new Error("Topic-covered Discovery must reference its confirmed Topic Plan");
	}
}

function validateTopic(topic: GoalTopicInput, requireId: boolean): void {
	if (topic && typeof topic === "object") assertNoUnknownFields(topic, TOPIC_FIELDS, `Goal Topic '${topic.id || "unknown"}'`);
	if (!topic || (requireId ? !topic.id || !ID.test(topic.id) : topic.id !== undefined && !ID.test(topic.id))
		|| !text(topic.title) || !text(topic.intent)
		|| !strings(topic.questions) || !strings(topic.include) || !strings(topic.exclude)) {
		throw new Error(`Goal Topic '${topic?.id || "unknown"}' is invalid`);
	}
}

function assertNoUnknownFields(value: object, allowed: ReadonlySet<string>, label: string): void {
	const unknown = Object.keys(value).find((key) => !allowed.has(key));
	if (unknown) throw new Error(`${label} contains unknown field '${unknown}'`);
}

function validateOperation(operation: GoalTopicPatchOperation): void {
	if (!operation || typeof operation !== "object") throw new Error("Goal Topic Patch operation is invalid");
	if (operation.op === "add") return validateTopic(operation.topic, false);
	if (!ID.test(operation.topic_id)) throw new Error("Goal Topic Patch topic_id is invalid");
	if (operation.op === "remove") return;
	if (operation.op !== "update" || !operation.set || Object.keys(operation.set).length === 0) {
		throw new Error("Goal Topic Patch operation is invalid");
	}
	const allowed = new Set(["title", "intent", "questions", "include", "exclude"]);
	if (Object.keys(operation.set).some((key) => !allowed.has(key))) throw new Error(`Goal Topic update '${operation.topic_id}' contains an unknown field`);
	const set = operation.set;
	if ((set.title !== undefined && !text(set.title)) || (set.intent !== undefined && !text(set.intent))
		|| (set.questions !== undefined && !strings(set.questions)) || (set.include !== undefined && !strings(set.include))
		|| (set.exclude !== undefined && !strings(set.exclude))) throw new Error(`Goal Topic update '${operation.topic_id}' is invalid`);
}

function text(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

function strings(value: unknown): value is string[] {
	return Array.isArray(value) && value.every(text);
}
