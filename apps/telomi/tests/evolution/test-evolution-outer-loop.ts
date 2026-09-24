/**
 * End-to-end check for the Evolution outer Operations loop (plan §12).
 *
 * A Capture instance runs a real Browser Evolution and captures it as an `evolution` Case. That
 * Case is exported as a Bundle, imported into a separate Eval instance whose Goal carries a
 * different Browser Skill, and replayed there as a Candidate. The checks are that the Replay
 * reproduces the whole inner loop from the frozen Case alone, that it leaves that instance's real
 * Goal byte-identical, that both sides produce the exact tree the external evaluation environment reads, and that the
 * Candidate Case survives its own isolated workspace being deleted.
 *
 * The Evolution Agent session is scripted and the three Prime Search Cases are replayed by a
 * scripted Recipe, so no model, Provider or Browser is involved.
 */
import assert from "node:assert/strict";
import {
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";

import type { AgentTool } from "@earendil-works/pi-agent-core";

import { snapshotSkills } from "../../server/agent-runtime/skill-registry.js";
import { hashDirectory, sha256 } from "../../server/lib/hash.js";
import { caseCaptureHealth, resetCaseCaptureForTest } from "../../server/observability/case-capture.js";
import { appendRuntimeContext } from "../../server/observability/run-records.js";
import { serverRuntimeDirForGoal } from "../../server/workspaces/server-runtime-paths.js";
import { NodeBacktestService, type NodeBacktestCaseRef } from "../../server/evaluation/node-backtest.js";
import { createOperationsRuntime } from "../../server/evaluation/operations-runtime.js";
import {
	EVOLUTION_AGENT_ID,
	EVOLUTION_RECIPE_VERSION,
	assertFrozenEvolutionCase,
	createEvolutionReplayRecipe,
	evolutionCaseCapture,
} from "../../server/evaluation/evolution-replay.js";
import { BROWSER_EVOLUTION_TARGET_ID, createEvolutionTargets } from "../../server/evolution/targets.js";
import { EvolutionService, type EvolutionRun } from "../../server/evolution/service.js";
import {
	beginNodeEvaluationCase,
	findNodeEvaluationCases,
	finishNodeEvaluationCase,
	type NodeReplayRecipe,
} from "../../server/agent-runtime/node-evaluation.js";
import {
	finalizeStageOutput,
	type AgentStageRequest,
	type AgentStageRunner,
	type ValidatedStageArtifact,
} from "../../server/agent-runtime/agent-stage-runtime.js";
import { RunArtifactStore } from "../../server/agent-runtime/artifact-store.js";

const SKILL = "prime-browser-provider-skill";
const GOAL_ID = "goal_evolution_outer";
const GOAL_TITLE = "Evolution outer loop";
const NEW_REFERENCE = "references/dynamic-feeds.md";
const CHILD_ID = "sub-b1";
const STAGE = "stage-1";
const BASELINE_BODY = "Explore the page, then materialize sources.";
const EVAL_GOAL_BODY = "A different Browser Skill the outer Replay must never touch.";
/** What the scripted Evolution Agent session reports, exactly as the real Stage Runtime would. */
const AGENT_STAGE_METRICS = {
	turns: 2, tool_calls: 1, input_tokens: 31, output_tokens: 17, cost_usd: 0.004, model_calls: 2,
	duration_ms: 1_234,
};

const root = mkdtempSync(join(tmpdir(), "telomi-evolution-outer-"));
const evalWorkspace = join(root, "eval");
const evalGoal = createGoal(evalWorkspace, EVAL_GOAL_BODY);

// ---------------------------------------------------------------------------
// 1. Capture: one terminal Browser Evolution Run is one `evolution` Case.
// ---------------------------------------------------------------------------

const confirmedRun = await runCapturedEvolution("confirmed", { outcome: "confirmed" });
assert.equal(confirmedRun.run.status, "applied", confirmedRun.run.error ?? "");
const captured = confirmedRun.instance.backtests.listCases(GOAL_ID, EVOLUTION_AGENT_ID);
assert.equal(captured.length, 1, "one terminal Browser Evolution Run captures exactly one Case");
const observedCase = captured[0]!.ref;
assert.equal(captured[0]!.value.recipe.id, EVOLUTION_AGENT_ID);
assert.equal(captured[0]!.value.runId, confirmedRun.run.id, "the Case belongs to the Evolution Run it captured");
console.log("A terminal Browser Evolution Run captures one evolution Case");

// The pair-level metrics the evaluation environment compares must include the Evolution Agent's own session, not just the
// inner Browser Replays it spent.
const observedMetrics = captured[0]!.value.observed.metrics!;
assert.ok(observedMetrics.inputTokens > AGENT_STAGE_METRICS.input_tokens,
	"Case metrics must add the Agent's own stage usage to the inner Replay usage");
assert.equal(observedMetrics.turns, 1 + AGENT_STAGE_METRICS.turns, "one replay round plus the Agent's own turns");
assert.equal(observedMetrics.toolCalls, 2 * 3 + AGENT_STAGE_METRICS.tool_calls,
	"three replayed Cases plus the Agent's own tool calls");
assert.ok((captured[0]!.value.observed.durationMs ?? 0) >= AGENT_STAGE_METRICS.duration_ms,
	"Case duration includes the Evolution Agent session as well as its inner Replay rounds");
console.log("Evolution Case metrics carry the Agent's own stage usage beside the inner Replay usage");

// ---------------------------------------------------------------------------
// 2. The Observed output tree is exactly what the external evaluation environment reads.
// ---------------------------------------------------------------------------

const observedCaseDirectory = confirmedRun.instance.backtests.caseRoots(GOAL_ID, observedCase).caseDirectory;
const observedOutput = join(observedCaseDirectory, captured[0]!.value.observed.output!.ref);
assertReaderOutputTree(observedOutput, { outcome: "confirmed", references: [NEW_REFERENCE] });
const observedSummary = readSummary(observedOutput);
assert.notEqual(observedSummary.skill.finalSha256, observedSummary.skill.baselineSha256,
	"a confirmed Evolution publishes the Skill it changed");
assert.ok(existsSync(join(observedCaseDirectory, "agent-trace.jsonl")),
	"the Case carries the Evolution Agent's own session Trace");
assert.equal(observedSummary.applyReceipt, "apply-receipt.json");
assert.ok(existsSync(join(observedOutput, observedSummary.applyReceipt)), "a confirmed Case carries its Apply Receipt");
console.log("The Observed Evolution output tree matches the external Evolution reader contract");

// ---------------------------------------------------------------------------
// 3. Frozen input: the Case pins every mutable dependency, and says so checkably.
// ---------------------------------------------------------------------------

const frozen = join(observedCaseDirectory, "input");
const frozenRequest = assertFrozenEvolutionCase(frozen);
assert.equal(frozenRequest.cases.length, 3, "all three Provider Child Cases are frozen into the outer Case");
assert.equal(frozenRequest.max_replay_rounds, 3);
assert.equal(frozenRequest.baseline_skill_sha256,
	snapshotSkills([join(frozen, "baseline", SKILL)]).skills[0]!.sha256);
for (const caseRef of frozenRequest.cases) {
	const frozenRun = join(frozen, "cases", caseRef.sourceRunId, caseRef.caseId, "run");
	assert.ok(existsSync(join(frozenRun, "node-evaluation", "cases", caseRef.caseId, "manifest.json")),
		"each frozen Case is addressed by Run id and Case id, so two Cases of one Run cannot collide");
	const childManifest = JSON.parse(readFileSync(join(frozenRun, "node-evaluation", "cases", caseRef.caseId, "manifest.json"), "utf-8"));
	const frozenMount = childManifest.mounts.find((mount: { guestPath: string }) => mount.guestPath === "/frozen-skills");
	assert.equal(readFileSync(join(frozenRun, frozenMount.directory.ref, "root-agent/shared/context.md"), "utf-8"),
		"Frozen child-visible ancillary skill.", "outer freezing retains child mounts with resolvable run-relative refs");
	assert.ok(existsSync(join(frozenRun, "node-evaluation", "cases", caseRef.caseId, "observed-output", "traces", "execution-conditions.jsonl")),
		"run-rooted Case files are frozen beside the Case");
}
console.log("The outer Case freezes all three Provider Child Cases and the effective baseline Skill");

// Tampering with any pinned value is refused before a Candidate Agent could act on it.
for (const [reason, tamper] of [
	["a rewritten baseline Skill", (input: string) =>
		writeFileSync(join(input, "baseline", SKILL, "SKILL.md"), skillMarkdown("Tampered baseline."))],
	["a raised replay budget", (input: string) => patchRequest(input, { max_replay_rounds: 4 })],
	["a dropped execution", (input: string) => patchRequest(input,
		{ evidence_refs: readRequest(input).evidence_refs.slice(0, 2) })],
	["three executions of two Cases", (input: string) => patchRequest(input, {
		evidence_refs: readRequest(input).evidence_refs.map((ref, index) => index === 2
			? { ...ref, runId: readRequest(input).evidence_refs[0]!.runId, caseId: readRequest(input).evidence_refs[0]!.caseId }
			: ref),
	})],
	["a Case that is not frozen", (input: string) => rmSync(
		join(input, "cases", readRequest(input).cases[0]!.sourceRunId), { recursive: true, force: true })],
] as const) {
	const tampered = join(root, `tampered-${reason.replaceAll(/[^a-z]+/gu, "-")}`);
	cpSync(frozen, tampered, { recursive: true });
	tamper(tampered);
	assert.throws(() => assertFrozenEvolutionCase(tampered), /request\.json is invalid|baseline/u,
		`a frozen Case with ${reason} must be refused`);
	rmSync(tampered, { recursive: true, force: true });
}
console.log("A tampered frozen Case is refused before the Candidate Evolution Agent runs");

// ---------------------------------------------------------------------------
// 4. Bundle export and import move that Case to a separate Eval instance.
// ---------------------------------------------------------------------------

const bundle = await confirmedRun.instance.backtests.exportCaseBundle(GOAL_ID, GOAL_TITLE, observedCase);
assert.equal(bundle.manifest.agent_id, EVOLUTION_AGENT_ID);
assert.ok(bundle.manifest.files.some((file) => file.path === "case/agent-trace.jsonl"),
	"the Bundle carries the Evolution Agent Trace, so the Case stays reviewable off its own machine");
confirmedRun.instance.stop();

const evalBacktests = new NodeBacktestService({
	workspaceDir: evalWorkspace,
	listGoalIds: () => [GOAL_ID],
	recipes: [
		scriptedProviderChildRecipe(),
		createEvolutionReplayRecipe({ innerRecipes: [scriptedProviderChildRecipe()] }),
	],
	runner: scriptedEvolutionRunner({ outcome: "confirmed" }),
});
const imported = evalBacktests.importBundle(bundle.path, ensureGoalDirectory(evalWorkspace));
let incompatibleAgentCalls = 0;
const incompatibleEval = new NodeBacktestService({
	workspaceDir: join(root, "incompatible-eval"),
	listGoalIds: () => [GOAL_ID],
	recipes: [createEvolutionReplayRecipe({ innerRecipes: [] })],
	runner: { async runStage() { incompatibleAgentCalls++; throw new Error("Agent must not run"); } },
});
const incompatibleImported = incompatibleEval.importBundle(bundle.path, ensureGoalDirectory(join(root, "incompatible-eval")));
incompatibleEval.start();
try {
	const incompatibleRun = await settleBacktest(incompatibleEval, incompatibleEval.enqueue(GOAL_ID, {
		agentId: EVOLUTION_AGENT_ID, cases: [incompatibleImported.caseRef], candidate: {},
		repetitions: 1, rubricId: "evolution-browser-agent-v1",
	}).id);
	assert.equal(incompatibleRun.status, "failed");
	assert.match(incompatibleRun.executions[0]?.error ?? incompatibleRun.error ?? "", /unsupported inner Replay Recipe/);
	assert.equal(incompatibleAgentCalls, 0, "reject incompatible nested Cases before any model call");
} finally {
	incompatibleEval.stop();
}
bundle.cleanup();
assert.deepEqual(imported.caseRef, observedCase, "the imported Case keeps its identity");
console.log("An evolution Case Bundle imports into a separate Eval instance");

// ---------------------------------------------------------------------------
// 5. The outer Candidate Replay: the whole inner loop again, isolated from the real Goal.
// ---------------------------------------------------------------------------

const evalGoalBefore = hashDirectory(evalGoal);
evalBacktests.start();
const backtest = evalBacktests.enqueue(GOAL_ID, {
	agentId: EVOLUTION_AGENT_ID,
	cases: [imported.caseRef],
	candidate: {},
	repetitions: 1,
	rubricId: "evolution-browser-agent-v1",
});
const replayed = await settleBacktest(evalBacktests, backtest.id);
assert.equal(replayed.status, "awaiting_evaluation", replayed.error ?? "");
assert.equal(replayed.executions.length, 1);
const execution = replayed.executions[0]!;
assert.equal(execution.status, "completed", execution.error ?? "");
console.log("The outer Candidate Replay reruns the complete Evolution inner loop from the frozen Case");

assert.equal(hashDirectory(evalGoal), evalGoalBefore,
	"the outer Candidate Replay reconstructs an isolated Goal and never writes the real one");
assert.ok(readFileSync(join(evalGoal, "skills", "prime-search", SKILL, "SKILL.md"), "utf-8")
	.includes(EVAL_GOAL_BODY), "the real Goal Skill still says what it said before the Replay");
console.log("The outer Candidate Replay leaves the real Goal byte-identical");

const candidateOutput = dirname(evalBacktests.artifactFile(GOAL_ID, backtest.id, execution.id, "evolution.json"));
assertReaderOutputTree(candidateOutput, { outcome: "confirmed", references: [NEW_REFERENCE] });
assert.equal(readSummary(candidateOutput).skill.baselineSha256, frozenRequest.baseline_skill_sha256,
	"the Candidate evolves the Skill the Case froze, not the Eval Goal's own Skill");
console.log("The Candidate output tree matches the reader contract and starts from the frozen baseline");

// ---------------------------------------------------------------------------
// 6. Candidate Evidence: its own Case, complete enough to leave this machine.
// ---------------------------------------------------------------------------

assert.ok(execution.candidateCaseRef, "the outer Candidate Replay must capture a Candidate Case");
const candidateCase = evalBacktests.readCase(GOAL_ID, execution.candidateCaseRef!);
assert.equal(candidateCase.agentId, EVOLUTION_AGENT_ID);
assert.equal(candidateCase.capabilitySnapshotId, replayed.candidate.capabilitySnapshotId);

const executionRecord = join(serverRuntimeDirForGoal(GOAL_ID, evalWorkspace), "evaluation", "node-backtests",
	backtest.id, "executions", execution.id);
assert.equal(existsSync(join(executionRecord, "work", "isolated-goal")), false,
	"the isolated Goal workspace is removed when the Replay ends");
assert.equal(evalBacktests.status().active, 0);
assert.equal(evalBacktests.status().queued, 0);
assert.equal(readdirSync(join(serverRuntimeDirForGoal(GOAL_ID, evalWorkspace), "evaluation", "node-backtests")).length, 1,
	"the inner rounds ran on the isolated service, so the Eval instance stores exactly one Run");
console.log("The inner rounds run on a nested queue, so the concurrency-1 outer queue cannot deadlock");

// Every ref the Candidate Case declares has to survive the isolated Goal it was produced in.
const candidateBundle = await evalBacktests.exportCaseBundle(GOAL_ID, GOAL_TITLE, execution.candidateCaseRef!);
const importWorkspace = join(root, "reimport");
const importBacktests = new NodeBacktestService({
	workspaceDir: importWorkspace,
	listGoalIds: () => [GOAL_ID],
	recipes: [scriptedProviderChildRecipe(), createEvolutionReplayRecipe()],
});
const reimported = importBacktests.importBundle(candidateBundle.path, ensureGoalDirectory(importWorkspace));
candidateBundle.cleanup();
const reread = importBacktests.readCase(GOAL_ID, reimported.caseRef);
assert.equal(reread.agentId, EVOLUTION_AGENT_ID);
const rereadRoots = importBacktests.caseRoots(GOAL_ID, reimported.caseRef);
assert.ok(existsSync(join(rereadRoots.caseDirectory, "agent-trace.jsonl")),
	"the Candidate Agent Trace survives the isolated Goal being deleted, the Bundle and the import");
assert.equal(reread.observed.trace?.root, "case");
for (const file of importBacktests.listCaseFiles(GOAL_ID, reimported.caseRef)) {
	assert.ok(existsSync(importBacktests.caseFile(GOAL_ID, reimported.caseRef, file.ref)),
		`every ref of the re-imported Candidate Case must resolve: ${file.ref}`);
}
assertReaderOutputTree(join(rereadRoots.caseDirectory, reread.observed.output!.ref),
	{ outcome: "confirmed", references: [NEW_REFERENCE] });
console.log("The Candidate evolution Case exports, imports and re-reads with every ref intact");

assert.equal(replayed.pairs.length, 1);
assert.deepEqual([replayed.pairs[0]!.a, replayed.pairs[0]!.b].sort(), ["candidate", "observed"]);

// ---------------------------------------------------------------------------
// 7. Candidate Evidence fails closed when the Evolution Agent left no Trace.
// ---------------------------------------------------------------------------

const tracelessBacktests = new NodeBacktestService({
	workspaceDir: evalWorkspace,
	listGoalIds: () => [GOAL_ID],
	recipes: [
		scriptedProviderChildRecipe(),
		createEvolutionReplayRecipe({ innerRecipes: [scriptedProviderChildRecipe()] }),
	],
	runner: scriptedEvolutionRunner({ outcome: "confirmed", writeTrace: false }),
});
tracelessBacktests.start();
const tracelessRun = await settleBacktest(tracelessBacktests, tracelessBacktests.enqueue(GOAL_ID, {
	agentId: EVOLUTION_AGENT_ID,
	cases: [imported.caseRef],
	candidate: {},
	repetitions: 1,
	rubricId: "evolution-browser-agent-v1",
}).id);
tracelessBacktests.stop();
assert.equal(tracelessRun.status, "failed", "a Candidate with no Agent Trace is not reviewable Evidence");
assert.match(tracelessRun.error ?? "", /Agent Trace/u);
console.log("The outer Candidate Replay fails closed when the Evolution Agent wrote no Trace");
evalBacktests.stop();
importBacktests.stop();

// ---------------------------------------------------------------------------
// 8. The production Capture side is fail-open, and refuses to mislabel a Run.
// ---------------------------------------------------------------------------

resetCaseCaptureForTest();
const uncapturedRun = detachRunRecord(confirmedRun.run, join(root, "run-without-trace"));
rmSync(join(uncapturedRun.directory, `evolution_browser_skill--browser-skill-evolution.jsonl`));
evolutionCaseCapture({ nodeBacktests: confirmedRun.instance.backtests })(uncapturedRun);
assert.equal(existsSync(join(uncapturedRun.directory, "node-evaluation", "cases")), false,
	"a Run whose Agent Trace is gone writes no Case at all");
assert.match(caseCaptureHealth().recent.at(-1)?.reason ?? "", /Agent Trace/u);
assert.equal(caseCaptureHealth().recent.at(-1)?.node, EVOLUTION_AGENT_ID);
assert.equal(confirmedRun.run.status, "applied", "Capture never changes the Evolution verdict");
console.log("Production Capture records a missing Agent Trace and leaves the Evolution verdict alone");

const failedRunId = "evo-failed-recovery";
const failedRun = detachRunRecord({ ...confirmedRun.run, id: failedRunId, status: "failed", error: "apply was interrupted" },
	join(serverRuntimeDirForGoal(GOAL_ID, confirmedRun.instance.workspace), "evolution", "runs", failedRunId));
evolutionCaseCapture({ nodeBacktests: confirmedRun.instance.backtests })(failedRun);
const failedCases = findNodeEvaluationCases(failedRun.directory, EVOLUTION_AGENT_ID);
assert.equal(failedCases.length, 1, "a failed Evolution Run becomes one Recovery Case");
assert.equal(failedCases[0]!.value.status, "failed");
assert.equal(failedCases[0]!.value.observed.output, undefined, "a Recovery Case must not fabricate an Observed output");
assert.match(failedCases[0]!.value.observed.error ?? "", /apply was interrupted/u);
assert.ok(failedCases[0]!.value.observed.trace, "the Recovery Case carries the failed Evolution Agent Trace");
const recoveryReplay = confirmedRun.instance.backtests.enqueue(GOAL_ID, {
	agentId: EVOLUTION_AGENT_ID,
	cases: [{ sourceRunId: failedRunId, caseId: failedCases[0]!.value.caseId }],
	candidate: {},
	repetitions: 1,
	rubricId: "evolution-browser-agent-v1",
});
assert.equal(recoveryReplay.kind, "recovery");
assert.deepEqual(recoveryReplay.pairs, [], "a failed Evolution Case enters Recovery Replay without a blind Pair");
confirmedRun.instance.backtests.cancel(GOAL_ID, recoveryReplay.id);

const recoveryBundle = await confirmedRun.instance.backtests.exportCaseBundle(GOAL_ID, GOAL_TITLE, {
	sourceRunId: failedRunId,
	caseId: failedCases[0]!.value.caseId,
});
const recoveryWorkspace = join(root, "recovery-eval");
const recoveryBacktests = new NodeBacktestService({
	workspaceDir: recoveryWorkspace,
	listGoalIds: () => [GOAL_ID],
	recipes: [scriptedProviderChildRecipe(), createEvolutionReplayRecipe({ innerRecipes: [scriptedProviderChildRecipe()] })],
	runner: scriptedEvolutionRunner({ outcome: "confirmed" }),
});
const recoveredCase = recoveryBacktests.importBundle(recoveryBundle.path, ensureGoalDirectory(recoveryWorkspace));
recoveryBundle.cleanup();
recoveryBacktests.start();
const recovered = await settleBacktest(recoveryBacktests, recoveryBacktests.enqueue(GOAL_ID, {
	agentId: EVOLUTION_AGENT_ID,
	cases: [recoveredCase.caseRef],
	candidate: {},
	repetitions: 1,
	rubricId: "evolution-browser-agent-v1",
}).id);
recoveryBacktests.stop();
assert.equal(recovered.kind, "recovery");
assert.equal(recovered.status, "completed", recovered.error ?? "");
assert.deepEqual(recovered.pairs, []);
assert.ok(recovered.executions[0]!.candidateCaseRef, "successful Recovery Replay captures a new Quality Case");
console.log("A failed Evolution Run is captured as Recovery evidence, not a succeeded Quality Case");

const replayRunId = confirmedRun.run.innerLoop!.rounds[0]!.replayRunId;
const replayRun = confirmedRun.instance.backtests.read(GOAL_ID, replayRunId)!;
const replayExecution = replayRun.executions[0]!;
rmSync(confirmedRun.instance.backtests.artifactFile(GOAL_ID, replayRunId, replayExecution.id, "result.json"));
const incompleteRun = detachRunRecord({ ...confirmedRun.run, id: "evo-incomplete-evidence" },
	join(root, "evo-incomplete-evidence"));
evolutionCaseCapture({ nodeBacktests: confirmedRun.instance.backtests })(incompleteRun);
assert.equal(findNodeEvaluationCases(incompleteRun.directory, EVOLUTION_AGENT_ID).length, 0,
	"a successful Evolution with missing inner evidence must not become a reviewable Case");
assert.match(caseCaptureHealth().recent.at(-1)?.reason ?? "", /missing Candidate Provider Child result/u);
console.log("Evolution Case capture fails closed when a required inner Artifact is missing");
resetCaseCaptureForTest();

// ---------------------------------------------------------------------------
// 9. no_change adopts nothing: the Case shows the baseline Skill, and still shows the reasoning.
// ---------------------------------------------------------------------------

const noChangeRun = await runCapturedEvolution("no-change", { outcome: "no_change" });
assert.equal(noChangeRun.run.status, "no_change", noChangeRun.run.error ?? "");
const noChangeCase = noChangeRun.instance.backtests.listCases(GOAL_ID, EVOLUTION_AGENT_ID)[0]!;
const noChangeDirectory = noChangeRun.instance.backtests.caseRoots(GOAL_ID, noChangeCase.ref).caseDirectory;
const noChangeOutput = join(noChangeDirectory, noChangeCase.value.observed.output!.ref);
assertReaderOutputTree(noChangeOutput, { outcome: "no_change", references: [] });
const noChangeSummary = readSummary(noChangeOutput);
assert.equal(noChangeSummary.skill.finalSha256, noChangeSummary.skill.baselineSha256,
	"no_change publishes the effective baseline, never the draft the Agent withheld");
assert.equal(noChangeSummary.skill.finalSha256,
	snapshotSkills([join(noChangeRun.instance.goalDirectory, "skills", "prime-search", SKILL)]).skills[0]!.sha256,
	"and that baseline is the Skill the Goal still loads");
assert.equal(existsSync(join(noChangeOutput, "skill", NEW_REFERENCE)), false,
	"the withheld reference is not presented as part of the final Skill");
assert.ok(noChangeSummary.rounds.length >= 1, "a no_change Case still carries the round evidence it was decided on");
assert.ok(String(noChangeSummary.rounds[0]!.reasoning).trim());
console.log("A no_change Evolution Case publishes the baseline Skill and keeps its round evidence");

const noChangeBundle = await noChangeRun.instance.backtests.exportCaseBundle(GOAL_ID, GOAL_TITLE, noChangeCase.ref);
noChangeRun.instance.stop();
const noChangeEval = new NodeBacktestService({
	workspaceDir: evalWorkspace,
	listGoalIds: () => [GOAL_ID],
	recipes: [
		scriptedProviderChildRecipe(),
		createEvolutionReplayRecipe({ innerRecipes: [scriptedProviderChildRecipe()] }),
	],
	runner: scriptedEvolutionRunner({ outcome: "no_change" }),
});
const noChangeImported = noChangeEval.importBundle(noChangeBundle.path, ensureGoalDirectory(evalWorkspace));
noChangeBundle.cleanup();
noChangeEval.start();
const noChangeReplay = await settleBacktest(noChangeEval, noChangeEval.enqueue(GOAL_ID, {
	agentId: EVOLUTION_AGENT_ID,
	cases: [noChangeImported.caseRef],
	candidate: {},
	repetitions: 1,
	rubricId: "evolution-browser-agent-v1",
}).id);
noChangeEval.stop();
assert.equal(noChangeReplay.status, "awaiting_evaluation", noChangeReplay.error ?? "");
const noChangeCandidate = dirname(noChangeEval.artifactFile(GOAL_ID, noChangeReplay.id,
	noChangeReplay.executions[0]!.id, "evolution.json"));
assertReaderOutputTree(noChangeCandidate, { outcome: "no_change", references: [] });
assert.equal(readSummary(noChangeCandidate).skill.finalSha256, frozenRequest.baseline_skill_sha256,
	"the no_change Candidate ends on the same frozen baseline the Observed side did");
assert.equal(hashDirectory(evalGoal), evalGoalBefore, "and it still never wrote the real Goal");
console.log("A no_change outer Candidate Replay adopts nothing and matches the Observed baseline");

const failedRoundRun = await runCapturedEvolution("failed-round-no-change", {
	outcome: "no_change", failReplay: true,
});
try {
	assert.equal(failedRoundRun.run.status, "no_change", failedRoundRun.run.error ?? "");
	const failedRoundCase = failedRoundRun.instance.backtests.listCases(GOAL_ID, EVOLUTION_AGENT_ID)[0];
	assert.ok(failedRoundCase, "a no_change Evolution after failed Replays remains reviewable");
	const failedRoundDirectory = failedRoundRun.instance.backtests.caseRoots(GOAL_ID, failedRoundCase.ref).caseDirectory;
	const failedRoundOutput = join(failedRoundDirectory, failedRoundCase.value.observed.output!.ref);
	const summary = readSummary(failedRoundOutput);
	assert.equal(summary.rounds.length, 1);
	assert.equal(summary.rounds[0]!.cases.length, 3);
	for (const value of summary.rounds[0]!.cases) {
		assert.equal(value.status, "failed");
		assert.ok(value.checks.some((check) => check.id === "replay-completed" && !check.passed),
			"no_change keeps the failed Case check visible to reviewers");
		assert.ok(value.checks.some((check) => check.id === "round:three-replays-valid" && !check.passed),
			"no_change keeps the failed round gate visible to reviewers");
		const artifacts = value.artifacts.map((file) => readFileSync(join(failedRoundOutput, file.path), "utf-8"));
		assert.ok(artifacts.some((content) => {
			const artifact = JSON.parse(content) as { status?: string; error?: string };
			return artifact.status === "failed" && artifact.error === "Scripted Prime Search failed after writing its Trace";
		}), "each failed outer Case must export the actual failure artifact");
		const traces = value.traces.map((file) => readFileSync(join(failedRoundOutput, file.path), "utf-8"));
		assert.ok(traces.some((content) => content.includes('"name":"browser"')),
			"each failed outer Case must export its existing Browser child Trace");
	}
	assertReaderOutputTree(failedRoundOutput, { outcome: "no_change", references: [] });
	console.log("A no_change Evolution after failed Replays exports every failure artifact and retained child Trace");
} finally {
	failedRoundRun.instance.stop();
}

// ---------------------------------------------------------------------------
// 10. The composition roots actually wire both halves.
// ---------------------------------------------------------------------------

const appSource = readFileSync(new URL("../../server/app.ts", import.meta.url), "utf-8");
assert.match(appSource, /onRunSettled: evolutionCaseCapture\(\{ nodeBacktests: runtime\.nodeBacktests \}\)/u,
	"server/app.ts must install Evolution Case Capture on the mode-gated EvolutionService");
assert.match(appSource, /import\("\.\/evaluation\/evolution-replay\.js"\)/u,
	"and must reach it through the mode-gated dynamic import");
const operations = createOperationsRuntime({
	mode: "eval",
	port: 0,
	workspaceDir: join(root, "operations"),
	goals: { listGoals: () => [], getGoal: () => undefined, ensureImportedGoal: () => undefined } as never,
});
assert.ok(operations.nodeBacktests.status().recipes.includes(`${EVOLUTION_AGENT_ID}@${EVOLUTION_RECIPE_VERSION}`),
	"createOperationsRuntime must register the Evolution Replay Recipe");
operations.close();
resetCaseCaptureForTest();
console.log("Both composition roots wire Evolution Case Capture and the Evolution Replay Recipe");

rmSync(root, { recursive: true, force: true });
console.log("Evolution outer loop: capture, bundle, isolated Candidate Replay and blind pair");

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

interface CaptureInstance {
	workspace: string;
	goalDirectory: string;
	backtests: NodeBacktestService;
	evolution: EvolutionService;
	stop(): void;
}

/** One Capture instance: three production Prime Search Cases, then one Browser Evolution. */
async function runCapturedEvolution(
	name: string,
	options: { outcome: "confirmed" | "no_change"; failReplay?: boolean },
): Promise<{ instance: CaptureInstance; run: EvolutionRun }> {
	const workspace = join(root, name);
	const goalDirectory = createGoal(workspace, BASELINE_BODY);
	const cases = [1, 2, 3].map((index) => captureObservedProviderChildCase(workspace, index));
	const backtests = new NodeBacktestService({
		workspaceDir: workspace,
		listGoalIds: () => [GOAL_ID],
		// A Capture instance registers the Evolution Recipe too: without it the Case it just
		// captured would be neither listable nor exportable.
		recipes: [scriptedProviderChildRecipe(options.failReplay), createEvolutionReplayRecipe()],
	});
	const evolution = new EvolutionService({
		workspaceDir: workspace,
		listGoalIds: () => [GOAL_ID],
		targets: createEvolutionTargets({ modelPolicy: { preferred: ["openai-codex/gpt-5.6-terra"], fallback: [], reasoning: "high" },
			workspaceDir: workspace,
			nodeBacktests: backtests,
			stageRunner: scriptedEvolutionRunner(options),
		}),
		onRunSettled: evolutionCaseCapture({ nodeBacktests: backtests }),
	});
	const instance: CaptureInstance = {
		workspace,
		goalDirectory,
		backtests,
		evolution,
		stop: () => { evolution.stop(); backtests.stop(); },
	};
	backtests.start();
	const started = evolution.start(GOAL_ID, {
		targetId: BROWSER_EVOLUTION_TARGET_ID,
		objective: "Improve the Browser Provider Skill for the scenarios these three executions show.",
		acceptanceCriteria: ["Every rule generalizes to the scenario class"],
		evidenceRefs: cases.map((caseRef, index) => ({
			kind: "browser_provider_execution",
			runId: caseRef.sourceRunId,
			caseId: caseRef.caseId,
			executionId: `provider-execution:${index + 1}:browser:${CHILD_ID}`,
		})),
	});
	return { instance, run: await settleEvolution(evolution, started.id) };
}

function createGoal(workspace: string, body: string): string {
	const goalDirectory = join(workspace, GOAL_ID);
	const skill = join(goalDirectory, "skills", "prime-search", SKILL);
	mkdirSync(skill, { recursive: true });
	writeFileSync(join(skill, "SKILL.md"), skillMarkdown(body));
	return goalDirectory;
}

function ensureGoalDirectory(workspace: string): (id: string) => void {
	return (id) => mkdirSync(join(workspace, id), { recursive: true });
}

function skillMarkdown(body: string, references: string[] = []): string {
	return [
		"---",
		`name: ${SKILL}`,
		"description: Browser Provider Skill for authenticated and dynamic website exploration.",
		"---",
		"",
		body,
		...references.map((reference) => `- Read \`${reference}\` when the page is an infinite-scroll feed.`),
		"",
	].join("\n");
}

/** A copy of one Run record without its Case, so a Capture attempt on it starts from nothing. */
function detachRunRecord(run: EvolutionRun, destination: string): EvolutionRun {
	cpSync(run.directory, destination, { recursive: true });
	rmSync(join(destination, "node-evaluation"), { recursive: true, force: true });
	return { ...run, directory: destination };
}

function readRequest(caseInput: string): { evidence_refs: Array<Record<string, string>>; cases: NodeBacktestCaseRef[] } {
	return JSON.parse(readFileSync(join(caseInput, "request.json"), "utf-8")) as never;
}

function patchRequest(caseInput: string, patch: Record<string, unknown>): void {
	const value = JSON.parse(readFileSync(join(caseInput, "request.json"), "utf-8")) as Record<string, unknown>;
	writeFileSync(join(caseInput, "request.json"), `${JSON.stringify({ ...value, ...patch }, null, 2)}\n`);
}

/** One production Prime Search Case with a settled Browser Provider child execution. */
function captureObservedProviderChildCase(workspace: string, index: number): NodeBacktestCaseRef {
	const runId = `run-${index}`;
	const sourceRun = join(serverRuntimeDirForGoal(GOAL_ID, workspace), "runs", runId);
	const inputDirectory = join(sourceRun, "inputs", "prime-search");
	mkdirSync(inputDirectory, { recursive: true });
	writeFileSync(join(inputDirectory, "request.json"),
		`${JSON.stringify({ schema_version: 1, provider_id: "browser", child_id: CHILD_ID,
			source: { sourceRunId: runId, caseId: `parent-${index}`, executionId: `provider-execution:${index}:browser:${CHILD_ID}` },
			task: `Read the newest items ${index}.` }, null, 2)}\n`);
	writeFileSync(join(inputDirectory, "task.md"), `Read the newest items ${index}.`);
	const store = new RunArtifactStore(sourceRun);
	const staging = join(sourceRun, "observed-staging");
	mkdirSync(staging, { recursive: true });
	writeFileSync(join(staging, "result.json"), resultJson({
		urls: [`https://example.test/feed/${index}/1`],
		executionId: `provider-execution:${index}:browser:${CHILD_ID}`,
	}));
	const sessionPath = writePrimeSearchTrace(sourceRun, [], "");
	copyChildTraces(sourceRun, staging);
	const artifact = store.publishDirectory(staging, "observed", staging);
	rmSync(staging, { recursive: true, force: true });
	const request = providerChildStageRequest({ runId, recordDirectory: sourceRun, inputDirectory, store });
	const draft = beginNodeEvaluationCase({
		request,
		recordDirectory: sourceRun,
		promptConfig: request.promptConfig!,
		sessionContextFile: join(sourceRun, ".missing-session"),
		composedSystemPrompt: "",
		actualModel: "scripted-model",
	});
	assert.ok(draft);
	const capture = finishNodeEvaluationCase(draft, {
		status: "succeeded",
		workDirectory: join(sourceRun, "work"),
		result: stageArtifact(artifact, sessionPath),
		validationErrors: [],
	});
	assert.equal(capture.status, "captured", capture.status === "capture_failed" ? capture.reason : "");
	return { sourceRunId: runId, caseId: `parent-${index}` };
}

function providerChildStageRequest(input: {
	runId: string;
	recordDirectory: string;
	inputDirectory: string;
	store: RunArtifactStore;
}): AgentStageRequest<unknown> {
	const frozenSkills = join(input.recordDirectory, "frozen-skills");
	mkdirSync(join(frozenSkills, "root-agent", "shared"), { recursive: true });
	writeFileSync(join(frozenSkills, "root-agent", "shared", "context.md"), "Frozen child-visible ancillary skill.");

	return {
		runId: input.runId,
		stageId: `prime-search-batch-${STAGE}`,
		attemptId: "1",
		attempt: 1,
		role: "prime_search",
		promptConfig: { domain: "research", id: "prime-search", sandboxRole: "research.prime_search" as never },
		recordKind: "research",
		evaluation: {
			agentId: "provider-child",
			recipe: { id: "provider-child", version: 1 },
			recipeInput: {},
			inputRelativePath: relative(input.recordDirectory, input.inputDirectory).split(sep).join("/"),
			harnessMounts: [],
			liveExternalState: true,
		},
		session: { key: "prime-search", policy: "fresh" },
		modelPolicy: { preferred: ["scripted-model"], reasoning: "medium" },
		systemPrompt: "",
		userPrompt: "Read the newest items.",
		workDirectory: join(input.recordDirectory, "work"),
		readonlyMounts: [{ hostPath: frozenSkills, guestPath: "/frozen-skills", access: "read-only" }],
		controlDirectory: input.recordDirectory,
		recordDirectory: input.recordDirectory,
		artifactStore: input.store,
		output: { kind: "source_bundle", publishRelativePath: "observed", validate: () => ({}) },
		signal: new AbortController().signal,
	};
}

/**
 * The Trace layout a Prime Search Case is read through: the Root Trace at the Run root names the
 * Trace directory, and the Browser child's own session artifacts carry the reference reads.
 */
function writePrimeSearchTrace(recordDirectory: string, references: string[], skillSha256: string, skillDirectory?: string): string {
	const traceRoot = join(recordDirectory, "prime-search-traces", STAGE);
	const childRoot = join(traceRoot, "acquisition-session", "session-artifacts", CHILD_ID);
	mkdirSync(childRoot, { recursive: true });
	// The Runtime bridge appends one skill_read receipt per reference the child read through
	// research_runtime.read_skill; the child Trace itself only shows the ipython call.
	writeFileSync(join(traceRoot, "execution-conditions.jsonl"), `${[
		JSON.stringify({ schema_version: 1, agent_session_id: CHILD_ID, skills: { items: [{ name: SKILL, sha256: skillSha256 }] } }),
		...references.map((reference) => JSON.stringify({
			schema_version: 1, kind: "skill_read", agent_session_id: CHILD_ID,
			path: `skills/provider-workers/browser/${SKILL}/${reference}`,
			sha256: sha256(readFileSync(join(skillDirectory!, reference))), recorded_at: "2026-09-05T00:00:00.000Z",
		})),
	].join("\n")}\n`);
	writeFileSync(join(childRoot, "session.jsonl"), `${[
		assistantToolCall("browser", "https://example.test/feed/1"),
		...references.map((reference) => assistantToolCall("ipython", `import research_runtime as rt; rt.read_skill("skills/provider-workers/browser/${SKILL}/${reference}")`)),
	].join("\n")}\n`);
	const sessionPath = join(recordDirectory, `prime_search--${STAGE}.jsonl`);
	writeFileSync(sessionPath, `${JSON.stringify({ type: "message_end" })}\n`);
	return sessionPath;
}

function copyChildTraces(recordDirectory: string, output: string): void {
	const traces = join(output, "traces");
	mkdirSync(traces, { recursive: true });
	const root = join(recordDirectory, "prime-search-traces", STAGE);
	cpSync(join(root, "execution-conditions.jsonl"), join(traces, "execution-conditions.jsonl"));
	cpSync(join(root, "acquisition-session", "session-artifacts", CHILD_ID, "session.jsonl"), join(traces, "session.jsonl"));
}

function assistantToolCall(name: string, path: string): string {
	return JSON.stringify({
		type: "message",
		message: { role: "assistant", content: [{ type: "toolCall", id: "call-1", name, arguments: { path } }] },
	});
}

function resultJson(input: { urls: string[]; executionId: string }): string {
	return `${JSON.stringify({
		schema_version: 1, provider_id: "browser", child_id: CHILD_ID, execution_id: input.executionId, terminal_status: "valid_bundle", tool_calls: 2,
		usage: { inputTokens: 11, outputTokens: 7, costUsd: 0.001, calls: 1 },
		logical_sources: input.urls.map((url, index) => ({ id: `s${index + 1}`, url, providerId: "browser" })),
		execution_records: [{
			execution_id: input.executionId,
			provider_id: "browser",
			terminal_status: "valid_bundle",
			operations: [{ operation: "prime_agent", status: "succeeded" }],
			bundle_ref: "artifacts/source-bundles/1",
		}],
	}, null, 2)}\n`;
}

/**
 * A scripted Prime Search Replay. It records the Skill hash it loaded and a Browser child that
 * really read every reference of that Skill, which is what the inner loop's hard gates check.
 */
function scriptedProviderChildRecipe(failReplay = false): NodeReplayRecipe {
	return {
		identity: { id: "provider-child", version: 1 },
		async replay(input) {
			const skillDirectory = join(input.harnessWorkspaceDirectory, "skills", "prime-search", SKILL);
			const skill = snapshotSkills([skillDirectory]).skills[0]!;
			const referenceRoot = join(skillDirectory, "references");
			const references = existsSync(referenceRoot)
				? readdirSync(referenceRoot).map((name) => `references/${name}`)
				: [];
			const record = input.recordDirectory;
			mkdirSync(record, { recursive: true });
			const sessionPath = writePrimeSearchTrace(record, references, skill.sha256, skillDirectory);
			if (failReplay) {
				const runtime = join(record, "runtime");
				mkdirSync(runtime, { recursive: true });
				cpSync(join(record, "prime-search-traces", STAGE, "acquisition-session", "session-artifacts", CHILD_ID, "session.jsonl"), join(runtime, "trace.jsonl"));
				cpSync(join(record, "prime-search-traces", STAGE, "execution-conditions.jsonl"), join(runtime, "execution-conditions.jsonl"));
				throw new Error("Scripted Prime Search failed after writing its Trace");
			}
			const inputDirectory = join(record, "inputs", "prime-search");
			cpSync(join(dirname(input.casePath), "input"), inputDirectory, { recursive: true });
			const staging = join(record, "candidate-staging");
			mkdirSync(staging, { recursive: true });
			writeFileSync(join(staging, "result.json"), resultJson({
				urls: ["https://example.test/feed/1/1", "https://example.test/feed/1/2"],
				executionId: `provider-execution:1:browser:${CHILD_ID}`,
			}));
			copyChildTraces(record, staging);
			const artifact = input.artifactStore.publishDirectory(staging, "result", staging);
			rmSync(staging, { recursive: true, force: true });
			const request = providerChildStageRequest({
				runId: input.candidateCase?.sourceRunId ?? input.value.runId,
				recordDirectory: record,
				inputDirectory,
				store: input.artifactStore,
			});
			const draft = beginNodeEvaluationCase({
				request,
				recordDirectory: record,
				promptConfig: request.promptConfig!,
				sessionContextFile: join(record, ".missing-session"),
				composedSystemPrompt: "",
				actualModel: "scripted-model",
				...(input.candidateCase ? { capabilitySnapshotId: input.candidateCase.capabilitySnapshotId } : {}),
			});
			assert.ok(draft);
			const capture = finishNodeEvaluationCase(draft, {
				status: "succeeded",
				workDirectory: input.workDirectory,
				result: stageArtifact(artifact, sessionPath),
				validationErrors: [],
			});
			// Candidate Evidence 是 fail-closed 的。
			if (capture.status !== "captured") throw new Error(capture.reason);
			return {
				caseId: input.value.caseId,
				agentId: "provider-child",
				artifact,
				usage: { inputTokens: 11, outputTokens: 7, costUsd: 0.001, calls: 1 },
				turns: 1,
				toolCalls: 2,
			};
		},
	};
}

function stageArtifact(
	artifact: ValidatedStageArtifact<unknown>["artifact"],
	sessionPath: string,
): ValidatedStageArtifact<unknown> {
	return {
		value: {},
		artifact,
		submissionCount: 1,
		validationErrors: [],
		session: { id: "scripted", mode: "fresh" },
		turns: 1,
		toolCalls: 2,
		toolCounts: {},
		usage: { inputTokens: 11, outputTokens: 7, costUsd: 0.001, calls: 1 },
		sessionPath,
	};
}

/** One scripted Evolution Agent session: add one conditional reference, replay it once, decide. */
function scriptedEvolutionRunner(options: {
	outcome: "confirmed" | "no_change";
	writeTrace?: boolean;
	failReplay?: boolean;
}): AgentStageRunner {
	return {
		async runStage<T>(request: AgentStageRequest<T>): Promise<ValidatedStageArtifact<T>> {
			const tool = (request.additionalTools ?? []).find((item) => item.name === "run_browser_replay") as AgentTool;
			assert.ok(tool, "the Browser Evolution Agent must receive run_browser_replay");
			const packageRoot = join(request.workDirectory, "candidate-package");
			const skill = join(packageRoot, SKILL);
			mkdirSync(join(skill, "references"), { recursive: true });
			writeFileSync(join(skill, "references", "dynamic-feeds.md"),
				"# Dynamic feeds\n\nScroll until the item count stops growing.\n");
			writeFileSync(join(skill, "SKILL.md"), skillMarkdown(BASELINE_BODY, [NEW_REFERENCE]));
			const result = await tool.execute("call", { intent: "Index a dynamic-feed reference conditionally." });
			const text = result.content.map((item) => "text" in item ? item.text : "").join("");
			assert.equal((JSON.parse(text) as { passed?: unknown }).passed, !options.failReplay, text);
			writeFileSync(join(packageRoot, "outcome.json"), `${JSON.stringify({
				schema_version: 1,
				outcome: options.outcome,
				skill_name: SKILL,
				summary: "Index a dynamic-feed reference conditionally.",
				scenario_class: "Infinite-scroll feeds, shown by all three executions.",
				generalization: "The rule keys on scroll-driven pagination, not on any URL.",
				improvement: "Each replay materialized the second page of the feed.",
				regression_risk: "The non-feed replay kept its Observed source set.",
				remaining_risk: "Feeds behind a login are untested.",
				references: [{
					path: NEW_REFERENCE,
					state: "added",
					trigger: "The page loads more items on scroll instead of paginating.",
				}],
			}, null, 2)}\n`);
			const recordDirectory = request.recordDirectory ?? request.workDirectory;
			const sessionPath = join(recordDirectory, `${request.role}--${request.stageId}.jsonl`);
			if (options.writeTrace !== false) {
				writeFileSync(sessionPath, `${JSON.stringify({ type: "message_end" })}\n`);
			}
			// The Stage terminal record the real Agent Stage Runtime writes, and the only place the
			// Evolution Agent's own usage is available from.
			appendRuntimeContext(recordDirectory, "evaluation", {
				type: "runtime.stage_completed",
				stage_id: request.stageId,
				execution_id: `${request.stageId}-1`,
				metrics: { ...AGENT_STAGE_METRICS, tool_counts: { run_browser_replay: 1 } },
			});
			const finalized = await finalizeStageOutput({
				artifactStore: request.artifactStore,
				output: request.output,
				workDirectory: request.workDirectory,
			});
			return {
				value: finalized.value,
				artifact: finalized.artifact,
				submissionCount: 1,
				validationErrors: [],
				session: { id: "scripted", mode: "fresh" },
				turns: AGENT_STAGE_METRICS.turns,
				toolCalls: AGENT_STAGE_METRICS.tool_calls,
				toolCounts: {},
				usage: {
					inputTokens: AGENT_STAGE_METRICS.input_tokens,
					outputTokens: AGENT_STAGE_METRICS.output_tokens,
					costUsd: AGENT_STAGE_METRICS.cost_usd,
					calls: AGENT_STAGE_METRICS.model_calls,
				},
				sessionPath,
			};
		},
	};
}

// ---------------------------------------------------------------------------
// The external Evolution reader contract, checked against a real output tree
// ---------------------------------------------------------------------------

interface EvolutionSummary {
	schema_version: number;
	outcome: string;
	explanation: string;
	skill: { name: string; baselineSha256: string; finalSha256: string };
	references: Array<{ path: string; state: string; trigger: string }>;
	applyReceipt: string | null;
	rounds: Array<{
		round: number;
		reasoning: string;
		metrics: Record<string, number>;
		cases: Array<{
			caseId: string;
			status: string;
			checks: Array<{ id: string; passed: boolean; detail: string }>;
			referenceReads: Array<{ path: string; evidence: string }>;
			artifacts: Array<{ label: string; path: string }>;
			traces: Array<{ label: string; path: string }>;
		}>;
	}>;
}

function readSummary(root: string): EvolutionSummary {
	return JSON.parse(readFileSync(join(root, "evolution.json"), "utf-8")) as EvolutionSummary;
}

/**
 * Mirrors what the external evaluation environment requires of one Case output tree. It is written
 * out here rather than imported because that reader lives outside this repository: this is the contract Telomi
 * owes it, and a Telomi change that breaks it has to fail in Telomi's own tests.
 */
function assertReaderOutputTree(root: string, expected: { outcome: string; references: string[] }): void {
	const files = new Set(listTreeFiles(root, root));
	assert.ok(files.has("evolution.json"), "the evaluation environment reads evolution.json");
	assert.ok(files.has("skill/SKILL.md"), "the evaluation environment reads the complete final Skill tree under skill/");
	const summary = readSummary(root);
	assert.equal(summary.schema_version, 1);
	assert.equal(summary.outcome, expected.outcome);
	assert.ok(summary.explanation.trim(), "the evaluation environment requires the final confirmed or no_change explanation");
	for (const key of ["name", "baselineSha256", "finalSha256"] as const) {
		assert.ok(summary.skill[key].trim(), `skill.${key} is required`);
	}
	assert.deepEqual(summary.references.map((reference) => reference.path).sort(), [...expected.references].sort());
	if (expected.outcome === "confirmed") {
		assert.equal(summary.applyReceipt, "apply-receipt.json");
		assert.ok(files.has(summary.applyReceipt), "a confirmed side carries its production-shaped Apply Receipt");
	} else {
		assert.equal(summary.applyReceipt, null);
		assert.equal(files.has("apply-receipt.json"), false, "no_change has no Apply Receipt");
	}
	for (const reference of summary.references) {
		assert.ok(["added", "modified"].includes(reference.state));
		assert.ok(reference.trigger.trim(), "the evaluation environment shows the trigger condition the Agent stated");
		assert.ok(files.has(`skill/${reference.path}`), `${reference.path} must be in the Skill tree`);
	}
	assert.ok(summary.rounds.length >= 1, "an Evolution that replayed records its rounds");
	for (const round of summary.rounds) {
		assert.ok(Number.isInteger(round.round) && round.round >= 1);
		assert.ok(round.reasoning.trim(), "every round carries the Agent's own reasoning");
		for (const key of ["inputTokens", "outputTokens", "costUsd", "modelCalls", "toolCalls", "durationMs"]) {
			assert.equal(typeof round.metrics[key], "number");
		}
		assert.equal(round.cases.length, 3, "every round replays all three historical Cases");
		for (const value of round.cases) {
			assert.ok(value.caseId && value.status);
			assert.ok(value.checks.length > 0, "the evaluation environment requires the Runtime hard checks of every replayed Case");
			for (const check of value.checks) assert.equal(typeof check.passed, "boolean");
			for (const item of [...value.artifacts, ...value.traces]) {
				assert.ok(item.label.trim());
				assert.ok(files.has(item.path), `evolution.json points at '${item.path}', which the tree must carry`);
			}
			assert.ok(value.traces.length > 0, "each replayed Case carries its Browser child Trace");
			assert.ok(value.artifacts.length > 0, "each replayed Case carries its inner Replay artifacts");
		}
	}
	const last = summary.rounds.at(-1)!;
	const reads = last.cases.flatMap((value) => value.referenceReads);
	for (const reference of summary.references) {
		const read = reads.find((item) => item.path === reference.path);
		assert.ok(read, `the last round must show whether ${reference.path} was read`);
		assert.match(read.evidence, /line \d+/u, "a reference read is located in a Trace, not claimed");
	}
	if (expected.outcome === "confirmed") {
		for (const check of last.cases.flatMap((value) => value.checks)) {
			assert.equal(check.passed, true, `a confirmed Evolution cannot carry a failed hard check on its last round: ${check.id}`);
		}
	}
}

function listTreeFiles(root: string, current: string): string[] {
	return readdirSync(current, { withFileTypes: true }).flatMap((entry) => {
		const path = join(current, entry.name);
		return entry.isDirectory()
			? listTreeFiles(root, path)
			: [relative(root, path).split(sep).join("/")];
	});
}

async function settleEvolution(service: EvolutionService, runId: string): Promise<EvolutionRun> {
	for (let attempt = 0; attempt < 2_000; attempt += 1) {
		const run = service.read(GOAL_ID, runId);
		if (["applied", "no_change", "failed", "cancelled"].includes(run.status)) return run;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error("Evolution Run never settled");
}

async function settleBacktest(service: NodeBacktestService, runId: string) {
	for (let attempt = 0; attempt < 2_000; attempt += 1) {
		const run = service.read(GOAL_ID, runId);
		if (run && ["awaiting_evaluation", "completed", "failed", "cancelled"].includes(run.status)) return run;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error("Node Backtest never settled: the outer Replay is deadlocked on its own queue");
}
