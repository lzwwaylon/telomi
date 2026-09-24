import { join } from "node:path";

import type { GoalService } from "../../goals/service.js";
import { publish } from "../../events/event-bus.js";
import { serverRuntimeDirForGoal } from "../../workspaces/server-runtime-paths.js";
import * as log from "../../lib/log.js";
import type { ResearchScheduleReviewService } from "./review-service.js";
import { countGoalUserMessages, isResearchScheduleReviewDue } from "./review-trigger.js";
import { readProcessedResearchRun } from "./source-processing.js";
import { ResearchScheduleStore } from "./store.js";
import type { ClaimedResearchScheduleRun } from "./types.js";
import { toErrorMessage } from "../../lib/values.js";

const TICK_INTERVAL_MS = 15_000;

export class ResearchScheduleScheduler {
	private timer?: NodeJS.Timeout;
	private ticking = false;
	private readonly activeGoals = new Set<string>();
	private readonly reviewing = new Set<string>();

	constructor(
		private readonly workspaceDir: string,
		private readonly goals: GoalService,
		private readonly reviews: ResearchScheduleReviewService,
	) {}

	start(): void {
		if (this.timer) return;
		for (const goal of this.goals.listGoals()) {
			try {
				const store = new ResearchScheduleStore(goal.id, this.workspaceDir);
				try {
					const recovered = store.recoverInterrupted();
					if (recovered > 0) this.changed(goal.id, "recovered_interrupted_runs");
				} finally {
					store.close();
				}
			} catch (error) {
				this.logStoreFailure(goal.id, error);
			}
		}
		void this.tick();
		this.timer = setInterval(() => void this.tick(), TICK_INTERVAL_MS);
		this.timer.unref();
	}

	stop(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
	}

	/** Whether a claimed occurrence is still starting its Research Run or running it. */
	hasClaimedOccurrence(): boolean {
		return this.activeGoals.size > 0;
	}

	/**
	 * The earliest time an active Schedule is next due, which may already be past while its Goal
	 * is busy. Undefined when nothing is pending or this scheduler is not running.
	 */
	nextOccurrenceAt(): string | undefined {
		if (!this.timer) return undefined;
		let next: string | undefined;
		for (const goal of this.goals.listGoals()) {
			try {
				const store = new ResearchScheduleStore(goal.id, this.workspaceDir);
				try {
					for (const schedule of store.list()) {
						if (schedule.status !== "active" || !schedule.nextRunAt) continue;
						if (!next || Date.parse(schedule.nextRunAt) < Date.parse(next)) next = schedule.nextRunAt;
					}
				} finally {
					store.close();
				}
			} catch (error) {
				// A store the scheduler cannot open cannot start work either.
				this.logStoreFailure(goal.id, error);
			}
		}
		return next;
	}

	async tick(now = new Date()): Promise<void> {
		if (this.ticking) return;
		this.ticking = true;
		try {
			for (const goal of this.goals.listGoals()) {
				// Reviews are evaluated independently of occurrence claiming: a Review neither waits
				// for the Goal to go idle nor blocks the occurrence that is due on the same tick.
				this.startDueReviews(goal.id, now);
				if (this.activeGoals.has(goal.id) || this.goals.isGoalActive(goal.id)) continue;
				let claimed: ClaimedResearchScheduleRun | undefined;
				try {
					const store = new ResearchScheduleStore(goal.id, this.workspaceDir);
					try {
						claimed = store.claimNext(now);
					} finally {
						store.close();
					}
				} catch (error) {
					this.logStoreFailure(goal.id, error);
					continue;
				}
				if (!claimed) continue;
				this.activeGoals.add(goal.id);
				void this.runClaim(claimed).finally(() => this.activeGoals.delete(goal.id));
			}
		} finally {
			this.ticking = false;
		}
	}

	/**
	 * Runs the Research Schedule Reviewer for every active Schedule the deterministic trigger
	 * reports as due. At most one Reviewer per Schedule: a Schedule already under Review is
	 * skipped until its Review finishes and its bookkeeping has advanced.
	 */
	private startDueReviews(goalId: string, now: Date): void {
		let due: string[];
		try {
			const store = new ResearchScheduleStore(goalId, this.workspaceDir);
			try {
				const candidates = store.list().filter((schedule) => schedule.status === "active"
					&& !this.reviewing.has(this.reviewKey(goalId, schedule.id))
					&& !this.reviews.isRunning(goalId, schedule.id));
				// The transcript is only read when a Goal has an active Schedule to review, so the
				// tick does not scan every Goal's conversation every 15 seconds.
				const userMessages = candidates.length
					? countGoalUserMessages(join(this.workspaceDir, goalId))
					: 0;
				due = candidates
					.filter((schedule) => isResearchScheduleReviewDue(schedule, userMessages, now))
					.map((schedule) => schedule.id);
			} finally {
				store.close();
			}
		} catch (error) {
			log.logWarning(
				`[${goalId}] skipped Research Schedule Review evaluation because its store is unavailable`,
				toErrorMessage(error),
			);
			return;
		}
		for (const scheduleId of due) {
			const key = this.reviewKey(goalId, scheduleId);
			this.reviewing.add(key);
			void this.reviews.review(goalId, scheduleId)
				.catch((error) => log.logWarning(
					`[${goalId}] Research Schedule Review did not start for ${scheduleId}`,
					toErrorMessage(error),
				))
				.finally(() => this.reviewing.delete(key));
		}
	}

	private reviewKey(goalId: string, scheduleId: string): string {
		return `${goalId}:${scheduleId}`;
	}

	private logStoreFailure(goalId: string, error: unknown): void {
		log.logWarning(
			`[${goalId}] skipped Research Schedule tick because its store is unavailable`,
			toErrorMessage(error),
		);
	}

	private async runClaim(claimed: ClaimedResearchScheduleRun): Promise<void> {
		const { schedule, run } = claimed;
		this.changed(schedule.goalId, "run_started", schedule.id);
		const store = new ResearchScheduleStore(schedule.goalId, this.workspaceDir);
		try {
			if (!schedule.reportContext.trim()) {
				throw new Error("Research Schedule requires reportContext");
			}
			const result = await this.goals.runScheduledResearch({
				goalId: schedule.goalId,
				title: schedule.title,
				question: schedule.monitoringScope,
				reportContext: schedule.reportContext,
				// The occurrence names its Run as soon as one exists, not when it finishes, so the
				// Activity list shows one entry for it rather than a placeholder beside the live Run.
				onRunReserved: (researchRunId) => {
					try {
						store.linkResearchRun(run.id, researchRunId);
					} catch (error) {
						log.logWarning(`[${schedule.goalId}] could not link occurrence to its Research Run`, toErrorMessage(error));
					}
				},
				context: {
					scheduleId: schedule.id,
					occurrenceId: run.id,
					monitoringScope: schedule.monitoringScope,
					window: {
						startAt: run.windowStart,
						endAt: run.windowEnd,
						timeZone: schedule.timeZone,
					},
					processedSources: claimed.processedSources,
				},
			});
			const processed = readProcessedResearchRun({
				goalDir: join(this.workspaceDir, schedule.goalId),
				controlRunDir: join(
					serverRuntimeDirForGoal(schedule.goalId, this.workspaceDir),
					"runs",
					result.runId,
				),
				runId: result.runId,
			});
			const status = result.status === "published"
				? "published"
				: result.skipReason === "no_source_increment"
					? "skipped_no_source_increment"
					: "skipped_no_qualifying_evidence";
			store.complete({
				runId: run.id,
				status,
				researchRunId: result.runId,
				...(result.status === "published"
					? { reportPath: `wiki/runs/${result.runId}/report/final.md` }
					: {}),
				discoveredSources: processed.discoveredSources,
				incrementalSources: processed.sources.length,
				cornellNotes: processed.cornellNotes,
				sources: processed.sources,
				sourceGaps: processed.unprocessedSources,
			});
			this.changed(schedule.goalId, status, schedule.id);
		} catch (error) {
			const message = toErrorMessage(error);
			try {
				store.fail(run.id, message);
			} catch {
				// Preserve the original Runtime failure if persistence also failed.
			}
			this.changed(schedule.goalId, "run_failed", schedule.id);
		} finally {
			store.close();
		}
	}

	private changed(goalId: string, reason: string, scheduleId?: string): void {
		publish({
			type: "research/schedules:changed",
			goalId,
			...(scheduleId ? { scheduleId } : {}),
			reason,
			ts: new Date().toISOString(),
		});
	}
}
