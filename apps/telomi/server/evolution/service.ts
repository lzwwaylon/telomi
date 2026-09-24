import { randomUUID } from "node:crypto";
import {
	cpSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	renameSync,
	rmSync,
	rmdirSync,
	writeFileSync,
} from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";

import { isInsideRoot } from "../lib/paths.js";
import { toErrorMessage } from "../lib/values.js";
import { snapshotSkills } from "../agent-runtime/skill-registry.js";
import { JsonDocumentStore } from "../lib/json-document-store.js";
import { sha256 } from "../lib/hash.js";
import { serverRuntimeDirForGoal } from "../workspaces/server-runtime-paths.js";
import { readJson } from "../lib/fs.js";

const SAFE_ID = /^[a-z0-9][a-z0-9._/-]*$/u;
const SAFE_SKILL = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

export type EvolutionRunStatus =
	| "queued"
	| "collecting_evidence"
	| "authoring"
	| "replaying"
	| "applied"
	| "no_change"
	| "failed"
	| "cancelled";

/** Statuses a worker must be driving. Nothing resumes them, so a restart settles them. */
export const IN_FLIGHT_RUN_STATUSES: readonly EvolutionRunStatus[] = [
	"queued", "collecting_evidence", "authoring", "replaying",
];
export const TERMINAL_RUN_STATUSES: readonly EvolutionRunStatus[] = [
	"applied", "no_change", "failed", "cancelled",
];

export interface EvolutionEvidenceRef {
	kind: string;
	[key: string]: unknown;
}

export interface EvolutionEvidenceBundle {
	manifest: Record<string, unknown>;
	files: Array<{ sourcePath: string; relativePath: string }>;
}

/** One bounded inner-loop round: the Agent changed the Candidate, then replayed it. */
export interface EvolutionInnerLoopRound {
	round: number;
	replayRunId: string;
	passed: boolean;
	recordRelativePath: string;
}

/**
 * Rounds that reached a Candidate Replay. A round Runtime could not start records an empty
 * `replayRunId`, so a Run with none of them settled without testing anything its evidence could
 * have shown: `no_change` then reports the environment, not a judgment about the Skill.
 */
export function replayedRounds(run: Pick<EvolutionRun, "innerLoop">): number {
	return (run.innerLoop?.rounds ?? []).filter((round) => round.replayRunId !== "").length;
}

export interface EvolutionInnerLoopResult {
	outcome: "confirmed" | "no_change";
	summary: string;
	rounds: EvolutionInnerLoopRound[];
	/** Required when the Agent confirmed; ignored otherwise. */
	candidate?: EvolutionCandidateSubmission;
}

export interface EvolutionInnerLoopInput {
	run: EvolutionRun;
	goalDirectory: string;
	evidenceDirectory: string;
	baselineDirectory: string;
	candidateDirectory: string;
	recordDirectory: string;
	/** Reports the Agent phase so a long inner loop stays observable from the Run record. */
	setStatus(status: "authoring" | "replaying"): void;
	/**
	 * Publishes one finished round. A Run spends 40 to 90 minutes inside the loop, and its rounds
	 * are durable on disk as they complete; without this the Run record carries none of them until
	 * the whole loop returns, so `status` alone has to stand for an hour of progress.
	 */
	recordRound(round: EvolutionInnerLoopRound): void;
	signal: AbortSignal;
}

/**
 * Durable intent written before the Goal Skill is touched. A crash between the two directory
 * renames leaves exactly this file plus the on-disk evidence recovery needs to finish or undo.
 */
export interface EvolutionApplyIntent {
	schemaVersion: 1;
	phase: "prepared";
	runId: string;
	goalId: string;
	targetId: string;
	ownerAgentId: string;
	skillName: string;
	before: {
		skillSetSha256: string;
		skillSha256: string | null;
		source: "bundled" | "goal_override";
	};
	candidateSha256: string;
	replayRunIds: string[];
	preparedAt: string;
}

/** Immutable record of one automatic Goal Skill replacement. */
export interface EvolutionApplyReceipt {
	schemaVersion: 1;
	runId: string;
	goalId: string;
	targetId: string;
	skillName: string;
	before: {
		skillSetSha256: string;
		skillSha256: string | null;
		source: "bundled" | "goal_override";
		snapshotRelativePath: string | null;
	};
	after: { skillSetSha256: string; skillSha256: string };
	candidateSha256: string;
	replayRunIds: string[];
	/** How a maintenance command undoes this apply. */
	restore: "restore_before_snapshot" | "remove_goal_override";
	appliedAt: string;
}

export interface EvolutionTarget {
	id: string;
	ownerAgentId: string;
	version: number;
	/** Skill roots the Candidate starts from. Defaults to the Goal Skills of the owner Agent. */
	baselineSkillRoots?(goalDirectory: string): string[];
	collectEvidence(input: {
		goalId: string;
		goalDirectory: string;
		objective: string;
		acceptanceCriteria: string[];
		evidenceRefs: EvolutionEvidenceRef[];
		signal: AbortSignal;
	}): Promise<EvolutionEvidenceBundle>;
	/**
	 * Bounded iterative loop: the Agent edits and replays until it explicitly confirms.
	 * A confirmed result is applied automatically; `no_change` mutates nothing.
	 */
	innerLoop(input: EvolutionInnerLoopInput): Promise<EvolutionInnerLoopResult>;
}

export interface EvolutionCandidateSubmission {
	skillName: string;
	summary: string;
	expectedOutcome: string;
	selfChecks: string[];
}

export interface EvolutionRunRequest {
	targetId: string;
	objective: string;
	acceptanceCriteria: string[];
	evidenceRefs: EvolutionEvidenceRef[];
}

export interface EvolutionRun {
	schemaVersion: 1;
	id: string;
	goalId: string;
	targetId: string;
	ownerAgentId: string;
	status: EvolutionRunStatus;
	objective: string;
	acceptanceCriteria: string[];
	evidenceRefs: EvolutionEvidenceRef[];
	directory: string;
	createdAt: string;
	updatedAt: string;
	baseline: { skillSetSha256: string };
	candidate?: EvolutionCandidateSubmission & { sha256: string };
	/**
	 * Rounds appear here as the inner loop finishes them; `outcome` and `summary` arrive with the
	 * verdict, so both are absent while the loop is still running.
	 */
	innerLoop?: { outcome?: "confirmed" | "no_change"; summary?: string; rounds: EvolutionInnerLoopRound[] };
	apply?: EvolutionApplyReceipt;
	error?: string;
}

function evolutionRunStore(directory: string): JsonDocumentStore<EvolutionRun> {
	return new JsonDocumentStore<EvolutionRun>(directory, (value) => {
		const run = value as Partial<EvolutionRun> | null;
		if (!run || run.schemaVersion !== 1) throw new Error("schemaVersion must be 1");
		for (const field of ["id", "goalId", "targetId", "ownerAgentId", "status", "objective", "directory", "createdAt", "updatedAt"] as const) {
			if (typeof run[field] !== "string") throw new Error(`${field} must be a string`);
		}
		if (!Array.isArray(run.acceptanceCriteria) || !Array.isArray(run.evidenceRefs)) throw new Error("acceptanceCriteria and evidenceRefs must be arrays");
		if (typeof run.baseline?.skillSetSha256 !== "string") throw new Error("baseline.skillSetSha256 must be a string");
		return run as EvolutionRun;
	});
}

export class EvolutionService {
	private readonly targets: Map<string, EvolutionTarget>;
	private readonly active = new Map<string, { controller: AbortController; targetId: string }>();
	private readonly settledListeners = new Set<(run: EvolutionRun) => void>();

	constructor(private readonly options: {
		workspaceDir: string;
		listGoalIds: () => string[];
		targets: EvolutionTarget[];
		/**
		 * Called once per Run that reaches a terminal status, after that status is durably on disk.
		 * The optional composition-root observer captures Cases; lifecycle listeners can also
		 * subscribe through onSettled(). Errors never change the Run's verdict.
		 */
		onRunSettled?: (run: EvolutionRun) => void;
	}) {
		this.targets = new Map(options.targets.map((target) => [target.id, target]));
		if (this.targets.size !== options.targets.length) throw new Error("Evolution Target ids must be unique");
		if (options.onRunSettled) this.settledListeners.add(options.onRunSettled);
		this.recoverInterruptedRuns();
	}

	/** Adds one terminal Run observer and returns its lifecycle disposer. */
	onSettled(listener: (run: EvolutionRun) => void): () => void {
		this.settledListeners.add(listener);
		return () => this.settledListeners.delete(listener);
	}

	/**
	 * Settles every Run a dead process left behind. Nothing resumes an Evolution, so an in-flight
	 * Run without a worker would otherwise hold its Goal forever. Recovery keeps the Run and its
	 * consumed evidence refs, so the Browser cursor neither replays nor loses that batch.
	 */
	private recoverInterruptedRuns(): void {
		for (const goalId of this.safeGoalIds()) {
			for (const run of this.list(goalId)) {
				try {
					this.recoverRun(run);
				} catch (error) {
					console.warn(`[telomi][evolution] Recovery skipped Run '${run.id}': ${toErrorMessage(error)}`);
				}
			}
		}
	}

	private recoverRun(run: EvolutionRun): void {
		const receiptPath = join(run.directory, APPLY_RECEIPT_FILE);
		if (existsSync(receiptPath)) {
			// The Goal Skill was replaced and the Receipt is durable: only the Run record lagged.
			if (run.status !== "applied") {
				this.transition({ ...run, apply: readJson<EvolutionApplyReceipt>(receiptPath) }, "applied");
			}
			return;
		}
		// A Run that already settled keeps its verdict. Only an unfinished one needs recovery.
		if (TERMINAL_RUN_STATUSES.includes(run.status)) return;
		if (existsSync(join(run.directory, APPLY_INTENT_FILE))) {
			this.recoverInterruptedApply(run);
			return;
		}
		this.transition({ ...run, error: "Evolution was interrupted before it finished" }, "cancelled");
	}

	/**
	 * A crash inside the apply protocol. `apply-intent.json` pins what the Goal Skill was and what
	 * it was becoming, so the on-disk Skill decides deterministically between finishing and undoing.
	 */
	private recoverInterruptedApply(run: EvolutionRun): void {
		const intent = readJson<EvolutionApplyIntent>(join(run.directory, APPLY_INTENT_FILE));
		const goalSkill = goalSkillPath(this.goalDirectory(run.goalId), intent.ownerAgentId, intent.skillName);
		const snapshot = beforeSnapshotPath(run.directory, intent.skillName);
		this.clearStagedCandidate(run, intent);
		const current = skillSha256(goalSkill);
		if (current === intent.candidateSha256) {
			// The replacement rename completed. The mutation stands, so it gets its durable Receipt.
			const receipt = finalizeReceipt(intent, {
				afterSkillSha256: current,
				snapshotRelativePath: existsSync(snapshot) ? `${BEFORE_DIRECTORY}/${intent.skillName}` : null,
				afterSkillSetSha256: this.skillSetSha256(run, intent),
			});
			writeImmutableJson(join(run.directory, APPLY_RECEIPT_FILE), receipt);
			this.transition({ ...run, apply: receipt }, "applied");
			return;
		}
		if (current === null && existsSync(snapshot)) {
			// The Goal Skill was displaced but never replaced: undo, so no mutation survives.
			renameSync(snapshot, goalSkill);
			this.transition({ ...run, error: "Evolution apply was interrupted and rolled back" }, "cancelled");
			return;
		}
		if (current === intent.before.skillSha256
			|| (current === null && intent.before.source === "bundled" && !existsSync(snapshot))) {
			this.transition({ ...run, error: "Evolution apply was interrupted before it changed the Goal" }, "cancelled");
			return;
		}
		// Nothing on disk matches either side of the intent. Never guess: leave the Goal alone.
		this.transition({
			...run,
			error: `Evolution apply was interrupted and the Goal Skill matches neither side; recover from ${BEFORE_DIRECTORY}/${intent.skillName}`,
		}, "failed");
	}

	/** A staged Candidate a dead process left behind is never part of the Goal Skill set. */
	private clearStagedCandidate(run: EvolutionRun, intent: EvolutionApplyIntent): void {
		const goalDirectory = this.goalDirectory(run.goalId);
		rmSync(incomingPath(goalDirectory, intent.ownerAgentId, intent.skillName, run.id),
			{ recursive: true, force: true });
		removeIfEmpty(join(goalDirectory, "skills", INCOMING_DIRECTORY));
	}

	private skillSetSha256(run: EvolutionRun, intent: EvolutionApplyIntent): string {
		const target = this.targets.get(intent.targetId);
		return target
			? this.baselineSkills(this.goalDirectory(run.goalId), target).sha256
			: run.baseline.skillSetSha256;
	}

	private safeGoalIds(): string[] {
		try {
			return this.options.listGoalIds();
		} catch {
			return [];
		}
	}

	listTargets(): Array<{ id: string; ownerAgentId: string; version: number }> {
		return [...this.targets.values()]
			.map(({ id, ownerAgentId, version }) => ({ id, ownerAgentId, version }))
			.sort((left, right) => left.id.localeCompare(right.id));
	}

	start(goalId: string, request: EvolutionRunRequest): EvolutionRun {
		const goalDirectory = this.goalDirectory(goalId);
		if (!this.options.listGoalIds().includes(goalId) || !existsSync(goalDirectory)) {
			throw new Error(`Unknown goal '${goalId}'`);
		}
		const targetId = required(request.targetId, "targetId");
		const target = this.targets.get(targetId);
		if (!target) throw new Error(`Unknown Evolution Target '${targetId}'`);
		// One Goal runs at most one Evolution per Target: an inner loop replays into the same
		// Goal Skill it is about to replace, so a second concurrent Run would race its apply.
		if (this.activeRun(goalId, targetId)) {
			throw new Error(`Goal '${goalId}' already runs Evolution Target '${targetId}'`);
		}
		const objective = required(request.objective, "objective");
		const acceptanceCriteria = uniqueStrings(request.acceptanceCriteria, "acceptanceCriteria");
		if (!Array.isArray(request.evidenceRefs) || request.evidenceRefs.length === 0) {
			throw new Error("evidenceRefs must contain at least one reference");
		}
		const id = `evo_${Date.now()}_${randomUUID().slice(0, 8)}`;
		const directory = join(this.runsDirectory(goalId), id);
		mkdirSync(directory, { recursive: false });
		const now = new Date().toISOString();
		const run: EvolutionRun = {
			schemaVersion: 1,
			id,
			goalId,
			targetId,
			ownerAgentId: target.ownerAgentId,
			status: "queued",
			objective,
			acceptanceCriteria,
			evidenceRefs: structuredClone(request.evidenceRefs),
			directory,
			createdAt: now,
			updatedAt: now,
			baseline: { skillSetSha256: this.baselineSkills(goalDirectory, target).sha256 },
		};
		writeImmutableJson(join(directory, "request.json"), {
			schemaVersion: 1,
			id,
			goalId,
			targetId,
			objective,
			acceptanceCriteria,
			evidenceRefs: run.evidenceRefs,
			createdAt: now,
			baseline: run.baseline,
		});
		this.save(run);
		const controller = new AbortController();
		this.active.set(this.key(goalId, id), { controller, targetId });
		void this.execute(run, target, controller.signal).finally(() => this.active.delete(this.key(goalId, id)));
		return run;
	}

	read(goalId: string, runId: string): EvolutionRun {
		const run = evolutionRunStore(this.runDirectory(goalId, runId)).get("current");
		if (run === undefined) throw new Error(`Unknown Evolution Run '${runId}'`);
		return run;
	}

	list(goalId: string): EvolutionRun[] {
		const root = this.runsDirectory(goalId);
		if (!existsSync(root)) return [];
		return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
			if (!entry.isDirectory()) return [];
			try { return [this.read(goalId, entry.name)]; } catch { return []; }
		}).sort((left, right) => right.createdAt.localeCompare(left.createdAt));
	}

	/**
	 * A Run that still holds this Goal for this Target. A cancelled Run releases it at once, and
	 * the persisted statuses are consulted too so a Run this process does not drive still counts.
	 */
	private activeRun(goalId: string, targetId: string): boolean {
		const prefix = `${goalId}\0`;
		const driven = [...this.active].filter(([key, entry]) => key.startsWith(prefix)
			&& entry.targetId === targetId);
		if (driven.some(([, entry]) => !entry.controller.signal.aborted)) return true;
		const aborted = new Set(driven.map(([key]) => key.slice(prefix.length)));
		return this.list(goalId).some((run) => run.targetId === targetId
			&& IN_FLIGHT_RUN_STATUSES.includes(run.status) && !aborted.has(run.id));
	}

	cancel(goalId: string, runId: string): EvolutionRun {
		const run = this.read(goalId, runId);
		this.active.get(this.key(goalId, runId))?.controller.abort("evolution_cancelled");
		return TERMINAL_RUN_STATUSES.includes(run.status) ? run : this.transition(run, "cancelled");
	}

	/** Whether this process is still executing a Run, including one that is settling after cancellation. Nothing resumes a Run. */
	hasExecutingRun(): boolean {
		return this.active.size > 0;
	}

	stop(): void {
		for (const { controller } of this.active.values()) controller.abort("evolution_service_stopped");
	}

	private async execute(initial: EvolutionRun, target: EvolutionTarget, signal: AbortSignal): Promise<void> {
		let run = initial;
		try {
			run = this.transition(run, "collecting_evidence");
			const evidenceDirectory = join(run.directory, "evidence");
			mkdirSync(evidenceDirectory);
			const bundle = await target.collectEvidence({
				goalId: run.goalId,
				goalDirectory: this.goalDirectory(run.goalId),
				objective: run.objective,
				acceptanceCriteria: run.acceptanceCriteria,
				evidenceRefs: run.evidenceRefs,
				signal,
			});
			this.materializeEvidence(evidenceDirectory, run, target, bundle);
			const baselineDirectory = join(run.directory, "baseline");
			materializeSkillSet(this.baselineSkills(this.goalDirectory(run.goalId), target), baselineDirectory);
			const candidateDirectory = join(run.directory, "candidate");
			mkdirSync(candidateDirectory);
			run = this.transition(run, "authoring");
			await this.runInnerLoop(run, target, { evidenceDirectory, baselineDirectory, candidateDirectory }, signal);
		} catch (error) {
			if (signal.aborted) {
				const current = this.read(initial.goalId, initial.id);
				if (current.status !== "cancelled") this.transition(current, "cancelled");
				return;
			}
			const current = this.read(initial.goalId, initial.id);
			this.transition({ ...current, error: toErrorMessage(error) }, "failed");
		}
	}

	/**
	 * Bounded iterative path. The Target Agent edits and replays the Candidate itself and
	 * finishes with an explicit verdict; Runtime only records the verdict and, when the
	 * Agent confirmed, replaces the Goal Skill application-atomically with a recoverable snapshot.
	 */
	private async runInnerLoop(
		initial: EvolutionRun,
		target: EvolutionTarget,
		directories: { evidenceDirectory: string; baselineDirectory: string; candidateDirectory: string },
		signal: AbortSignal,
	): Promise<void> {
		let run = initial;
		const result = await target.innerLoop({
			run,
			goalDirectory: this.goalDirectory(run.goalId),
			evidenceDirectory: directories.evidenceDirectory,
			baselineDirectory: directories.baselineDirectory,
			candidateDirectory: directories.candidateDirectory,
			recordDirectory: run.directory,
			setStatus: (status) => { run = this.transition(run, status); },
			recordRound: (round) => {
				const rounds = [...(run.innerLoop?.rounds ?? []), round];
				run = this.transition({ ...run, innerLoop: { ...run.innerLoop, rounds } }, run.status);
			},
			signal,
		});
		if (signal.aborted) return;
		if (result.outcome !== "confirmed" && result.outcome !== "no_change") {
			throw new Error("Evolution inner loop must finish as confirmed or no_change");
		}
		const innerLoop = {
			outcome: result.outcome,
			summary: required(result.summary, "inner loop summary"),
			rounds: result.rounds,
		};
		writeImmutableJson(join(run.directory, "inner-loop.json"), { schemaVersion: 1, ...innerLoop });
		if (result.outcome === "no_change") {
			this.transition({ ...run, innerLoop }, "no_change");
			return;
		}
		if (!result.candidate) throw new Error("A confirmed Evolution inner loop must submit one Candidate Skill");
		const candidate = this.validateCandidate(directories.candidateDirectory, result.candidate);
		writeImmutableJson(join(run.directory, "candidate.json"), candidate);
		run = { ...run, innerLoop, candidate };
		const apply = this.applyInnerLoopCandidate(run, target, result.rounds.map((round) => round.replayRunId));
		writeImmutableJson(join(run.directory, APPLY_RECEIPT_FILE), apply);
		this.transition({ ...run, apply }, "applied");
	}

	/**
	 * Installs a confirmed Candidate as the Goal Skill and returns its Apply Receipt.
	 *
	 * Two synchronous directory renames run in one JavaScript turn: the current Goal Skill moves
	 * into `before/`, then the staged Candidate moves into its place. No request in the supported
	 * single-process deployment can observe the gap. `apply-intent.json` makes a process crash in
	 * that gap recoverable before the next listener starts accepting work.
	 */
	private applyInnerLoopCandidate(
		run: EvolutionRun,
		target: EvolutionTarget,
		replayRunIds: string[],
	): EvolutionApplyReceipt {
		const candidate = run.candidate;
		if (!candidate) throw new Error("Evolution apply requires a validated Candidate");
		const goalDirectory = this.goalDirectory(run.goalId);
		const beforeSkillSetSha256 = this.baselineSkills(goalDirectory, target).sha256;
		if (beforeSkillSetSha256 !== run.baseline.skillSetSha256) {
			throw new Error("Evolution baseline changed before apply");
		}
		const overridePath = goalSkillPath(goalDirectory, run.ownerAgentId, candidate.skillName);
		const hadOverride = existsSync(overridePath);
		const intent: EvolutionApplyIntent = {
			schemaVersion: 1,
			phase: "prepared",
			runId: run.id,
			goalId: run.goalId,
			targetId: run.targetId,
			ownerAgentId: run.ownerAgentId,
			skillName: candidate.skillName,
			before: {
				skillSetSha256: beforeSkillSetSha256,
				// No Goal override existed means the bundled default was in effect, and the Run
				// already materialized that effective Skill into its immutable baseline.
				skillSha256: skillSha256(hadOverride ? overridePath : join(run.directory, "baseline", candidate.skillName)),
				source: hadOverride ? "goal_override" : "bundled",
			},
			// The Skill hash, so the Receipt links directly to the hash each replay round pinned.
			candidateSha256: requiredSkillSha256(join(run.directory, "candidate", candidate.skillName)),
			replayRunIds,
			preparedAt: new Date().toISOString(),
		};
		writeImmutableJson(join(run.directory, APPLY_INTENT_FILE), intent);
		const replaced = this.replaceGoalSkill(run, candidate.skillName, candidate.sha256);
		return finalizeReceipt(intent, {
			afterSkillSha256: requiredSkillSha256(overridePath),
			snapshotRelativePath: replaced.snapshotRelativePath,
			afterSkillSetSha256: this.baselineSkills(goalDirectory, target).sha256,
		});
	}

	/**
	 * Replaces the Goal Skill with the confirmed Candidate by one rename on the same volume.
	 * The displaced Skill becomes the Run's recoverable `before/` snapshot.
	 */
	private replaceGoalSkill(
		run: EvolutionRun,
		skillName: string,
		expectedSha256: string,
	): { snapshotPath: string | null; snapshotRelativePath: string | null } {
		const candidate = join(run.directory, "candidate", skillName);
		if (snapshotSkills([candidate]).sha256 !== expectedSha256) {
			throw new Error("Evolution Candidate changed after it was confirmed");
		}
		const goalDirectory = this.goalDirectory(run.goalId);
		const ownerRoot = join(goalDirectory, "skills", run.ownerAgentId);
		mkdirSync(ownerRoot, { recursive: true });
		const target = goalSkillPath(goalDirectory, run.ownerAgentId, skillName);
		const incoming = incomingPath(goalDirectory, run.ownerAgentId, skillName, run.id);
		const displaced = beforeSnapshotPath(run.directory, skillName);
		let snapshot: string | null = null;
		try {
			rmSync(incoming, { recursive: true, force: true });
			mkdirSync(resolve(incoming, ".."), { recursive: true });
			cpSync(candidate, incoming, { recursive: true });
			if (snapshotSkills([incoming]).sha256 !== expectedSha256) {
				throw new Error("Evolution Candidate copy does not match the confirmed Skill");
			}
			if (existsSync(target)) {
				mkdirSync(join(run.directory, BEFORE_DIRECTORY), { recursive: true });
				renameSync(target, displaced);
				snapshot = displaced;
			}
			try {
				renameSync(incoming, target);
			} catch (error) {
				if (snapshot && existsSync(snapshot)) renameSync(snapshot, target);
				throw error;
			}
		} finally {
			// Never leave a staged copy behind: a later Skill snapshot must see one Goal Skill.
			rmSync(incoming, { recursive: true, force: true });
			removeIfEmpty(join(goalDirectory, "skills", INCOMING_DIRECTORY));
		}
		return {
			snapshotPath: snapshot,
			snapshotRelativePath: snapshot ? `${BEFORE_DIRECTORY}/${skillName}` : null,
		};
	}

	private materializeEvidence(
		directory: string,
		run: EvolutionRun,
		target: EvolutionTarget,
		bundle: EvolutionEvidenceBundle,
	): void {
		const files = bundle.files.map((file) => {
			const source = safeRegularFile(file.sourcePath, "Evolution evidence");
			const relativePath = safeRelativePath(file.relativePath, "Evolution evidence path");
			const targetPath = resolve(directory, relativePath);
			if (targetPath === resolve(directory) || !isInsideRoot(directory, targetPath)) {
				throw new Error("Evolution evidence target escapes its root");
			}
			mkdirSync(resolve(targetPath, ".."), { recursive: true });
			cpSync(source, targetPath);
			return { relativePath, sha256: sha256(readFileSync(targetPath)) };
		});
		writeImmutableJson(join(directory, "manifest.json"), {
			schemaVersion: 1,
			goalId: run.goalId,
			targetId: run.targetId,
			targetVersion: target.version,
			objective: run.objective,
			acceptanceCriteria: run.acceptanceCriteria,
			evidenceRefs: run.evidenceRefs,
			baselineSkillSetSha256: run.baseline.skillSetSha256,
			redaction: "target_projection",
			files,
			...bundle.manifest,
		});
	}

	private validateCandidate(
		candidateDirectory: string,
		submission: EvolutionCandidateSubmission,
	): EvolutionRun["candidate"] & {} {
		const skillName = submission.skillName?.trim();
		if (!skillName || !SAFE_SKILL.test(skillName)) throw new Error("Candidate skillName is invalid");
		const entries = readdirSync(candidateDirectory, { withFileTypes: true });
		if (entries.length !== 1 || entries[0]?.name !== skillName || !entries[0].isDirectory()) {
			throw new Error("Candidate must contain exactly one Skill directory");
		}
		const skill = snapshotSkills([join(candidateDirectory, skillName)]);
		if (skill.skills.length !== 1 || skill.skills[0]?.name !== skillName) {
			throw new Error("Candidate Skill identity changed");
		}
		return {
			skillName,
			summary: required(submission.summary, "candidate summary"),
			expectedOutcome: required(submission.expectedOutcome, "candidate expectedOutcome"),
			selfChecks: uniqueStrings(submission.selfChecks, "candidate selfChecks"),
			sha256: skill.sha256,
		};
	}

	private transition(run: EvolutionRun, status: EvolutionRunStatus): EvolutionRun {
		const next = { ...run, status, updatedAt: new Date().toISOString() };
		this.save(next);
		if (TERMINAL_RUN_STATUSES.includes(status)) {
			// Fail-open, exactly like product Case Capture: the verdict is already durable, and a
			// Capture failure must not turn a settled Evolution into an error.
			for (const listener of this.settledListeners) {
				try {
					listener(next);
				} catch (error) {
					console.warn(`[telomi][evolution] settled listener skipped Run '${next.id}': ${toErrorMessage(error)}`);
				}
			}
		}
		return next;
	}

	private save(run: EvolutionRun): void {
		evolutionRunStore(run.directory).put("current", run);
	}

	/** Effective Skills the Target evolves: bundled defaults resolved by the Target, else the Goal Skills it owns. */
	private baselineSkills(goalDirectory: string, target: EvolutionTarget) {
		return snapshotSkills(
			target.baselineSkillRoots?.(goalDirectory) ?? [join(goalDirectory, "skills", target.ownerAgentId)],
			{ allowOverrides: true },
		);
	}

	private goalDirectory(goalId: string): string {
		return join(this.options.workspaceDir, safeIdentity(goalId, "goal"));
	}

	private runsDirectory(goalId: string): string {
		const path = join(serverRuntimeDirForGoal(goalId, this.options.workspaceDir), "evolution", "runs");
		mkdirSync(path, { recursive: true });
		return path;
	}

	private runDirectory(goalId: string, runId: string): string {
		return join(this.runsDirectory(goalId), safeIdentity(runId, "Evolution Run"));
	}

	private key(goalId: string, runId: string): string {
		return `${goalId}\0${runId}`;
	}
}

export const APPLY_INTENT_FILE = "apply-intent.json";
export const APPLY_RECEIPT_FILE = "apply-receipt.json";
export const BEFORE_DIRECTORY = "before";
const INCOMING_DIRECTORY = ".evolution-incoming";

/** The Goal Skill an owner Agent loads. Recovery and apply must agree on this path exactly. */
export function goalSkillPath(goalDirectory: string, ownerAgentId: string, skillName: string): string {
	return join(goalDirectory, "skills", ownerAgentId, skillName);
}

/**
 * The staged Candidate: on the same volume as the Goal Skill so one rename installs it, but
 * outside every owner Skill root, because a Skill snapshot scans those roots by directory and
 * would otherwise read a half-staged copy as a second Skill of the same name.
 */
export function incomingPath(
	goalDirectory: string,
	ownerAgentId: string,
	skillName: string,
	runId: string,
): string {
	return join(goalDirectory, "skills", INCOMING_DIRECTORY, `${ownerAgentId}.${skillName}.${runId}`);
}

/** The displaced Goal Skill, kept for recovery and for a maintenance restore. */
export function beforeSnapshotPath(runDirectory: string, skillName: string): string {
	return join(runDirectory, BEFORE_DIRECTORY, skillName);
}

function finalizeReceipt(intent: EvolutionApplyIntent, applied: {
	afterSkillSha256: string;
	afterSkillSetSha256: string;
	snapshotRelativePath: string | null;
}): EvolutionApplyReceipt {
	return {
		schemaVersion: 1,
		runId: intent.runId,
		goalId: intent.goalId,
		targetId: intent.targetId,
		skillName: intent.skillName,
		before: { ...intent.before, snapshotRelativePath: applied.snapshotRelativePath },
		after: { skillSetSha256: applied.afterSkillSetSha256, skillSha256: applied.afterSkillSha256 },
		candidateSha256: intent.candidateSha256,
		replayRunIds: intent.replayRunIds,
		restore: intent.before.source === "goal_override" ? "restore_before_snapshot" : "remove_goal_override",
		appliedAt: new Date().toISOString(),
	};
}

/** Removes the shared staging directory once the last Run left it empty. */
function removeIfEmpty(path: string): void {
	try {
		rmdirSync(path);
	} catch { /* Missing, or another Run is still staging into it. */ }
}


function requiredSkillSha256(path: string): string {
	const value = skillSha256(path);
	if (!value) throw new Error(`Evolution apply produced no Goal Skill at ${basename(path)}`);
	return value;
}

function skillSha256(path: string): string | null {
	return existsSync(path) ? snapshotSkills([path]).skills[0]?.sha256 ?? null : null;
}

function materializeSkillSet(snapshot: ReturnType<typeof snapshotSkills>, target: string): void {
	mkdirSync(target, { recursive: true });
	for (const skill of snapshot.skills) cpSync(skill.sourcePath, join(target, skill.name), { recursive: true });
	writeImmutableJson(join(target, ".skill-snapshot.json"), {
		schemaVersion: snapshot.schemaVersion,
		sha256: snapshot.sha256,
		skills: snapshot.skills.map((skill) => ({ name: skill.name, sha256: skill.sha256 })),
	});
}

function safeRegularFile(path: string, label: string): string {
	if (!existsSync(path)) throw new Error(`${label} does not exist`);
	const stat = lstatSync(path);
	if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error(`${label} must be one regular file`);
	return resolve(path);
}

function safeRelativePath(value: string, label: string): string {
	if (!value || isAbsolute(value) || value.includes("\0")) throw new Error(`${label} is invalid`);
	const normalized = value.split("\\").join("/");
	if (normalized.split("/").some((segment) => !segment || segment === "." || segment === "..")) {
		throw new Error(`${label} is invalid`);
	}
	return normalized;
}

function safeIdentity(value: string, label: string): string {
	if (typeof value !== "string" || !value.trim() || !SAFE_ID.test(value) || value.includes("/") || value.includes("..")) {
		throw new Error(`${label} id is invalid`);
	}
	return value;
}

function required(value: unknown, label: string): string {
	if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is required`);
	return value.trim();
}

function uniqueStrings(value: unknown, label: string): string[] {
	if (!Array.isArray(value) || !value.every((item) => typeof item === "string" && item.trim())) {
		throw new Error(`${label} must be a non-empty string array`);
	}
	return [...new Set(value.map((item) => item.trim()))];
}

function writeImmutableJson(path: string, value: unknown): void {
	if (existsSync(path)) throw new Error(`Immutable Evolution record already exists: ${basename(path)}`);
	mkdirSync(resolve(path, ".."), { recursive: true });
	writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf-8", flag: "wx", mode: 0o600 });
}
