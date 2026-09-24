import { trackTaskModelSelection } from "../agent-runtime/model-policy.js";
/**
 * Browser Provider Skill Evolution inner loop.
 *
 * One bounded Agent session edits the effective Browser Provider Skill and replays it against
 * the exact three historical Provider Child Cases this Evolution Run consumed. The Agent decides
 * what the Skill should say; Runtime owns the replay, the immutable per-round Evidence and the
 * deterministic hard gates that must hold before a confirmed Candidate replaces the Goal Skill.
 *
 * The Agent never sees an Operations URL or another Goal: `run_browser_replay` is an in-process
 * Tool pinned to this Run's three Cases, this Run's Candidate Skill, and at most three calls.
 */
import { isRecord, toErrorMessage } from "../lib/values.js";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";

import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@sinclair/typebox";

import { bundledAgentSkillPaths, snapshotSkills } from "../agent-runtime/skill-registry.js";
import { sha256 } from "../lib/hash.js";
import { renderAgentPrompt } from "../agent-runtime/prompt-registry.js";
import type {
	NodeBacktestCaseFile,
	NodeBacktestCaseRef,
	NodeBacktestService,
} from "../evaluation/node-backtest.js";
import type { ResearchModelPolicy } from "../agent-runtime/models/model-policy.js";
import type { PiSettings } from "../config/settings.js";
import { resolveLLMConfig, resolveStageThinkingLevel } from "../agent-runtime/model-config/resolve.js";
import { RunArtifactStore } from "../agent-runtime/artifact-store.js";
import { SrtStageRuntime, type AgentStageRunner } from "../agent-runtime/agent-stage-runtime.js";
import { candidateCapabilitySnapshot, failedReplayFiles, waitForBacktest } from "./candidate-replay.js";
import type {
	EvolutionInnerLoopInput,
	EvolutionInnerLoopResult,
	EvolutionInnerLoopRound,
} from "./service.js";
import { replayedRounds } from "./service.js";
import { listFilesRecursive } from "../lib/fs.js";

export const BROWSER_SKILL_NAME = "prime-browser-provider-skill";
/** Every round replays all three Cases, and one Evolution Run gets at most three rounds. */
export const MAX_REPLAY_ROUNDS = 3;
export const BROWSER_EVOLUTION_STAGE_ID = "browser-skill-evolution";
export const BROWSER_EVOLUTION_ROLE = "evolution_browser_skill";

/** Shared by the running Agent and the Case that describes its model policy. */
export function browserSkillEvolutionModelPolicy(
	env: NodeJS.ProcessEnv = process.env,
	settingsOverride?: PiSettings,
): ResearchModelPolicy {
	const config = resolveLLMConfig({
		envVarName: "TELOMI_EVOLUTION_MODEL",
		taskModelRole: "browserEvolution",
		envOverride: env,
		...(settingsOverride ? { settingsOverride } : {}),
	});
	if (!config.model) throw new Error("Browser Evolution requires a configured provider/model");
	return {
		preferred: [config.model],
		fallback: [...config.fallbackChain],
		reasoning: resolveStageThinkingLevel("browserEvolution", "evolution", env, settingsOverride).thinkingLevel,
	};
}
const REPLAY_RUBRIC_ID = "provider-child-browser-v1";
const OWNER_AGENT_ID = "prime-search";
const CASE_COUNT = 3;
const PROMPT_CONFIG = {
	domain: "evolution",
	id: BROWSER_EVOLUTION_STAGE_ID,
	sandboxRole: "evolution.candidate_author",
} as const;

/**
 * The exact Prompt pair this Agent runs with. The Evolution Case Capture records the Agent's real
 * input by calling this, so the Case can never document a Prompt the Agent did not receive.
 */
export function browserSkillEvolutionPrompts(input: {
	objective: string;
	acceptanceCriteria: readonly string[];
}): { promptConfig: typeof PROMPT_CONFIG; systemPrompt: string; userPrompt: string } {
	return {
		promptConfig: PROMPT_CONFIG,
		systemPrompt: renderAgentPrompt("evolution", BROWSER_EVOLUTION_STAGE_ID, "system").content,
		userPrompt: renderAgentPrompt("evolution", BROWSER_EVOLUTION_STAGE_ID, "user", {
			objective: input.objective,
			acceptance_criteria: input.acceptanceCriteria.map((criterion) => `- ${criterion}`).join("\n"),
			skill_name: BROWSER_SKILL_NAME,
			case_count: CASE_COUNT,
			max_rounds: MAX_REPLAY_ROUNDS,
			evidence_manifest_path: "/evidence/manifest.json",
			evidence_root: "/evidence",
			baseline_root: "/baseline",
			candidate_output_path: "/work/candidate-package",
		}).content,
	};
}

/**
 * An isolated Provider Child result identifies the RLM child that owns its session Trace.
 * Activation evidence is only read from the Trace of a Browser child of this very replay, never
 * from the Root Agent, the Organizer, another Provider's child, or a Prompt that names the file.
 */
const CHILD_ID_PATTERN = /^sub-[A-Za-z0-9-]+$/u;

export interface BrowserReplayCaseEvidence {
	caseRef: NodeBacktestCaseRef;
	executionId: string;
	status: "completed" | "failed" | "missing";
	error?: string;
	/** Skill identity the replayed Provider child actually loaded, read from its launch conditions. */
	loadedSkill: { name: string; sha256: string; ref: string } | null;
	/** Browser child executions of this replay, and the Trace file each one wrote. */
	browserChildren: Array<{ executionId: string; childId: string; traceRefs: string[] }>;
	referenceReads: Array<{
		referencePath: string;
		executionId: string;
		childId: string;
		traceRef: string;
		line: number;
		toolName: string;
	}>;
	traceRefs: string[];
	artifactRef: string | null;
	diff: Record<string, unknown> | null;
	checks: Array<{ id: string; passed: boolean; detail: string }>;
}

export interface BrowserReplayRoundEvidence {
	schemaVersion: 2;
	round: number;
	intent: string;
	startedAt: string;
	finishedAt: string;
	/**
	 * `changedReferences` holds every reference whose bytes differ from the baseline, which is the
	 * same rule the Agent's submission contract states. Comparing paths instead would let the
	 * Skill only grow: a reference that was rewritten rather than added could never be activated.
	 */
	candidate: { skillName: string; sha256: string; changedReferences: string[] };
	capabilitySnapshotId: string;
	replay: { nodeBacktestRunId: string; status: string; executionCount: number };
	cases: BrowserReplayCaseEvidence[];
	gates: Array<{ id: string; passed: boolean; detail: string }>;
	passed: boolean;
	/** Set when Runtime could not complete the round. The round is still spent. */
	error?: string;
}

export function createBrowserSkillEvolutionLoop(options: {
	nodeBacktests: NodeBacktestService;
	runner?: AgentStageRunner;
	modelPolicy?: ResearchModelPolicy;
}): (input: EvolutionInnerLoopInput) => Promise<EvolutionInnerLoopResult> {
	const runner = options.runner ?? new SrtStageRuntime();
	return async (input) => {
		const modelPolicy = options.modelPolicy ?? browserSkillEvolutionModelPolicy();
		const release = trackTaskModelSelection(["browserEvolution"], {
			TELOMI_EVOLUTION_MODEL: modelPolicy.preferred[0],
			TELOMI_EVOLUTION_THINKING_LEVEL: modelPolicy.reasoning ?? "off",
		}, ["browserEvolution.evolution"]);
		try {
		mkdirSync(input.recordDirectory, { recursive: true });
		writeFileSync(join(input.recordDirectory, "model-policy.json"), `${JSON.stringify(modelPolicy)}\n`);
		const cases = evidenceCaseRefs(input.evidenceDirectory);
		const baselineSkill = join(input.baselineDirectory, BROWSER_SKILL_NAME);
		if (!existsSync(join(baselineSkill, "SKILL.md"))) {
			throw new Error(`Evolution baseline has no '${BROWSER_SKILL_NAME}'`);
		}
		const baselineReferenceHashes = referenceHashes(baselineSkill);
		const workDirectory = join(input.recordDirectory, "agent-work");
		const packageRoot = join(workDirectory, "candidate-package");
		mkdirSync(packageRoot, { recursive: true });
		const replayEvidenceDirectory = join(input.recordDirectory, "replay-evidence");
		mkdirSync(replayEvidenceDirectory, { recursive: true });
		// The Agent edits the effective Skill in place: a full same-name override starts from it.
		cpSync(baselineSkill, join(packageRoot, BROWSER_SKILL_NAME), { recursive: true });

		const rounds: BrowserReplayRoundEvidence[] = [];
		const replayTool = createReplayTool({
			input,
			cases,
			nodeBacktests: options.nodeBacktests,
			packageRoot,
			baselineReferenceHashes,
			rounds,
		});
		const prompts = browserSkillEvolutionPrompts({
			objective: input.run.objective,
			acceptanceCriteria: input.run.acceptanceCriteria,
		});
		const result = await runner.runStage({
			runId: input.run.id,
			stageId: BROWSER_EVOLUTION_STAGE_ID,
			attemptId: `${BROWSER_EVOLUTION_STAGE_ID}-1`,
			attempt: 1,
			role: BROWSER_EVOLUTION_ROLE,
			promptConfig: { ...prompts.promptConfig },
			recordKind: "evaluation",
			session: { key: BROWSER_EVOLUTION_STAGE_ID, policy: "fresh" },
			modelPolicy,
			systemPrompt: prompts.systemPrompt,
			userPrompt: prompts.userPrompt,
			workDirectory,
			readonlyMounts: [
				{ hostPath: replayEvidenceDirectory, guestPath: "/replays", access: "read-only" },
				{ hostPath: input.evidenceDirectory, guestPath: "/evidence", access: "read-only" },
				{ hostPath: input.baselineDirectory, guestPath: "/baseline", access: "read-only" },
				...bundledAgentSkillPaths("evolution", "browser-skill-evolution").map((hostPath) => ({
					hostPath,
					guestPath: `/skills/${hostPath.split("/").at(-1)}`,
					access: "read-only" as const,
				})),
			],
			controlDirectory: input.recordDirectory,
			recordDirectory: input.recordDirectory,
			artifactStore: new RunArtifactStore(input.recordDirectory),
			additionalTools: [replayTool],
			output: {
				kind: "json_candidate",
				entryRelativePath: "candidate-package/outcome.json",
				rootRelativePath: "candidate-package",
				publishRelativePath: "agent/candidate-package",
				validate: ({ entryPath, outputRoot }) => validateOutcome(entryPath, outputRoot, rounds, baselineReferenceHashes),
				isValidationErrorRepairable: () => true,
			},
			executionProfile: "pi_builtin",
			signal: input.signal,
		});
		const outcome = result.value;
		const loopRounds: EvolutionInnerLoopRound[] = rounds.map(loopRound);
		// A Run whose rounds never reached a replay reports the environment, not the Skill. Saying
		// only how many rounds were spent reads the same either way, so state how many of them ran.
		const replayed = replayedRounds({ innerLoop: { outcome: outcome.outcome, summary: "", rounds: loopRounds } });
		const summary = [outcome.summary,
			`Rounds: ${rounds.length}/${MAX_REPLAY_ROUNDS}, ${replayed} replayed.`].join(" ");
		if (outcome.outcome === "no_change") {
			return { outcome: "no_change", summary, rounds: loopRounds };
		}
		const confirmed = rounds.at(-1);
		if (!confirmed?.passed) throw new Error("A confirmed Browser Evolution must end on a passing replay round");
		const artifact = result.artifact;
		if (!("files" in artifact)) throw new Error("Browser Evolution Agent must publish one directory");
		const published = join(artifact.absolutePath, BROWSER_SKILL_NAME);
		if (snapshotSkills([published]).skills[0]?.sha256 !== confirmed.candidate.sha256) {
			throw new Error("Confirmed Browser Skill differs from the Skill of the last replay round");
		}
		cpSync(published, join(input.candidateDirectory, BROWSER_SKILL_NAME), { recursive: true });
		return {
			outcome: "confirmed",
			summary,
			rounds: loopRounds,
			candidate: {
				skillName: BROWSER_SKILL_NAME,
				summary: outcome.summary,
				expectedOutcome: outcome.improvement,
				selfChecks: rounds.map((round) =>
					`Round ${round.round}: ${CASE_COUNT} historical Provider Child Cases replayed with Skill ${round.candidate.sha256.slice(0, 12)}`),
			},
		};
		} finally { release(); }
	};
}

/** One reference the Agent changed, and the condition it says should route a Browser task to it. */
export interface BrowserEvolutionReference {
	path: string;
	state: "added" | "modified";
	trigger: string;
}

interface BrowserEvolutionOutcome {
	outcome: "confirmed" | "no_change";
	summary: string;
	improvement: string;
	references: BrowserEvolutionReference[];
}

function createReplayTool(context: {
	input: EvolutionInnerLoopInput;
	cases: NodeBacktestCaseRef[];
	nodeBacktests: NodeBacktestService;
	packageRoot: string;
	baselineReferenceHashes: Map<string, string>;
	rounds: BrowserReplayRoundEvidence[];
}): AgentTool {
	const parameters = Type.Object({
		intent: Type.String({ minLength: 1, maxLength: 2000 }),
	}, { additionalProperties: false });
	const tool: AgentTool<typeof parameters> = {
		name: "run_browser_replay",
		label: "run_browser_replay",
		description: `Replay all ${CASE_COUNT} historical Provider Child Cases of this Evolution with the current`
			+ ` /work/candidate-package/${BROWSER_SKILL_NAME}. At most ${MAX_REPLAY_ROUNDS} calls per Evolution.`,
		parameters,
		executionMode: "sequential",
		execute: async (_toolCallId, value) => {
			if (context.rounds.length >= MAX_REPLAY_ROUNDS) {
				const text = `run_browser_replay is exhausted: ${MAX_REPLAY_ROUNDS} rounds already ran.`
					+ " Finish with confirmed or no_change based on the Evidence you already have.";
				return { content: [{ type: "text", text }], details: { accepted: false, errors: [text] } };
			}
			// The reference-activated gate needs a changed reference to look for, so a Candidate
			// that changed none can only fail. That is knowable from the package alone: answer it
			// here rather than after three live executions have already spent the round. A Candidate
			// too malformed to inspect is not this check's business; the round below records it.
			let unchanged = false;
			try {
				unchanged = changedReferences(assertCandidateSkill(context.packageRoot), context.baselineReferenceHashes).length === 0;
			} catch { /* Leave a renamed or missing Skill to the round that has always reported it. */ }
			if (unchanged) {
				const text = "run_browser_replay needs at least one reference whose bytes differ from the baseline."
					+ " The current Candidate changes none, so no replay could prove a reference was activated."
					+ " Edit or add a reference under references/ and index it from SKILL.md, then call again."
					+ " This call did not spend a round.";
				return { content: [{ type: "text", text }], details: { accepted: false, errors: [text] } };
			}
			// Every invocation consumes a round, including one that fails inside Runtime. A retry
			// that did not cost a round would let one Evolution replay without a bound.
			const round = context.rounds.length + 1;
			context.input.setStatus("replaying");
			// Both paths below end a round, and the Run record should carry it as soon as its
			// Evidence is durable rather than an hour later when the whole loop returns.
			const record = (evidence: BrowserReplayRoundEvidence) => {
				context.rounds.push(evidence);
				context.input.recordRound(loopRound(evidence));
			};
			try {
				const evidence = await runReplayRound(context, round, value.intent.trim());
				record(evidence);
				return {
					content: [{ type: "text", text: `${JSON.stringify(agentView(evidence), null, 2)}\n` }],
					details: { accepted: evidence.passed },
				};
			} catch (error) {
				if (context.input.signal.aborted) throw error;
				const evidence = failedRound(context, round, value.intent.trim(), error);
				record(evidence);
				return {
					content: [{ type: "text", text: `${JSON.stringify(agentView(evidence), null, 2)}\n` }],
					details: { accepted: false, errors: [evidence.error ?? "replay failed"] },
				};
			} finally {
				context.input.setStatus("authoring");
			}
		},
	};
	return tool as AgentTool;
}

async function runReplayRound(
	context: {
		input: EvolutionInnerLoopInput;
		cases: NodeBacktestCaseRef[];
		nodeBacktests: NodeBacktestService;
		packageRoot: string;
		baselineReferenceHashes: Map<string, string>;
	},
	round: number,
	intent: string,
): Promise<BrowserReplayRoundEvidence> {
	const { input, nodeBacktests } = context;
	const startedAt = new Date().toISOString();
	const roundDirectory = roundDirectoryPath(input.recordDirectory, round);
	mkdirSync(roundDirectory, { recursive: true });
	// The round replays an immutable copy: later Agent edits cannot rewrite what was measured.
	const candidateSkill = join(roundDirectory, "candidate", BROWSER_SKILL_NAME);
	cpSync(assertCandidateSkill(context.packageRoot), candidateSkill, { recursive: true });
	const snapshotted = snapshotSkills([candidateSkill]).skills[0]!;
	const changed = changedReferences(candidateSkill, context.baselineReferenceHashes);
	const capability = candidateCapabilitySnapshot({
		goalId: input.run.goalId,
		goalDirectory: input.goalDirectory,
		runDirectory: roundDirectory,
		ownerAgentId: OWNER_AGENT_ID,
		candidateSkillDirectory: candidateSkill,
		skillName: BROWSER_SKILL_NAME,
		nodeBacktests,
	});
	const enqueued = nodeBacktests.enqueue(input.run.goalId, {
		agentId: "provider-child",
		cases: context.cases,
		candidate: { capabilitySnapshotId: capability.id },
		repetitions: 1,
		rubricId: REPLAY_RUBRIC_ID,
	});
	const completed = await waitForBacktest(nodeBacktests, input.run.goalId, enqueued.id, input.signal);
	const cases = context.cases.map((caseRef) => caseEvidence({
		nodeBacktests,
		goalId: input.run.goalId,
		backtestRunId: completed.id,
		run: completed,
		caseRef,
		candidateSha256: snapshotted.sha256,
		changedReferences: changed,
		referenceContentHashes: referenceHashes(candidateSkill),
	}));
	const evidence: BrowserReplayRoundEvidence = {
		schemaVersion: 2,
		round,
		intent,
		startedAt,
		finishedAt: new Date().toISOString(),
		candidate: { skillName: BROWSER_SKILL_NAME, sha256: snapshotted.sha256, changedReferences: changed },
		capabilitySnapshotId: capability.id,
		replay: {
			nodeBacktestRunId: completed.id,
			status: completed.status,
			executionCount: completed.executions.length,
		},
		cases,
		gates: [],
		passed: false,
	};
	evidence.gates = roundGates(evidence, completed.status, completed.error);
	evidence.passed = evidence.gates.every((gate) => gate.passed);
	// Publish only verified Case outputs and traces, never the replay workspace or Runtime control tree.
	const visibleRoot = join(input.recordDirectory, "replay-evidence", String(round));
	mkdirSync(visibleRoot, { recursive: true });
	const manifestCases = completed.executions.map((execution, index) => {
		const files: Array<{ ref: string; kind: string; path: string }> = [];
		const retain = (source: string, ref: string, kind: string) => {
			const local = `${index + 1}/${ref.replace(":", "/")}`;
			mkdirSync(dirname(join(visibleRoot, local)), { recursive: true });
			cpSync(source, join(visibleRoot, local), { errorOnExist: true, force: false });
			files.push({ ref, kind, path: `/replays/${round}/${local}` });
		};
		if (execution.status === "completed") retain(nodeBacktests.artifactFile(
			input.run.goalId, completed.id, execution.id, "result.json"), "result.json", "result");
		if (execution.status === "failed") {
			for (const file of failedReplayFiles(nodeBacktests, input.run.goalId, completed.id, execution)) {
				retain(file.path, file.ref, file.kind);
			}
		}
		if (execution.candidateCaseRef) {
			for (const file of nodeBacktests.listCaseFilePaths(input.run.goalId, execution.candidateCaseRef)) {
				if (!["observed_output", "child_trace", "execution_conditions"].includes(file.kind)) continue;
				retain(file.absolutePath, file.ref, file.kind);
			}
		}
		return { case: execution.caseRef, status: execution.status, files };
	});
	writeFileSync(join(visibleRoot, "manifest.json"), JSON.stringify({ cases: manifestCases }, null, 2), { flag: "wx" });
	return persistRound(input.recordDirectory, evidence);
}

/**
 * A round Runtime could not complete. It is recorded and it is spent, so three failing
 * invocations exhaust the budget exactly like three completed ones.
 */
function failedRound(
	context: { input: EvolutionInnerLoopInput; packageRoot: string; baselineReferenceHashes: Map<string, string> },
	round: number,
	intent: string,
	error: unknown,
): BrowserReplayRoundEvidence {
	const detail = toErrorMessage(error);
	const now = new Date().toISOString();
	let candidate = { skillName: BROWSER_SKILL_NAME, sha256: "", changedReferences: [] as string[] };
	try {
		const skill = join(context.packageRoot, BROWSER_SKILL_NAME);
		candidate = {
			skillName: BROWSER_SKILL_NAME,
			sha256: snapshotSkills([skill]).skills[0]?.sha256 ?? "",
			changedReferences: changedReferences(skill, context.baselineReferenceHashes),
		};
	} catch { /* The Candidate itself may be what failed; the round is still recorded. */ }
	return persistRound(context.input.recordDirectory, {
		schemaVersion: 2,
		round,
		intent,
		startedAt: now,
		finishedAt: now,
		candidate,
		capabilitySnapshotId: "",
		replay: { nodeBacktestRunId: "", status: "failed", executionCount: 0 },
		cases: [],
		gates: [{ id: "replay-round-completed", passed: false, detail }],
		passed: false,
		error: detail,
	});
}

function roundDirectoryPath(recordDirectory: string, round: number): string {
	return join(recordDirectory, "rounds", String(round));
}

/** Round Evidence is immutable: one record per invocation, written once. */
/** The summary of one round the Run record carries, both while running and in the final verdict. */
function loopRound(evidence: BrowserReplayRoundEvidence): EvolutionInnerLoopRound {
	return {
		round: evidence.round,
		replayRunId: evidence.replay.nodeBacktestRunId,
		passed: evidence.passed,
		recordRelativePath: `rounds/${evidence.round}/round.json`,
	};
}

function persistRound(recordDirectory: string, evidence: BrowserReplayRoundEvidence): BrowserReplayRoundEvidence {
	const directory = roundDirectoryPath(recordDirectory, evidence.round);
	mkdirSync(directory, { recursive: true });
	writeFileSync(join(directory, "round.json"), `${JSON.stringify(evidence, null, 2)}\n`,
		{ encoding: "utf-8", flag: "wx", mode: 0o600 });
	const visible = join(recordDirectory, "replay-evidence", String(evidence.round));
	mkdirSync(visible, { recursive: true });
	writeFileSync(join(visible, "round.json"), JSON.stringify(evidence, null, 2), { flag: "wx" });
	if (!existsSync(join(visible, "manifest.json"))) {
		writeFileSync(join(visible, "manifest.json"), JSON.stringify({ cases: [], error: evidence.error }), { flag: "wx" });
	}
	return evidence;
}

/** Deterministic hard gates. None of them judges whether the Candidate is semantically better. */
function roundGates(
	evidence: BrowserReplayRoundEvidence,
	backtestStatus: string,
	backtestError: string | undefined,
): BrowserReplayRoundEvidence["gates"] {
	const completed = evidence.cases.filter((item) => item.status === "completed");
	const loaded = evidence.cases.filter((item) => item.loadedSkill?.sha256 === evidence.candidate.sha256);
	const traced = evidence.cases.filter((item) => item.traceRefs.length > 0);
	const reads = evidence.cases.flatMap((item) => item.referenceReads);
	return [
		{
			id: "three-replays-valid",
			passed: backtestStatus === "awaiting_evaluation" && completed.length === CASE_COUNT,
			detail: backtestStatus === "awaiting_evaluation" && completed.length === CASE_COUNT
				? `${CASE_COUNT} Candidate Replays passed production validation.`
				: backtestError ?? `${completed.length}/${CASE_COUNT} Candidate Replays completed at status ${backtestStatus}.`,
		},
		{
			id: "candidate-skill-loaded",
			passed: loaded.length === CASE_COUNT,
			detail: loaded.length === CASE_COUNT
				? `Every replay loaded Skill ${evidence.candidate.sha256}.`
				: `${loaded.length}/${CASE_COUNT} replays recorded loading the exact Candidate Skill.`,
		},
		{
			id: "browser-child-trace-located",
			passed: traced.length === CASE_COUNT,
			detail: traced.length === CASE_COUNT
				? "Every replay published the session Trace of its own Browser Provider child."
				: `${traced.length}/${CASE_COUNT} replays published a Browser child Trace.`,
		},
		{
			id: "reference-activated",
			passed: evidence.candidate.changedReferences.length > 0 && reads.length > 0,
			detail: evidence.candidate.changedReferences.length === 0
				? "The Candidate changes no reference to activate."
				: reads.length > 0
					? `${reads.length} trace-located reads of ${[...new Set(reads.map((read) => read.referencePath))].join(", ")}.`
					: `No replay read any of: ${evidence.candidate.changedReferences.join(", ")}.`,
		},
	];
}

function caseEvidence(args: {
	nodeBacktests: NodeBacktestService;
	goalId: string;
	backtestRunId: string;
	run: { executions: Array<{ id: string; caseRef: NodeBacktestCaseRef; status?: string; error?: string;
		candidateCaseRef?: NodeBacktestCaseRef; artifact: { ref: string } }> };
	caseRef: NodeBacktestCaseRef;
	candidateSha256: string;
	changedReferences: string[];
	referenceContentHashes: Map<string, string>;
}): BrowserReplayCaseEvidence {
	const execution = args.run.executions.find((item) => item.caseRef.caseId === args.caseRef.caseId
		&& item.caseRef.sourceRunId === args.caseRef.sourceRunId);
	if (!execution) {
		return {
			caseRef: args.caseRef,
			executionId: "",
			status: "missing",
			error: "The Candidate Replay never reached this Case",
			loadedSkill: null,
			browserChildren: [],
			referenceReads: [],
			traceRefs: [],
			artifactRef: null,
			diff: null,
			checks: [{ id: "replay-completed", passed: false, detail: "No Candidate Replay execution for this Case" }],
		};
	}
	const base: BrowserReplayCaseEvidence = {
		caseRef: args.caseRef,
		executionId: execution.id,
		status: execution.status === "completed" ? "completed" : "failed",
		...(execution.error ? { error: execution.error } : {}),
		loadedSkill: null,
		browserChildren: [],
		referenceReads: [],
		traceRefs: [],
		artifactRef: execution.artifact?.ref ?? null,
		diff: null,
		checks: [],
	};
	if (execution.status !== "completed") {
		base.checks = [{ id: "replay-completed", passed: false, detail: execution.error ?? "Candidate Replay failed" }];
		return base;
	}
	if (!execution.candidateCaseRef) {
		base.checks = [{ id: "candidate-case-captured", passed: false, detail: "The Candidate Replay captured no Case" }];
		return base;
	}
	const files = args.nodeBacktests.listCaseFilePaths(args.goalId, execution.candidateCaseRef);
	const paths = new Map(files.map((file) => [file.ref, file.absolutePath]));
	const filePath = (file: NodeBacktestCaseFile) => paths.get(file.ref)!;
	base.artifactRef = execution.artifact?.ref ?? null;
	base.diff = observedCandidateDiff(args, execution.id);
	// Which Browser children this replay actually dispatched, from its own execution records.
	base.browserChildren = browserChildExecutions(args, execution.id).map((child) => ({
		...child,
		traceRefs: files
			.filter((file) => file.kind === "child_trace" && file.ref === "output:traces/session.jsonl")
			.map((file) => file.ref),
	}));
	base.loadedSkill = loadedSkillIdentity(files, filePath, base.browserChildren.map((child) => child.childId));
	base.traceRefs = base.browserChildren.flatMap((child) => child.traceRefs);
	base.referenceReads = files.filter((file) => file.kind === "execution_conditions").flatMap((file) =>
		locateReferenceReads(filePath(file), file.ref, args.changedReferences, args.referenceContentHashes)
			.flatMap((read) => base.browserChildren
				.filter((child) => child.childId === read.childId)
				.map((child) => ({ ...read, executionId: child.executionId }))));
	base.checks = [
		{ id: "replay-completed", passed: true, detail: "The Candidate Replay finished production validation." },
		{
			id: "candidate-skill-loaded",
			passed: base.loadedSkill?.sha256 === args.candidateSha256,
			detail: base.loadedSkill
				? `Loaded ${base.loadedSkill.name} ${base.loadedSkill.sha256} from ${base.loadedSkill.ref}.`
				: "The replay recorded no Browser Skill launch conditions.",
		},
		{
			id: "browser-child-trace-located",
			passed: base.traceRefs.length > 0,
			detail: base.browserChildren.length === 0
				? "The replay dispatched no Browser Provider child."
				: `${base.traceRefs.length} Trace files for Browser children ${
					base.browserChildren.map((child) => child.childId).join(", ")}.`,
		},
	];
	return base;
}

/** Browser Provider children this replay dispatched, taken from the replay's own execution records. */
function browserChildExecutions(
	args: { nodeBacktests: NodeBacktestService; goalId: string; backtestRunId: string },
	executionId: string,
): Array<{ executionId: string; childId: string }> {
	try {
		const value = JSON.parse(readFileSync(
			args.nodeBacktests.artifactFile(args.goalId, args.backtestRunId, executionId, "result.json"), "utf-8",
		)) as { provider_id?: string; execution_id?: string; child_id?: string };
		if (value.provider_id !== "browser" || typeof value.execution_id !== "string"
			|| typeof value.child_id !== "string" || !CHILD_ID_PATTERN.test(value.child_id)) return [];
		return [{ executionId: value.execution_id, childId: value.child_id }];
	} catch {
		return [];
	}
}

/** The Skill identity a replayed Provider child actually loaded, from its Prime launch conditions. */
function loadedSkillIdentity(
	files: NodeBacktestCaseFile[],
	filePath: (file: NodeBacktestCaseFile) => string,
	childIds: string[],
): BrowserReplayCaseEvidence["loadedSkill"] {
	for (const file of files.filter((item) => item.kind === "execution_conditions")) {
		for (const line of readFileSync(filePath(file), "utf-8").split("\n")) {
			if (!line.trim()) continue;
			let value: { agent_session_id?: string; skills?: { items?: Array<{ name?: unknown; sha256?: unknown }> } };
			try { value = JSON.parse(line); } catch { continue; }
			if (!value.agent_session_id || !childIds.includes(value.agent_session_id)) continue;
			const item = value.skills?.items?.find((skill) => skill.name === BROWSER_SKILL_NAME);
			if (item && typeof item.sha256 === "string") {
				return { name: BROWSER_SKILL_NAME, sha256: item.sha256, ref: file.ref };
			}
		}
	}
	return null;
}

/**
 * Reads of a new reference, located to one execution-conditions file and line.
 *
 * The Prime kernel has no read Tool; a child reads a reference through
 * `research_runtime.read_skill`, and the Runtime bridge (not the child) reads the bytes and
 * appends a `skill_read` receipt with the child's execution id and the content hash. Only such a
 * receipt counts: a Python `open()`, a printed receipt, a Prompt that quotes the path, or a
 * receipt for another file version proves nothing about activation.
 */
function locateReferenceReads(
	path: string,
	ref: string,
	changedReferences: string[],
	referenceContentHashes: Map<string, string>,
): Array<{ referencePath: string; childId: string; traceRef: string; line: number; toolName: string }> {
	if (changedReferences.length === 0) return [];
	const reads: Array<{ referencePath: string; childId: string; traceRef: string; line: number; toolName: string }> = [];
	for (const [index, line] of readFileSync(path, "utf-8").split("\n").entries()) {
		if (!line.trim()) continue;
		let record: unknown;
		try { record = JSON.parse(line); } catch { continue; }
		if (!isRecord(record) || record.kind !== "skill_read") continue;
		if (typeof record.path !== "string" || typeof record.sha256 !== "string" || typeof record.agent_session_id !== "string") continue;
		if (!CHILD_ID_PATTERN.test(record.agent_session_id)) continue;
		for (const reference of changedReferences) {
			if (!isSkillReferencePath(record.path, reference)) continue;
			if (record.sha256 !== referenceContentHashes.get(reference)) continue;
			reads.push({ referencePath: reference, childId: record.agent_session_id, traceRef: ref, line: index + 1, toolName: "research_runtime.read_skill" });
		}
	}
	return reads;
}

/** True when the path's last segments are exactly `<skill>/references/<file>` after normalization. */
function isSkillReferencePath(value: string, reference: string): boolean {
	const expected = [BROWSER_SKILL_NAME, ...pathSegments(reference)];
	const segments = pathSegments(value);
	if (segments.length < expected.length) return false;
	const offset = segments.length - expected.length;
	return expected.every((segment, index) => segments[offset + index] === segment);
}

function pathSegments(value: string): string[] {
	const segments: string[] = [];
	for (const segment of value.split(/[\\/]+/u)) {
		if (!segment || segment === ".") continue;
		if (segment === "..") { segments.pop(); continue; }
		segments.push(segment);
	}
	return segments;
}

function observedCandidateDiff(
	args: {
		nodeBacktests: NodeBacktestService;
		goalId: string;
		backtestRunId: string;
		caseRef: NodeBacktestCaseRef;
	},
	executionId: string,
): Record<string, unknown> | null {
	try {
		const observed = browserResultSummary(
			args.nodeBacktests.caseFile(args.goalId, args.caseRef, "output:result.json"));
		const candidate = browserResultSummary(
			args.nodeBacktests.artifactFile(args.goalId, args.backtestRunId, executionId, "result.json"));
		return {
			observed,
			candidate,
		};
	} catch (error) {
		return { error: toErrorMessage(error) };
	}
}

interface BrowserResultSummary {
	terminal_status: string;
	tool_calls: number;
	usage: unknown;
}

function browserResultSummary(path: string): BrowserResultSummary {
	const value = JSON.parse(readFileSync(path, "utf-8")) as {
		terminal_status: string; tool_calls: number; usage: unknown;
	};
	return { terminal_status: value.terminal_status, tool_calls: value.tool_calls, usage: value.usage };
}

/** What the Agent sees after a round: the full Evidence minus the file-level noise. */
function agentView(round: BrowserReplayRoundEvidence): Record<string, unknown> {
	return {
		round: round.round,
		record: `/replays/${round.round}/round.json`,
		evidence_manifest: `/replays/${round.round}/manifest.json`,
		rounds_remaining: MAX_REPLAY_ROUNDS - round.round,
		candidate: round.candidate,
		replay: round.replay,
		gates: round.gates,
		passed: round.passed,
		...(round.error ? { error: round.error } : {}),
		cases: round.cases.map((item) => ({
			case_id: item.caseRef.caseId,
			status: item.status,
			...(item.error ? { error: item.error } : {}),
			loaded_skill_sha256: item.loadedSkill?.sha256 ?? null,
			browser_children: item.browserChildren.map((child) => ({
				execution_id: child.executionId,
				trace_ref_count: child.traceRefs.length,
			})),
			reference_reads: item.referenceReads,
			artifact_ref: item.artifactRef,
			diff: item.diff,
			checks: item.checks,
		})),
	};
}

function validateOutcome(
	entryPath: string,
	outputRoot: string,
	rounds: BrowserReplayRoundEvidence[],
	baselineReferences: Map<string, string>,
): BrowserEvolutionOutcome {
	const value = JSON.parse(readFileSync(entryPath, "utf-8")) as Record<string, unknown>;
	const expected = ["generalization", "improvement", "outcome", "references", "regression_risk", "remaining_risk",
		"scenario_class", "schema_version", "skill_name", "summary"];
	if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(expected)) {
		throw new Error(`outcome.json must contain exactly: ${expected.join(", ")}`);
	}
	if (value.schema_version !== 1 || value.skill_name !== BROWSER_SKILL_NAME) {
		throw new Error(`outcome.json must declare schema_version 1 and skill_name '${BROWSER_SKILL_NAME}'`);
	}
	for (const key of ["summary", "scenario_class", "generalization", "improvement", "regression_risk", "remaining_risk"]) {
		if (typeof value[key] !== "string" || !(value[key] as string).trim()) {
			throw new Error(`outcome.json field '${key}' must be a non-empty string`);
		}
	}
	if (value.outcome !== "confirmed" && value.outcome !== "no_change") {
		throw new Error("outcome.json must finish as confirmed or no_change");
	}
	const outcome: BrowserEvolutionOutcome = {
		outcome: value.outcome,
		summary: (value.summary as string).trim(),
		improvement: (value.improvement as string).trim(),
		references: validateReferences(value.references, join(outputRoot, BROWSER_SKILL_NAME), baselineReferences),
	};
	if (outcome.outcome === "no_change") return outcome;
	const last = rounds.at(-1);
	if (!last) throw new Error("confirmed requires at least one run_browser_replay round");
	if (!last.passed) {
		throw new Error(`confirmed requires the last replay round to pass every hard check: ${
			last.gates.filter((gate) => !gate.passed).map((gate) => `${gate.id}: ${gate.detail}`).join("; ")}`);
	}
	const skill = join(outputRoot, BROWSER_SKILL_NAME);
	if (!existsSync(join(skill, "SKILL.md"))) throw new Error(`confirmed requires ${BROWSER_SKILL_NAME}/SKILL.md`);
	const current = snapshotSkills([skill]).skills[0]?.sha256;
	if (current !== last.candidate.sha256) {
		throw new Error(`The Skill changed after round ${last.round}: replay it again before confirming`);
	}
	return outcome;
}

function assertCandidateSkill(packageRoot: string): string {
	const skill = join(packageRoot, BROWSER_SKILL_NAME);
	if (!existsSync(join(skill, "SKILL.md"))) {
		throw new Error(`The Candidate must stay one Skill directory named '${BROWSER_SKILL_NAME}' with SKILL.md`);
	}
	const snapshot = snapshotSkills([skill]);
	if (snapshot.skills.length !== 1 || snapshot.skills[0]?.name !== BROWSER_SKILL_NAME) {
		throw new Error(`The Candidate Skill must keep the name '${BROWSER_SKILL_NAME}'`);
	}
	return skill;
}

/**
 * The Agent's own account of what it changed and when each reference should be read.
 *
 * Runtime cannot derive a routing condition from a Markdown file, so the trigger stays the Agent's
 * judgment. What Runtime does check is that the account matches the tree it submitted: exactly the
 * references whose bytes differ from the baseline, each with the state that difference actually has.
 * That keeps the reviewer from reading a trigger for a reference nobody touched, or from missing
 * one the Candidate quietly added.
 */
function validateReferences(
	value: unknown,
	skillDirectory: string,
	baseline: Map<string, string>,
): BrowserEvolutionReference[] {
	if (!Array.isArray(value)) throw new Error("outcome.json field 'references' must be an array");
	const declared = value.map((item, index): BrowserEvolutionReference => {
		const entry = item as Record<string, unknown> | null;
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
			throw new Error(`outcome.json references[${index}] must be an object`);
		}
		if (JSON.stringify(Object.keys(entry).sort()) !== JSON.stringify(["path", "state", "trigger"])) {
			throw new Error(`outcome.json references[${index}] must contain exactly: path, state, trigger`);
		}
		if (entry.state !== "added" && entry.state !== "modified") {
			throw new Error(`outcome.json references[${index}].state must be "added" or "modified"`);
		}
		for (const key of ["path", "trigger"] as const) {
			if (typeof entry[key] !== "string" || !(entry[key] as string).trim()) {
				throw new Error(`outcome.json references[${index}].${key} must be a non-empty string`);
			}
		}
		return { path: (entry.path as string).trim(), state: entry.state, trigger: (entry.trigger as string).trim() };
	});
	const actual = [...referenceHashes(skillDirectory)]
		.filter(([path, digest]) => baseline.get(path) !== digest)
		.map(([path]) => ({ path, state: baseline.has(path) ? "modified" as const : "added" as const }))
		.sort((left, right) => left.path.localeCompare(right.path));
	const describe = (items: Array<{ path: string; state: string }>) =>
		items.map((item) => `${item.path} (${item.state})`).join(", ") || "none";
	const sorted = [...declared].sort((left, right) => left.path.localeCompare(right.path));
	if (JSON.stringify(sorted.map(({ path, state }) => ({ path, state }))) !== JSON.stringify(actual)) {
		throw new Error(`outcome.json 'references' declares ${describe(sorted)} but the Candidate Skill changed ${
			describe(actual)}: declare exactly the references you changed, each with its trigger condition`);
	}
	return declared;
}

/** Content hash of every reference file of one Skill, keyed by the path relative to the Skill root. */
function referenceHashes(skillDirectory: string): Map<string, string> {
	return new Map(skillReferenceFiles(skillDirectory)
		.map((path) => [path, sha256(readFileSync(join(skillDirectory, path)))]));
}

/**
 * References of `skillDirectory` whose bytes differ from the baseline, added and rewritten alike.
 * A path absent from the baseline has no hash to match, so an added file is the degenerate case.
 */
function changedReferences(skillDirectory: string, baseline: Map<string, string>): string[] {
	return [...referenceHashes(skillDirectory)]
		.filter(([path, hash]) => baseline.get(path) !== hash)
		.map(([path]) => path);
}

/** Reference files of one Skill, relative to the Skill root. */
function skillReferenceFiles(skillDirectory: string): string[] {
	return listFilesRecursive(join(skillDirectory, "references"), { absolute: true })
		.map((path) => relative(skillDirectory, path).split(sep).join("/"))
		.sort();
}

function evidenceCaseRefs(evidenceDirectory: string): NodeBacktestCaseRef[] {
	const manifest = JSON.parse(readFileSync(join(evidenceDirectory, "manifest.json"), "utf-8")) as {
		runs?: Array<{ child_case_ref?: NodeBacktestCaseRef }>;
	};
	const cases = (manifest.runs ?? []).map((run) => run.child_case_ref);
	if (cases.length !== CASE_COUNT || cases.some((ref) => !ref || typeof ref.sourceRunId !== "string"
		|| !ref.sourceRunId || typeof ref.caseId !== "string" || !ref.caseId)
		|| new Set(cases.map((ref) => `${ref?.sourceRunId}\0${ref?.caseId}`)).size !== CASE_COUNT) {
		throw new Error(`Browser Evolution replays exactly ${CASE_COUNT} distinct historical Provider Child Cases`);
	}
	return cases as NodeBacktestCaseRef[];
}
