import { inspectProviderChildCapture } from "../evaluation/provider-child-case.js";
import type { ResearchModelPolicy } from "../agent-runtime/models/model-policy.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { bundledAgentSkillPath, snapshotSkills } from "../agent-runtime/skill-registry.js";
import type { AgentStageRunner } from "../agent-runtime/agent-stage-runtime.js";
import { createBrowserSkillEvolutionLoop } from "./browser-inner-loop.js";
import {
	NodeBacktestService,
	type NodeBacktestCaseRef,
} from "../evaluation/node-backtest.js";
import { effectiveProviderWorkerSkills, goalPrimeSearchSkills } from "../agent-runtime/provider-skills.js";
import type { SearchExecutionRecord } from "../providers/search-contracts.js";
import type {
	EvolutionEvidenceBundle,
	EvolutionEvidenceRef,
	EvolutionTarget,
} from "./service.js";

export function createEvolutionTargets(options: {
	workspaceDir: string;
	nodeBacktests: NodeBacktestService;
	/** Overrides the Agent Stage Runner of the Browser inner loop. Tests inject a scripted one. */
	stageRunner?: AgentStageRunner;
	/** Explicit Candidate Replay identity, never replaced by global configuration. */
	modelPolicy?: ResearchModelPolicy;
}): EvolutionTarget[] {
	return [browserProviderTarget(options)];
}

export const BROWSER_EVOLUTION_TARGET_ID = "prime-search/browser-provider";
/** One Evolution consumes exactly three settled Browser Provider child executions. */
export const BROWSER_EVOLUTION_BATCH_SIZE = 3;
const BROWSER_PROVIDER = { id: "browser", workerSkills: ["prime-browser-provider-skill"] } as const;

/** Effective Browser Provider Skill: the bundled default unless the Goal ships a same-name full override. */
export function effectiveBrowserProviderSkill(goalDirectory: string): string {
	return effectiveProviderWorkerSkills(
		[BROWSER_PROVIDER],
		goalPrimeSearchSkills(join(goalDirectory, "skills", "prime-search")),
	)[BROWSER_PROVIDER.id]![0]!;
}

/** One Browser Provider child execution, identified by the captured Prime Search Case that recorded it. */
export interface BrowserProviderExecutionRef {
	runId: string;
	caseId: string;
	executionId: string;
}

export function browserProviderExecutionEvidenceRef(value: BrowserProviderExecutionRef): EvolutionEvidenceRef {
	return { kind: "browser_provider_execution", runId: value.runId, caseId: value.caseId, executionId: value.executionId };
}

/**
 * Browser Provider child executions a captured Prime Search Case recorded as terminal successes.
 * `valid_bundle` is only written after the child's Candidate Ledger and Source Bundle both validated,
 * so it is the Provider completion receipt this Evolution counts.
 */
export function capturedBrowserProviderExecutions(
	nodeBacktests: Pick<NodeBacktestService, "listCaseFilePaths">,
	goalId: string,
	caseRef: NodeBacktestCaseRef,
): SearchExecutionRecord[] {
	const files = nodeBacktests.listCaseFilePaths(goalId, caseRef);
	const output = files.find((file) => file.ref === BROWSER_CASE_RESULT_REF);
	if (!output) return [];
	const result = JSON.parse(readFileSync(output.absolutePath, "utf-8")) as {
		execution_records?: unknown;
	};
	const records = Array.isArray(result.execution_records) ? result.execution_records : [];
	return records
		.filter((record): record is SearchExecutionRecord => Boolean(record) && typeof record === "object"
			&& (record as SearchExecutionRecord).provider_id === BROWSER_PROVIDER.id
			&& (record as SearchExecutionRecord).terminal_status === "valid_bundle"
			&& typeof (record as SearchExecutionRecord).execution_id === "string")
		.filter((record) => {
			try { inspectProviderChildCapture({ parent: { agentId: "prime-search" }, files, executionId: record.execution_id }); return true; }
			catch { return false; }
		})
		.sort((left, right) => left.execution_id.localeCompare(right.execution_id));
}

/**
 * Whether a Prime Search batch produced anything this Target could count: a Browser child that ended
 * in `valid_bundle`. Instances without full capture keep only these Prime Search Cases.
 */
export function producesBrowserEvolutionEvidence(result: {
	executionRecords: ReadonlyArray<{ record: Pick<SearchExecutionRecord, "provider_id" | "terminal_status"> }>;
}): boolean {
	return result.executionRecords.some(({ record }) => record.provider_id === BROWSER_PROVIDER.id
		&& record.terminal_status === "valid_bundle");
}

const BROWSER_CASE_RESULT_REF = "output:result.json";

function browserProviderExecutionRef(value: EvolutionEvidenceRef): BrowserProviderExecutionRef {
	if (value.kind !== "browser_provider_execution" || typeof value.runId !== "string" || !value.runId
		|| typeof value.caseId !== "string" || !value.caseId
		|| typeof value.executionId !== "string" || !value.executionId) {
		throw new Error("Browser Provider evidence must be Browser Provider execution refs");
	}
	return { runId: value.runId, caseId: value.caseId, executionId: value.executionId };
}

function browserProviderExecutionRefs(refs: readonly EvolutionEvidenceRef[]): BrowserProviderExecutionRef[] {
	const parsed = refs.map(browserProviderExecutionRef);
	if (parsed.length !== BROWSER_EVOLUTION_BATCH_SIZE) {
		throw new Error(`Browser Provider Evolution requires exactly ${BROWSER_EVOLUTION_BATCH_SIZE} Browser Provider executions`);
	}
	const identities = new Set(parsed.map((ref) => `${ref.runId}\u0000${ref.caseId}\u0000${ref.executionId}`));
	if (identities.size !== parsed.length) throw new Error("Browser Provider evidence repeats one execution");
	// The inner loop replays one Node Case per execution and rejects duplicate Case refs, so the
	// batch must come from distinct Cases, exactly as the automatic trigger assembles it.
	const cases = new Set(parsed.map((ref) => `${ref.runId}\u0000${ref.caseId}`));
	if (cases.size !== parsed.length) throw new Error("Browser Provider evidence must come from distinct Prime Search Cases");
	return parsed;
}

function browserProviderTarget(options: {
	workspaceDir: string;
	nodeBacktests: NodeBacktestService;
	stageRunner?: AgentStageRunner;
	/** Explicit Candidate Replay identity, never replaced by global configuration. */
	modelPolicy?: ResearchModelPolicy;
}): EvolutionTarget {
	return {
		id: BROWSER_EVOLUTION_TARGET_ID,
		ownerAgentId: "prime-search",
		version: 4,
		baselineSkillRoots: (goalDirectory) => [effectiveBrowserProviderSkill(goalDirectory)],
		async collectEvidence(input) {
			const refs = browserProviderExecutionRefs(input.evidenceRefs);
			const files: EvolutionEvidenceBundle["files"] = [];
			const runs = await Promise.all(refs.map(async (ref, caseIndex) => {
				const caseRef = { sourceRunId: ref.runId, caseId: ref.caseId };
				const childCaseRef = await options.nodeBacktests.ensureProviderChildCase(input.goalId, caseRef, ref.executionId);
				const value = options.nodeBacktests.readCase(input.goalId, childCaseRef);
				const record = JSON.parse(readFileSync(options.nodeBacktests.caseFile(input.goalId, childCaseRef,
					BROWSER_CASE_RESULT_REF), "utf-8")) as { provider_id?: string; terminal_status?: string };
				if (value.agentId !== "provider-child" || record.provider_id !== "browser" || record.terminal_status !== "valid_bundle") {
					throw new Error(`Node Case '${ref.caseId}' has no valid Browser child '${ref.executionId}'`);
				}
				files.push(...options.nodeBacktests.listCaseFilePaths(input.goalId, childCaseRef)
					.filter((file) => ["input", "observed_output", "child_trace", "execution_conditions", "agent_trace"].includes(file.kind))
					.map((file) => ({
					sourcePath: file.absolutePath,
					relativePath: `cases/${caseIndex + 1}/${file.ref.replace(":", "/")}`,
				})));
				return {
					run_id: ref.runId,
					case_id: ref.caseId,
					execution_id: ref.executionId,
					child_case_ref: childCaseRef,
					node_id: value.nodeId,
					captured_at: value.capturedAt,
					research_task: caseQuestion(options.nodeBacktests, input.goalId, childCaseRef),
					terminal_status: record.terminal_status,
				};
			}));
			return {
				manifest: {
					kind: "browser_provider_executions",
					browser_skill: browserSkillIdentity(input.goalDirectory),
					runs,
				},
				files,
			};
		},
		// The Browser Target owns a bounded iterative inner loop instead of one-shot authoring
		// plus blind judgment: the Agent replays its own Candidate and confirms it explicitly.
		innerLoop: createBrowserSkillEvolutionLoop({
			nodeBacktests: options.nodeBacktests,
			...(options.modelPolicy ? { modelPolicy: options.modelPolicy } : {}),
			...(options.stageRunner ? { runner: options.stageRunner } : {}),
		}),
	};
}

/** Identity of the Skill a Provider child would load right now: bundled default or Goal override. */
function browserSkillIdentity(goalDirectory: string): { name: string; sha256: string; source: "bundled" | "goal_override" } {
	const path = effectiveBrowserProviderSkill(goalDirectory);
	const skill = snapshotSkills([path]).skills[0]!;
	return {
		name: skill.name,
		sha256: skill.sha256,
		source: path === bundledAgentSkillPath("research", "prime-search", skill.name) ? "bundled" : "goal_override",
	};
}

function caseQuestion(
	nodeBacktests: Pick<NodeBacktestService, "caseInputFile">,
	goalId: string,
	caseRef: NodeBacktestCaseRef,
): string {
	const task = readFileSync(nodeBacktests.caseInputFile(goalId, caseRef, "task.md"), "utf-8");
	if (!task.trim()) throw new Error(`Node Case '${caseRef.caseId}' has no frozen Provider Child task`);
	return task.trimEnd();
}
