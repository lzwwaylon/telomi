/**
 * Automatic Browser Evolution trigger.
 *
 * Runtime only counts settled Browser Provider child executions and schedules one
 * Evolution per full batch of three. Whether the batch contains an improvable pattern
 * stays with the Evolution Agent.
 *
 * The per-Goal cursor is the Evolution Run store itself: every started Run persists its
 * three execution refs in an immutable `request.json` before `start()` returns, so a
 * restart resolves the same consumed set without a second source of truth that could
 * disagree with the Runs it guards.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { NodeBacktestCaseRef, NodeBacktestService } from "../evaluation/node-backtest.js";
import { runRecordDir } from "../observability/run-records.js";
import { TERMINAL_RUN_STATUSES } from "../research/run-state.js";
import { IN_FLIGHT_RUN_STATUSES, replayedRounds, type EvolutionRun, type EvolutionService } from "./service.js";
import {
	BROWSER_EVOLUTION_BATCH_SIZE,
	BROWSER_EVOLUTION_TARGET_ID,
	browserProviderExecutionEvidenceRef,
	capturedBrowserProviderExecutions,
	type BrowserProviderExecutionRef,
} from "./targets.js";

const CASE_WINDOW = 500;
/** How often one batch may be handed to a Run that never reached a Candidate Replay. */
const MAX_UNREPLAYED_ATTEMPTS = 2;

const OBJECTIVE = "Improve the Browser Provider Skill for the scenarios these three Browser Provider executions show.";
const ACCEPTANCE_CRITERIA = [
	"Every rule generalizes to the scenario class, not to one URL, site, or keyword",
	"All three historical Browser Provider Child Cases replay with the Candidate Browser Skill",
	"Skill stays progressively disclosed: SKILL.md indexes each reference conditionally",
];

export interface BrowserProviderExecutionUnit extends BrowserProviderExecutionRef {
	capturedAt: string;
}

export class BrowserEvolutionTrigger {
	constructor(private readonly options: {
		workspaceDir: string;
		nodeBacktests: Pick<NodeBacktestService, "listCases" | "listCaseFilePaths">;
		evolution: Pick<EvolutionService, "list" | "start">;
	}) {}

	/**
	 * Consumes the next non-overlapping batch of three and starts one Evolution.
	 * Returns undefined while a batch is short, or while this Goal already owns an active Run.
	 */
	observe(goalId: string): EvolutionRun | undefined {
		const runs = this.options.evolution.list(goalId)
			.filter((run) => run.targetId === BROWSER_EVOLUTION_TARGET_ID);
		// An unfinished Run still owns its batch, so newer executions wait for the next one.
		if (runs.some((run) => IN_FLIGHT_RUN_STATUSES.includes(run.status))) return undefined;
		const pending = this.pending(goalId, runs);
		const batch: BrowserProviderExecutionUnit[] = [];
		const cases = new Set<string>();
		for (const unit of pending) {
			const key = `${unit.runId}\u0000${unit.caseId}`;
			if (cases.has(key)) continue;
			cases.add(key);
			batch.push(unit);
			if (batch.length === BROWSER_EVOLUTION_BATCH_SIZE) break;
		}
		if (batch.length < BROWSER_EVOLUTION_BATCH_SIZE) return undefined;
		return this.options.evolution.start(goalId, {
			targetId: BROWSER_EVOLUTION_TARGET_ID,
			objective: OBJECTIVE,
			acceptanceCriteria: [...ACCEPTANCE_CRITERIA],
			evidenceRefs: batch.map(browserProviderExecutionEvidenceRef),
		});
	}

	/** Countable executions this Goal has not consumed yet, oldest first. */
	pending(goalId: string, runs = this.options.evolution.list(goalId)): BrowserProviderExecutionUnit[] {
		const consumed = new Set<string>();
		const attempts = new Map<string, number>();
		for (const run of runs.filter((run) => run.targetId === BROWSER_EVOLUTION_TARGET_ID)) {
			// An in-flight Run owns its batch outright, and so does a cancelled one: stopping it
			// was a decision about the batch. Otherwise a settled Run owns it once a Candidate
			// Replay actually ran. A Run that never reached one tested nothing these executions
			// could have shown, so releasing them costs no evidence and keeps the batch usable.
			const owns = run.status === "cancelled"
				|| IN_FLIGHT_RUN_STATUSES.includes(run.status)
				|| replayedRounds(run) > 0;
			for (const ref of run.evidenceRefs) {
				const key = executionKey(ref as Partial<BrowserProviderExecutionRef>);
				const attempt = (attempts.get(key) ?? 0) + 1;
				attempts.set(key, attempt);
				// A permanently broken environment must not retry the same batch forever.
				if (owns || attempt >= MAX_UNREPLAYED_ATTEMPTS) consumed.add(key);
			}
		}
		return this.countable(goalId).filter((unit) => !consumed.has(executionKey(unit)));
	}

	/**
	 * One unit is one Browser Provider child execution that reached `valid_bundle` inside a
	 * captured production Prime Search Case whose enclosing Research Run has settled.
	 */
	countable(goalId: string): BrowserProviderExecutionUnit[] {
		const units: BrowserProviderExecutionUnit[] = [];
		for (const { ref, value } of this.options.nodeBacktests.listCases(goalId, "prime-search", CASE_WINDOW)) {
			// Candidate Replay Cases carry a Capability Snapshot; counting them would let an
			// Evolution's own verification feed the next batch.
			if (value.status !== "succeeded" || value.capabilitySnapshotId) continue;
			if (!this.settledResearchRun(goalId, ref.sourceRunId)) continue;
			for (const record of this.browserExecutions(goalId, ref)) {
				units.push({
					runId: ref.sourceRunId,
					caseId: ref.caseId,
					executionId: record.execution_id,
					capturedAt: value.capturedAt,
				});
			}
		}
		return units.sort((left, right) => executionOrder(left).localeCompare(executionOrder(right)));
	}

	private browserExecutions(goalId: string, caseRef: NodeBacktestCaseRef) {
		try {
			return capturedBrowserProviderExecutions(this.options.nodeBacktests, goalId, caseRef);
		} catch {
			return [];
		}
	}

	/** Imported and Candidate Replay Case run ids resolve to no Research Run directory. */
	private settledResearchRun(goalId: string, runId: string): boolean {
		let path: string;
		try {
			path = join(runRecordDir(this.options.workspaceDir, goalId, runId), "run-state.json");
		} catch {
			return false;
		}
		if (!existsSync(path)) return false;
		try {
			const status = (JSON.parse(readFileSync(path, "utf-8")) as { status?: unknown }).status;
			return typeof status === "string" && (TERMINAL_RUN_STATUSES as readonly string[]).includes(status);
		} catch {
			return false;
		}
	}
}

function executionKey(value: Partial<BrowserProviderExecutionRef>): string {
	return `${value.runId} ${value.caseId} ${value.executionId}`;
}

function executionOrder(unit: BrowserProviderExecutionUnit): string {
	return `${unit.capturedAt} ${unit.runId} ${unit.caseId} ${unit.executionId}`;
}
