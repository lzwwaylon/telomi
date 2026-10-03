export {
	createGoalLlmWikiTools,
	normalizeWikiPagePath,
} from "./tools.js";
export {
	GoalWikiSearch,
	scheduleWikiIndexRefresh,
	wikiIndexPath,
	type WikiIndexCoverage,
} from "./local-search.js";
export { hashWikiDirectory } from "./files.js";
export type {
	GoalTopicPlan,
	WikiCompilationBatchFailure,
	WikiCompilationRequest,
	WikiCompilationResult,
} from "./contracts.js";
export { validateGoalTopicPlan } from "./contracts.js";

export { WikiCompiler, type WikiReindexRequest, type WikiReindexResult } from "./wiki-compiler.js";
