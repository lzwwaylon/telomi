import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { RunArtifactStore } from "../agent-runtime/artifact-store.js";
import { GoalTopicPlanStore } from "../goals/topic-plan/index.js";
import { serverRuntimeDirForGoal } from "../workspaces/server-runtime-paths.js";
import { toErrorMessage } from "../lib/values.js";
import type { WikiGoalContext } from "../wiki/contracts.js";
import { drainCueWikiUpdates, enqueueCueWikiUpdate, getCueWikiQueueStatus } from "./cue-wiki-queue.js";

interface GoalInput {
	workspaceDir: string;
	goalId: string;
	goalDir: string;
	goalContext: WikiGoalContext;
	env: Record<string, string | undefined>;
	getGoalContext?: () => WikiGoalContext;
}

/** Register only committed artifacts. Startup repairs a crash between commit and registration. */
export function registerSavedInvestigationCues(input: Pick<GoalInput, "workspaceDir" | "goalId" | "goalDir">,
	origin?: { invocationId: string; investigationId: string; threadId: string }): void {
	const root = join(input.goalDir, "artifacts", "deep-search");
	if (!existsSync(root)) return;
	const files = origin ? [`${origin.invocationId}.json`] : readdirSync(root).filter(file => /^[a-f0-9]{24}-(?:external-)?[1-9][0-9]*\.json$/u.test(file)).sort();
	const store = new RunArtifactStore(input.goalDir);
	for (const file of files) {
		try {
			const investigationId = origin?.investigationId ?? file.slice(0, 24);
			const binding = join(serverRuntimeDirForGoal(input.goalId, input.workspaceDir), "research", "investigations", investigationId, "thread-binding.json");
			const threadId = origin?.threadId ?? (existsSync(binding) ? (JSON.parse(readFileSync(binding, "utf8")) as { thread_id?: string }).thread_id : undefined);
			const artifact = store.describeFile(`artifacts/deep-search/${file}`);
			enqueueCueWikiUpdate({ ...input, investigationId, threadId,
				artifactRef: { path: artifact.relativePath, sha256: artifact.sha256 } });
		} catch (error) {
			// One damaged historical file cannot hide other committed Notes or fail a user answer.
			console.warn(`[telomi][cue-wiki] registration failed for ${file}: ${toErrorMessage(error)}`);
		}
	}
}

/** Returns a durable start receipt; background errors remain in the queue and Wiki Activity. */
export function startGoalCueWikiUpdates(input: GoalInput & { retry?: boolean }) {
	const getContext = () => {
		const topics = new GoalTopicPlanStore(input.goalId, input.workspaceDir);
		const active = topics.readActive();
		const reframePending = active && topics.listProposals().some(proposal => proposal.status === "activated"
			&& proposal.candidate_plan.revision === active.revision
			&& (!proposal.reframe || ["running", "failed"].includes(proposal.reframe.status)));
		return { goalContext: input.getGoalContext?.() ?? input.goalContext,
			topicPlan: active && !topics.hasPendingRequiredConfirmation() && !reframePending ? active : undefined };
	};
	const execution = drainCueWikiUpdates({ ...input, ...getContext(), getContext });
	void execution.then(status => {
		if (status.status === "failed" || status.status === "interrupted") console.warn(`[telomi][cue-wiki] ${input.goalId}: ${status.message ?? status.status}`);
	}).catch(error => console.warn(`[telomi][cue-wiki] ${input.goalId}: ${toErrorMessage(error)}`));
	return { receipt: getCueWikiQueueStatus(input), execution };
}
