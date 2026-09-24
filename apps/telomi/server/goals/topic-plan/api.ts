import { Router } from "express";

import { toErrorMessage } from "../../lib/values.js";
import type { GoalTopicPlanActivation, GoalTopicPlanActivationGoal } from "./activation.js";

/**
 * Topic Plan 的 HTTP Adapter：解析请求、调用完整激活操作、把结果和错误映射成响应。
 * 业务状态、执行顺序和后台调度留在 Topic Plan Module。
 */
export function createTopicPlanRouter(deps: {
	getGoal: (goalId: string) => GoalTopicPlanActivationGoal | undefined;
	activation: GoalTopicPlanActivation;
}): Router {
	const router = Router();
	router.post("/api/goals/:goalId/topic-plans/:proposalId/activate", async (req, res) => {
		const goal = deps.getGoal(req.params.goalId);
		if (!goal) {
			res.status(404).json({ error: "Unknown goal" });
			return;
		}
		try {
			const accepted = await deps.activation.activate(goal, req.params.proposalId);
			res.status(202).json({ accepted: true, goalId: accepted.goalId, proposalId: accepted.proposalId });
		} catch (error) {
			res.status(409).json({ error: toErrorMessage(error) });
		}
	});
	return router;
}
