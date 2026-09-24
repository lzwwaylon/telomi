import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";

import { Router } from "express";

import type { GoalService } from "../goals/service.js";
import { GoalWikiSearch } from "./index.js";
import { wikiSearchExcerpt } from "./evidence.js";
import { createWikiRuntime } from "./model/index.js";
import { resolveWikiSource, resolveWikiSourceAsset } from "./source.js";
import { resolveWikiEdition } from "./editions.js";
import { toErrorMessage } from "../lib/values.js";

function errorStatus(error: unknown): number {
	if (error instanceof Error && "code" in error && error.code === "ENOENT") return 404;
	const message = toErrorMessage(error);
	if (/Wiki Edition not found/iu.test(message)) return 404;
	return /path must|invalid .* path|escapes the wiki root|outside the wiki root/i.test(message) ? 400 : 500;
}

function errorMessage(error: unknown): string {
	return toErrorMessage(error);
}

export function createWikiRouter(
	workspaceDir: string,
	goals: GoalService,
): Router {
	const router = Router();
	const revisionFrom = (query: Record<string, unknown>) => typeof query.revision === "string" && query.revision.trim()
		? query.revision.trim()
		: undefined;
	const editionFor = (goalId: string, query: Record<string, unknown>) => resolveWikiEdition(workspaceDir, goalId, revisionFrom(query));
	const runtimeFor = (goalId: string, query: Record<string, unknown>) => {
		const edition = editionFor(goalId, query);
		return { edition, runtime: createWikiRuntime(edition.root, { goalDir: join(workspaceDir, goalId) }) };
	};
	const knownGoal = (goalId: string) => Boolean(goals.getGoal(goalId));
	router.get("/api/goals/:goalId/wiki", async (req, res) => {
		if (!knownGoal(req.params.goalId)) return res.status(404).json({ error: "Unknown goal" });
		try {
			const { edition, runtime } = runtimeFor(req.params.goalId, req.query);
			res.json({ ...await runtime.readTree(), edition: { revision: edition.revision, source: edition.source } });
		} catch (error) {
			res.status(errorStatus(error)).json({ error: errorMessage(error) });
		}
	});

	router.get("/api/goals/:goalId/wiki/page", async (req, res) => {
		if (!knownGoal(req.params.goalId)) return res.status(404).json({ error: "Unknown goal" });
		const pagePath = typeof req.query.path === "string" ? req.query.path : "";
		if (!pagePath) return res.status(400).json({ error: "path query parameter required" });
		try {
			res.json(await runtimeFor(req.params.goalId, req.query).runtime.readPage(pagePath));
		} catch (error) {
			res.status(errorStatus(error)).json({ error: errorMessage(error) });
		}
	});

	router.get("/api/goals/:goalId/wiki/graph", async (req, res) => {
		if (!knownGoal(req.params.goalId)) return res.status(404).json({ error: "Unknown goal" });
		try {
			const { nodes, ...graph } = await runtimeFor(req.params.goalId, req.query).runtime.buildGraph();
			res.json({ ...graph, nodes: nodes.map(({ body: _body, ...node }) => node) });
		} catch (error) {
			res.status(errorStatus(error)).json({ error: errorMessage(error) });
		}
	});

	router.get("/api/goals/:goalId/wiki/search", async (req, res) => {
		if (!knownGoal(req.params.goalId)) return res.status(404).json({ error: "Unknown goal" });
		const query = typeof req.query.q === "string" ? req.query.q.trim() : "";
		const topicId = typeof req.query.topic === "string" ? req.query.topic.trim() : "";
		if (!query) return res.status(400).json({ error: "q query parameter required" });
		const parsedLimit = Number(req.query.limit ?? 20);
		const limit = Number.isInteger(parsedLimit) ? Math.max(1, Math.min(20, parsedLimit)) : 20;
		const goalDir = join(workspaceDir, req.params.goalId);
		try {
			const edition = editionFor(req.params.goalId, req.query);
			const search = new GoalWikiSearch(edition.root, { goalDir });
			const result = await search.search(query, limit, undefined, topicId || undefined);
			const results = await Promise.all(result.results.map(async (hit) => {
				const page = await search.readPage(hit.path);
				return { ...hit, snippet: wikiSearchExcerpt(page.content, query, { description: page.description }) };
			}));
			res.json({ ...result, results });
		} catch (error) {
			res.status(errorStatus(error)).json({ error: errorMessage(error) });
		}
	});

	router.get("/api/goals/:goalId/wiki/source", async (req, res) => {
		if (!knownGoal(req.params.goalId)) return res.status(404).json({ error: "Unknown goal" });
		const sourcePath = typeof req.query.path === "string" ? req.query.path : "";
		if (!sourcePath) return res.status(400).json({ error: "path query parameter required" });
		try {
			const edition = editionFor(req.params.goalId, req.query);
			res.json(await resolveWikiSource(join(workspaceDir, req.params.goalId), sourcePath,
				sourceRunForEdition(edition.root, sourcePath)));
		} catch (error) {
			res.status(errorStatus(error) === 500 && /not found/iu.test(errorMessage(error)) ? 404 : errorStatus(error)).json({ error: errorMessage(error) });
		}
	});

	router.get("/api/goals/:goalId/wiki/source-asset", async (req, res) => {
		if (!knownGoal(req.params.goalId)) return res.status(404).json({ error: "Unknown goal" });
		const sourceId = typeof req.query.source === "string" ? req.query.source : "";
		const assetPath = typeof req.query.path === "string" ? req.query.path : "";
		if (!sourceId || !assetPath) return res.status(400).json({ error: "source and path query parameters required" });
		try {
			// Report citations reference Research Runs that may predate any Wiki Edition; fall back to searching all Runs.
			let pinnedRunId: string | null = null;
			try {
				pinnedRunId = sourceRunForEdition(editionFor(req.params.goalId, req.query).root, sourceId);
			} catch {
				pinnedRunId = null;
			}
			const asset = await resolveWikiSourceAsset(join(workspaceDir, req.params.goalId), sourceId, assetPath, pinnedRunId);
			res.setHeader("Cache-Control", "private, max-age=300");
			res.sendFile(asset.absolutePath);
		} catch (error) {
			res.status(errorStatus(error) === 500 && /not found/iu.test(errorMessage(error)) ? 404 : errorStatus(error)).json({ error: errorMessage(error) });
		}
	});

	return router;
}

function sourceRunForEdition(editionRoot: string, sourceId: string): string {
	const path = join(editionRoot, ".note-registry.json");
	if (!existsSync(path)) throw new Error("Wiki Note Registry is missing");
	const registry = JSON.parse(readFileSync(path, "utf-8")) as { entries?: Array<{
		sourceId?: unknown;
		sourceRunId?: unknown;
		members?: Array<{ source_id?: unknown }>;
	}> };
	const entry = registry.entries?.find((candidate) => candidate.sourceId === sourceId
		|| candidate.members?.some((member) => member.source_id === sourceId));
	if (typeof entry?.sourceRunId !== "string" || !entry.sourceRunId) {
		throw new Error(`Wiki Source provenance is missing: ${sourceId}`);
	}
	return entry.sourceRunId;
}
