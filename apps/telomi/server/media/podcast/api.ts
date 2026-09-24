import { Router } from "express";
import { existsSync, promises as fsp } from "node:fs";
import { join } from "node:path";

import type { PodcastTranscriptResponse } from "../../../shared/types.js";
import type { GoalService } from "../../goals/service.js";
import { toErrorMessage } from "../../lib/values.js";

const SLUG_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/;

export function createPodcastsRouter(workspaceDir: string, goals: GoalService): Router {
	const router = Router();

	router.get("/api/goals/:goalId/podcasts/:slug/transcript-json", async (req, res) => {
		const goal = goals.getGoal(req.params.goalId);
		if (!goal) {
			res.status(404).json({ error: "Unknown goal" });
			return;
		}
		const slug = req.params.slug;
		if (!SLUG_RE.test(slug)) {
			res.status(400).json({ error: "invalid slug" });
			return;
		}
		const transcriptPath = join(workspaceDir, goal.id, "podcasts", slug, "transcript.json");
		if (!existsSync(transcriptPath)) {
			res.status(404).json({ error: "transcript timeline not found" });
			return;
		}
		try {
			const parsed = JSON.parse(await fsp.readFile(transcriptPath, "utf-8")) as PodcastTranscriptResponse;
			res.setHeader("Cache-Control", "no-cache");
			res.json(parsed);
		} catch (error) {
			res.status(500).json({ error: toErrorMessage(error) });
		}
	});

	return router;
}
