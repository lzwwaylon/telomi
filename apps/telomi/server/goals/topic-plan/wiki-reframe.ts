import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { serverRuntimeDirForGoal } from "../../workspaces/server-runtime-paths.js";
import { hashWikiDirectory } from "../../wiki/files.js";
import { curateWikiEdition } from "../../wiki/wiki-shard-merge.js";
import type { ResearchModelUsage } from "../../agent-runtime/model-usage.js";
import { RunArtifactStore } from "../../agent-runtime/artifact-store.js";
import { publishCompilation } from "../../wiki/publication.js";
import type { GoalTopicPlanProposal } from "./contracts.js";
import { GoalTopicPlanStore } from "./store.js";
import { toErrorMessage } from "../../lib/values.js";

export async function reframeActivatedGoalWiki(input: {
	goalId: string;
	goalDir: string;
	workspaceDir: string;
	goal: string;
	proposal: GoalTopicPlanProposal;
	env: Record<string, string | undefined>;
	signal: AbortSignal;
	curate?: typeof curateWikiEdition;
	publish?: typeof publishCompilation;
}): Promise<{
	status: "promoted" | "no_change" | "no_wiki";
	pageCount: number;
	usage: ResearchModelUsage;
	changedPaths: string[];
}> {
	const store = new GoalTopicPlanStore(input.goalId, input.workspaceDir);
	const knowledgeRoot = join(input.goalDir, "wiki", "knowledge");
	if (!existsSync(join(knowledgeRoot, ".note-registry.json"))) {
		store.recordReframe(input.proposal.proposal_id, { status: "no_wiki", updated_at: new Date().toISOString() });
		return { status: "no_wiki", pageCount: 0, usage: emptyUsage(), changedPaths: [] };
	}
	store.recordReframe(input.proposal.proposal_id, { status: "running", updated_at: new Date().toISOString() });
	const workRoot = join(serverRuntimeDirForGoal(input.goalId, input.workspaceDir), "topic-plan", "reframes", input.proposal.proposal_id);
	mkdirSync(workRoot, { recursive: true });
	try {
		const curated = await (input.curate ?? curateWikiEdition)({
			operation: "reframe",
			goal: input.goal,
			topicPlan: input.proposal.candidate_plan,
			previousEditionRoot: knowledgeRoot,
			draftRoots: [],
			workRoot: join(workRoot, "work"),
			sessionRoot: join(workRoot, "sessions"),
			signal: input.signal,
		});
		const artifactStore = new RunArtifactStore(workRoot);
		const knowledge = artifactStore.publishDirectory(curated.knowledgeRoot, "artifacts/knowledge", curated.knowledgeRoot);
		const compilationId = `wiki-curator-${input.proposal.candidate_plan.revision}`;
		const publication = await (input.publish ?? publishCompilation)({
			goalId: input.goalId,
			goalDir: input.goalDir,
			workspaceDir: input.workspaceDir,
			compilation: {
				status: "compiled",
				compilationId,
				baseKnowledgeSha256: hashWikiDirectory(knowledgeRoot),
				knowledge,
				pageCount: curated.pageCount,
				usage: curated.usage,
				agentStages: curated.usage.calls > 0 ? 1 : 0,
				sessionPaths: curated.sessionPaths,
				failedBatches: [],
			},
			env: input.env,
			signal: input.signal,
		});
		store.recordReframe(input.proposal.proposal_id, {
			status: "succeeded",
			updated_at: new Date().toISOString(),
			message: publication.status,
			usage: usageRecord(curated.usage),
		});
		return { status: publication.status, pageCount: curated.pageCount, usage: curated.usage, changedPaths: publication.changedPaths };
	} catch (error) {
		store.recordReframe(input.proposal.proposal_id, {
			status: "failed",
			updated_at: new Date().toISOString(),
			message: toErrorMessage(error),
		});
		throw error;
	}
}

function emptyUsage(): ResearchModelUsage {
	return { inputTokens: 0, outputTokens: 0, costUsd: 0, calls: 0 };
}

function usageRecord(usage: ResearchModelUsage): NonNullable<GoalTopicPlanProposal["reframe"]>["usage"] {
	return { input_tokens: usage.inputTokens, output_tokens: usage.outputTokens, cost_usd: usage.costUsd, model_calls: usage.calls };
}
