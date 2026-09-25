import { join } from "node:path";

import { publish } from "../../events/event-bus.js";
import { toErrorMessage } from "../../lib/values.js";
import { GoalWorkspacePublicationLock } from "../../workspaces/publication-lock.js";
import type { GoalTopicPlanProposal } from "./contracts.js";
import { GoalTopicPlanStore } from "./store.js";
import { reframeActivatedGoalWiki } from "./wiki-reframe.js";

/** 一次激活需要的 Goal 身份；Wiki reframe 用标题和描述表达用户的 Goal。 */
export interface GoalTopicPlanActivationGoal {
	id: string;
	title: string;
	description: string;
}

/** 组合根提供的外部能力：Goal 日志和 Goal 环境快照。 */
export interface GoalTopicPlanActivationCapabilities {
	workspaceDir: string;
	/**
	 * 把 Topic Plan Confirmation 写进 Goal 日志，Main Agent 下一轮据此看到用户的决定。
	 * 中断后的重试会再次调用它，所以它按已有的持久事件标识去重，返回 "duplicate"
	 * 表示这次确认之前已经通知过。
	 */
	recordConfirmation: (input: { goalId: string; revision: string; proposalId: string })
		=> Promise<"recorded" | "duplicate">;
	/** Wiki reframe 执行真实模型调用所需的 Goal 环境，含凭证隔离。 */
	goalEnv: (goalId: string) => Record<string, string | undefined>;
	reframe?: typeof reframeActivatedGoalWiki;
}

export interface GoalTopicPlanActivationResult {
	goalId: string;
	proposalId: string;
	/** 后台 Wiki reframe。它自己记录成败并发布事件，因此从不 reject。 */
	reframe: Promise<void>;
}

/**
 * 用户确认 Topic Plan 后的完整业务操作：Proposal 状态检查、重复请求保护、发布锁与锁内状态复核、
 * 确认事件、Discovery Resolution，以及随后的 Wiki reframe。
 *
 * 只有用户的显式确认请求会调用它；Agent 讨论不激活 Proposal。返回时确认与事件已持久化，
 * reframe 仍在后台运行。确认落盘之后任何一步失败都不回滚已确认的 Topic Plan Revision：
 * 重试读持久状态，从同一个 revision 继续未完成的后续处理，不再确认第二次。
 */
export class GoalTopicPlanActivation {
	private readonly activating = new Set<string>();

	constructor(private readonly capabilities: GoalTopicPlanActivationCapabilities) {}

	async activate(goal: GoalTopicPlanActivationGoal, proposalId: string): Promise<GoalTopicPlanActivationResult> {
		const { workspaceDir } = this.capabilities;
		const store = new GoalTopicPlanStore(goal.id, workspaceDir);
		const proposal = store.readProposal(proposalId);
		if (proposal.status === "superseded") throw new Error("Topic Plan Proposal is superseded");
		// 已确认的 Proposal 只在后续处理还没走完时可以重试：reframe 没有任何记录说明后续处理没开始
		// （正在跑，或进程停在半路，启动恢复会把它修成 failed），reframe 记为 failed 说明只剩
		// reframe 要重跑。其余情况这次激活已经结束。
		if (proposal.status === "activated" && proposal.reframe && proposal.reframe.status !== "failed") {
			throw new Error("Topic Plan Proposal is already active");
		}
		const key = `${goal.id}:${proposal.proposal_id}`;
		if (this.activating.has(key)) throw new Error("Topic Plan activation is already running");
		this.activating.add(key);
		// 这次请求是否拥有该 Proposal 的激活：重试时我们从已确认状态进来，新确认时锁内确认成功。
		// 只有拥有者才在失败时改写它的状态，另一个请求确认的激活不会被这里标成失败。
		let ownsActivation = proposal.status === "activated";
		try {
			if (proposal.status === "proposed") {
				// 发布锁把确认和 Wiki 发布串起来，锁内复核状态，避免两个请求确认同一个 Proposal。
				await new GoalWorkspacePublicationLock(goal.id, workspaceDir).withLock("topic-plan-confirm", () => {
					const current = store.readProposal(proposal.proposal_id);
					if (current.status !== "proposed") throw new Error("Topic Plan Proposal is no longer pending");
					store.activate(current.proposal_id);
					ownsActivation = true;
				});
			}
			// 确认之后的处理由持久状态驱动，而不是这次请求的内存变量：中断后重试从同一个已确认
			// revision 继续，不会再确认一次。确认通知按持久事件标识去重，所以重试既不会漏掉
			// 还没写下的通知，也不会重复通知；只有真正新写下通知时才发广播。
			const activated = store.readProposal(proposal.proposal_id);
			const confirmation = await this.capabilities.recordConfirmation({
				goalId: goal.id,
				revision: activated.candidate_plan.revision,
				proposalId: activated.proposal_id,
			});
			if (confirmation === "recorded") {
				publish({
					type: "topic-plan:changed", goalId: goal.id, proposalId: proposal.proposal_id,
					status: "activated", ts: new Date().toISOString(),
				});
				for (const candidateId of activated.source_discovery_ids ?? []) {
					publish({ type: "discovery:changed", goalId: goal.id, candidateId, status: "closed", ts: new Date().toISOString() });
				}
			}
			return {
				goalId: goal.id,
				proposalId: proposal.proposal_id,
				reframe: this.reframe(goal, activated).finally(() => this.activating.delete(key)),
			};
		} catch (error) {
			// 确认可能已经落盘。释放占用，并把这次未完成的激活记成失败的 reframe，
			// 让 Activity 上既有的"重试 Wiki 整理"入口指回同一个确认请求。
			this.activating.delete(key);
			if (ownsActivation) this.markFollowUpFailed(store, proposal.proposal_id, error);
			throw error;
		}
	}

	/** 把未完成的激活记成失败的 reframe，复用 Activity 上既有的重试入口，不新增 UI 流程。 */
	private markFollowUpFailed(store: GoalTopicPlanStore, proposalId: string, error: unknown): void {
		try {
			const proposal = store.readProposal(proposalId);
			if (proposal.status !== "activated" || proposal.reframe?.status === "succeeded" || proposal.reframe?.status === "no_wiki") return;
			store.recordReframe(proposalId, {
				status: "failed",
				updated_at: new Date().toISOString(),
				message: toErrorMessage(error),
			});
			publish({
				type: "topic-plan:changed", goalId: proposal.goal_id, proposalId,
				status: "failed", ts: new Date().toISOString(),
			});
		} catch (failure) {
			console.error(`[telomi][topic-plan] could not record the interrupted activation of ${proposalId}`, failure);
		}
	}

	private async reframe(
		goal: GoalTopicPlanActivationGoal,
		proposal: GoalTopicPlanProposal,
	): Promise<void> {
		const { workspaceDir } = this.capabilities;
		try {
			await (this.capabilities.reframe ?? reframeActivatedGoalWiki)({
				goalId: goal.id,
				goalDir: join(workspaceDir, goal.id),
				workspaceDir,
				goal: [goal.title, goal.description].filter(Boolean).join("\n\n"),
				proposal,
				env: this.capabilities.goalEnv(goal.id),
				signal: new AbortController().signal,
			});
			publish({
				type: "topic-plan:changed", goalId: goal.id, proposalId: proposal.proposal_id,
				status: "reframed", ts: new Date().toISOString(),
			});
		} catch (error) {
			console.error(`[telomi][topic-plan] activation failed for ${proposal.proposal_id}`, error);
			this.markFollowUpFailed(new GoalTopicPlanStore(goal.id, workspaceDir), proposal.proposal_id, error);
		}
	}
}
