import { Router, type Response } from "express";

import type { GoalService } from "../../goals/service.js";
import { publish } from "../../events/event-bus.js";
import { createResearchScheduleFromRun } from "./create-from-run.js";
import { ResearchScheduleReviewService } from "./review-service.js";
import { ResearchScheduleStore } from "./store.js";
import { toErrorMessage } from "../../lib/values.js";

const UPDATABLE_FIELDS = ["title", "monitoringScope", "reportContext", "cron", "timeZone"] as const;
const PROPOSAL_EDIT_FIELDS = ["monitoringScope", "reportContext"] as const;
const REJECTION_FIELDS = ["reason"] as const;

export function createResearchSchedulesRouter(
	workspaceDir: string,
	goals: GoalService,
	reviews = new ResearchScheduleReviewService(workspaceDir),
): Router {
	const router = Router();

	router.get("/api/goals/:goalId/research/schedules", (req, res) => {
		withStore(req.params.goalId, workspaceDir, goals, res, (store) => {
			res.json({ schedules: store.list() });
		});
	});

	router.get("/api/goals/:goalId/research/schedules/:scheduleId", (req, res) => {
		withStore(req.params.goalId, workspaceDir, goals, res, (store) => {
			const schedule = store.get(req.params.scheduleId);
			if (!schedule) {
				res.status(404).json({ error: "Research Schedule not found" });
				return;
			}
			res.json({ schedule });
		});
	});

	router.post("/api/goals/:goalId/research/schedules", (req, res) => {
		try {
			const goalId = knownGoal(req.params.goalId, goals);
			const body = objectBody(req.body);
			const schedule = createResearchScheduleFromRun({
				workspaceDir,
				goalId,
				title: text(body.title, "title"),
				monitoringScope: text(body.monitoringScope, "monitoringScope"),
				sourceRunId: text(body.sourceRunId, "sourceRunId"),
				cron: text(body.cron, "cron"),
				timeZone: text(body.timeZone, "timeZone"),
			});
			changed(goalId, schedule.id, "created");
			res.status(201).json({ schedule });
		} catch (error) {
			apiError(res, error);
		}
	});

	router.patch("/api/goals/:goalId/research/schedules/:scheduleId", (req, res) => {
		withStore(req.params.goalId, workspaceDir, goals, res, (store, goalId) => {
			const schedule = store.update(
				req.params.scheduleId,
				given(objectBody(req.body), UPDATABLE_FIELDS),
			);
			changed(goalId, schedule.id, "updated");
			res.json({ schedule });
		});
	});

	router.get("/api/goals/:goalId/research/schedules/:scheduleId/reviews", (req, res) => {
		withStore(req.params.goalId, workspaceDir, goals, res, (store) => {
			const scheduleId = req.params.scheduleId;
			res.json({
				reviews: store.listReviews(scheduleId),
				proposals: store.listProposals(scheduleId),
			});
		});
	});

	router.post("/api/goals/:goalId/research/schedules/:scheduleId/review", (req, res) => {
		void (async () => {
			try {
				const goalId = knownGoal(req.params.goalId, goals);
				// The Review service publishes the Schedules changed event with its outcome.
				res.json({ review: await reviews.review(goalId, req.params.scheduleId) });
			} catch (error) {
				apiError(res, error);
			}
		})();
	});

	router.post(
		"/api/goals/:goalId/research/schedules/:scheduleId/proposals/:proposalId/confirm",
		(req, res) => {
			withStore(req.params.goalId, workspaceDir, goals, res, (store, goalId) => {
				const { schedule, proposal } = store.confirmProposal(
					req.params.scheduleId,
					req.params.proposalId,
					given(objectBody(req.body ?? {}), PROPOSAL_EDIT_FIELDS),
				);
				changed(goalId, schedule.id, `proposal_${proposal.status}`);
				res.json({ schedule, proposal });
			});
		},
	);

	router.post(
		"/api/goals/:goalId/research/schedules/:scheduleId/proposals/:proposalId/reject",
		(req, res) => {
			withStore(req.params.goalId, workspaceDir, goals, res, (store, goalId) => {
				const { schedule, proposal } = store.rejectProposal(
					req.params.scheduleId,
					req.params.proposalId,
					given(objectBody(req.body ?? {}), REJECTION_FIELDS).reason,
				);
				changed(goalId, schedule.id, `proposal_${proposal.status}`);
				projectRejection(goals, goalId);
				res.json({ schedule, proposal });
			});
		},
	);

	for (const action of ["pause", "resume", "run-now", "archive"] as const) {
		router.post(
			`/api/goals/:goalId/research/schedules/:scheduleId/${action}`,
			(req, res) => {
				withStore(req.params.goalId, workspaceDir, goals, res, (store, goalId) => {
					const scheduleId = req.params.scheduleId;
					const value = action === "pause"
						? { schedule: store.pause(scheduleId) }
						: action === "resume"
							? { schedule: store.resume(scheduleId) }
							: action === "archive"
								? { schedule: store.archive(scheduleId) }
								: { run: store.requestRunNow(scheduleId) };
					changed(goalId, scheduleId, action);
					res.json(value);
				});
			},
		);
	}

	return router;
}

/**
 * 拒绝是用户对这条 Research Schedule 的一次判断，和 Topic Plan 确认走同一条投影路径：
 * 被拒的取值和理由进入 User Memory Service，Main Agent 与后续 Review 都能回忆起来。
 */
function projectRejection(goals: GoalService, goalId: string): void {
	const goal = goals.getGoal(goalId);
	if (!goal) return;
	void goals.getRunner(goal)
		.then((runner) => runner.projectUserMemory())
		.catch((error: unknown) => {
			console.error(`[telomi][research-schedules] memory projection failed for ${goalId}`, error);
		});
}

function withStore(
	goalIdValue: string,
	workspaceDir: string,
	goals: GoalService,
	res: Response,
	work: (store: ResearchScheduleStore, goalId: string) => void,
): void {
	let store: ResearchScheduleStore | undefined;
	try {
		const goalId = knownGoal(goalIdValue, goals);
		store = new ResearchScheduleStore(goalId, workspaceDir);
		work(store, goalId);
	} catch (error) {
		apiError(res, error);
	} finally {
		store?.close();
	}
}

function knownGoal(value: string, goals: GoalService): string {
	if (!goals.getGoal(value)) throw new Error(`Unknown goal: ${value}`);
	return value;
}

function objectBody(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("Request body must be an object");
	}
	return value as Record<string, unknown>;
}

/**
 * 取出请求体里允许出现的字段并校验为非空文本。范围外的字段直接拒绝，端点因此不会
 * 因为多写一个键而悄悄改掉别的东西。
 */
function given<K extends string>(
	body: Record<string, unknown>,
	allowed: readonly K[],
): Partial<Record<K, string>> {
	const unexpected = Object.keys(body).filter((key) => !(allowed as readonly string[]).includes(key));
	if (unexpected.length > 0) throw new Error(`Only ${allowed.join(", ")} may be given here`);
	const picked: Partial<Record<K, string>> = {};
	for (const key of allowed) {
		if (body[key] !== undefined) picked[key] = text(body[key], key);
	}
	return picked;
}

function text(value: unknown, name: string): string {
	if (typeof value !== "string" || !value.trim()) throw new Error(`${name} is required`);
	return value.trim();
}

function changed(goalId: string, scheduleId: string, reason: string): void {
	publish({
		type: "research/schedules:changed",
		goalId,
		scheduleId,
		reason,
		ts: new Date().toISOString(),
	});
}

function apiError(
	res: Response,
	error: unknown,
): void {
	const message = toErrorMessage(error);
	const status = /Unknown|not found/iu.test(message)
		? 404
		: /active Run|already running|cannot|must initialize/iu.test(message)
			? 409
			: 400;
	res.status(status).json({ error: message });
}
