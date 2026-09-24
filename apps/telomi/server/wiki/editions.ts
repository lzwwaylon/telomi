import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { GoalTopicPlanStore } from "../goals/topic-plan/index.js";
import { serverRuntimeDirForGoal } from "../workspaces/server-runtime-paths.js";

export interface WikiEdition {
	revision: string;
	root: string;
	updatedAt: string;
	source: "published" | "wiki_update" | "topic_reframe";
}

export function listWikiEditions(workspaceDir: string, goalId: string): WikiEdition[] {
	const goalDir = join(workspaceDir, goalId);
	const candidates: WikiEdition[] = [];
	addEdition(candidates, join(goalDir, "wiki", "knowledge"), "published");

	const updatesRoot = join(goalDir, "wiki", "updates");
	for (const updateId of directories(updatesRoot)) {
		const resultPath = join(updatesRoot, updateId, "artifacts", "wiki-update", "result.json");
		if (!existsSync(resultPath)) continue;
		const result = JSON.parse(readFileSync(resultPath, "utf-8")) as {
			status?: unknown; compilation_id?: unknown; finished_at?: unknown;
		};
		if (!["succeeded", "partial"].includes(String(result.status)) || typeof result.compilation_id !== "string") continue;
		addEdition(candidates, join(
			updatesRoot, updateId, "artifacts", "wiki-compilations", result.compilation_id, "knowledge",
		), "wiki_update", typeof result.finished_at === "string" ? result.finished_at : undefined);
	}

	const store = new GoalTopicPlanStore(goalId, workspaceDir);
	for (const proposal of store.listProposals()) {
		if (proposal.reframe?.status !== "succeeded") continue;
		addEdition(candidates, join(
			serverRuntimeDirForGoal(goalId, workspaceDir), "topic-plan", "reframes", proposal.proposal_id, "artifacts", "knowledge",
		), "topic_reframe", proposal.reframe.updated_at);
	}

	const sourcePriority: Record<WikiEdition["source"], number> = { published: 0, topic_reframe: 1, wiki_update: 2 };
	const sorted = candidates.sort((left, right) => sourcePriority[left.source] - sourcePriority[right.source]
		|| right.updatedAt.localeCompare(left.updatedAt));
	const seen = new Set<string>();
	return sorted.filter((edition) => {
		if (seen.has(edition.revision)) return false;
		seen.add(edition.revision);
		return true;
	});
}

export function resolveWikiEdition(workspaceDir: string, goalId: string, revision?: string): WikiEdition {
	const editions = listWikiEditions(workspaceDir, goalId);
	const edition = revision ? editions.find((candidate) => candidate.revision === revision) : editions[0];
	if (!edition) throw new Error(revision ? `Wiki Edition not found for Topic revision ${revision}` : "Wiki Edition not found");
	return edition;
}

function addEdition(
	editions: WikiEdition[],
	root: string,
	source: WikiEdition["source"],
	updatedAt?: string,
): void {
	const topicPlanPath = join(root, ".topic-plan.json");
	if (!existsSync(topicPlanPath)) return;
	const value = JSON.parse(readFileSync(topicPlanPath, "utf-8")) as { revision?: unknown };
	if (typeof value.revision !== "string" || !value.revision.trim()) return;
	editions.push({ revision: value.revision, root, source, updatedAt: updatedAt ?? statSync(topicPlanPath).mtime.toISOString() });
}

function directories(root: string): string[] {
	return existsSync(root)
		? readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort()
		: [];
}
