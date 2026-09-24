import { researchModelCandidates, type ResearchModelPolicy } from "../agent-runtime/models/model-policy.js";
/**
 * Evolution as an outer Operations Case (plan §12).
 *
 * The product inner loop improves one Goal's Browser Provider Skill. This file makes the Evolution
 * Agent that drives that loop reviewable by the same machinery every other Agent already uses: one
 * terminal Browser Evolution Run becomes an `evolution` Case, and the Replay Recipe reruns the
 * complete inner loop from that Case's frozen inputs.
 *
 * Three rules shape everything below.
 *
 * The Case is self-contained. Freezing pins the three Provider Child Cases the Run consumed and the
 * effective baseline Browser Skill into the Case input, so a Replay months later reads no mutable
 * production path: not the Goal Skill, not the Case store, not the bundled Skill.
 *
 * The Candidate never touches the real Goal. A Replay reconstructs an isolated Goal workspace from
 * the frozen input and runs there, with its own NodeBacktestService. That second service is also
 * why the outer Replay cannot deadlock: the outer Run holds the only worker of the outer queue for
 * its whole duration, and every inner round is enqueued on a queue that outer Run does not share.
 *
 * A confirmed output carries its Apply Receipt. Both Observed and Candidate production-shaped Runs
 * produce one, so the receipt can remain inside the blind A/B evidence without identifying a side.
 */
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
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { toErrorMessage } from "../lib/values.js";
import { snapshotSkills } from "../agent-runtime/skill-registry.js";
import { recordCaseCaptureFailure } from "../observability/case-capture.js";
import { readRuntimeRecords } from "../observability/run-records.js";
import { serverRuntimeDirForGoal } from "../workspaces/server-runtime-paths.js";
import { failedReplayFiles } from "../evolution/candidate-replay.js";
import {
	beginNodeEvaluationCase,
	findNodeEvaluationCases,
	finishNodeEvaluationCase,
	type EvaluationCaseCapture,
	type NodeReplayRecipe,
} from "../agent-runtime/node-evaluation.js";
import { RunArtifactStore, type PublishedArtifactDirectoryRef } from "../agent-runtime/artifact-store.js";
import { type AgentStageRequest, type ValidatedStageArtifact } from "../agent-runtime/agent-stage-runtime.js";
import {
	BROWSER_EVOLUTION_ROLE,
	BROWSER_EVOLUTION_STAGE_ID,
	BROWSER_SKILL_NAME,
	MAX_REPLAY_ROUNDS,
	browserSkillEvolutionPrompts,
	type BrowserReplayRoundEvidence,
} from "../evolution/browser-inner-loop.js";
import {
	BROWSER_EVOLUTION_BATCH_SIZE,
	BROWSER_EVOLUTION_TARGET_ID,
	createEvolutionTargets,
	effectiveBrowserProviderSkill,
} from "../evolution/targets.js";
import {
	APPLY_RECEIPT_FILE,
	EvolutionService,
	TERMINAL_RUN_STATUSES,
	type EvolutionEvidenceRef,
	type EvolutionRun,
} from "../evolution/service.js";
import { NodeBacktestService, type NodeBacktestCaseRef } from "./node-backtest.js";
import { liveProviderChildReplayRecipe } from "./provider-child-replay.js";
import { isFileNameSegment } from "../lib/paths.js";

export const EVOLUTION_AGENT_ID = "evolution";
export const EVOLUTION_RECIPE_VERSION = 2;
const OWNER_AGENT_ID = "prime-search";
const SUMMARY_FILE = "evolution.json";
const SKILL_ROOT = "skill";
const INPUT_DIRECTORY = "node-evaluation/evolution-input";
const SETTLED_POLL_MS = 100;

/** The Case a terminal Evolution Run freezes, so a Replay depends on no mutable production path. */
interface FrozenEvolutionRequest {
	schema_version: 1;
	goal_id: string;
	target_id: string;
	skill_name: string;
	objective: string;
	acceptance_criteria: string[];
	evidence_refs: EvolutionEvidenceRef[];
	cases: NodeBacktestCaseRef[];
	baseline_skill_sha256: string;
	baseline_skill_set_sha256: string;
	max_replay_rounds: number;
	model_policy?: ResearchModelPolicy;
}

type CaseStore = Pick<NodeBacktestService,
	"read" | "readCase" | "caseRoots" | "listCaseFiles" | "listCaseFilePaths" | "caseFile" | "artifactFile" | "replayFile">;

/**
 * The `onRunSettled` hook of the production EvolutionService, wired in `server/app.ts`.
 */
export function evolutionCaseCapture(options: { nodeBacktests: CaseStore }): (run: EvolutionRun) => void {
	return (run) => {
		if (run.targetId !== BROWSER_EVOLUTION_TARGET_ID) return;
		const capture = captureEvolutionCase({ run, nodeBacktests: options.nodeBacktests });
		// 正式 Capture fail-open：Evolution 的结论已经落盘，Capture 失败只记录健康状态。
		if (capture.status !== "captured") recordCaseCaptureFailure(EVOLUTION_AGENT_ID, capture.reason);
	};
}

const QUALITY_RUN_STATUSES = ["applied", "no_change"];
const RECOVERY_RUN_STATUSES = ["failed", "cancelled"];

/**
 * Captures one terminal Evolution Run as an `evolution` Case in the Run's own record directory.
 *
 * Applied and no-change Runs become Quality Cases. Failed and cancelled Runs become Recovery Cases
 * with no Observed output, so the evaluation environment can prove whether a Candidate Evolution Agent recovers the fault.
 */
export function captureEvolutionCase(input: {
	run: EvolutionRun;
	nodeBacktests: CaseStore;
}): EvaluationCaseCapture {
	const { run } = input;
	const inputDirectory = join(run.directory, INPUT_DIRECTORY);
	try {
		const quality = QUALITY_RUN_STATUSES.includes(run.status);
		const recovery = RECOVERY_RUN_STATUSES.includes(run.status);
		if (!quality && !recovery) {
			throw new Error(`Evolution Run '${run.id}' settled at '${run.status}', not `
				+ `${[...QUALITY_RUN_STATUSES, ...RECOVERY_RUN_STATUSES].join(", ")}`);
		}
		// Recovery can settle a Run a second time. The first Case is the immutable one.
		const existing = findNodeEvaluationCases(run.directory, EVOLUTION_AGENT_ID)[0];
		if (existing) return { status: "captured", caseId: existing.value.caseId, casePath: existing.path };
		rmSync(inputDirectory, { recursive: true, force: true });
		freezeEvolutionInput({ run, nodeBacktests: input.nodeBacktests, destination: inputDirectory });
		if (recovery) {
			return writeEvolutionRecoveryCase({
				run,
				recordDirectory: run.directory,
				inputDirectory,
				artifactStore: new RunArtifactStore(run.directory),
			});
		}
		return writeEvolutionCase({
			run,
			nodeBacktests: input.nodeBacktests,
			recordDirectory: run.directory,
			inputDirectory,
			artifactStore: new RunArtifactStore(run.directory),
			outputRelativePath: "evaluation/evolution-output",
		}).capture;
	} catch (error) {
		return { status: "capture_failed", reason: toErrorMessage(error) };
	} finally {
		// The Case keeps its own immutable snapshot of the input; the staging copy never lingers.
		rmSync(inputDirectory, { recursive: true, force: true });
	}
}

function writeEvolutionRecoveryCase(input: Pick<EvolutionCaseInput,
	"run" | "recordDirectory" | "inputDirectory" | "artifactStore">): EvaluationCaseCapture {
	const traceStaging = mkdtempSync(join(tmpdir(), "telomi-evolution-recovery-trace-"));
	try {
		const sessionPath = stagedAgentTrace(input.run.directory, traceStaging);
		const prompts = browserSkillEvolutionPrompts({
			objective: input.run.objective,
			acceptanceCriteria: input.run.acceptanceCriteria,
		});
		const request = caseRequest({
			run: input.run,
			prompts,
			recordDirectory: input.recordDirectory,
			inputDirectory: input.inputDirectory,
			artifactStore: input.artifactStore,
			outputRelativePath: "evaluation/evolution-output",
		});
		const draft = beginNodeEvaluationCase({
			request,
			recordDirectory: input.recordDirectory,
			promptConfig: request.promptConfig!,
			sessionContextFile: join(input.recordDirectory, ".missing-evolution-session"),
			composedSystemPrompt: prompts.systemPrompt,
			actualModel: request.modelPolicy.preferred[0]!,
		});
		if (!draft) throw new Error("Evolution Recovery Case draft was not created");
		const agent = agentStageMetrics(input.run.directory);
		return finishNodeEvaluationCase(draft, {
			status: input.run.status === "cancelled" ? "cancelled" : "failed",
			workDirectory: join(input.run.directory, "agent-work"),
			sessionPath,
			validationErrors: [],
			error: input.run.error ?? `Evolution settled at ${input.run.status}`,
			durationMs: agent.durationMs,
		});
	} finally {
		rmSync(traceStaging, { recursive: true, force: true });
	}
}

/**
 * Replays one `evolution` Case: the complete inner loop again, from the same frozen Cases, in an
 * isolated Goal workspace the real Goal cannot see and that is removed when the Replay ends.
 */
export function createEvolutionReplayRecipe(options: {
	/** Recipes the isolated inner NodeBacktestService replays the three frozen Cases with. */
	innerRecipes?: readonly NodeReplayRecipe[];
} = {}): NodeReplayRecipe {
	return {
		identity: { id: EVOLUTION_AGENT_ID, version: EVOLUTION_RECIPE_VERSION },
		async replay(input) {
			if (input.value.agentId !== EVOLUTION_AGENT_ID) {
				throw new Error(`Node Case belongs to Agent '${input.value.agentId}'`);
			}
			if (input.promptOverride) {
				// The Evolution Agent renders its Prompt pair from the Agent Bundle under test, so
				// an override would review a Prompt no Evolution Run can ever run with.
				throw new Error("Evolution replay does not accept prompt overrides");
			}
			const caseInput = join(dirname(input.casePath), "input");
			const request = assertFrozenEvolutionCase(caseInput);
			const modelPolicy = request.model_policy ?? input.value.request.modelPolicy;
			if (!modelPolicy) throw new Error("Evolution Case is missing its model policy");
			researchModelCandidates(modelPolicy);
			const isolated = join(input.workDirectory, "isolated-goal");
			const inputDirectory = join(input.recordDirectory, INPUT_DIRECTORY);
			rmSync(isolated, { recursive: true, force: true });
			rmSync(inputDirectory, { recursive: true, force: true });
			materializeIsolatedGoal(caseInput, request, isolated);
			const nodeBacktests = new NodeBacktestService({
				workspaceDir: isolated,
				listGoalIds: () => [request.goal_id],
				recipes: options.innerRecipes ?? [liveProviderChildReplayRecipe],
				runner: input.runner,
			});
			const evolution = new EvolutionService({
				workspaceDir: isolated,
				listGoalIds: () => [request.goal_id],
				targets: createEvolutionTargets({ workspaceDir: isolated, nodeBacktests, stageRunner: input.runner, modelPolicy }),
			});
			try {
				const supported = new Set(nodeBacktests.status().recipes);
				for (const ref of request.cases) {
					const recipe = nodeBacktests.readCase(request.goal_id, ref).recipe;
					if (!supported.has(`${recipe.id}@${recipe.version}`)) {
						throw new Error(`Evolution Case '${ref.caseId}' requires unsupported inner Replay Recipe `
							+ `${recipe.id}@${recipe.version}; capture new Cases with the current product version.`);
					}
				}
				nodeBacktests.start();
				const started = evolution.start(request.goal_id, {
					targetId: request.target_id,
					objective: request.objective,
					acceptanceCriteria: request.acceptance_criteria,
					evidenceRefs: request.evidence_refs,
				});
				const settled = await waitForEvolution(evolution, request.goal_id, started.id, input.signal);
				// Candidate Evidence 是 fail-closed 的：没有到达 applied 或 no_change 的 Run
				// 没有可评审的结论，绝不能当成一个候选输出送进盲评。
				if (settled.status !== "applied" && settled.status !== "no_change") {
					throw new Error(`Evolution outer Replay settled at '${settled.status}': ${settled.error ?? "no verdict"}`);
				}
				cpSync(caseInput, inputDirectory, { recursive: true });
				const written = writeEvolutionCase({
					run: settled,
					nodeBacktests,
					recordDirectory: input.recordDirectory,
					inputDirectory,
					artifactStore: input.artifactStore,
					outputRelativePath: "result",
					...(input.candidateCase ? { candidateCase: input.candidateCase } : {}),
				});
				if (written.capture.status !== "captured") {
					throw new Error(`Evolution Candidate Case Capture failed: ${written.capture.reason}`);
				}
				return {
					caseId: input.value.caseId,
					agentId: EVOLUTION_AGENT_ID,
					artifact: written.artifact,
					usage: written.usage,
					turns: written.turns,
					toolCalls: written.toolCalls,
				};
			} finally {
				// Strict lifecycle: both queues stop and the reconstructed Goal disappears even when
				// the Replay threw, so nothing outlives the Replay that created it.
				evolution.stop();
				nodeBacktests.stop();
				rmSync(isolated, { recursive: true, force: true });
				rmSync(inputDirectory, { recursive: true, force: true });
			}
		},
	};
}

/**
 * Registered in `server/evaluation/operations-runtime.ts`. Without it a Capture instance can
 * neither list nor export the `evolution` Cases it writes, and no Eval instance can replay one.
 */
export const evolutionReplayRecipe = createEvolutionReplayRecipe();

// ---------------------------------------------------------------------------
// Case record
// ---------------------------------------------------------------------------

interface EvolutionCaseInput {
	run: EvolutionRun;
	nodeBacktests: CaseStore;
	recordDirectory: string;
	inputDirectory: string;
	artifactStore: RunArtifactStore;
	outputRelativePath: string;
	candidateCase?: { sourceRunId: string; capabilitySnapshotId: string };
}

interface EvolutionCaseRecord {
	capture: EvaluationCaseCapture;
	artifact: PublishedArtifactDirectoryRef;
	usage: ValidatedStageArtifact<unknown>["usage"];
	turns: number;
	toolCalls: number;
}

function writeEvolutionCase(input: EvolutionCaseInput): EvolutionCaseRecord {
	const { run } = input;
	// Staged outside the Run being captured: `finishNodeEvaluationCase` keeps a Trace that already
	// lives in the Run as a Run-rooted reference, and a Run-rooted reference is neither carried by a
	// Case Bundle nor able to survive the isolated Goal an outer Replay deletes.
	const traceStaging = mkdtempSync(join(tmpdir(), "telomi-evolution-trace-"));
	const staging = join(input.recordDirectory, ".evolution-output");
	rmSync(staging, { recursive: true, force: true });
	try {
		return writeCaseRecord({ ...input, staging, sessionPath: stagedAgentTrace(run.directory, traceStaging) });
	} finally {
		rmSync(staging, { recursive: true, force: true });
		rmSync(traceStaging, { recursive: true, force: true });
	}
}

function writeCaseRecord(input: EvolutionCaseInput & { staging: string; sessionPath: string }): EvolutionCaseRecord {
	const { run, staging } = input;
	const output = buildEvolutionOutput({ run, nodeBacktests: input.nodeBacktests, destination: staging });
	const artifact = input.artifactStore.publishDirectory(staging, input.outputRelativePath, staging);
	const prompts = browserSkillEvolutionPrompts({
		objective: run.objective,
		acceptanceCriteria: run.acceptanceCriteria,
	});
	const stageRequest = caseRequest({
		run,
		prompts,
		recordDirectory: input.recordDirectory,
		inputDirectory: input.inputDirectory,
		artifactStore: input.artifactStore,
		outputRelativePath: input.outputRelativePath,
		...(input.candidateCase ? { candidateCase: input.candidateCase } : {}),
	});
	const draft = beginNodeEvaluationCase({
		request: stageRequest,
		recordDirectory: input.recordDirectory,
		promptConfig: stageRequest.promptConfig!,
		sessionContextFile: join(input.recordDirectory, ".missing-evolution-session"),
		composedSystemPrompt: prompts.systemPrompt,
		actualModel: stageRequest.modelPolicy.preferred[0]!,
		...(input.candidateCase ? { capabilitySnapshotId: input.candidateCase.capabilitySnapshotId } : {}),
	});
	if (!draft) throw new Error("Evolution Node Evaluation draft was not created");
	const capture = finishNodeEvaluationCase(draft, {
		status: "succeeded",
		workDirectory: join(input.recordDirectory, ".missing-evolution-work"),
		result: {
			value: {},
			artifact,
			submissionCount: 1,
			validationErrors: [],
			session: { id: BROWSER_EVOLUTION_STAGE_ID, mode: "fresh" },
			turns: output.turns,
			toolCalls: output.toolCalls,
			toolCounts: {},
			usage: output.usage,
			sessionPath: input.sessionPath,
		},
		validationErrors: [],
		durationMs: output.durationMs,
	});
	return { capture, artifact, usage: output.usage, turns: output.turns, toolCalls: output.toolCalls };
}

/**
 * The synthetic Stage request one Evolution Run is, from the Case store's point of view. An
 * Evolution Run is a whole bounded Agent session rather than a single Stage, so only what a Case
 * needs is filled in: identity, the real Prompt pair, the frozen input and the output contract.
 */
function caseRequest(input: {
	run: EvolutionRun;
	prompts: ReturnType<typeof browserSkillEvolutionPrompts>;
	recordDirectory: string;
	inputDirectory: string;
	artifactStore: RunArtifactStore;
	outputRelativePath: string;
	candidateCase?: { sourceRunId: string; capabilitySnapshotId: string };
}): AgentStageRequest<unknown> {
	return {
		runId: input.candidateCase?.sourceRunId ?? input.run.id,
		stageId: BROWSER_EVOLUTION_STAGE_ID,
		attemptId: "1",
		attempt: 1,
		role: BROWSER_EVOLUTION_ROLE,
		promptConfig: { ...input.prompts.promptConfig } as AgentStageRequest<unknown>["promptConfig"],
		recordKind: "evaluation",
		evaluation: {
			agentId: EVOLUTION_AGENT_ID,
			recipe: { id: EVOLUTION_AGENT_ID, version: EVOLUTION_RECIPE_VERSION },
			recipeInput: {},
			inputRelativePath: relative(input.recordDirectory, input.inputDirectory).split(sep).join("/"),
			harnessMounts: [],
			// The inner rounds replay live Provider Child Cases, so the Case is not deterministic.
			liveExternalState: true,
		},
		session: { key: BROWSER_EVOLUTION_STAGE_ID, policy: "fresh" },
		modelPolicy: JSON.parse(readFileSync(join(input.run.directory, "model-policy.json"), "utf-8")) as ResearchModelPolicy,
		systemPrompt: input.prompts.systemPrompt,
		userPrompt: input.prompts.userPrompt,
		workDirectory: join(input.recordDirectory, ".missing-evolution-work"),
		readonlyMounts: [],
		controlDirectory: input.recordDirectory,
		recordDirectory: input.recordDirectory,
		artifactStore: input.artifactStore,
		output: {
			kind: "json_candidate",
			entryRelativePath: SUMMARY_FILE,
			rootRelativePath: ".",
			publishRelativePath: input.outputRelativePath,
			validate: () => ({}),
		},
		executionProfile: "pi_builtin",
		signal: new AbortController().signal,
	};
}

/**
 * The Evolution Agent's own session Trace, staged where the Case will copy it into itself.
 *
 * A missing Trace is fatal, not a silent gap: without it nobody can check whether the Agent's
 * stated reasoning matches what it actually did, which is the whole point of the outer review.
 * The Candidate side therefore fails closed; the production side turns the same throw into a
 * recorded Capture failure, which never changes the Evolution verdict that is already on disk.
 */
function stagedAgentTrace(runDirectory: string, staging: string): string {
	const trace = existsSync(runDirectory)
		? readdirSync(runDirectory)
			.filter((entry) => entry.startsWith(`${BROWSER_EVOLUTION_ROLE}--`) && entry.endsWith(".jsonl"))
			.sort()[0]
		: undefined;
	if (!trace) {
		throw new Error(`Evolution Run at '${basename(runDirectory)}' wrote no `
			+ `'${BROWSER_EVOLUTION_ROLE}--*.jsonl' Agent Trace: the Case would carry no session evidence`);
	}
	const target = join(staging, "agent-trace.jsonl");
	cpSync(join(runDirectory, trace), target);
	return target;
}

// ---------------------------------------------------------------------------
// Output tree. Its shape is the contract the external evaluation environment reads.
// ---------------------------------------------------------------------------

interface EvolutionOutputSummary {
	usage: ValidatedStageArtifact<unknown>["usage"];
	turns: number;
	toolCalls: number;
	durationMs: number;
}

/**
 * Writes one Evolution Case output tree:
 *
 *	 evolution.json						  the summary the external evaluation environment reads
 *	 skill/								  the complete final Browser Skill tree
 *	 rounds/<n>/<caseId>/artifacts/...	  the inner Replay result and its Observed/Candidate diff
 *	 rounds/<n>/<caseId>/traces/...		  the Browser child Traces that Replay wrote
 *
 * Every path evolution.json names is a file in this tree, because the external reader refuses a summary
 * that points at evidence the Case does not carry.
 */
function buildEvolutionOutput(input: {
	run: EvolutionRun;
	nodeBacktests: CaseStore;
	destination: string;
}): EvolutionOutputSummary {
	const { run } = input;
	const innerLoop = run.innerLoop;
	// Rounds appear here while the loop is still running; only the verdict makes a Run capturable.
	if (!innerLoop?.outcome) throw new Error(`Evolution Run '${run.id}' has no inner loop verdict to capture`);
	const outcome = innerLoop.outcome;
	const published = join(run.directory, "agent", "candidate-package");
	const baselineSkill = join(run.directory, "baseline", BROWSER_SKILL_NAME);
	// `no_change` changed nothing, so the Skill this Evolution ends with is the one it started from.
	// Publishing the Agent's unapplied draft here would show a reviewer a Skill no Goal ever loaded
	// and invite a judgment on work that was explicitly withheld. The rounds still carry the draft's
	// replay evidence and the Agent's reasoning, which is what a `no_change` is judged on.
	const confirmed = outcome === "confirmed";
	const finalSkill = confirmed ? join(published, BROWSER_SKILL_NAME) : baselineSkill;
	if (!existsSync(join(finalSkill, "SKILL.md"))) {
		throw new Error(`Evolution Run '${run.id}' has no '${BROWSER_SKILL_NAME}/SKILL.md' to publish`);
	}
	const agentOutcome = readAgentOutcome(join(published, "outcome.json"));
	mkdirSync(input.destination, { recursive: true });
	cpSync(finalSkill, join(input.destination, SKILL_ROOT), { recursive: true });
	let applyReceipt: string | null = null;
	if (confirmed) {
		const source = join(run.directory, APPLY_RECEIPT_FILE);
		if (!existsSync(source)) throw new Error(`Evolution Run '${run.id}' has no Apply Receipt`);
		applyReceipt = APPLY_RECEIPT_FILE;
		cpSync(source, join(input.destination, applyReceipt));
	}

	const evidenceCases = evidenceCaseRefs(run.directory);
	const usage = { inputTokens: 0, outputTokens: 0, costUsd: 0, calls: 0 };
	let toolCalls = 0;
	let durationMs = 0;
	const rounds = readRounds(run.directory).map((round) => {
		const backtest = round.replay.nodeBacktestRunId
			? input.nodeBacktests.read(run.goalId, round.replay.nodeBacktestRunId)
			: null;
		const metrics = roundMetrics(round, backtest);
		usage.inputTokens += metrics.inputTokens;
		usage.outputTokens += metrics.outputTokens;
		usage.costUsd += metrics.costUsd;
		usage.calls += metrics.modelCalls;
		toolCalls += metrics.toolCalls;
		durationMs += metrics.durationMs;
		// A round Runtime could not finish records no Case, but it replayed against the same three
		// Cases and it still spent a round, so the reviewer has to see all three, failed.
		const cases = round.cases.length > 0
			? round.cases.map((value) => roundCase({ ...input, round, backtest, value }))
			: evidenceCases.map((caseRef) => unreachedCase(caseRef, round));
		return { round: round.round, reasoning: round.intent, cases, metrics };
	});
	writeFileSync(join(input.destination, SUMMARY_FILE), `${JSON.stringify({
		schema_version: 1,
		outcome,
		explanation: explanation(agentOutcome),
		skill: {
			name: BROWSER_SKILL_NAME,
			baselineSha256: skillSha256(baselineSkill),
			finalSha256: skillSha256(finalSkill),
		},
		// A withheld reference is not an adopted one: `no_change` adopts nothing.
		references: confirmed ? agentOutcome.references : [],
		applyReceipt,
		rounds,
	}, null, 2)}\n`, { encoding: "utf-8", mode: 0o600 });
	// The pair-level metrics the evaluation environment compares are about the Evolution Agent, so its own session counts
	// on top of the inner Browser Replays it spent. Both come from structured Runtime records.
	const agent = agentStageMetrics(run.directory);
	return {
		usage: {
			inputTokens: usage.inputTokens + agent.inputTokens,
			outputTokens: usage.outputTokens + agent.outputTokens,
			costUsd: usage.costUsd + agent.costUsd,
			calls: usage.calls + agent.modelCalls,
		},
		turns: rounds.length + agent.turns,
		toolCalls: toolCalls + agent.toolCalls,
		durationMs: durationMs + agent.durationMs,
	};
}

interface AgentStageMetrics {
	inputTokens: number;
	outputTokens: number;
	costUsd: number;
	modelCalls: number;
	turns: number;
	toolCalls: number;
	durationMs: number;
}

/**
 * The Evolution Agent session's own usage, read from the terminal Stage records the Agent Stage
 * Runtime writes for this Run. Absent when the Runtime wrote none, in which case the Case still
 * reports the inner Replay metrics rather than a guess.
 */
function agentStageMetrics(runDirectory: string): AgentStageMetrics {
	const total: AgentStageMetrics = {
		inputTokens: 0, outputTokens: 0, costUsd: 0, modelCalls: 0, turns: 0, toolCalls: 0, durationMs: 0,
	};
	let records: ReturnType<typeof readRuntimeRecords>;
	try {
		records = readRuntimeRecords(runDirectory, "evaluation");
	} catch {
		return total;
	}
	for (const event of records) {
		if (!STAGE_TERMINAL_EVENTS.includes(String(event.type)) || event.stage_id !== BROWSER_EVOLUTION_STAGE_ID) continue;
		const metrics = event.metrics;
		if (!metrics || typeof metrics !== "object" || Array.isArray(metrics)) continue;
		const value = metrics as Record<string, unknown>;
		const add = (key: string) => (typeof value[key] === "number" && Number.isFinite(value[key]) ? value[key] : 0);
		total.inputTokens += add("input_tokens");
		total.outputTokens += add("output_tokens");
		total.costUsd += add("cost_usd");
		total.modelCalls += add("model_calls");
		total.turns += add("turns");
		total.toolCalls += add("tool_calls");
		total.durationMs += add("duration_ms");
	}
	return total;
}

/** Every Stage terminal record carries the session's metrics, including a failed or cancelled one. */
const STAGE_TERMINAL_EVENTS = ["runtime.stage_completed", "runtime.stage_failed", "runtime.stage_cancelled"];

function roundCase(input: {
	run: EvolutionRun;
	nodeBacktests: CaseStore;
	destination: string;
	round: BrowserReplayRoundEvidence;
	backtest: ReturnType<NodeBacktestService["read"]>;
	value: BrowserReplayRoundEvidence["cases"][number];
}): Record<string, unknown> {
	const { value, round } = input;
	const caseRoot = join(input.destination, "rounds", String(round.round), caseSegment(value.caseRef.caseId));
	const artifacts: Array<{ label: string; path: string }> = [];
	const traces: Array<{ label: string; path: string }> = [];
	const treePath = (path: string) => relative(input.destination, path).split(sep).join("/");
	const copy = (kind: "artifacts" | "traces", relativePath: string, source: () => string, label: string,
		required: boolean) => {
		const target = insideRoot(join(caseRoot, kind), relativePath);
		try {
			const path = source();
			if (!existsSync(path)) throw new Error(`missing source '${path}'`);
			mkdirSync(dirname(target), { recursive: true });
			cpSync(path, target);
		} catch (error) {
			if (required) throw new Error(`Evolution Case is missing ${label}: ${toErrorMessage(error)}`);
			// Evidence a failed Replay never produced. The Case records what exists and no more.
			return;
		}
		(kind === "artifacts" ? artifacts : traces).push({ label, path: treePath(target) });
	};
	if (value.diff) {
		mkdirSync(join(caseRoot, "artifacts"), { recursive: true });
		const diffPath = join(caseRoot, "artifacts", "diff.json");
		writeFileSync(diffPath, `${JSON.stringify(value.diff, null, 2)}\n`, { encoding: "utf-8", mode: 0o600 });
		artifacts.push({ label: "Observed and Candidate result difference", path: treePath(diffPath) });
	}
	if (value.status === "completed" && value.executionId && round.replay.nodeBacktestRunId) {
		copy("artifacts", "result.json", () => input.nodeBacktests.artifactFile(
			input.run.goalId, round.replay.nodeBacktestRunId, value.executionId, "result.json",
		), "Candidate Provider Child result", value.status === "completed");
	}
	const execution = input.backtest?.executions.find((execution) => execution.id === value.executionId);
	if (execution?.status === "failed") {
		for (const [index, file] of failedReplayFiles(input.nodeBacktests,
			input.run.goalId, round.replay.nodeBacktestRunId, execution).entries()) {
			copy(file.kind === "failure" ? "artifacts" : "traces", `${index + 1}-${basename(file.ref)}`,
				() => file.path, file.kind === "failure" ? "Candidate Replay failure" : `Replay evidence ${basename(file.ref)}`, true);
		}
	}
	const candidateCaseRef = execution?.candidateCaseRef;
	let candidatePaths: Map<string, string> | undefined;
	const candidateFile = (ref: string): string => {
		candidatePaths ??= new Map(input.nodeBacktests.listCaseFilePaths(input.run.goalId, candidateCaseRef!)
			.map((file) => [file.ref, file.absolutePath]));
		const path = candidatePaths.get(ref);
		if (!path) throw new Error(`Unknown Node Case file ref '${ref}'`);
		return path;
	};
	if (candidateCaseRef) {
		for (const file of input.nodeBacktests.listCaseFilePaths(input.run.goalId, candidateCaseRef)) {
			if (file.kind === "observed_output" && file.ref !== "output:result.json") {
				copy("artifacts", file.ref.replace(/^output:/u, ""), () => file.absolutePath, file.ref, true);
			} else if (file.kind === "execution_conditions") {
				copy("traces", "execution-conditions.jsonl", () => file.absolutePath, "Browser child execution conditions", true);
			}
		}
	}
	for (const child of candidateCaseRef ? value.browserChildren : []) {
		for (const ref of child.traceRefs) {
			copy("traces", join(caseSegment(child.childId), basename(ref)),
				() => candidateFile(ref),
				`Browser child ${child.childId} Trace`, value.status === "completed");
		}
	}
	return {
		caseId: value.caseRef.caseId,
		sourceRunId: value.caseRef.sourceRunId,
		status: value.status,
		checks: caseChecks(value, round),
		referenceReads: value.referenceReads.map((read) => ({
			path: read.referencePath,
			evidence: `${read.traceRef} line ${read.line}, ${read.toolName} call by Browser child ${read.childId}`,
		})),
		artifacts,
		traces,
	};
}

/**
 * Per-Case hard checks plus the round-level gates no single Case owns. A `confirmed` verdict beside
 * a failed check is the contradiction a reviewer most needs to see, so no gate is dropped merely
 * because it is scoped to the round rather than to one Case.
 */
function caseChecks(
	value: BrowserReplayRoundEvidence["cases"][number],
	round: BrowserReplayRoundEvidence,
): Array<{ id: string; passed: boolean; detail: string }> {
	const owned = new Set(value.checks.map((check) => check.id));
	return [
		...value.checks,
		...round.gates.filter((gate) => !owned.has(gate.id)).map((gate) => ({ ...gate, id: `round:${gate.id}` })),
	];
}

function unreachedCase(caseRef: NodeBacktestCaseRef, round: BrowserReplayRoundEvidence): Record<string, unknown> {
	return {
		caseId: caseRef.caseId,
		sourceRunId: caseRef.sourceRunId,
		status: "missing",
		checks: round.gates.length > 0
			? round.gates.map((gate) => ({ ...gate, id: `round:${gate.id}` }))
			: [{ id: "round:replay-round-completed", passed: false, detail: round.error ?? "The round recorded no Replay" }],
		referenceReads: [],
		artifacts: [],
		traces: [],
	};
}

function roundMetrics(round: BrowserReplayRoundEvidence, backtest: ReturnType<NodeBacktestService["read"]>): {
	inputTokens: number;
	outputTokens: number;
	costUsd: number;
	modelCalls: number;
	toolCalls: number;
	durationMs: number;
} {
	const executions = backtest?.executions ?? [];
	const total = (pick: (metrics: (typeof executions)[number]["metrics"]) => number) =>
		executions.reduce((sum, execution) => sum + pick(execution.metrics), 0);
	return {
		inputTokens: total((metrics) => metrics.inputTokens),
		outputTokens: total((metrics) => metrics.outputTokens),
		costUsd: total((metrics) => metrics.costUsd),
		modelCalls: total((metrics) => metrics.calls),
		toolCalls: total((metrics) => metrics.toolCalls),
		durationMs: Math.max(0, Date.parse(round.finishedAt) - Date.parse(round.startedAt)),
	};
}

/** The Agent's own closing account, in the order the evaluation Rubric reads it. */
function explanation(outcome: AgentOutcome): string {
	return [
		outcome.summary,
		`Scenario class: ${outcome.scenario_class}`,
		`Generalization: ${outcome.generalization}`,
		`Improvement: ${outcome.improvement}`,
		`Regression risk: ${outcome.regression_risk}`,
		`Remaining risk: ${outcome.remaining_risk}`,
	].join("\n\n");
}

interface AgentOutcome {
	summary: string;
	scenario_class: string;
	generalization: string;
	improvement: string;
	regression_risk: string;
	remaining_risk: string;
	references: Array<{ path: string; state: string; trigger: string }>;
}

function readAgentOutcome(path: string): AgentOutcome {
	const value = JSON.parse(readFileSync(path, "utf-8")) as AgentOutcome;
	for (const key of ["summary", "scenario_class", "generalization", "improvement", "regression_risk", "remaining_risk"] as const) {
		if (typeof value[key] !== "string" || !value[key].trim()) throw new Error(`Evolution outcome.json has no '${key}'`);
	}
	if (!Array.isArray(value.references)) throw new Error("Evolution outcome.json has no 'references'");
	return value;
}

function readRounds(runDirectory: string): BrowserReplayRoundEvidence[] {
	const root = join(runDirectory, "rounds");
	if (!existsSync(root)) return [];
	return readdirSync(root, { withFileTypes: true })
		.filter((entry) => entry.isDirectory() && /^[0-9]+$/u.test(entry.name))
		.map((entry) => JSON.parse(readFileSync(join(root, entry.name, "round.json"), "utf-8")) as BrowserReplayRoundEvidence)
		.sort((left, right) => left.round - right.round);
}

function skillSha256(skillDirectory: string): string {
	const skill = snapshotSkills([skillDirectory]).skills[0];
	if (!skill) throw new Error(`Evolution Case output has no Skill at ${basename(skillDirectory)}`);
	return skill.sha256;
}

// ---------------------------------------------------------------------------
// Freezing and reconstruction
// ---------------------------------------------------------------------------

/**
 * Freezes everything a Replay of this Evolution needs: the Provider Child Cases it consumed, the
 * effective baseline Browser Skill it started from, and the request that produced it.
 */
function freezeEvolutionInput(input: {
	run: EvolutionRun;
	nodeBacktests: CaseStore;
	destination: string;
}): void {
	const { run } = input;
	const baseline = join(run.directory, "baseline", BROWSER_SKILL_NAME);
	if (!existsSync(join(baseline, "SKILL.md"))) {
		throw new Error(`Evolution Run '${run.id}' has no baseline '${BROWSER_SKILL_NAME}'`);
	}
	mkdirSync(input.destination, { recursive: true });
	cpSync(baseline, join(input.destination, "baseline", BROWSER_SKILL_NAME), { recursive: true });
	const evidenceManifest = join(run.directory, "evidence", "manifest.json");
	if (existsSync(evidenceManifest)) cpSync(evidenceManifest, join(input.destination, "evidence-manifest.json"));
	const cases = evidenceCaseRefs(run.directory);
	for (const caseRef of cases) {
		freezeNodeCase(input.nodeBacktests, run.goalId, caseRef, frozenCaseDirectory(input.destination, caseRef));
	}
	const request: FrozenEvolutionRequest = {
		schema_version: 1,
		goal_id: run.goalId,
		target_id: run.targetId,
		skill_name: BROWSER_SKILL_NAME,
		objective: run.objective,
		acceptance_criteria: [...run.acceptanceCriteria],
		evidence_refs: run.evidenceRefs,
		cases,
		baseline_skill_sha256: skillSha256(baseline),
		baseline_skill_set_sha256: run.baseline.skillSetSha256,
		max_replay_rounds: MAX_REPLAY_ROUNDS,
		model_policy: JSON.parse(readFileSync(join(run.directory, "model-policy.json"), "utf-8")) as ResearchModelPolicy,
	};
	writeFileSync(join(input.destination, "request.json"), `${JSON.stringify(request, null, 2)}\n`,
		{ encoding: "utf-8", mode: 0o600 });
	// A Case that would fail its own integrity check at Replay time is not worth writing.
	assertFrozenEvolutionCase(input.destination);
}

/**
 * One frozen Case per Run and Case id. A Run can produce several Provider Child Cases, so the Run id
 * alone is not an identity: two of them would freeze over each other.
 */
function frozenCaseDirectory(caseInput: string, caseRef: NodeBacktestCaseRef): string {
	return join(caseInput, "cases", caseSegment(caseRef.sourceRunId), caseSegment(caseRef.caseId));
}

/**
 * One frozen Provider Child Case, laid out so it reproduces the exact same file set somewhere else:
 * `run/` is the Run root its refs resolve against, `workspace/` the Goal Run directory the Case
 * store also reads Source Bundle indexes and Search Executions from.
 */
function freezeNodeCase(
	nodeBacktests: CaseStore,
	goalId: string,
	caseRef: NodeBacktestCaseRef,
	destination: string,
): void {
	const roots = nodeBacktests.caseRoots(goalId, caseRef);
	const value = nodeBacktests.readCase(goalId, caseRef);
	if (value.agentId !== "provider-child") {
		throw new Error(`Node Case '${caseRef.caseId}' belongs to '${value.agentId}', not 'provider-child'`);
	}
	cpSync(roots.caseDirectory, join(destination, "run", "node-evaluation", "cases", caseSegment(value.caseId)),
		{ recursive: true });
	for (const file of nodeBacktests.listCaseFilePaths(goalId, caseRef)) {
		const separator = file.ref.indexOf(":");
		const root = separator < 0 ? "" : file.ref.slice(0, separator);
		if (root !== "run" && root !== "workspace") continue;
		const target = insideRoot(join(destination, root), file.ref.slice(separator + 1));
		if (existsSync(target)) continue;
		mkdirSync(dirname(target), { recursive: true });
		cpSync(file.absolutePath, target);
	}
}

/**
 * Rebuilds the Goal the frozen Evolution ran against, in a throwaway directory. The baseline Skill
 * is installed as the Goal override so the Replay evolves the Skill the Case pinned rather than
 * whatever bundled default the worktree under test happens to ship.
 */
function materializeIsolatedGoal(caseInput: string, request: FrozenEvolutionRequest, isolated: string): void {
	const goalDirectory = join(isolated, caseSegment(request.goal_id));
	mkdirSync(join(goalDirectory, "skills", OWNER_AGENT_ID), { recursive: true });
	cpSync(join(caseInput, "baseline", request.skill_name),
		join(goalDirectory, "skills", OWNER_AGENT_ID, request.skill_name), { recursive: true });
	const runtime = serverRuntimeDirForGoal(request.goal_id, isolated);
	// Cases of one Run share that Run's root, exactly as they did in production: their own
	// `node-evaluation/cases/<caseId>` subtrees keep them apart.
	for (const caseRef of request.cases) {
		const source = frozenCaseDirectory(caseInput, caseRef);
		cpSync(join(source, "run"), join(runtime, "runs", caseSegment(caseRef.sourceRunId)), { recursive: true });
		const workspace = join(source, "workspace");
		if (existsSync(workspace)) {
			cpSync(workspace, join(goalDirectory, "wiki", "runs", caseSegment(caseRef.sourceRunId)), { recursive: true });
		}
	}
	// The Agent must evolve the Skill the Case pinned, never whatever the worktree under test ships.
	const effective = snapshotSkills([effectiveBrowserProviderSkill(goalDirectory)], { allowOverrides: true });
	if (effective.skills[0]?.sha256 !== request.baseline_skill_sha256
		|| effective.sha256 !== request.baseline_skill_set_sha256) {
		throw new Error("The reconstructed Goal does not carry the baseline Browser Skill the Case pinned");
	}
}

/**
 * Everything a Replay assumes about a frozen Evolution Case, checked before the Candidate Agent
 * runs. A Case whose pinned Skill, batch or budget no longer matches what it carries would produce
 * a Candidate that answers a different question than the Observed Baseline did, and a blind pair
 * built from those two sides is worse than no pair at all.
 */
export function assertFrozenEvolutionCase(caseInput: string): FrozenEvolutionRequest {
	const value = JSON.parse(readFileSync(join(caseInput, "request.json"), "utf-8")) as FrozenEvolutionRequest;
	const invalid = (reason: string) => new Error(`Evolution Case request.json is invalid: ${reason}`);
	if (value.schema_version !== 1) throw invalid("schema_version must be 1");
	if (value.model_policy) researchModelCandidates(value.model_policy);
	if (!value.goal_id || !value.objective) throw invalid("goal_id and objective are required");
	if (value.target_id !== BROWSER_EVOLUTION_TARGET_ID) throw invalid(`target_id must be '${BROWSER_EVOLUTION_TARGET_ID}'`);
	if (value.skill_name !== BROWSER_SKILL_NAME) throw invalid(`skill_name must be '${BROWSER_SKILL_NAME}'`);
	if (!Array.isArray(value.acceptance_criteria) || value.acceptance_criteria.length === 0) {
		throw invalid("acceptance_criteria must not be empty");
	}
	if (value.max_replay_rounds !== MAX_REPLAY_ROUNDS) {
		throw invalid(`max_replay_rounds must be ${MAX_REPLAY_ROUNDS}`);
	}
	const executions = Array.isArray(value.evidence_refs) ? value.evidence_refs : [];
	if (executions.length !== BROWSER_EVOLUTION_BATCH_SIZE) {
		throw invalid(`evidence_refs must pin exactly ${BROWSER_EVOLUTION_BATCH_SIZE} Browser Provider executions`);
	}
	const identities = new Set<string>();
	for (const ref of executions) {
		if (ref?.kind !== "browser_provider_execution" || typeof ref.runId !== "string"
			|| typeof ref.caseId !== "string" || typeof ref.executionId !== "string"
			|| !ref.runId || !ref.caseId || !ref.executionId) {
			throw invalid("every evidence ref must be a complete Browser Provider execution ref");
		}
		identities.add(`${ref.runId}\u0000${ref.caseId}\u0000${ref.executionId}`);
	}
	if (identities.size !== executions.length) throw invalid("evidence_refs repeats one execution");
	// Each frozen Case represents one selected child execution.
	const cases = Array.isArray(value.cases) ? value.cases : [];
	const caseKeys = new Set(cases.map((caseRef) => `${caseRef?.sourceRunId}\u0000${caseRef?.caseId}`));
	if (cases.length !== BROWSER_EVOLUTION_BATCH_SIZE || caseKeys.size !== cases.length) {
		throw invalid(`cases must pin ${BROWSER_EVOLUTION_BATCH_SIZE} distinct Provider Child Cases`);
	}
	const frozenIdentities = new Set<string>();
	for (const caseRef of cases) {
		const directory = join(frozenCaseDirectory(caseInput, caseRef), "run", "node-evaluation", "cases",
			caseSegment(caseRef.caseId));
		const manifest = join(directory, "manifest.json");
		if (!existsSync(manifest)) throw invalid(`Case '${caseRef.caseId}' is not frozen into this Case input`);
		const child = JSON.parse(readFileSync(manifest, "utf-8")) as { agentId: string };
		if (child.agentId !== "provider-child") throw invalid("Evolution requires isolated Provider Child Cases; capture new Cases");
		const request = JSON.parse(readFileSync(join(directory, "input", "request.json"), "utf-8")) as {
			source: { sourceRunId: string; caseId: string; executionId: string };
		};
		frozenIdentities.add(`${request.source.sourceRunId}\0${request.source.caseId}\0${request.source.executionId}`);
	}
	if (frozenIdentities.size !== identities.size || [...identities].some((id) => !frozenIdentities.has(id))) {
		throw invalid("cases and evidence_refs describe different Provider Child executions");
	}
	const baseline = snapshotSkills([join(caseInput, "baseline", value.skill_name)], { allowOverrides: true });
	if (baseline.skills[0]?.sha256 !== value.baseline_skill_sha256) {
		throw invalid("the frozen baseline Skill does not match baseline_skill_sha256");
	}
	if (baseline.sha256 !== value.baseline_skill_set_sha256) {
		throw invalid("the frozen baseline Skill set does not match baseline_skill_set_sha256");
	}
	return value;
}

async function waitForEvolution(
	service: Pick<EvolutionService, "read">,
	goalId: string,
	runId: string,
	signal: AbortSignal,
): Promise<EvolutionRun> {
	while (true) {
		if (signal.aborted) throw new Error("Evolution outer Replay cancelled");
		const run = service.read(goalId, runId);
		if (TERMINAL_RUN_STATUSES.includes(run.status)) return run;
		await new Promise((settle) => setTimeout(settle, SETTLED_POLL_MS));
	}
}

/** The distinct Provider Child Cases the Browser executions of this Evolution belong to. */
function evidenceCaseRefs(runDirectory: string): NodeBacktestCaseRef[] {
	const manifest = JSON.parse(readFileSync(join(runDirectory, "evidence", "manifest.json"), "utf-8")) as {
		runs?: Array<{ child_case_ref?: NodeBacktestCaseRef }>;
	};
	const cases = (manifest.runs ?? []).map((run) => run.child_case_ref);
	if (cases.length !== BROWSER_EVOLUTION_BATCH_SIZE || cases.some((ref) => !ref?.caseId || !ref.sourceRunId)) {
		throw new Error("Evolution Run requires isolated Provider Child Cases; capture new Cases");
	}
	return cases as NodeBacktestCaseRef[];
}

function insideRoot(root: string, relativePath: string): string {
	const target = resolve(root, relativePath);
	const rel = relative(resolve(root), target);
	if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
		throw new Error(`Evolution Case path escapes its root: ${relativePath}`);
	}
	return target;
}

function caseSegment(value: string): string {
	if (!isFileNameSegment(value)) throw new Error(`Evolution Case path segment is invalid: ${value}`);
	return value;
}
