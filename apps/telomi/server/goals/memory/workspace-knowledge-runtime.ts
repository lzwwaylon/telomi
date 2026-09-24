import { hashJson } from "../../lib/hash.js";
import {
	buildWorkspaceKnowledgeSnapshot,
	readGoalSources,
	readWorkspaceKnowledgePages,
	type WorkspaceKnowledgeSnapshot,
} from "./knowledge-reflection.js";

export interface PinnedWorkspaceKnowledge {
	workspaceContentHash: string;
	knowledgeMemoryHash: string;
	knowledge: WorkspaceKnowledgeSnapshot;
}

/** Pins published knowledge by content. Goal Git state is intentionally irrelevant. */
export function readWorkspaceKnowledge(goalDir: string, goalId: string): PinnedWorkspaceKnowledge {
	const pages = readWorkspaceKnowledgePages(goalDir);
	const sources = readGoalSources(goalDir);
	const workspaceContentHash = hashJson({ pages, sources });
	const knowledge = buildWorkspaceKnowledgeSnapshot({ workspaceContentHash, goalId, pages, sources });
	return {
		workspaceContentHash,
		knowledgeMemoryHash: hashJson({ pages: knowledge.pages, sources: knowledge.sources, index: knowledge.index }),
		knowledge,
	};
}
