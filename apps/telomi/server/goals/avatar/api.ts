import { Router } from "express";

import type { GoalSummary } from "../../../shared/types.js";
import type { GoalService } from "../service.js";
import { toErrorMessage } from "../../lib/values.js";

export function createAvatarRouter(input: {
	goals: GoalService;
	onGoalUpdated: (goal: GoalSummary) => void;
}): Router {
	const router = Router();

	router.post("/api/goals/:goalId/avatar/reroll", (req, res) => {
		try {
			const goal = input.goals.rerollGoalAvatar(req.params.goalId);
			input.onGoalUpdated(goal);
			res.json({ goal });
		} catch (error) {
			const message = toErrorMessage(error);
			res.status(message.startsWith("Unknown goal") ? 404 : 400).json({ error: message });
		}
	});

	return router;
}
