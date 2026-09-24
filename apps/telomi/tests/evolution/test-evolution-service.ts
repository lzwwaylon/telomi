import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EvolutionService, type EvolutionTarget } from "../../server/evolution/service.js";

const root = mkdtempSync(join(tmpdir(), "telomi-evolution-service-"));
const workspaceDir = join(root, "data");
const goalId = "goal_evolution";
const goalDir = join(workspaceDir, goalId);
const ownerSkillRoot = join(goalDir, "skills", "cornell-note");
mkdirSync(ownerSkillRoot, { recursive: true });
const bundledSkillRoot = join(root, "bundled", "default-strategy");
mkdirSync(bundledSkillRoot, { recursive: true });
writeFileSync(join(bundledSkillRoot, "SKILL.md"), [
	"---",
	"name: default-strategy",
	"description: Bundled default strategy Skill outside every Goal.",
	"---",
	"",
].join("\n"));

const target: EvolutionTarget = {
	id: "cornell-note/strategy",
	ownerAgentId: "cornell-note",
	version: 1,
	baselineSkillRoots: (goalDirectory) => [bundledSkillRoot, join(goalDirectory, "skills", "cornell-note")],
	async collectEvidence(input) {
		assert.deepEqual(input.evidenceRefs, [{ kind: "node_case", runId: "run-1", caseId: "case-1" }]);
		return {
			manifest: { source: "fixed-test-case", case_count: 1 },
			files: [],
		};
	},
	async innerLoop(input) {
		assert.ok(existsSync(join(input.evidenceDirectory, "manifest.json")));
		assert.ok(existsSync(join(input.baselineDirectory, "default-strategy", "SKILL.md")),
			"Evolution baseline must materialize the Target's effective Skills, not only the Goal Skill directory");
		const skill = join(input.candidateDirectory, "one-call-strategy");
		mkdirSync(skill, { recursive: true });
		writeFileSync(join(skill, "SKILL.md"), [
			"---",
			"name: one-call-strategy",
			"description: Use one-call strategy for repeated fixed searches.",
			"---",
			"",
			"Use the one-call strategy.",
			"",
		].join("\n"));
		input.setStatus("replaying");
		// A Run spends most of its life here, so a finished round must reach the Run record before
		// the verdict does. Reading it back mid-loop is the only way to prove that.
		input.recordRound({ round: 1, replayRunId: "replay-1", passed: true, recordRelativePath: "rounds/1.json" });
		const midLoop = service.list(goalId).find((run) => run.id === input.run.id);
		assert.deepEqual(midLoop?.innerLoop?.rounds,
			[{ round: 1, replayRunId: "replay-1", passed: true, recordRelativePath: "rounds/1.json" }],
			"a finished round is readable from the Run record while the loop is still running");
		assert.equal(midLoop?.innerLoop?.outcome, undefined, "the verdict is not published before it exists");
		assert.equal(midLoop?.status, "replaying");
		return {
			outcome: "confirmed",
			summary: "Collapsed repeated steps into one-call strategy.",
			rounds: [{ round: 1, replayRunId: "replay-1", passed: true, recordRelativePath: "rounds/1.json" }],
			candidate: {
				skillName: "one-call-strategy",
				summary: "Collapsed repeated steps into one-call strategy.",
				expectedOutcome: "Reduce steps from four to one.",
				selfChecks: ["fixed-case"],
			},
		};
	},
};

const service = new EvolutionService({
	workspaceDir,
	listGoalIds: () => [goalId],
	targets: [target],
});

try {
	const started = service.start(goalId, {
		targetId: target.id,
		objective: "Reduce repeated search cost and execution steps.",
		acceptanceCriteria: ["Candidate uses fewer steps", "Fixed case still succeeds"],
		evidenceRefs: [{ kind: "node_case", runId: "run-1", caseId: "case-1" }],
	});
	assert.equal(started.status, "queued");
	assert.ok(existsSync(join(started.directory, "request.json")));

	const applied = await waitFor(service, goalId, started.id, "applied");
	assert.equal(applied.candidate?.skillName, "one-call-strategy");
	assert.match(applied.candidate?.sha256 ?? "", /^[a-f0-9]{64}$/u);
	assert.equal(applied.innerLoop?.outcome, "confirmed");
	assert.ok(existsSync(join(ownerSkillRoot, "one-call-strategy", "SKILL.md")));
	assert.equal(applied.apply?.before.skillSetSha256, applied.baseline.skillSetSha256);
	assert.equal(applied.apply?.after.skillSetSha256.length, 64);
	assert.deepEqual(applied.apply?.replayRunIds, ["replay-1"]);
	assert.equal(applied.apply?.restore, "remove_goal_override");
	assert.ok(existsSync(join(applied.directory, "apply-receipt.json")));
	assert.deepEqual(service.list(goalId).map((run) => run.id), [started.id]);
	assert.deepEqual(JSON.parse(readFileSync(join(applied.directory, "current.json"), "utf-8")), applied);
	assert.deepEqual(service.read(goalId, started.id), applied);
	const brokenDirectory = join(applied.directory, "..", "broken-run");
	mkdirSync(brokenDirectory);
	writeFileSync(join(brokenDirectory, "current.json"), "{");
	assert.throws(() => service.read(goalId, "broken-run"), /current\.json/u);
	assert.throws(() => service.read(goalId, "missing-run"), /Unknown Evolution Run/u);
	assert.deepEqual(service.list(goalId), [applied]);

	console.log("Evolution service runs one inner loop and applies its confirmed Skill candidate");
} finally {
	service.stop();
	rmSync(root, { recursive: true, force: true });
}

async function waitFor(
	service: EvolutionService,
	goalId: string,
	runId: string,
	status: string,
) {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		const run = service.read(goalId, runId);
		if (run.status === status) return run;
		if (["failed", "cancelled", "no_change"].includes(run.status)) {
			throw new Error(`Evolution Run stopped at ${run.status}: ${run.error ?? "unknown error"}`);
		}
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(`Evolution Run '${runId}' did not reach '${status}'`);
}
