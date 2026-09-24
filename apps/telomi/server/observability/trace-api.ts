import { Router } from "express";

import type { GoalService } from "../goals/service.js";
import {
	listTraceRuns,
	readTraceRun,
	resolveTraceFile,
	type TraceKind,
} from "./trace-reader.js";
import { toErrorMessage } from "../lib/values.js";

export function createTraceRouter(
	workspaceDir: string,
	goals: Pick<GoalService, "getGoal">,
): Router {
	const router = Router();

	router.get("/api/goals/:goalId/traces", (req, res) => {
		const goal = goals.getGoal(req.params.goalId);
		if (!goal) {
			res.status(404).json({ error: "Unknown goal" });
			return;
		}
		try {
			const kind = optionalKind(req.query.kind);
			res.json({
				ok: true,
				runs: listTraceRuns({
					workspaceDir,
					goalId: req.params.goalId,
					goalTitle: goal.title,
					...(kind ? { kind } : {}),
					limit: positiveLimit(req.query.limit, 50),
				}),
			});
		} catch (error) {
			res.status(400).json({ error: toErrorMessage(error) });
		}
	});

	router.get("/api/goals/:goalId/traces/:kind/:runId", async (req, res) => {
		const goal = goals.getGoal(req.params.goalId);
		if (!goal) {
			res.status(404).json({ error: "Unknown goal" });
			return;
		}
		try {
			res.json({ ok: true, run: readTraceRun({
				workspaceDir,
				goalId: req.params.goalId,
				goalTitle: goal.title,
				kind: requiredKind(req.params.kind),
				runId: req.params.runId,
			}) });
		} catch (error) {
			res.status(404).json({ error: toErrorMessage(error) });
		}
	});

	router.get("/api/goals/:goalId/traces/:kind/:runId/file", (req, res) => {
		if (!goals.getGoal(req.params.goalId)) {
			res.status(404).json({ error: "Unknown goal" });
			return;
		}
		try {
			const ref = typeof req.query.ref === "string" ? req.query.ref : "";
			if (!ref) throw new Error("ref is required");
			res.sendFile(resolveTraceFile({
				workspaceDir,
				goalId: req.params.goalId,
				kind: requiredKind(req.params.kind),
				runId: req.params.runId,
				ref,
			}));
		} catch (error) {
			res.status(404).json({ error: toErrorMessage(error) });
		}
	});

	return router;
}

function optionalKind(value: unknown): TraceKind | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string") throw new Error("kind must be research or wiki");
	return requiredKind(value);
}

function requiredKind(value: string): TraceKind {
	if (value === "research" || value === "wiki") return value;
	throw new Error("kind must be research or wiki");
}

function positiveLimit(value: unknown, fallback: number): number {
	if (value === undefined) return fallback;
	const parsed = typeof value === "string" ? Number(value) : Number.NaN;
	if (!Number.isInteger(parsed) || parsed < 1) throw new Error("limit must be a positive integer");
	return Math.min(500, parsed);
}

