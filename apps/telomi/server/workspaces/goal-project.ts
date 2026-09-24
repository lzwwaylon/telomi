import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { WORKSPACE_AGENT_IDS } from "./agent-layout.js";

export interface GoalWorkspaceOptions {
	goalDir: string;
	goalId: string;
	title: string;
	description?: string;
	createdAt?: string;
}

export interface GoalWorkspaceResult {
	goalDir: string;
	filesCreated: string[];
}

/** Creates only Goal-owned data directories. Research Harness contracts remain server-owned. */
export function ensureGoalWorkspace(options: GoalWorkspaceOptions): GoalWorkspaceResult {
	mkdirSync(options.goalDir, { recursive: true });
	for (const directory of [
		...WORKSPACE_AGENT_IDS.map((agentId) => `skills/${agentId}`),
		"wiki/knowledge/sources",
	]) mkdirSync(join(options.goalDir, directory), { recursive: true });
	const filesCreated: string[] = [];
	const manifest = join(options.goalDir, "wiki/manifest.yaml");
	if (!existsSync(manifest)) {
		writeFileSync(manifest, [
			"schema_version: 1",
			"knowledge:",
			"  root: knowledge",
			"  sources: knowledge/sources",
			"  index: knowledge/index.md",
			"",
		].join("\n"), "utf-8");
		filesCreated.push("wiki/manifest.yaml");
	}
	return { goalDir: options.goalDir, filesCreated };
}
