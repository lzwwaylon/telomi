import type { ProjectionContribution } from "../../events/activity-projection.js";
import { GoalTopicPlanStore, type GoalTopicPlanProposal } from "./index.js";
import { activityTiming } from "../../events/projection-helpers.js";
import { providerErrorMessage } from "../../../shared/provider-error.js";
import type { ActivityAction, ActivityLifecycle, ActivityOutcome, ActivityProjectionItem } from "../../../shared/events/activity-projection.js";
import { chrome } from "../../../shared/events/activity-text.js";

export class TopicPlanActivityProjection {
	constructor(private readonly options: {
		workspaceDir: string;
		readTopicPlanGeneration?: (goalId: string) => { startedAt: string; failedAt?: string; error?: string } | undefined;
	}) {}
	project(goalId: string): ProjectionContribution[] {
		const items = this.readTopicPlans(goalId);
		const generation = this.options.readTopicPlanGeneration?.(goalId);
		if (generation && !items.some((item) => item.lifecycle === "waiting")) {
			const failed = generation.error !== undefined;
			items.push({
				activityId: `topic-plan:generation:${goalId}`,
				kind: "topic-plan",
				scope: { kind: "goal", goalId },
				trigger: { kind: "agent", agentName: "main_agent" },
				title: chrome(failed ? "activityChrome.topicPlan.generationFailedTitle" : "activityChrome.topicPlan.generatingTitle"),
				// The Provider's own words are the only text that says what to fix, so they pass through.
				summary: failed
					? providerErrorMessage(generation.error ?? "")
						?? chrome("activityChrome.topicPlan.generationFailedSummary", { error: generation.error ?? "" })
					: chrome("activityChrome.topicPlan.generatingSummary"),
				lifecycle: failed ? "finished" : "running",
				...(failed ? { outcome: "failed" as const } : {}),
				timing: activityTiming(generation.startedAt, generation.failedAt ?? generation.startedAt, failed ? generation.failedAt : undefined),
				resultLinks: [],
				steps: [],
				sourceRef: `topic-plan:generation:${goalId}`,
			});
		}
		return [{ source: "topic-plan", items }];
	}

	private readTopicPlans(goalId: string): ActivityProjectionItem[] {
		return new GoalTopicPlanStore(goalId, this.options.workspaceDir).listProposals()
			.filter((proposal) => proposal.status === "proposed" || (proposal.status === "activated" && Boolean(proposal.confirmed_version)))
			.map((proposal) => this.fromTopicPlanProposal(proposal));
	}

	private fromTopicPlanProposal(proposal: GoalTopicPlanProposal): ActivityProjectionItem {
		const reframe = proposal.reframe;
		const topics = proposal.candidate_plan.topics.length;
		const lifecycle: ActivityLifecycle = proposal.status === "proposed"
			? "waiting" : !reframe || reframe.status === "running" ? "running" : "finished";
		const normalizedLifecycle: ActivityLifecycle = proposal.status === "superseded" ? "finished" : lifecycle;
		const outcome: ActivityOutcome | undefined = proposal.status === "superseded" ? "skipped" : reframe?.status === "failed"
			? "failed" : reframe?.status === "no_wiki" || reframe?.message === "no_change"
				? "no-change" : reframe?.status === "succeeded" ? "succeeded" : undefined;
		const updatedAt = reframe?.updated_at ?? proposal.activated_at ?? proposal.superseded_at ?? proposal.created_at;
		const reframeTiming = activityTiming(proposal.activated_at ?? proposal.created_at, updatedAt,
			lifecycle === "finished" ? updatedAt : undefined);
		const activationHref = `/api/goals/${encodeURIComponent(proposal.goal_id)}/topic-plans/${encodeURIComponent(proposal.proposal_id)}/activate`;
		const reviewAction: ActivityAction = {
			actionId: `review-topic-plan:${proposal.proposal_id}`,
			kind: "open",
			label: chrome("activityChrome.topicPlan.review"),
			enabled: true,
			requiresConfirmation: false,
			href: `/chat/${encodeURIComponent(proposal.goal_id)}#topic-plan-proposal`,
		};
		const retryAction: ActivityAction = {
			actionId: `retry-wiki-reframe:${proposal.proposal_id}`,
			kind: "retry",
			label: chrome("activityChrome.topicPlan.retryReframe"),
			enabled: true,
			requiresConfirmation: false,
			href: activationHref,
		};
		return {
			activityId: `topic-plan:${proposal.proposal_id}`,
			kind: "topic-plan",
			scope: { kind: "goal", goalId: proposal.goal_id },
			trigger: { kind: "agent", agentName: proposal.source },
			title: chrome(proposal.status === "proposed"
				? "activityChrome.topicPlan.draftTitle"
				: "activityChrome.topicPlan.confirmTitle"),
			summary: chrome(proposal.status === "proposed"
				? "activityChrome.topicPlan.awaitingConfirmation"
				: reframe?.status === "failed" ? "activityChrome.topicPlan.confirmedWikiFailed"
					: reframe?.status === "no_wiki" ? "activityChrome.topicPlan.confirmed"
						: reframe?.status === "succeeded" ? "activityChrome.topicPlan.confirmedWikiUpdated"
							: "activityChrome.topicPlan.confirmedWikiRunning", { count: topics }),
			lifecycle: normalizedLifecycle,
			...(outcome ? { outcome } : {}),
			...(proposal.status === "proposed" ? {
				waiting: {
					kind: "decision" as const,
					reason: chrome("activityChrome.topicPlan.reviewReason"),
					waitingSince: proposal.created_at,
					actions: [reviewAction],
				},
				attention: {
					kind: "decision" as const,
					summary: chrome("activityChrome.topicPlan.awaitingAttention", { count: topics }),
					actions: [reviewAction],
				},
			} : reframe?.status === "failed" ? {
				attention: {
					kind: "failure" as const,
					summary: chrome("activityChrome.topicPlan.reframeFailedAttention"),
					actions: [retryAction],
				},
			} : {}),
			timing: activityTiming(proposal.created_at, updatedAt, normalizedLifecycle === "finished" ? updatedAt : undefined),
			resultLinks: reframe?.status === "succeeded" ? [{
				kind: "artifact",
				label: chrome("activityChrome.wiki.open"),
				href: `/wiki/${encodeURIComponent(proposal.goal_id)}`,
				available: true,
				primary: true,
			}] : [],
			steps: [
				{
					stepId: "topic-patch",
					title: chrome("activityChrome.topicPlan.draftStep"),
					summary: chrome("activityChrome.topicPlan.draftStepSummary", { count: topics }),
					lifecycle: "finished",
					outcome: "succeeded",
					timing: activityTiming(proposal.created_at, proposal.created_at, proposal.created_at),
					dependsOnStepIds: [], parallelSteps: [], agentActivities: [],
				},
				{
					stepId: "topic-confirmation",
					title: chrome("activityChrome.topicPlan.confirmStep"),
					summary: chrome(proposal.status === "proposed" ? "activityChrome.topicPlan.confirmWaiting"
						: proposal.status === "superseded" ? "activityChrome.topicPlan.confirmSuperseded"
							: "activityChrome.topicPlan.confirmActivated"),
					lifecycle: proposal.status === "proposed" ? "waiting" : "finished",
					...(proposal.status === "activated" ? { outcome: "succeeded" as const } : proposal.status === "superseded" ? { outcome: "skipped" as const } : {}),
					timing: activityTiming(proposal.created_at, proposal.activated_at ?? proposal.superseded_at ?? proposal.created_at,
						proposal.activated_at ?? proposal.superseded_at),
					dependsOnStepIds: ["topic-patch"], parallelSteps: [], agentActivities: [],
				},
				...(proposal.status === "activated" ? [{
					stepId: "wiki-reframe",
					title: chrome("activityChrome.topicPlan.reframeStep"),
					// reframe.message 是 Runtime 原始错误文本，保持原语言。
					summary: reframe?.status === "succeeded"
						? chrome("activityChrome.usage.modelCalls", { count: reframe.usage?.model_calls ?? 0 })
						: reframe?.status === "no_wiki" ? chrome("activityChrome.topicPlan.reframeNoWiki")
							: reframe?.status === "failed"
								? reframe.message ? [{ text: reframe.message }] : chrome("activityChrome.topicPlan.reframeFailedStep")
								: chrome("activityChrome.topicPlan.reframeRunning"),
					lifecycle: reframe?.status === "running" || !reframe ? "running" as const : "finished" as const,
					...(outcome ? { outcome } : {}),
					timing: reframeTiming,
					dependsOnStepIds: ["topic-confirmation"], parallelSteps: [], agentActivities: [],
				}] : []),
			],
			sourceRef: `topic-plan:${proposal.proposal_id}`,
		};
	}

}
