import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, join, relative } from "node:path";

import { sha256, type WikiSource } from "./contracts.js";
import { listFilesRecursive } from "../../lib/fs.js";

export interface WorkspaceKnowledgeSnapshot {
	schemaVersion: 2;
	workspaceContentHash: string;
	goalId: string;
	pages: Record<string, { content: string; sha256: string; sourceIds: string[] }>;
	sources: Record<string, WikiSource>;
	index: Array<{ path: string; title: string; sourceIds: string[] }>;
}

const PROFILE_PROJECTION_PATHS = new Set([
	"pages/user-knowledge.md",
	"pages/communication-overrides.md",
]);

export function buildWorkspaceKnowledgeSnapshot(input: Omit<WorkspaceKnowledgeSnapshot, "schemaVersion" | "index">): WorkspaceKnowledgeSnapshot {
	const index = Object.entries(input.pages)
		.map(([path, page]) => ({ path, title: /^#\s+(.+)$/m.exec(page.content)?.[1]?.trim() || basename(path, ".md"), sourceIds: page.sourceIds }))
		.sort((left, right) => left.path.localeCompare(right.path));
	return {
		schemaVersion: 2,
		...input,
		index,
	};
}

export function readWorkspaceKnowledgePages(goalDir: string): WorkspaceKnowledgeSnapshot["pages"] {
	const root = join(goalDir, "wiki", "knowledge");
	if (!existsSync(root)) return {};
	const pages: WorkspaceKnowledgeSnapshot["pages"] = {};
	for (const path of listFilesRecursive(root, { absolute: true, strict: true })) {
		const rel = relative(root, path).replaceAll("\\", "/");
		if (!path.endsWith(".md") || rel.startsWith("sources/") || ["index.md", "log.md", "_plan.md", "INSTRUCTIONS.md", "MEMORY.md"].includes(basename(path))) continue;
		if (PROFILE_PROJECTION_PATHS.has(rel) || rel === "pages/search-memory.md") continue;
		const content = readFileSync(path, "utf-8");
		pages[rel] = pageRecord(content, extractSourceIds(content));
	}
	return pages;
}

export function readGoalSources(goalDir: string): Record<string, WikiSource> {
	const root = join(goalDir, "wiki", "knowledge", "sources");
	if (!existsSync(root)) return {};
	const result: Record<string, WikiSource> = {};
	for (const path of listFilesRecursive(root, { absolute: true, strict: true })) {
		if (!path.endsWith(".md") || ["README.md", "index.md"].includes(basename(path))) continue;
		const content = readFileSync(path);
		const ids = [...new Set([...content.toString("utf-8").matchAll(/source:[a-f0-9]{24}/gu)].map((match) => match[0]))];
		for (const id of ids.length ? ids : [`source_${sha256(content).slice(0, 20)}`]) {
			result[id] = {
				id,
				uri: `goal:${relative(goalDir, path).replaceAll("\\", "/")}`,
				sha256: sha256(content),
				provenance: "goal-published-source",
				contentPath: path,
				verifiedAt: statSync(path).mtime.toISOString(),
			};
		}
	}
	return result;
}

function pageRecord(content: string, sourceIds: string[]): WorkspaceKnowledgeSnapshot["pages"][string] {
	return { content, sha256: sha256(content), sourceIds: [...new Set(sourceIds)].sort() };
}

function extractSourceIds(content: string): string[] {
	return [...content.matchAll(/source:[a-f0-9]{24}/g)].map((match) => match[0]);
}

