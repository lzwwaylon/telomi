/**
 * Process-restart and apply-crash recovery for the Evolution store.
 *
 * Nothing resumes an Evolution, so a Run whose worker died must not keep holding its Goal, and a
 * Goal Skill replacement must never survive without a durable Receipt. The Targets here are plain
 * inner-loop stubs: the protocol under test lives in EvolutionService, not in Browser.
 */
import { replayableChildFiles } from "./provider-child-fixture.js";
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { snapshotSkills } from "../../server/agent-runtime/skill-registry.js";
import {
	APPLY_INTENT_FILE,
	APPLY_RECEIPT_FILE,
	beforeSnapshotPath,
	EvolutionService,
	goalSkillPath,
	type EvolutionRun,
	type EvolutionTarget,
} from "../../server/evolution/service.js";
import { BrowserEvolutionTrigger } from "../../server/evolution/browser-trigger.js";
import { BROWSER_EVOLUTION_TARGET_ID } from "../../server/evolution/targets.js";
import type { NodeBacktestService } from "../../server/evaluation/node-backtest.js";
import { runRecordDir } from "../../server/observability/run-records.js";

const GOAL_ID = "goal_recovery";
const OWNER = "cornell-note";
const SKILL = "strategy-skill";
const CANDIDATE_BODY = "Use the one-call strategy.";
const BASELINE_BODY = "Use the four-call strategy.";

function writeSkill(directory: string, body: string): void {
	mkdirSync(directory, { recursive: true });
	const name = directory.split("/").at(-1)!;
	writeFileSync(join(directory, "SKILL.md"),
		["---", `name: ${name}`, "description: Skill under Evolution.", "---", "", body, ""].join("\n"));
}

/** A Target whose inner loop confirms one Candidate, optionally after preparing a crash. */
function confirmingTarget(prepare?: (input: { recordDirectory: string }) => void): EvolutionTarget {
	return {
		id: "cornell-note/strategy",
		ownerAgentId: OWNER,
		version: 1,
		baselineSkillRoots: (goalDirectory) => [join(goalDirectory, "skills", OWNER)],
		async collectEvidence() {
			return { manifest: { kind: "recovery_stub" }, files: [] };
		},
		async innerLoop(input) {
			writeSkill(join(input.candidateDirectory, SKILL), CANDIDATE_BODY);
			prepare?.({ recordDirectory: input.recordDirectory });
			return {
				outcome: "confirmed",
				summary: "Collapse the repeated steps.",
				rounds: [{ round: 1, replayRunId: "nodebt-1", passed: true, recordRelativePath: "rounds/1/round.json" }],
				candidate: {
					skillName: SKILL,
					summary: "Collapse the repeated steps.",
					expectedOutcome: "One call instead of four.",
					selfChecks: ["round 1 replay passed"],
				},
			};
		},
	};
}

/** A Target whose inner loop never returns, standing in for a worker the process lost. */
const hangingTarget: EvolutionTarget = {
	...confirmingTarget(),
	async innerLoop(input) {
		input.setStatus("replaying");
		await new Promise(() => {});
		throw new Error("unreachable");
	},
};

function createWorkspace(options: { goalSkillBody?: string } = {}): string {
	const root = mkdtempSync(join(tmpdir(), "telomi-evolution-recovery-"));
	const workspaceDir = join(root, "data");
	mkdirSync(join(workspaceDir, GOAL_ID, "skills", "wiki-curator"), { recursive: true });
	if (options.goalSkillBody !== undefined) {
		writeSkill(join(workspaceDir, GOAL_ID, "skills", OWNER, SKILL), options.goalSkillBody);
	} else {
		mkdirSync(join(workspaceDir, GOAL_ID, "skills", OWNER), { recursive: true });
	}
	return workspaceDir;
}

function createService(workspaceDir: string, targets: EvolutionTarget[]): EvolutionService {
	return new EvolutionService({ workspaceDir, listGoalIds: () => [GOAL_ID], targets });
}

function start(service: EvolutionService, targetId: string, evidenceRefs: Array<Record<string, unknown>>): EvolutionRun {
	return service.start(GOAL_ID, {
		targetId,
		objective: "Improve the strategy.",
		acceptanceCriteria: ["Fewer steps"],
		evidenceRefs: evidenceRefs as never,
	});
}

async function waitForStatus(service: EvolutionService, runId: string, statuses: string[]): Promise<EvolutionRun> {
	for (let attempt = 0; attempt < 400; attempt += 1) {
		const run = service.read(GOAL_ID, runId);
		if (statuses.includes(run.status)) return run;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(`Evolution Run never reached ${statuses.join("/")}`);
}

const BROWSER_REFS = [1, 2, 3].map((index) => ({
	kind: "browser_provider_execution",
	runId: `run-${index}`,
	caseId: `case-${index}`,
	executionId: `provider-execution:1:browser:sub-${index}`,
}));

// 1. A restart settles an interrupted Run, keeps its consumed Evidence, and releases the Goal.
{
	const workspaceDir = createWorkspace({ goalSkillBody: BASELINE_BODY });
	const browserTarget: EvolutionTarget = { ...hangingTarget, id: BROWSER_EVOLUTION_TARGET_ID, ownerAgentId: "prime-search" };
	const before = createService(workspaceDir, [browserTarget]);
	try {
		const started = start(before, BROWSER_EVOLUTION_TARGET_ID, BROWSER_REFS);
		await waitForStatus(before, started.id, ["replaying"]);
		assert.throws(() => start(before, BROWSER_EVOLUTION_TARGET_ID, BROWSER_REFS),
			/already runs Evolution Target/u, "one Goal drives at most one Run per Target");
		// The process dies: the hung inner loop never writes again and never cancels itself.
		before.stop();

		const after = createService(workspaceDir, [browserTarget]);
		const recovered = after.read(GOAL_ID, started.id);
		assert.equal(recovered.status, "cancelled", "a restart settles an interrupted Run without a manual cancel");
		assert.match(recovered.error ?? "", /interrupted/u);
		assert.deepEqual(recovered.evidenceRefs, started.evidenceRefs,
			"recovery keeps the consumed Evidence refs, so the batch is neither replayed nor lost");

		// The Browser cursor now moves: the consumed batch stays consumed and the next one may start.
		const trigger = new BrowserEvolutionTrigger({
			workspaceDir,
			nodeBacktests: browserCases(workspaceDir, 6),
			evolution: after,
		});
		assert.deepEqual(trigger.pending(GOAL_ID).map((unit) => unit.caseId), ["case-4", "case-5", "case-6"],
			"the interrupted batch stays consumed");
		const next = trigger.observe(GOAL_ID);
		assert.ok(next, "a recovered Goal no longer blocks the next Browser batch");
		assert.deepEqual(next.evidenceRefs.map((ref) => ref.caseId), ["case-4", "case-5", "case-6"]);
		after.stop();
		console.log("Evolution recovery settles an interrupted Run and unblocks the next Browser batch");
	} finally {
		rmSync(join(workspaceDir, ".."), { recursive: true, force: true });
	}
}

// 2. Apply crash windows. Each state is rewound from one real applied Run.
{
	const templateRoot = mkdtempSync(join(tmpdir(), "telomi-evolution-applied-"));
	const templateWorkspace = join(templateRoot, "data");
	mkdirSync(join(templateWorkspace, GOAL_ID, "skills", "wiki-curator"), { recursive: true });
	writeSkill(join(templateWorkspace, GOAL_ID, "skills", OWNER, SKILL), BASELINE_BODY);
	const templateService = createService(templateWorkspace, [confirmingTarget()]);
	const beforeSha256 = snapshotSkills([goalSkillPath(join(templateWorkspace, GOAL_ID), OWNER, SKILL)]).skills[0]!.sha256;
	const templateStarted = start(templateService, "cornell-note/strategy",
		[{ kind: "node_case", runId: "run-1", caseId: "case-1" }]);
	const applied = await waitForStatus(templateService, templateStarted.id, ["applied", "failed"]);
	assert.equal(applied.status, "applied", applied.error ?? "");
	const appliedSha256 = snapshotSkills([goalSkillPath(join(templateWorkspace, GOAL_ID), OWNER, SKILL)]).skills[0]!.sha256;
	assert.notEqual(appliedSha256, beforeSha256);
	templateService.stop();

	/** Copies the applied workspace, rewinds it into one crash state, and restarts the service. */
	function recover(rewind: (paths: {
		workspaceDir: string; goalSkill: string; runDirectory: string; snapshot: string;
	}) => void): { run: EvolutionRun; goalSkill: string; workspaceDir: string; root: string } {
		const root = mkdtempSync(join(tmpdir(), "telomi-evolution-crash-"));
		const workspaceDir = join(root, "data");
		cpSync(templateWorkspace, workspaceDir, { recursive: true });
		const goalSkill = goalSkillPath(join(workspaceDir, GOAL_ID), OWNER, SKILL);
		const runDirectory = join(workspaceDir, ...relativeRunPath(templateWorkspace, applied.directory));
		rewind({ workspaceDir, goalSkill, runDirectory, snapshot: beforeSnapshotPath(runDirectory, SKILL) });
		const service = createService(workspaceDir, [confirmingTarget()]);
		const run = service.read(GOAL_ID, applied.id);
		service.stop();
		return { run, goalSkill, workspaceDir, root };
	}

	/** Rewinds the persisted Run to the phase a crash would have left behind, in its copied workspace. */
	function rewindStatus(runDirectory: string): void {
		const path = join(runDirectory, "current.json");
		const run = JSON.parse(readFileSync(path, "utf-8")) as EvolutionRun;
		writeFileSync(path, `${JSON.stringify(
			{ ...run, directory: runDirectory, status: "replaying", apply: undefined }, null, 2)}\n`);
	}

	try {
		// D: the rename and the Receipt both landed, only the Run record lagged.
		{
			const { run, goalSkill, root } = recover(({ runDirectory }) => rewindStatus(runDirectory));
			assert.equal(run.status, "applied", "a durable Receipt finalizes the Run");
			assert.equal(run.apply?.candidateSha256, appliedSha256);
			assert.equal(snapshotSkills([goalSkill]).skills[0]!.sha256, appliedSha256);
			rmSync(root, { recursive: true, force: true });
		}

		// C: the rename landed but the Receipt did not. The mutation stands, so it gets its Receipt.
		{
			const { run, goalSkill, root } = recover(({ runDirectory }) => {
				rmSync(join(runDirectory, APPLY_RECEIPT_FILE));
				rewindStatus(runDirectory);
			});
			assert.equal(run.status, "applied", "a Goal mutation is never left without a Receipt");
			assert.equal(run.apply?.after.skillSha256, appliedSha256);
			assert.equal(run.apply?.before.skillSha256, beforeSha256);
			assert.equal(snapshotSkills([goalSkill]).skills[0]!.sha256, appliedSha256,
				"recovery finalizes the Receipt without touching the Goal Skill");
			rmSync(root, { recursive: true, force: true });
		}

		// B: the Goal Skill was displaced but never replaced. Undo, so no partial mutation survives.
		{
			const { run, goalSkill, root } = recover(({ runDirectory, goalSkill: skill }) => {
				rmSync(join(runDirectory, APPLY_RECEIPT_FILE));
				rmSync(skill, { recursive: true });
				rewindStatus(runDirectory);
			});
			assert.equal(run.status, "cancelled");
			assert.match(run.error ?? "", /rolled back/u);
			assert.equal(snapshotSkills([goalSkill]).skills[0]!.sha256, beforeSha256,
				"the displaced Goal Skill is restored from the before snapshot");
			assert.equal(existsSync(join(run.directory, APPLY_RECEIPT_FILE)), false,
				"a rolled back apply writes no Receipt");
			rmSync(root, { recursive: true, force: true });
		}

		// A: the intent was durable but nothing moved yet.
		{
			const { run, goalSkill, root } = recover(({ runDirectory, goalSkill: skill, snapshot }) => {
				rmSync(join(runDirectory, APPLY_RECEIPT_FILE));
				rmSync(skill, { recursive: true });
				cpSync(snapshot, skill, { recursive: true });
				rmSync(snapshot, { recursive: true });
				rewindStatus(runDirectory);
			});
			assert.equal(run.status, "cancelled");
			assert.match(run.error ?? "", /before it changed the Goal/u);
			assert.equal(snapshotSkills([goalSkill]).skills[0]!.sha256, beforeSha256);
			assert.equal(existsSync(join(run.directory, APPLY_RECEIPT_FILE)), false);
			rmSync(root, { recursive: true, force: true });
		}

		// Neither side: never guess, and never touch the Goal.
		{
			const { run, goalSkill, root } = recover(({ runDirectory, goalSkill: skill }) => {
				rmSync(join(runDirectory, APPLY_RECEIPT_FILE));
				writeSkill(skill, "Edited by hand between the crash and the restart.");
				rewindStatus(runDirectory);
			});
			assert.equal(run.status, "failed");
			assert.match(run.error ?? "", /matches neither side/u);
			assert.notEqual(snapshotSkills([goalSkill]).skills[0]!.sha256, appliedSha256,
				"an ambiguous crash leaves the Goal Skill exactly as it was found");
			assert.notEqual(snapshotSkills([goalSkill]).skills[0]!.sha256, beforeSha256);
			assert.equal(existsSync(join(run.directory, APPLY_RECEIPT_FILE)), false);
			rmSync(root, { recursive: true, force: true });
		}
		console.log("Evolution recovers every apply crash window without leaving a mutation unrecorded");
	} finally {
		rmSync(templateRoot, { recursive: true, force: true });
	}
}

// 3. A replacement that fails leaves the Goal Skill untouched and writes no Receipt.
{
	const workspaceDir = createWorkspace({ goalSkillBody: BASELINE_BODY });
	// A non-empty before/ snapshot directory makes the displacing rename fail with ENOTEMPTY,
	// which is the real failure the protocol must survive before it has changed anything.
	const service = createService(workspaceDir, [confirmingTarget(({ recordDirectory }) => {
		const blocked = beforeSnapshotPath(recordDirectory, SKILL);
		mkdirSync(blocked, { recursive: true });
		writeFileSync(join(blocked, "occupied.txt"), "blocked\n");
	})]);
	try {
		const goalSkill = goalSkillPath(join(workspaceDir, GOAL_ID), OWNER, SKILL);
		const beforeSha256 = snapshotSkills([goalSkill]).skills[0]!.sha256;
		const started = start(service, "cornell-note/strategy", [{ kind: "node_case", runId: "run-1", caseId: "case-1" }]);
		const run = await waitForStatus(service, started.id, ["applied", "failed", "cancelled"]);
		assert.equal(run.status, "failed", "a replacement that cannot displace the Goal Skill fails the Run");
		assert.equal(snapshotSkills([goalSkill]).skills[0]!.sha256, beforeSha256, "the Goal Skill is untouched");
		assert.equal(existsSync(join(run.directory, APPLY_INTENT_FILE)), true, "the intent was durable first");
		assert.equal(existsSync(join(run.directory, APPLY_RECEIPT_FILE)), false, "no mutation means no Receipt");
		assert.deepEqual(readdirSync(join(workspaceDir, GOAL_ID, "skills", OWNER)).sort(), [SKILL],
			"a failed replacement leaves no staged copy inside the owner Skill root");
		assert.deepEqual(readdirSync(join(workspaceDir, GOAL_ID, "skills")).sort(), [OWNER, "wiki-curator"],
			"the staging directory itself is cleaned up too");
		service.stop();
		console.log("A failed Goal Skill replacement leaves no mutation, no Receipt and no staging directory");
	} finally {
		rmSync(join(workspaceDir, ".."), { recursive: true, force: true });
	}
}

/** The Run directory, relative to its workspace, so a copied workspace resolves the same Run. */
function relativeRunPath(workspaceDir: string, runDirectory: string): string[] {
	const relative = runDirectory.slice(workspaceDir.length).split("/").filter(Boolean);
	if (relative.length === 0) throw new Error("Evolution Run directory is not inside its workspace");
	return relative;
}

/**
 * Captured Browser Provider Cases the trigger can count, plus the settled Research Run records it
 * requires. Cases 1 to 3 are the batch the interrupted Run consumed.
 */
function browserCases(
	workspaceDir: string,
	count: number,
): Pick<NodeBacktestService, "listCases" | "listCaseFilePaths"> {
	const cases = Array.from({ length: count }, (_value, index) => index + 1);
	for (const index of cases) {
		const directory = runRecordDir(workspaceDir, GOAL_ID, `run-${index}`);
		mkdirSync(directory, { recursive: true });
		writeFileSync(join(directory, "run-state.json"), `${JSON.stringify({ status: "published" })}\n`);
		writeFileSync(join(directory, "browser-result.json"), `${JSON.stringify({
			schema_version: 1,
			execution_records: [{
				execution_id: `provider-execution:1:browser:sub-${index}`,
				provider_id: "browser",
				terminal_status: "valid_bundle",
			}],
		})}\n`);
	}
	return {
		listCases: () => cases.map((index) => ({
			ref: { sourceRunId: `run-${index}`, caseId: `case-${index}` },
			value: {
				agentId: "prime-search",
				status: "succeeded",
				capturedAt: `2026-09-0${index}T00:00:00.000Z`,
			},
		})) as never,
		listCaseFilePaths: (_goalId, ref) => replayableChildFiles(
			join(runRecordDir(workspaceDir, GOAL_ID, ref.sourceRunId), "fixture"),
			join(runRecordDir(workspaceDir, GOAL_ID, ref.sourceRunId), "browser-result.json")),
	};
}
