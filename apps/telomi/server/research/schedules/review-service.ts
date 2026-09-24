import { inferOutputLanguage, type ResolvedOutputLanguage } from "../../../shared/languages.js";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { publish } from "../../events/event-bus.js";
import { caseCapture } from "../../observability/case-capture.js";
import { toErrorMessage } from "../../lib/values.js";
import { parseScheduleReviewOutput } from "./review-contract.js";
import { countGoalUserMessages } from "./review-trigger.js";
import {
	runPrimeScheduleReviewer,
	scheduleReviewRoot,
	scheduleReviewTraceRef,
	type ScheduleReviewer,
} from "./reviewer.js";
import { ResearchScheduleStore, type ResearchScheduleReviewOutcome } from "./store.js";
import type { ResearchScheduleReview } from "./types.js";

/** 一次 Review 的上限。超时按失败记录，不自动重试。 */
export const RESEARCH_SCHEDULE_REVIEW_TIMEOUT_MS = 20 * 60_000;

/**
 * 按需运行 Research Schedule Reviewer 并记录结果。
 *
 * Review 不进入 Goal admission：它既不阻塞用户对话，也不排队等 Goal 空闲。唯一的并发约束是
 * 每个 Schedule 同时只有一个 Reviewer，避免两次 Review 竞争产生 Proposal。任何失败 -  - 超时、
 * 记忆服务不可用、契约违规 -  - 都作为 `failed` Review 留档，不自动重试。
 */
export class ResearchScheduleReviewService {
	private readonly running = new Set<string>();

	constructor(
		private readonly workspaceDir: string,
		private readonly reviewer: ScheduleReviewer = runPrimeScheduleReviewer,
		private readonly timeoutMs = RESEARCH_SCHEDULE_REVIEW_TIMEOUT_MS,
		/** Resolves the Goal's output language the way a Scheduled Research Run does: against the Report Context. */
		private readonly resolveLanguage: (goalId: string, text: string) => ResolvedOutputLanguage = (_goalId, text) => inferOutputLanguage(text),
	) {}

	isRunning(goalId: string, scheduleId: string): boolean {
		return this.running.has(`${goalId}:${scheduleId}`);
	}

	async review(goalId: string, scheduleId: string): Promise<ResearchScheduleReview> {
		const key = `${goalId}:${scheduleId}`;
		if (this.running.has(key)) {
			throw new Error("A Research Schedule Review is already running for this Research Schedule");
		}
		const { schedule, previousReview } = this.withStore(goalId, (store) => {
			const current = store.get(scheduleId);
			if (!current) throw new Error(`Unknown Research Schedule: ${scheduleId}`);
			if (current.status !== "active") {
				throw new Error(`A ${current.status} Research Schedule cannot be reviewed`);
			}
			return { schedule: current, previousReview: previousReviewHistory(store, scheduleId) };
		});
		const reviewId = `review_${randomUUID()}`;
		const startedAt = new Date().toISOString();
		// The cursor is read before the Reviewer starts, so messages that arrive while it runs
		// still count towards the next Review.
		const userMessageCount = countGoalUserMessages(join(this.workspaceDir, goalId));
		const timeout = AbortSignal.timeout(this.timeoutMs);
		this.running.add(key);
		let outcome: ResearchScheduleReviewOutcome;
		try {
			const reviewerInput = {
				goalId,
				workspaceDir: this.workspaceDir,
				reviewId,
				schedule,
				language: this.resolveLanguage(goalId, schedule.reportContext),
				previousReview,
				signal: timeout,
			};
			const validate = (output: unknown) => parseScheduleReviewOutput(output, schedule);
			// Capture 关闭时直接跑 Reviewer 并校验契约，不写 Evaluation Case。
			const capture = caseCapture();
			outcome = capture?.scheduleReviewer
				? await capture.scheduleReviewer(reviewerInput, { execute: this.reviewer, validate })
				: validate(await this.reviewer(reviewerInput));
		} catch (error) {
			outcome = {
				decision: "failed",
				reason: timeout.aborted
					? `Research Schedule Review timed out after ${Math.round(this.timeoutMs / 1000)}s`
					: toErrorMessage(error),
			};
		}
		// The lock is held until the Review is recorded: releasing it earlier would let a second
		// Reviewer start against bookkeeping this one has not written yet.
		try {
			const review = this.withStore(goalId, (store) => store.recordReview({
				id: reviewId,
				scheduleId,
				startedAt,
				// 只有真的留下现场才记 Trace：还没落盘就失败的 Review 不该指向一个不存在的目录。
				...(existsSync(scheduleReviewRoot(goalId, this.workspaceDir, reviewId))
					? { traceRef: scheduleReviewTraceRef(reviewId) }
					: {}),
				outcome,
				userMessageCount,
			}));
			publish({
				type: "research/schedules:changed",
				goalId,
				scheduleId,
				reason: `reviewed_${review.status}`,
				ts: new Date().toISOString(),
			});
			return review;
		} finally {
			this.running.delete(key);
		}
	}

	private withStore<T>(goalId: string, work: (store: ResearchScheduleStore) => T): T {
		const store = new ResearchScheduleStore(goalId, this.workspaceDir);
		try {
			return work(store);
		} finally {
			store.close();
		}
	}
}

/**
 * 上一次 Review 及其 Proposal 的结局，作为历史交给 Reviewer。被拒绝的 Proposal 连同用户给出的
 * 理由一起出现在这里；Prompt 说明它是历史而不是规则。
 */
function previousReviewHistory(store: ResearchScheduleStore, scheduleId: string): unknown {
	const review = store.listReviews(scheduleId)[0];
	if (!review) return null;
	const proposal = review.proposalId
		? store.listProposals(scheduleId).find((candidate) => candidate.id === review.proposalId)
		: undefined;
	return { review, proposal: proposal ?? null };
}
