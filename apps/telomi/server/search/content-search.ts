import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync } from "node:fs";
import { basename, extname, join } from "node:path";

import { Router } from "express";

import type { GoalService } from "../goals/service.js";
import { readUserTaskHistory } from "../observability/task-history.js";
import { serverRuntimeDirForGoal } from "../workspaces/server-runtime-paths.js";
import {
	isUserFacingArtifact,
	resolveProductArtifactPath,
	scanGoalProductArtifacts,
} from "../media/product-artifacts.js";
import { cardIdFromArtifactName } from "../media/products-api.js";
import { toErrorMessage } from "../lib/values.js";

export type ContentSearchKind = "report" | "podcast" | "file" | "question";

export interface ContentSearchResult {
	id: string;
	kind: ContentSearchKind;
	goalId: string;
	goalTitle: string;
	title: string;
	summary: string;
	updatedAt: string;
	artifactName?: string;
	cardId?: string;
}

export function createContentSearchRouter(workspaceDir: string, goals: GoalService): Router {
	const router = Router();
	router.get("/api/search", (req, res) => {
		const query = typeof req.query.q === "string" ? req.query.q.trim() : "";
		const goalId = typeof req.query.goalId === "string" ? req.query.goalId.trim() : undefined;
		if (!query) return res.status(400).json({ error: "q query parameter required" });
		if (query.length > 500) return res.status(400).json({ error: "q is too long" });
		if (goalId && !goals.getGoal(goalId)) return res.status(404).json({ error: "Unknown goal" });
		try {
			const selectedGoals = goals.listGoals().filter((goal) => !goalId || goal.id === goalId);
			res.json({ query, goalId: goalId ?? null, results: searchContent(workspaceDir, selectedGoals, query) });
		} catch (error) {
			res.status(500).json({ error: toErrorMessage(error) });
		}
	});
	return router;
}

export function searchContent(
	workspaceDir: string,
	goals: ReadonlyArray<{ id: string; title: string }>,
	query: string,
	limit = 60,
): ContentSearchResult[] {
	const tokens = query.toLocaleLowerCase().split(/\s+/u).filter(Boolean);
	return goals.flatMap((goal) => goalResults(workspaceDir, goal))
		.flatMap((result) => {
			const score = matchScore(result, tokens);
			return score > 0 ? [{ result, score }] : [];
		})
		.sort((left, right) => right.score - left.score
			|| right.result.updatedAt.localeCompare(left.result.updatedAt)
			|| left.result.title.localeCompare(right.result.title))
		.slice(0, Math.max(1, Math.min(100, limit)))
		.map(({ result }) => result);
}

function goalResults(workspaceDir: string, goal: { id: string; title: string }): ContentSearchResult[] {
	const artifacts = scanGoalProductArtifacts(workspaceDir, goal.id)
		.filter((artifact) => isUserFacingArtifact(artifact.name, artifact.source))
		.map((artifact): ContentSearchResult => {
			const metadata = fileMetadata(resolveProductArtifactPath(workspaceDir, goal.id, artifact.name), artifact.name);
			return {
				id: `${goal.id}:artifact:${artifact.name}`,
				kind: artifact.source === "workspace-report" ? "report" : "file",
				goalId: goal.id,
				goalTitle: goal.title,
				title: metadata.title,
				summary: metadata.summary,
				updatedAt: new Date(artifact.mtimeMs).toISOString(),
				artifactName: artifact.name,
				...(cardIdFromArtifactName(artifact.name) ? { cardId: cardIdFromArtifactName(artifact.name)! } : {}),
			};
		});
	return [...artifacts, ...podcastResults(workspaceDir, goal, artifacts), ...questionResults(workspaceDir, goal)];
}

function podcastResults(
	workspaceDir: string,
	goal: { id: string; title: string },
	artifacts: ContentSearchResult[],
): ContentSearchResult[] {
	const root = join(workspaceDir, goal.id, ".media-products");
	if (!existsSync(root)) return [];
	return directories(root).flatMap((cardId) => {
		const path = join(root, cardId, "podcast-ai.meta.json");
		if (!existsSync(path)) return [];
		try {
			const value = JSON.parse(readFileSync(path, "utf-8")) as {
				generatedAt?: unknown;
				extra?: { title?: unknown; slug?: unknown };
			};
			if (typeof value.generatedAt !== "string" || typeof value.extra?.title !== "string" || typeof value.extra.slug !== "string"
				|| !existsSync(join(workspaceDir, goal.id, "podcasts", value.extra.slug, "episode.mp3"))) return [];
			const source = artifacts.find((artifact) => artifact.cardId === cardId);
			return [{
				id: `${goal.id}:podcast:${cardId}`,
				kind: "podcast" as const,
				goalId: goal.id,
				goalTitle: goal.title,
				title: value.extra.title,
				summary: `Podcast · ${value.extra.slug}`,
				updatedAt: value.generatedAt,
				...(source?.artifactName ? { artifactName: source.artifactName } : {}),
				cardId,
			}];
		} catch {
			return [];
		}
	});
}

function questionResults(workspaceDir: string, goal: { id: string; title: string }): ContentSearchResult[] {
	try {
		return readUserTaskHistory(serverRuntimeDirForGoal(goal.id, workspaceDir))
			.filter((record) => record.source === "user_message" && record.message?.role === "user")
			.map((record) => ({
				id: `${goal.id}:question:${record.taskId}`,
				kind: "question" as const,
				goalId: goal.id,
				goalTitle: goal.title,
				title: record.originalQuestion,
				summary: record.finalAnswer?.slice(0, 180) || "用户问题",
				updatedAt: record.createdAt,
			}));
	} catch {
		return [];
	}
}

function matchScore(result: ContentSearchResult, tokens: string[]): number {
	const title = result.title.toLocaleLowerCase();
	const body = `${result.goalTitle}\n${result.summary}\n${result.artifactName ?? ""}`.toLocaleLowerCase();
	if (!tokens.every((token) => title.includes(token) || body.includes(token))) return 0;
	const phrase = tokens.join(" ");
	return title === phrase ? 100
		: title.startsWith(phrase) ? 80
			: title.includes(phrase) ? 60
				: tokens.every((token) => title.includes(token)) ? 45
					: 20;
}

function fileMetadata(path: string, name: string): { title: string; summary: string } {
	const fallback = basename(name, extname(name));
	if (![".md", ".markdown", ".txt", ".json"].includes(extname(name).toLocaleLowerCase())) {
		return { title: fallback, summary: name };
	}
	let fd: number | undefined;
	try {
		fd = openSync(path, "r");
		const buffer = Buffer.alloc(16_384);
		const bytes = readSync(fd, buffer, 0, buffer.length, 0);
		const text = buffer.subarray(0, bytes).toString("utf-8");
		const title = /^#\s+(.+)$/mu.exec(text)?.[1]?.trim() || fallback;
		const summary = text.split(/\n\s*\n/gu).map((part) => part.replace(/[#*`>\[\]()]/gu, " ").replace(/\s+/gu, " ").trim())
			.find((part) => part.length > 20 && part !== title)?.slice(0, 180) || name;
		return { title, summary };
	} catch {
		return { title: fallback, summary: name };
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}

function directories(root: string): string[] {
	return readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
}
