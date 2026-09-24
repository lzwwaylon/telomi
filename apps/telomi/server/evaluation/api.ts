/**
 * Operations HTTP Router。只挂在 loopback Operations Listener 上，产品 HTTP app
 * 永远不挂载它。路由集合由 `routesForMode()` 决定：Capture 模式只有只读 Case
 * Interface，Eval Instance 模式额外暴露 Bundle Import、Candidate Replay 和取消。
 */
import { Router } from "express";

import { toErrorMessage } from "../lib/values.js";
import type { GoalService } from "../goals/service.js";
import { caseCaptureHealth } from "../observability/case-capture.js";
import { caseRetentionStatus } from "./case-retention.js";
import {
	OPERATIONS_PROTOCOL_VERSION,
	OPERATIONS_SCHEMA_HASH,
	expressPath,
	routesForMode,
	validateOperations,
	type OperationsOperationId,
	type OperationsRoute,
} from "./operations-contract.js";
import { resolveExchangeBundlePath } from "./exchange-root.js";
import {
	type NodeBacktestRequest,
	type NodeBacktestService,
} from "./node-backtest.js";

type OperationsGoals = Pick<GoalService, "getGoal" | "ensureImportedGoal">;

export function createOperationsRouter(
	goals: OperationsGoals,
	service: NodeBacktestService,
	mode: "capture" | "eval",
	/** Only place a Bundle tar may be imported from. Unused in `capture` mode, which has no import route. */
	exchangeRoot: string,
): Router {
	const router = Router();
	const handlers = operationsHandlers(goals, service, mode, exchangeRoot);
	for (const route of routesForMode(mode)) {
		router[route.method](expressPath(route), contractChecked(route, handlers[route.operationId]!));
	}
	return router;
}

/**
 * Fail-closed response validation, centralized for every JSON route: a success body that
 * violates the contract never reaches the evaluation environment, it becomes a 500 naming the operation and the
 * offending path. Binary routes stream files and have no JSON body to check. This only wraps
 * the Operations Listener's router; the product HTTP app never mounts it.
 */
function contractChecked(route: OperationsRoute, handler: Handler): Handler {
	const schema = route.responseSchema;
	if (!schema) return handler;
	return (req, res) => {
		const send = res.json.bind(res);
		res.json = (body: unknown) => {
			if (res.statusCode < 200 || res.statusCode > 299) return send(body);
			try {
				validateOperations(schema, body);
			} catch (error) {
				const reason = `Operations response for '${route.operationId}' violates the contract: ${toErrorMessage(error)}`;
				console.error(`[telomi][operations] ${reason}`);
				return send.call(res.status(500), { error: reason });
			}
			return send(body);
		};
		return handler(req, res);
	};
}

type Handler = (req: import("express").Request, res: import("express").Response) => void | Promise<void>;

function operationsHandlers(
	goals: OperationsGoals,
	service: NodeBacktestService,
	mode: "capture" | "eval",
	exchangeRoot: string,
): Record<OperationsOperationId, Handler> {
	/** Resolves the Goal or ends the response with 404. */
	const goal = (req: import("express").Request, res: import("express").Response): string | undefined => {
		const found = goals.getGoal(param(req, "goalId"));
		if (found) return found.id;
		res.status(404).json({ error: "Unknown goal" });
		return undefined;
	};
	const caseRef = (req: import("express").Request) => ({
		sourceRunId: param(req, "sourceRunId"),
		caseId: param(req, "caseId"),
	});

	return {
		getStatus: (_req, res) => {
			res.json({
				ok: true,
				protocolVersion: OPERATIONS_PROTOCOL_VERSION,
				schemaHash: OPERATIONS_SCHEMA_HASH,
				mode,
				writable: mode === "eval",
				capture: { ...caseCaptureHealth(), retention: caseRetentionStatus() },
				...service.status(),
			});
		},

		listCases: (req, res) => {
			const goalId = goal(req, res);
			if (!goalId) return;
			try {
				const agentId = typeof req.query.agentId === "string" && req.query.agentId.trim()
					? req.query.agentId.trim()
					: undefined;
				res.json({ ok: true, cases: service.listCases(goalId, agentId, parseLimit(req.query.limit, 100)) });
			} catch (error) {
				res.status(400).json({ error: toErrorMessage(error) });
			}
		},

		readCase: (req, res) => {
			const goalId = goal(req, res);
			if (!goalId) return;
			try {
				res.json({ ok: true, case: service.readCase(goalId, caseRef(req)) });
			} catch (error) {
				res.status(404).json({ error: toErrorMessage(error) });
			}
		},

		listCaseFiles: (req, res) => {
			const goalId = goal(req, res);
			if (!goalId) return;
			try {
				res.json({ ok: true, files: service.listCaseFiles(goalId, caseRef(req)) });
			} catch (error) {
				res.status(404).json({ error: toErrorMessage(error) });
			}
		},

		readCaseFile: (req, res) => {
			const goalId = goal(req, res);
			if (!goalId) return;
			try {
				if (typeof req.query.ref !== "string" || !req.query.ref) throw new Error("ref is required");
				res.sendFile(service.caseFile(goalId, caseRef(req), req.query.ref));
			} catch (error) {
				res.status(404).json({ error: toErrorMessage(error) });
			}
		},

		exportCaseBundle: async (req, res) => {
			const found = goals.getGoal(param(req, "goalId"));
			if (!found) return void res.status(404).json({ error: "Unknown goal" });
			try {
				const bundle = await service.exportCaseBundle(found.id, found.title, caseRef(req));
				res.type("application/x-tar");
				res.setHeader("Content-Disposition", `attachment; filename="${req.params.caseId}.tar"`);
				res.sendFile(bundle.path, (error) => {
					bundle.cleanup();
					if (error && !res.headersSent) res.status(500).json({ error: toErrorMessage(error) });
				});
			} catch (error) {
				res.status(400).json({ error: toErrorMessage(error) });
			}
		},

		exportProviderChildCaseBundle: async (req, res) => {
			const found = goals.getGoal(param(req, "goalId"));
			if (!found) return void res.status(404).json({ error: "Unknown goal" });
			try {
				const ref = await service.ensureProviderChildCase(found.id, caseRef(req), param(req, "executionId"));
				const bundle = await service.exportCaseBundle(found.id, found.title, ref);
				res.type("application/x-tar");
				res.setHeader("Content-Disposition", `attachment; filename="${ref.caseId}.tar"`);
				res.sendFile(bundle.path, (error) => {
					bundle.cleanup();
					if (error && !res.headersSent) res.status(500).json({ error: toErrorMessage(error) });
				});
			} catch (error) { res.status(400).json({ error: toErrorMessage(error) }); }
		},

		importBundle: (req, res) => {
			try {
				validateOperations("BundleImportRequest", req.body);
				const path = resolveExchangeBundlePath(exchangeRoot, (req.body as { path: string }).path);
				res.json(service.importBundle(path, (id, title) => void goals.ensureImportedGoal(id, title)));
			} catch (error) {
				res.status(400).json({ error: toErrorMessage(error) });
			}
		},

		readCapabilitySnapshot: (req, res) => {
			const goalId = goal(req, res);
			if (!goalId) return;
			try {
				res.json({ ok: true, snapshot: service.readCapabilitySnapshot(goalId, param(req, "snapshotId")) });
			} catch (error) {
				res.status(404).json({ error: toErrorMessage(error) });
			}
		},

		startReplay: (req, res) => {
			const goalId = goal(req, res);
			if (!goalId) return;
			try {
				const body = (req.body ?? {}) as Record<string, unknown>;
				validateOperations("ReplayRequest", body);
				res.status(202).json({ ok: true, run: service.enqueue(goalId, body as unknown as NodeBacktestRequest) });
			} catch (error) {
				res.status(400).json({ error: toErrorMessage(error) });
			}
		},

		readReplay: (req, res) => {
			const goalId = goal(req, res);
			if (!goalId) return;
			const run = service.read(goalId, param(req, "runId"));
			if (!run) return void res.status(404).json({ error: "Unknown Replay Run" });
			res.json({ ok: true, run });
		},

		readReplayFile: (req, res) => {
			const goalId = goal(req, res);
			if (!goalId) return;
			try {
				if (typeof req.query.ref !== "string" || !req.query.ref) throw new Error("ref is required");
				res.sendFile(service.replayFile(goalId, param(req, "runId"), req.query.ref));
			} catch (error) {
				res.status(404).json({ error: toErrorMessage(error) });
			}
		},

		readEvaluationBatch: (req, res) => {
			const goalId = goal(req, res);
			if (!goalId) return;
			try {
				res.json({ ok: true, batch: service.evaluationBatch(goalId, param(req, "runId")) });
			} catch (error) {
				res.status(409).json({ error: toErrorMessage(error) });
			}
		},

		readEvaluationOutputArtifact: (req, res) => {
			const goalId = goal(req, res);
			if (!goalId) return;
			try {
				const label = param(req, "label");
				if (label !== "A" && label !== "B") throw new Error("label must be A or B");
				const file = typeof req.query.file === "string" && req.query.file ? req.query.file : undefined;
				res.sendFile(service.evaluationArtifactFile(goalId, param(req, "runId"), param(req, "pairId"), label, file));
			} catch (error) {
				res.status(404).json({ error: toErrorMessage(error) });
			}
		},

		readExecutionArtifact: (req, res) => {
			const goalId = goal(req, res);
			if (!goalId) return;
			try {
				const file = typeof req.query.file === "string" && req.query.file ? req.query.file : undefined;
				res.sendFile(service.artifactFile(goalId, param(req, "runId"), param(req, "executionId"), file));
			} catch (error) {
				res.status(404).json({ error: toErrorMessage(error) });
			}
		},

		cancelReplay: (req, res) => {
			const goalId = goal(req, res);
			if (!goalId) return;
			try {
				res.json({ ok: true, run: service.cancel(goalId, param(req, "runId")) });
			} catch (error) {
				res.status(404).json({ error: toErrorMessage(error) });
			}
		},
	};
}

/** Express path parameters are typed as `string | string[]`; Operations paths only ever bind single values. */
function param(req: import("express").Request, name: string): string {
	const value = req.params[name];
	if (typeof value !== "string" || !value) throw new Error(`Missing path parameter '${name}'`);
	return value;
}

function parseLimit(value: unknown, fallback: number): number {
	const parsed = typeof value === "string" ? Number(value) : Number.NaN;
	return Number.isFinite(parsed) && parsed > 0 ? Math.min(500, Math.floor(parsed)) : fallback;
}
