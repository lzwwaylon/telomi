import { Router, type Request, type Response } from "express";

import { toErrorMessage } from "../lib/values.js";
import type { GoalService } from "../goals/service.js";
import { EvolutionService, type EvolutionRunRequest } from "./service.js";

export function createEvolutionRouter(
	goals: Pick<GoalService, "getGoal">,
	service: EvolutionService,
): Router {
	const router = Router();
	router.use((req, res, next) => {
		if (!isLoopback(req.socket.remoteAddress ?? "") || !isLocalOrigin(req.get("origin"))) {
			res.status(403).json({ ok: false, error: "Evolution administration is local-only" });
			return;
		}
		next();
	});

	router.get("/api/evolution/targets", (_req, res) => {
		res.json({ ok: true, targets: service.listTargets() });
	});

	router.post("/api/goals/:goalId/evolution/runs", (req, res) => {
		withGoal(req, res, goals, () => {
			const run = service.start(req.params.goalId, requireBody(req.body) as unknown as EvolutionRunRequest);
			res.status(202).json({ ok: true, run });
		});
	});

	router.get("/api/goals/:goalId/evolution/runs", (req, res) => {
		withGoal(req, res, goals, () => res.json({ ok: true, runs: service.list(req.params.goalId) }));
	});

	router.get("/api/goals/:goalId/evolution/runs/:runId", (req, res) => {
		withGoal(req, res, goals, () => res.json({ ok: true, run: service.read(req.params.goalId, req.params.runId) }));
	});

	router.post("/api/goals/:goalId/evolution/runs/:runId/cancel", (req, res) => {
		withGoal(req, res, goals, () => res.json({ ok: true, run: service.cancel(req.params.goalId, req.params.runId) }));
	});

	return router;
}

function withGoal(
	req: Request,
	res: Response,
	goals: Pick<GoalService, "getGoal">,
	action: () => void,
): void {
	if (!goals.getGoal(String(req.params.goalId))) {
		res.status(404).json({ error: "Unknown goal" });
		return;
	}
	try {
		action();
	} catch (error) {
		res.status(error instanceof SyntaxError ? 400 : 409).json({ error: toErrorMessage(error) });
	}
}

function requireBody(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new SyntaxError("JSON object body is required");
	return value as Record<string, unknown>;
}

function isLoopback(address: string): boolean {
	return address === "::1" || address === "127.0.0.1" || address.startsWith("::ffff:127.");
}

function isLocalOrigin(origin: string | undefined): boolean {
	if (!origin) return true;
	try {
		const hostname = new URL(origin).hostname;
		return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
	} catch {
		return false;
	}
}
