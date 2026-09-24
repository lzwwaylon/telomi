export type {
	DiscoveryCandidate,
	DiscoveryInboxItem,
	DiscoveryResolution,
	GoalTopic,
	GoalTopicPatch,
	GoalTopicPatchOperation,
	GoalTopicPlan,
	GoalTopicPlanProposal,
	GoalTopicRefResolution,
} from "./contracts.js";
export { GoalTopicPlanStore, applyGoalTopicPatch } from "./store.js";
export { GoalTopicPlanHistory, type GoalTopicPlanHistoryEntry } from "./history.js";
export {
	goalTopicDocumentFromPlan,
	goalTopicPlanFromDocument,
	goalTopicDocumentToPatch,
	hashGoalTopicDocument,
	parseGoalTopicDocument,
	stringifyGoalTopicDocument,
	TOPIC_PLAN_DOCUMENT_PATH,
	TOPIC_PLAN_SANDBOX_PATH,
	validateGoalTopicDocument,
	type GoalTopicDocument,
	type GoalTopicDocumentTopic,
} from "./document.js";
export { reframeActivatedGoalWiki } from "./wiki-reframe.js";
export {
	GoalTopicPlanActivation,
	type GoalTopicPlanActivationCapabilities,
	type GoalTopicPlanActivationGoal,
	type GoalTopicPlanActivationResult,
} from "./activation.js";
export { createTopicPlanRouter } from "./api.js";
export { goalTopicReferences, resolveGoalTopicRefs, validateDiscoveryCandidate, validateGoalTopicPatch, validateGoalTopicPlan } from "./validation.js";
