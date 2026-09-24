import { ActivityProjectionService } from "../events/activity-projection.js";
import { ObservabilityActivityProjection } from "../observability/activity-projection.js";
import { ResearchActivityProjection } from "../research/activity-projection.js";
import { WikiActivityProjection } from "../wiki/activity-projection.js";
import { TopicPlanActivityProjection } from "../goals/topic-plan/activity-projection.js";
import { mainAgentProjection } from "../main-agent/activity-projection.js";
import type { GoalActivityItem } from "../../shared/types.js";

export function createActivityProjection(options: {
	workspaceDir: string;
	listGoalIds: () => string[];
	listPodcastActivities?: (goalId: string) => GoalActivityItem[];
	readTopicPlanGeneration?: (goalId: string) => { startedAt: string } | undefined;
}): ActivityProjectionService {
	const outputs = new ObservabilityActivityProjection();
	const research = new ResearchActivityProjection(options, outputs);
	const wiki = new WikiActivityProjection(options, outputs);
	const topicPlans = new TopicPlanActivityProjection(options);
	const service = new ActivityProjectionService({
		listGoalIds: options.listGoalIds,
		// Projection revisions and stable sorting depend on the historical item order.
		// Freshness retains reducer registration order, which differs for schedules.
		itemSources: ["research", "wiki-update", "topic-plan", "scheduled-research", "podcast"],
		readOutput: (goalId, outputRef, options) => outputs.readOutput(goalId, outputRef, options),
	});
	service.registerProjection((goalId) => research.project(goalId));
	service.registerProjection((goalId) => wiki.project(goalId));
	service.registerProjection((goalId) => topicPlans.project(goalId));
	service.registerProjection(mainAgentProjection(options.listPodcastActivities ?? (() => [])));
	return service;
}
