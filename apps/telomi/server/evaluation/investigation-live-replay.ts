import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { RunArtifactStore } from "../agent-runtime/artifact-store.js";
import type { AgentStageRequest, ValidatedStageArtifact } from "../agent-runtime/agent-stage-runtime.js";
import { beginNodeEvaluationCase, finishNodeEvaluationCase, readNodeEvaluationCase, type NodeReplayRecipe } from "../agent-runtime/node-evaluation.js";
import { modelDefinitionHash } from "../agent-runtime/model-policy.js";
import type { ThinkingLevel } from "../agent-runtime/model-config/resolve.js";
import type { CaseCaptureHooks } from "../observability/case-capture.js";
import { executeInvestigation } from "../research/investigate.js";
import { validateInvestigationResult, type InvestigationResult } from "../citations/contracts.js";
import { sha256 } from "../lib/hash.js";
import { writeJsonAtomic as writeJson } from "../lib/fs.js";
import { toErrorMessage } from "../lib/values.js";
import { serverRuntimeDirForGoalDir } from "../workspaces/server-runtime-paths.js";
import { hashWikiDirectory } from "../wiki/files.js";
import { prepareMainAgentReplayGoalWorkspace, retainMainAgentReplayEvidence } from "./main-agent-replay.js";
import { collectInvestigationUsage } from "./investigation-usage.js";
import { freezeInvestigationModels, LIVE_INVESTIGATION_RECIPE, liveInvestigationBusinessHash, liveInvestigationProfile,
	liveInvestigationPrompts, readLiveInvestigationRequest, type InvestigationProfile, type LiveInvestigationRequest } from "./investigation-live-contract.js";

type CaptureInput = Parameters<CaseCaptureHooks["investigation"]>[0];
const outputPath = "artifacts/investigation-live-output";

function beginCapture(input: { request: LiveInvestigationRequest; recordDirectory: string; sourceRunId: string;
	profile: InvestigationProfile; capabilitySnapshotId?: string }) {
	const prompts = liveInvestigationPrompts(input.profile);
	const stage: AgentStageRequest<unknown> = {
		runId: input.sourceRunId, stageId: "prime-investigation", attemptId: "attempt-1", role: "prime_search",
		promptConfig: { domain: "research", id: "prime-search", sandboxRole: input.profile === "pi_builtin" ? "research.investigation" : "research.prime_search",
			userVariant: input.profile === "pi_builtin" ? "investigate-pi" : "investigate" } as never,
		recordKind: "evaluation", evaluation: { agentId: "prime-investigation", recipe: LIVE_INVESTIGATION_RECIPE,
			recipeInput: { mode: "live-investigation", businessInputSha256: input.request.business_input_sha256 },
			inputRelativePath: "live-input", harnessMounts: [], liveExternalState: true },
		session: { key: "live-investigation", policy: "fresh" }, modelPolicy: {
			preferred: [input.request.model_env.TELOMI_PRIME_AGENT_ROOT_MODEL!], fallback: [],
			reasoning: input.request.model_env.TELOMI_PRIME_SEARCH_THINKING_LEVEL as ThinkingLevel },
		...prompts, workDirectory: join(input.recordDirectory, "live-output"), readonlyMounts: [],
		controlDirectory: input.recordDirectory, recordDirectory: input.recordDirectory,
		artifactStore: new RunArtifactStore(input.recordDirectory),
		output: { kind: "json_candidate", publishRelativePath: outputPath, validate: () => ({}) }, signal: new AbortController().signal,
	};
	const draft = beginNodeEvaluationCase({ request: stage, recordDirectory: input.recordDirectory,
		promptConfig: stage.promptConfig!, sessionContextFile: join(input.recordDirectory, ".no-session"),
		composedSystemPrompt: prompts.systemPrompt, actualModel: input.request.model_env.TELOMI_PRIME_AGENT_ROOT_MODEL!,
		...(input.capabilitySnapshotId ? { capabilitySnapshotId: input.capabilitySnapshotId } : {}) });
	if (!draft) throw new Error("Live Investigation Case capture did not start");
	return draft;
}

/** Native tools run freely; only the business request, prestate and model conditions are frozen. */
export function createLiveInvestigationReplayRecipe(options: { execute?: typeof executeInvestigation } = {}): NodeReplayRecipe {
	return { identity: LIVE_INVESTIGATION_RECIPE, async replay(input) {
		if (input.value.agentId !== "prime-investigation" || input.value.recipe.version !== 2) throw new Error("Live Investigation needs recipe v2");
		if (input.promptMode && input.promptMode !== "candidate") throw new Error("Live Investigation uses its Candidate Agent Bundle; observed and override prompts are unsupported");
		const sourceInput = join(dirname(input.casePath), "input");
		const request = readLiveInvestigationRequest(sourceInput);
		const profile = liveInvestigationProfile();
		const prompts = liveInvestigationPrompts(profile);
		if (input.promptOverride && !isDeepStrictEqual(input.promptOverride, prompts)) throw new Error("Live Investigation pinned prompts changed");
		const env = { ...process.env, ...request.model_env };
		for (const [model, expected] of Object.entries(request.model_definition_hashes)) {
			if (modelDefinitionHash(model, env) !== expected) throw new Error(`Live Investigation model definition changed: ${model}`);
		}
		mkdirSync(input.recordDirectory, { recursive: true });
		cpSync(sourceInput, join(input.recordDirectory, "live-input"), { recursive: true });
		const goalId = `investigation-backtest-${sha256(input.recordDirectory).slice(0, 16)}`;
		const workspaceDirectory = join(input.recordDirectory, "live-runtime");
		const goalDir = await prepareMainAgentReplayGoalWorkspace({ value: input.value, casePath: input.casePath,
			sourceRunDirectory: input.sourceRunDirectory, harnessWorkspaceDirectory: input.harnessWorkspaceDirectory,
			workspaceDirectory, goalId, frozenGoalDirectory: join(sourceInput, "goal") });
		// Older Wiki aliases resolve through the owning invocation's citation snapshot.
		const priorArtifacts = join(goalDir, "artifacts", "investigations");
		if (existsSync(priorArtifacts)) {
			for (const entry of readdirSync(priorArtifacts, { withFileTypes: true })) {
				if (!entry.isDirectory() || !/^[a-f0-9]{24}$/u.test(entry.name) || !existsSync(join(priorArtifacts, entry.name, "citations.json"))) continue;
				const source = new RunArtifactStore(join(priorArtifacts, entry.name)).describeFile("citations.json").absolutePath;
				const target = join(serverRuntimeDirForGoalDir(goalDir), "research", "investigations", entry.name, "citations.json");
				mkdirSync(dirname(target), { recursive: true }); copyFileSync(source, target);
			}
		}
		const invocationId = `live-${basename(input.recordDirectory)}`;
		const investigationId = sha256(`${goalId}\0${invocationId}`).slice(0, 24);
		const runDir = join(serverRuntimeDirForGoalDir(goalDir), "research", "investigations", investigationId);
		const draft = beginCapture({ request, recordDirectory: input.recordDirectory,
			sourceRunId: input.candidateCase?.sourceRunId ?? input.value.runId, profile,
			capabilitySnapshotId: input.candidateCase?.capabilitySnapshotId });
		const output = join(input.recordDirectory, "live-output"); mkdirSync(join(output, "runtime"), { recursive: true });
		const started = Date.now();
		let native: CaptureInput | undefined, result: InvestigationResult | undefined, failure: unknown;
		try {
			result = await (options.execute ?? executeInvestigation)({ ...request.task, goalDir, goalId, invocationId,
				executionProfile: profile, env, signal: input.signal,
				captureOverride: async capture => {
					if (native) throw new Error("Live Investigation captured more than one Root");
					native = capture;
					if (capture.wikiSha256 !== request.wiki_sha256) throw new Error("Live Investigation Wiki differs from its historical prestate");
					if (readFileSync(join(capture.runDir, "prompt.md"), "utf8") !== prompts.userPrompt) throw new Error("Live Investigation runtime prompt differs from its pinned bundle");
					return capture.execute();
				} });
			if (!native) throw new Error("Live Investigation did not execute a fresh Root");
		} catch (error) { failure = error; }
		const traceStage = mkdtempSync(join(tmpdir(), "telomi-investigation-trace-"));
		try {
			const summary = collectInvestigationUsage({ runDir, goalDir, investigationId,
				rootUsage: native?.metrics?.usage, rootToolCalls: native?.metrics?.toolCalls });
			writeJson(join(output, "runtime/usage-summary.json"), summary);
			retainMainAgentReplayEvidence({ workspaceDirectory, goalId, recordDirectory: input.recordDirectory, evidenceDirectoryName: "investigation-evidence" });
			const evidence = join(draft.caseDirectory, "investigation-evidence");
			renameSync(join(input.recordDirectory, "investigation-evidence"), evidence);
			writeJson(join(output, "runtime/execution.json"), { boundary: "live-investigation", execution_profile: profile,
				...request, evidence_ref: relative(input.recordDirectory, evidence), evidence_manifest_sha256: sha256(readFileSync(join(evidence, "manifest.json"))),
				usage_scope: summary.scope, usage_complete: summary.complete,
				...(failure ? { error: toErrorMessage(failure) } : {}) });
			if (result) {
				writeJson(join(output, "result.json"), result);
				copyFileSync(join(runDir, "citations.json"), join(output, "citations.json"));
			}
			const trace = join(runDir, "trace.jsonl"), stagedTrace = join(traceStage, "trace.jsonl");
			if (result && !existsSync(trace)) throw new Error("Live Investigation succeeded without its Root trace");
			if (existsSync(trace)) copyFileSync(trace, stagedTrace);
			const artifact = result ? input.artifactStore.publishDirectory(output, outputPath) : undefined;
			const stageResult: ValidatedStageArtifact<unknown> | undefined = artifact ? { value: result, artifact,
				submissionCount: 1, validationErrors: [], session: { id: investigationId, mode: "fresh" }, turns: summary.usage.calls,
				toolCalls: summary.toolCalls, toolCounts: {}, usage: summary.usage,
				sessionPath: stagedTrace } : undefined;
			const captured = finishNodeEvaluationCase(draft, { status: failure ? input.signal.aborted ? "cancelled" : "failed" : "succeeded",
				workDirectory: output, result: stageResult, validationErrors: [], traceDirectories: [evidence],
				...(existsSync(stagedTrace) ? { sessionPath: stagedTrace } : {}),
				...(existsSync(join(runDir, "runtime/pi-effective-system-prompt.md")) ? { composedSystemPrompt: readFileSync(join(runDir, "runtime/pi-effective-system-prompt.md"), "utf8") } : {}),
				...(failure ? { error: toErrorMessage(failure) } : {}), durationMs: Date.now() - started });
			if (captured.status !== "captured") throw new Error(captured.reason);
			if (failure) throw failure;
			rmSync(workspaceDirectory, { recursive: true, force: true });
			return { caseId: input.value.caseId, agentId: input.value.agentId, artifact: artifact!, usage: summary.usage,
				turns: summary.usage.calls, toolCalls: summary.toolCalls };
		} catch (error) {
			if (failure && error !== failure) throw new AggregateError([failure, error], `${toErrorMessage(failure)}; evidence retention: ${toErrorMessage(error)}`);
			throw error;
		} finally { rmSync(traceStage, { recursive: true, force: true }); }
	} };
}

export const liveInvestigationReplayRecipe = createLiveInvestigationReplayRecipe();

/** Only a first investigation after read-only Main operations has the turn-start prestate. */
export function historicalInvestigationAssignment(messages: unknown[], toolCallId: string) {
	for (const raw of messages) {
		const row = raw as { message?: unknown };
		const message = (row.message ?? row) as { content?: Array<{ type?: string; id?: string; name?: string; arguments?: Record<string, unknown> }> };
		for (const call of message.content ?? []) {
			if (call.type !== "toolCall") continue;
			if (call.id === toolCallId && call.name === "investigate" && call.arguments) return call.arguments;
			const command = call.arguments?.command;
			const dateOnly = call.name === "bash" && typeof command === "string" && !/[`$;|&<>\\\r\n]/u.test(command)
				&& /^date(?:\s+(?:'\+[^']*'|"\+[^"]*"|\+[^\s]+))?$/u.test(command.trim());
			if (!["read", "search_user_memory"].includes(call.name ?? "") && !dateOnly) {
				throw new Error("Main turn-start prestate cannot replay an investigation after a state-changing or unclassified tool");
			}
		}
	}
	throw new Error("Historical Main trace has no matching investigate tool call");
}

/** Offline derivation only: normal Bundle export/import handles the resulting immutable Case. */
export async function deriveLiveInvestigationCase(input: {
	parentCasePath: string; parentSourceRunDirectory: string; investigationCasePath: string; investigationRunDirectory: string;
	toolCallId: string; recordDirectory: string; env?: NodeJS.ProcessEnv; capabilitySnapshotId?: string;
	restoreInputTree?: (treeSha: string, destination: string) => Promise<void>;
}) {
	const parent = readNodeEvaluationCase(input.parentCasePath, input.parentSourceRunDirectory);
	const observed = readNodeEvaluationCase(input.investigationCasePath, input.investigationRunDirectory);
	if (parent.agentId !== "main-agent" || observed.agentId !== "prime-investigation" || !parent.workspace?.input_tree_sha
		|| !parent.observed.trace || !observed.observed.output?.directory) throw new Error("Live derivation requires complete historical Main and Investigation Cases");
	const traceRoot = parent.observed.trace.root === "case" ? dirname(input.parentCasePath) : input.parentSourceRunDirectory;
	const trace = join(traceRoot, parent.observed.trace.ref);
	const assigned = historicalInvestigationAssignment(readFileSync(trace, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line)), input.toolCallId);
	const native = JSON.parse(readFileSync(join(input.investigationRunDirectory, "request.json"), "utf8"));
	const expectedId = sha256(`${native.goalId}\0${input.toolCallId}`).slice(0, 24);
	if (native.id !== expectedId || native.id !== basename(input.investigationRunDirectory)
		|| native.question !== (assigned.question as string)?.trim() || native.context !== ((assigned.context as string | undefined)?.trim() ?? "")
		|| native.threadId !== assigned.thread_id || native.title !== assigned.title || native.allowExternal !== (assigned.source_scope === "external_allowed")) {
		throw new Error("Historical investigate assignment differs from its native request");
	}
	const frozenInput = join(input.recordDirectory, "live-input"); mkdirSync(frozenInput, { recursive: true });
	const goal = join(frozenInput, "goal");
	const bundled = join(input.parentSourceRunDirectory, "workspace/input");
	if (existsSync(bundled)) cpSync(bundled, goal, { recursive: true });
	else if (input.restoreInputTree) await input.restoreInputTree(parent.workspace.input_tree_sha, goal);
	else throw new Error("Historical Main prestate bytes are unavailable");
	if (existsSync(join(goal, "artifacts/investigations", native.id, "result.json"))) throw new Error("Historical prestate contains the target investigation output");
	if (native.threadId && !existsSync(join(goal, "artifacts/investigation-threads", native.threadId, "thread.json"))) throw new Error("Historical prestate lacks its continued thread");
	const wikiHash = hashWikiDirectory(join(input.investigationRunDirectory, "input/wiki"));
	const capturedRequest = JSON.parse(readFileSync(join(dirname(input.investigationCasePath), "input/request.json"), "utf8"));
	if (capturedRequest.wiki_sha256 !== wikiHash || capturedRequest.question !== native.question
		|| capturedRequest.allow_external !== native.allowExternal) throw new Error("Native investigation inputs differ from their immutable Case");
	if (hashWikiDirectory(join(goal, "wiki/knowledge")) !== wikiHash) throw new Error("Main prestate Wiki differs from the investigation start");
	for (const file of ["history/topic-plan.jsonl", "work/topic-plan.json"]) {
		const source = join(dirname(input.parentCasePath), "input", file);
		if (existsSync(source)) { mkdirSync(dirname(join(frozenInput, file)), { recursive: true }); copyFileSync(source, join(frozenInput, file)); }
	}
	const body: Omit<LiveInvestigationRequest, "business_input_sha256"> = { schema_version: 2,
		source: { goal_id: native.goalId, main_case_ref: { sourceRunId: parent.runId, caseId: parent.caseId }, tool_call_id: input.toolCallId, investigation_id: native.id },
		task: { question: native.question, ...(assigned.context === undefined ? {} : { context: assigned.context as string }),
			...(native.threadId ? { threadId: native.threadId } : {}), ...(native.title ? { title: native.title } : {}),
			allowExternal: native.allowExternal, outputLanguage: native.language },
		...freezeInvestigationModels(input.env), goal_sha256: new RunArtifactStore(frozenInput).describeDirectory("goal").sha256, wiki_sha256: wikiHash };
	writeJson(join(frozenInput, "request.json"), { ...body, business_input_sha256: liveInvestigationBusinessHash(body) });
	const request = readLiveInvestigationRequest(frozenInput);
	const draft = beginCapture({ request, recordDirectory: input.recordDirectory, sourceRunId: `derived-investigation-${sha256(request.business_input_sha256).slice(0, 24)}`,
		profile: "prime_ipython", capabilitySnapshotId: input.capabilitySnapshotId });
	const sourceOutput = join(dirname(input.investigationCasePath), observed.observed.output.ref);
	const output = join(input.recordDirectory, "live-output"); mkdirSync(join(output, "runtime"), { recursive: true });
	for (const file of ["result.json", "citations.json"]) copyFileSync(join(sourceOutput, file), join(output, file));
	validateInvestigationResult(JSON.parse(readFileSync(join(output, "result.json"), "utf8")), native.id, native.question);
	writeJson(join(output, "runtime/execution.json"), { ...request, boundary: "live-investigation", execution_profile: "prime_ipython", usage_scope: "historical-root-only" });
	const metrics = observed.observed.metrics;
	if (!metrics) throw new Error("Historical Investigation Case lacks observed metrics");
	const artifact = new RunArtifactStore(input.recordDirectory).publishDirectory(output, outputPath);
	const sourceTrace = observed.observed.trace;
	const traceStage = mkdtempSync(join(tmpdir(), "telomi-derived-investigation-trace-"));
	try {
		const sessionPath = join(traceStage, "trace.jsonl");
		if (!sourceTrace) throw new Error("Historical Investigation Case lacks its native trace");
		copyFileSync(join(sourceTrace.root === "case" ? dirname(input.investigationCasePath) : input.investigationRunDirectory, sourceTrace.ref), sessionPath);
		const capture = finishNodeEvaluationCase(draft, { status: "succeeded", workDirectory: output, validationErrors: [],
			result: { value: {}, artifact, submissionCount: 1, validationErrors: [], session: { id: native.id, mode: "fresh" },
				usage: { inputTokens: metrics.inputTokens, outputTokens: metrics.outputTokens, costUsd: metrics.costUsd, calls: metrics.calls },
				turns: metrics.turns, toolCalls: metrics.toolCalls, toolCounts: {}, sessionPath }, durationMs: observed.observed.durationMs });
		if (capture.status !== "captured") throw new Error(capture.reason);
		return { casePath: capture.casePath, caseRef: { sourceRunId: draft.base.runId, caseId: capture.caseId },
			value: readNodeEvaluationCase(capture.casePath, input.recordDirectory), sourceRunDirectory: input.recordDirectory };
	} finally { rmSync(traceStage, { recursive: true, force: true }); }
}
