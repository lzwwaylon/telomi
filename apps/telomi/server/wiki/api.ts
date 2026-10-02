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
import { findLogicalSourceInRun, readSourceEvidenceAnchors } from "../workspaces/source-view.js";

function errorStatus(error: unknown): number {
	if (error instanceof Error && "code" in error && error.code === "ENOENT") return 404;
	const message = toErrorMessage(error);
	if (/Wiki Edition not found/iu.test(message)) return 404;
	if (/Wiki Source provenance is ambiguous/iu.test(message)) return 409;
	if (/Wiki Source Run is not part|Wiki Source document is not part|Invalid Wiki Source Run/iu.test(message)) return 400;
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
			const goalDir = join(workspaceDir, req.params.goalId);
			const runId = sourceRunForEdition(edition.root, sourcePath, goalDir, req.query.run);
			const documentPath = req.query.document === undefined ? undefined
				: sourceDocumentForEdition(edition.root, goalDir, sourcePath, runId, req.query.document);
			res.json(await resolveWikiSource(goalDir, sourcePath, runId, documentPath));
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
				pinnedRunId = sourceRunForEdition(editionFor(req.params.goalId, req.query).root, sourceId,
					join(workspaceDir, req.params.goalId), req.query.run);
			} catch (error) {
				if (req.query.revision || req.query.run || !/Wiki Edition not found|Wiki Note Registry is missing|Wiki Source provenance is missing/iu.test(errorMessage(error))) throw error;
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

function sourceDocumentForEdition(editionRoot: string, goalDir: string, sourceId: string, runId: string, document: unknown): string {
	const registry = JSON.parse(readFileSync(join(editionRoot, ".note-registry.json"), "utf8")) as {
		entries?: Array<{ sourceId: string; sourceRunId: string; anchors?: Array<{
			path: string; startLine: number; endLine: number; sha256: string; sourceId?: string; sourceRunId?: string;
		}> }>;
	};
	const anchor = typeof document === "string" && registry.entries?.flatMap(entry => (entry.anchors ?? [])
		.filter(item => item.path === document && (item.sourceId ?? entry.sourceId) === sourceId
			&& (item.sourceRunId ?? entry.sourceRunId) === runId))[0];
	if (!anchor) throw new Error("Wiki Source document is not part of this Edition");
	const source = findLogicalSourceInRun(join(goalDir, "wiki", "runs", runId), sourceId);
	if (!source) throw new Error(`Wiki Source not found: ${sourceId}`);
	readSourceEvidenceAnchors(source, [anchor]);
	return anchor.path;
}

function sourceRunForEdition(editionRoot: string, sourceId: string, goalDir: string, preferredRun?: unknown): string {
	if (preferredRun !== undefined && (typeof preferredRun !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(preferredRun))) {
		throw new Error("Invalid Wiki Source Run ID");
	}
	const path = join(editionRoot, ".note-registry.json");
	if (!existsSync(path)) throw new Error("Wiki Note Registry is missing");
	const registry = JSON.parse(readFileSync(path, "utf-8")) as { entries?: Array<{
		sourceId?: unknown;
		sourceRunId?: unknown;
		members?: Array<{ source_id?: unknown }>;
		anchors?: Array<{ sourceId?: unknown; sourceRunId?: unknown; sourceRevisionSha256?: unknown }>;
	}> };
	const runs = new Set<string>();
	for (const entry of registry.entries ?? []) {
		if (typeof entry.sourceRunId === "string" && (entry.sourceId === sourceId
			|| entry.members?.some((member) => member.source_id === sourceId))) runs.add(entry.sourceRunId);
		for (const anchor of entry.anchors ?? []) {
			if (typeof anchor.sourceRunId !== "string" || typeof anchor.sourceId !== "string"
				|| !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(anchor.sourceRunId)) continue;
			const source = findLogicalSourceInRun(join(goalDir, "wiki", "runs", anchor.sourceRunId), anchor.sourceId);
			if (anchor.sourceId !== sourceId && !source?.source.members?.some((member) => member.source_id === sourceId)) continue;
			if (!source || (anchor.sourceRevisionSha256 && source.source.revision_sha256 !== anchor.sourceRevisionSha256)) {
				throw new Error(`Wiki Source revision changed: ${anchor.sourceId}`);
			}
			runs.add(anchor.sourceRunId);
		}
	}
	if (preferredRun !== undefined) {
		if (!runs.has(preferredRun as string)) throw new Error(`Wiki Source Run is not part of this Edition: ${preferredRun}`);
		return preferredRun as string;
	}
	if (!runs.size) {
		throw new Error(`Wiki Source provenance is missing: ${sourceId}`);
	}
	if (runs.size !== 1) throw new Error(`Wiki Source provenance is ambiguous: ${sourceId}; select its original Run`);
	const run = [...runs][0]!;
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(run)) throw new Error("Invalid Wiki Source Run ID");
	return run;
}
