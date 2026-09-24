import { Router, type Response } from "express";

import {
	PromptRegistry,
	PromptRegistryConflictError,
	PromptRegistryNotFoundError,
	type PromptDomain,
	type PromptIdentity,
	type PromptKind,
} from "./prompt-registry.js";
import { toErrorMessage } from "../lib/values.js";

export function createPromptRegistryRouter(registry: PromptRegistry): Router {
	const router = Router();
	router.use((req, res, next) => {
		const address = req.socket.remoteAddress ?? "";
		if (!isLoopback(address) || !isLocalOrigin(req.get("origin"))) {
			res.status(403).json({ ok: false, error: "Prompt Registry administration is local-only" });
			return;
		}
		next();
	});

	router.get("/api/admin/prompts", (_req, res) => {
		try {
			res.json({ ok: true, prompts: registry.list().map((prompt) => ({
				identity: prompt.identity,
				defaultRevision: { revisionId: "default", templateSha256: prompt.defaultRevision.templateSha256,
					source: prompt.defaultRevision.source },
				activeRevision: { revisionId: prompt.activeRevision.revisionId,
					templateSha256: prompt.activeRevision.templateSha256, source: prompt.activeRevision.source },
				revisionCount: prompt.revisions.length,
			})) });
		} catch (error) {
			respondError(res, error);
		}
	});

	router.get("/api/admin/prompts/:domain/:id/:kind/:variant", (req, res) => {
		try {
			res.json({ ok: true, prompt: registry.get(identity(req.params)) });
		} catch (error) {
			respondError(res, error);
		}
	});

	router.post("/api/admin/prompts/:domain/:id/:kind/:variant/revisions", (req, res) => {
		try {
			const body = requireBody(req.body);
			assertKeys(body, ["template", "expectedActiveRevisionId", "description"]);
			const revision = registry.createRevision(identity(req.params), {
				template: body.template as string,
				expectedActiveRevisionId: body.expectedActiveRevisionId as string,
				...(body.description === undefined ? {} : { description: body.description as string }),
			});
			res.status(201).json({ ok: true, revision });
		} catch (error) {
			respondError(res, error);
		}
	});

	router.post("/api/admin/prompts/:domain/:id/:kind/:variant/activate", (req, res) => {
		try {
			const body = requireBody(req.body);
			assertKeys(body, ["revisionId", "expectedActiveRevisionId"]);
			const prompt = registry.activate(identity(req.params), {
				revisionId: body.revisionId as string,
				expectedActiveRevisionId: body.expectedActiveRevisionId as string,
			});
			res.json({ ok: true, prompt });
		} catch (error) {
			respondError(res, error);
		}
	});

	return router;
}

function identity(params: Record<string, string>): PromptIdentity {
	return {
		domain: params.domain as PromptDomain,
		id: params.id ?? "",
		kind: params.kind as PromptKind,
		variant: params.variant ?? "",
	};
}

function requireBody(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("JSON object body is required");
	return value as Record<string, unknown>;
}

function assertKeys(value: Record<string, unknown>, allowed: string[]): void {
	const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
	if (unknown.length) throw new Error(`Request contains unknown fields: ${unknown.join(", ")}`);
}

function respondError(res: Response, error: unknown): void {
	const status = error instanceof PromptRegistryConflictError ? 409
		: error instanceof PromptRegistryNotFoundError ? 404 : 400;
	res.status(status).json({ ok: false, error: toErrorMessage(error) });
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
