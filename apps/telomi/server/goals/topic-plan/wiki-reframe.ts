import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { serverRuntimeDirForGoal } from "../../workspaces/server-runtime-paths.js";
import { hashWikiDirectory } from "../../wiki/files.js";
import { WikiCompiler } from "../../wiki/wiki-compiler.js";
import type { WikiGoalContext } from "../../wiki/contracts.js";
import { caseCapture } from "../../observability/case-capture.js";
import type { ResearchModelUsage } from "../../agent-runtime/model-usage.js";
import { RunArtifactStore } from "../../agent-runtime/artifact-store.js";
import { publishCompilation } from "../../wiki/publication.js";
import type { GoalTopicPlanProposal } from "./contracts.js";
import { GoalTopicPlanStore } from "./store.js";
import { toErrorMessage } from "../../lib/values.js";
import { withGoalWikiExecution } from "../../wiki/update-runner.js";

export async function reframeActivatedGoalWiki(input: {
	goalId: string;
	goalDir: string;
	workspaceDir: string;
	goal: string;
	goalContext: WikiGoalContext;
	proposal: GoalTopicPlanProposal;
	env: Record<string, string | undefined>;
	signal: AbortSignal;
	reindex?: WikiCompiler["reindex"];
	publish?: typeof publishCompilation;
}): Promise<{
	status: "promoted" | "no_change" | "no_wiki";
	pageCount: number;
	usage: ResearchModelUsage;
	changedPaths: string[];
}> {
	return withGoalWikiExecution(input.goalDir, () => reframeGoalWiki(input));
}

async function reframeGoalWiki(input: Parameters<typeof reframeActivatedGoalWiki>[0]): Promise<Awaited<ReturnType<typeof reframeActivatedGoalWiki>>> {
	const store = new GoalTopicPlanStore(input.goalId, input.workspaceDir);
	const knowledgeRoot = join(input.goalDir, "wiki", "knowledge");
	if (!existsSync(join(knowledgeRoot, ".note-registry.json"))) {
		store.recordReframe(input.proposal.proposal_id, { status: "no_wiki", updated_at: new Date().toISOString() });
		return { status: "no_wiki", pageCount: 0, usage: emptyUsage(), changedPaths: [] };
	}
	store.recordReframe(input.proposal.proposal_id, { status: "running", updated_at: new Date().toISOString() });
	const workRoot = join(serverRuntimeDirForGoal(input.goalId, input.workspaceDir), "topic-plan", "reframes", input.proposal.proposal_id);
	mkdirSync(workRoot, { recursive: true });
	const baseKnowledgeSha256 = hashWikiDirectory(knowledgeRoot);
	try {
		const request = {
			knowledgeRoot,
			goalContext: input.goalContext,
			topicPlan: input.proposal.candidate_plan,
			workRoot: join(workRoot, "work"),
			env: input.env,
			signal: input.signal,
		};
		const execute = input.reindex ?? ((request) => new WikiCompiler().reindex(request));
		const capture = caseCapture()?.wikiReindex;
		const curated = await (capture ? capture(request, {
			recordDirectory: workRoot, runId: input.proposal.proposal_id, execute,
		}) : execute(request));
		if (curated.failedTopics.length) throw new Error(`Wiki navigation has ${curated.failedTopics.length} unfinished Topics; retry to complete publication`);
		const artifactStore = new RunArtifactStore(workRoot);
		const knowledge = existsSync(join(workRoot, "artifacts/knowledge"))
			? artifactStore.describeDirectory("artifacts/knowledge")
			: artifactStore.publishDirectory(curated.knowledgeRoot, "artifacts/knowledge", curated.knowledgeRoot);
		if (hashWikiDirectory(knowledge.absolutePath) !== hashWikiDirectory(curated.knowledgeRoot)) {
			throw new Error("Wiki navigation artifact changed across publication retry");
		}
		const compilationId = `wiki-navigation-${input.proposal.candidate_plan.revision}`;
		const publication = await (input.publish ?? publishCompilation)({
			goalId: input.goalId,
			goalDir: input.goalDir,
			workspaceDir: input.workspaceDir,
			compilation: {
				status: "compiled",
				compilationId,
				baseKnowledgeSha256,
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
