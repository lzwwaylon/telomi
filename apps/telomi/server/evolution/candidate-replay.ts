/**
 * Candidate Replay plumbing shared by the Browser inner loop and the outer Evolution Replay.
 *
 * A Candidate Replay runs a frozen historical Node Case against a Capability Snapshot that
 * carries the Candidate Skill.
 */
import { cpSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import { materializeCapabilities, type NodeBacktestExecution, type NodeBacktestRun, type NodeBacktestService } from "../evaluation/node-backtest.js";

const SETTLED_BACKTEST_STATUSES = ["awaiting_evaluation", "completed", "failed", "cancelled"];

/** Failed executions have no Candidate Case. Use only the executor's checked Artifact and ref allowlist. */
export function failedReplayFiles(
	service: Pick<NodeBacktestService, "artifactFile" | "replayFile">,
	goalId: string,
	runId: string,
	execution: NodeBacktestExecution,
): Array<{ ref: string; kind: "failure" | "trace"; path: string }> {
	return [
		{ ref: execution.artifact.ref, kind: "failure", path: service.artifactFile(goalId, runId, execution.id) },
		...[...new Set(Object.values(execution.refs ?? {}).filter((ref): ref is string => Boolean(ref)))].map((ref) => ({
			ref, kind: "trace" as const, path: service.replayFile(goalId, runId, ref),
		})),
	];
}

/** A Goal Capability Snapshot whose owner Skill directory is replaced by the Candidate. */
export function candidateCapabilitySnapshot(input: {
	goalId: string;
	goalDirectory: string;
	runDirectory: string;
	ownerAgentId: string;
	candidateSkillDirectory: string;
	skillName: string;
	nodeBacktests: Pick<NodeBacktestService, "createCapabilitySnapshot">;
}) {
	const root = join(input.runDirectory, "candidate-capability");
	rmSync(root, { recursive: true, force: true });
	mkdirSync(root, { recursive: true });
	materializeCapabilities(input.goalDirectory, root, ["wiki/knowledge"]);
	const ownerRoot = join(root, "skills", input.ownerAgentId);
	mkdirSync(ownerRoot, { recursive: true });
	rmSync(join(ownerRoot, input.skillName), { recursive: true, force: true });
	cpSync(input.candidateSkillDirectory, join(ownerRoot, input.skillName), { recursive: true });
	return input.nodeBacktests.createCapabilitySnapshot(input.goalId, root);
}

export async function waitForBacktest(
	service: Pick<NodeBacktestService, "read">,
	goalId: string,
	runId: string,
	signal: AbortSignal,
): Promise<NodeBacktestRun> {
	while (true) {
		if (signal.aborted) throw new Error("Evolution Candidate Replay cancelled");
		const run = service.read(goalId, runId);
		if (!run) throw new Error(`Node Backtest '${runId}' disappeared`);
		if (SETTLED_BACKTEST_STATUSES.includes(run.status)) return run;
		await new Promise((resolve) => setTimeout(resolve, 250));
	}
}
