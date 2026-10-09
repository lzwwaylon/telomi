import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { RunArtifactStore } from "../../server/agent-runtime/artifact-store.js";
import { beginNodeEvaluationCase, finishNodeEvaluationCase, findNodeEvaluationCases, readNodeEvaluationCase, type NodeReplayRecipe } from "../../server/agent-runtime/node-evaluation.js";
import type { AgentStageRequest } from "../../server/agent-runtime/agent-stage-runtime.js";
import { withInvestigationNodeCapture } from "../../server/evaluation/investigation-replay.js";
import { createLiveInvestigationReplayRecipe, deriveLiveInvestigationCase, historicalInvestigationAssignment } from "../../server/evaluation/investigation-live-replay.js";
import { liveInvestigationProfile, liveInvestigationPrompts, readLiveInvestigationRequest } from "../../server/evaluation/investigation-live-contract.js";
import { createCaseBundle, importCaseBundle } from "../../server/evaluation/case-bundle.js";
import { renderCapturedCandidatePrompts } from "../../server/evaluation/candidate-prompts.js";
import { installCaseCapture } from "../../server/observability/case-capture.js";
import { serverRuntimeDirForGoalDir } from "../../server/workspaces/server-runtime-paths.js";
import { sha256 } from "../../server/lib/hash.js";
import { executeInvestigation } from "../../server/research/investigate.js";
import { runPiInvestigation } from "../../server/research/pi-investigation.js";
import { liveInvestigationTraceRefs } from "../../server/evaluation/node-backtest.js";

const root = mkdtempSync(join(tmpdir(), "live-investigation-"));
const put = (path: string, value: unknown) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value)); };
const savedProfile = process.env.TELOMI_INVESTIGATION_REPLAY_PROFILE;
const savedEval = process.env.TELOMI_EVAL_INSTANCE;
try {
	assert.equal(liveInvestigationProfile({}), "prime_ipython");
	assert.equal(liveInvestigationProfile({ TELOMI_EVAL_INSTANCE: "1" }), "prime_ipython");
	assert.throws(() => liveInvestigationProfile({ TELOMI_INVESTIGATION_REPLAY_PROFILE: "typo" }), /Invalid/u);
	assert.throws(() => liveInvestigationProfile({ TELOMI_INVESTIGATION_REPLAY_PROFILE: "pi_builtin" }), /TELOMI_EVAL_INSTANCE=1/u);
	assert.equal(liveInvestigationProfile({ TELOMI_EVAL_INSTANCE: "1", TELOMI_INVESTIGATION_REPLAY_PROFILE: "pi_builtin" }), "pi_builtin");
	const untouched = join(root, "production-pi-rejected");
	await assert.rejects(executeInvestigation({ goalDir: untouched, goalId: "fixture", invocationId: "fixture", question: "Read the original evidence",
		executionProfile: "pi_builtin", env: { TELOMI_EVAL_INSTANCE: "0" } }), /only in an evaluation instance/u);
	await assert.rejects(runPiInvestigation({ cwd: untouched, runtimeRoot: join(untouched, "runtime"), sessionDir: join(untouched, "session"),
		provider: "fixture", model: "root", thinking: "off", prompt: "Read original evidence", bridge: { baseUrl: "http://127.0.0.1:1", token: "fixture" },
		env: {}, signal: new AbortController().signal, tracePath: join(untouched, "trace.jsonl"), conditionsPath: join(untouched, "conditions.jsonl") }), /only in an evaluation instance/u);
	assert.equal(existsSync(untouched), false, "evaluation-only Pi rejects before writing or creating a Session");
	process.env.TELOMI_EVAL_INSTANCE = "1";
	const goalId = "historical-goal", callId = "call-investigation", question = "Compare the documented methods and their evidence.";
	const investigationId = sha256(`${goalId}\0${callId}`).slice(0, 24);
	const assigned = { question, context: "Detailed original technical brief", title: "Methods", source_scope: "external_allowed" };
	const messages = [{ role: "assistant", content: [{ type: "toolCall", id: "date", name: "bash", arguments: { command: "date '+%Y-%m-%d'" } }] },
		{ role: "assistant", content: [{ type: "toolCall", id: callId, name: "investigate", arguments: assigned }] }];
	assert.deepEqual(historicalInvestigationAssignment(messages, callId), assigned);
	assert.throws(() => historicalInvestigationAssignment([{ content: [{ type: "toolCall", name: "write" }] }, ...messages], callId), /prestate/u);
	assert.throws(() => historicalInvestigationAssignment([{ content: [{ type: "toolCall", name: "bash", arguments: { command: "date; rm evidence" } }] }, ...messages], callId), /prestate/u);
	assert.throws(() => historicalInvestigationAssignment([...messages, { content: [{ type: "toolCall", id: "second", name: "investigate", arguments: assigned }] }], "second"), /prestate/u);
	const parentRoot = join(root, "main-run");
	put(join(parentRoot, "workspace/input/wiki/runs/source/source.md"), "BEFORE");
	put(join(parentRoot, "workspace/output/wiki/runs/source/source.md"), "AFTER: forbidden answer leakage");
	mkdirSync(join(parentRoot, "input"));
	const parentStore = new RunArtifactStore(parentRoot);
	const stage: AgentStageRequest<unknown> = {
		runId: "historical-main", stageId: "main-agent", attemptId: "1", role: "main-agent", recordKind: "main",
		promptConfig: { domain: "main", id: "main-agent", sandboxRole: "main.main_agent" } as never,
		evaluation: { agentId: "main-agent", recipe: { id: "main-agent", version: 1 }, recipeInput: {}, inputRelativePath: "input", harnessMounts: [], liveExternalState: false },
		session: { key: "main", policy: "fresh" }, modelPolicy: { preferred: ["fixture/root"] }, systemPrompt: "Main", userPrompt: "Original user request",
		workDirectory: parentRoot, readonlyMounts: [], controlDirectory: parentRoot, recordDirectory: parentRoot, artifactStore: parentStore,
		output: { kind: "json_candidate", publishRelativePath: "result.json", validate: () => ({}) }, signal: new AbortController().signal,
	};
	const parentDraft = beginNodeEvaluationCase({ request: stage, recordDirectory: parentRoot, promptConfig: stage.promptConfig!,
		sessionContextFile: join(root, "missing"), composedSystemPrompt: "Main", actualModel: "fixture/root" })!;
	put(join(parentRoot, "main-agent.jsonl"), messages.map(value => JSON.stringify(value)).join("\n"));
	const parentCapture = finishNodeEvaluationCase(parentDraft, { status: "succeeded", workDirectory: parentRoot, validationErrors: [],
		sessionPath: join(parentRoot, "main-agent.jsonl"), workspace: { input_tree_sha: sha256("prestate"), output_tree_sha: sha256("poststate"), exclude: [] } });
	assert.equal(parentCapture.status, "captured");
	const native = join(root, "investigations", investigationId);
	put(join(native, "request.json"), { goalId, id: investigationId, question, context: assigned.context, title: assigned.title, allowExternal: true, language: "en" });
	put(join(native, "prompt.md"), liveInvestigationPrompts("prime_ipython").userPrompt);
	mkdirSync(join(native, "input/wiki"), { recursive: true });
	const usage = { inputTokens: 10, outputTokens: 2, costUsd: 0.1, calls: 1 };
	const historical = { id: investigationId, question, answer: "Historical answer", citation_refs: [], gaps: [], wiki_sha256: sha256("") };
	await withInvestigationNodeCapture({ goalDir: join(root, goalId), goalId, runDir: native, question, context: assigned.context,
		language: "en", allowExternal: true, model: "fixture/root", thinking: "off", wikiSha256: sha256(""), metrics: { usage, toolCalls: 1 },
		execute: async () => { put(join(native, "trace.jsonl"), `${JSON.stringify({ type: "message", message: { role: "assistant", usage: { input: 10, output: 2, cost: { total: 0.1 } } } })}\n`);
			put(join(native, "citations.json"), { schema_version: 1, citations: [] }); return historical; } });
	const nativeCase = findNodeEvaluationCases(native, "prime-investigation")[0]!;
	const env = { TELOMI_PRIME_AGENT_ROOT_MODEL: "fixture/root", TELOMI_PRIME_AGENT_CHILD_MODEL: "fixture/child", TELOMI_NOTE_AGENT_MODEL: "fixture/reader",
		TELOMI_PRIME_SEARCH_THINKING_LEVEL: "off", TELOMI_PRIME_REPORT_THINKING_LEVEL: "low", TELOMI_NOTE_AGENT_THINKING_LEVEL: "off" };
	const derived = await deriveLiveInvestigationCase({ parentCasePath: parentDraft.manifestPath, parentSourceRunDirectory: parentRoot,
		investigationCasePath: nativeCase.path, investigationRunDirectory: native, toolCallId: callId, recordDirectory: join(root, "derived"), env });
	const frozen = readLiveInvestigationRequest(join(dirname(derived.casePath), "input"));
	assert.equal(frozen.task.question, question);
	assert.equal(frozen.task.threadId, undefined, "a newly created historical thread is not a continuation request");
	assert.equal(frozen.model_env.TELOMI_PRIME_REPORT_THINKING_LEVEL, "low");
	assert.equal(readFileSync(join(dirname(derived.casePath), "input/goal/wiki/runs/source/source.md"), "utf8"), "BEFORE");
	assert.equal(derived.value.recipe.version, 2);
	assert.equal(derived.value.liveExternalState, true);
	let calls = 0, oldCaptures = 0, failNext = false;
	const uninstall = installCaseCapture({ investigation: async input => { oldCaptures++; return input.execute(); } });
	const execute: typeof executeInvestigation = async input => {
		calls++;
		assert.equal(input.question, question); assert.equal(input.context, assigned.context);
		assert.equal(input.env!.TELOMI_NOTE_AGENT_MODEL, "fixture/reader");
		assert.equal(readFileSync(join(input.goalDir, "wiki/runs/source/source.md"), "utf8"), "BEFORE");
		assert.equal(existsSync(join(input.goalDir, "artifacts/new-answer.json")), false);
		assert.equal(existsSync(join(input.goalDir, "request.json")), false, "Replay preparation does not overlay unrelated harness files");
		const id = sha256(`${input.goalId}\0${input.invocationId}`).slice(0, 24);
		const runDir = join(serverRuntimeDirForGoalDir(input.goalDir), "research/investigations", id);
		put(join(runDir, "prompt.md"), liveInvestigationPrompts(input.executionProfile).userPrompt);
		return input.captureOverride!({ goalDir: input.goalDir, goalId: input.goalId, runDir, question,
			wikiSha256: sha256(""), model: "fixture/root", thinking: "off", metrics: { usage, toolCalls: 2 }, execute: async () => {
				put(join(input.goalDir, "artifacts/new-answer.json"), { generated: calls });
				put(join(runDir, "trace.jsonl"), `${JSON.stringify({ type: "message", message: { role: "assistant", usage: { input: 10, output: 2, cost: { total: 0.1 } } } })}\n`);
				put(join(runDir, "citations.json"), { schema_version: 1, citations: [] });
				if (failNext) throw new Error("Fixture native execution failed after spending tokens");
				const result = { ...historical, id, answer: `New autonomous answer ${calls}` };
				put(join(runDir, "result.json"), result); return result;
			} });
	};
	const recipe = createLiveInvestigationReplayRecipe({ execute });
	const harness = join(root, "capability"); mkdirSync(harness);
	put(join(harness, "request.json"), "Unrelated capability file");
	const run = async (casePath: string, sourceRunDirectory: string, profile: "prime_ipython" | "pi_builtin", label: string) => {
		process.env.TELOMI_INVESTIGATION_REPLAY_PROFILE = profile;
		const value = readNodeEvaluationCase(casePath, sourceRunDirectory);
		const prompts = renderCapturedCandidatePrompts(value, sourceRunDirectory);
		assert(!prompts.userPrompt.includes("replay-plan")); assert(!prompts.userPrompt.includes("Frozen coordination"));
		const recordDirectory = join(root, label, "executions", "candidate_1");
		const args: Parameters<NodeReplayRecipe["replay"]>[0] = { casePath, value, sourceRunDirectory, harnessWorkspaceDirectory: harness,
			recordDirectory, workDirectory: join(recordDirectory, "work"), artifactStore: new RunArtifactStore(recordDirectory),
			runner: { runStage: async () => { throw new Error("No Main or frozen stage should run"); } },
			candidateCase: { sourceRunId: label, capabilitySnapshotId: `caps_${"a".repeat(64)}` }, promptMode: "candidate", promptOverride: prompts,
			signal: new AbortController().signal };
		if (failNext) {
			await assert.rejects(recipe.replay(args), /failed after spending tokens/u);
			const cases = findNodeEvaluationCases(recordDirectory, "prime-investigation");
			assert.equal(cases.length, 1); assert.equal(cases[0]!.value.status, "failed");
			assert.equal(cases[0]!.value.observed.output, undefined);
			assert(existsSync(join(dirname(cases[0]!.path), "investigation-evidence/manifest.json")));
			assert.deepEqual(JSON.parse(readFileSync(join(recordDirectory, "live-output/runtime/usage-summary.json"), "utf8")).usage, usage);
			return { recordDirectory, capture: cases[0]! };
		}
		const result = await recipe.replay(args);
		const cases = findNodeEvaluationCases(recordDirectory, "prime-investigation");
		assert.equal(cases.length, 1, "only the v2 Root is captured"); assert.equal(cases[0]!.value.recipe.version, 2);
		assert.equal(JSON.parse(readFileSync(join(result.artifact.absolutePath, "result.json"), "utf8")).answer, `New autonomous answer ${calls}`);
		const execution = JSON.parse(readFileSync(join(result.artifact.absolutePath, "runtime/execution.json"), "utf8"));
		assert.equal(execution.execution_profile, profile); assert.equal(execution.business_input_sha256, frozen.business_input_sha256);
		assert.equal(execution.usage_scope, "live-investigation");
		assert.deepEqual(result.usage, JSON.parse(readFileSync(join(result.artifact.absolutePath, "runtime/usage-summary.json"), "utf8")).usage);
		const refs = liveInvestigationTraceRefs(join(root, label), { id: "candidate_1" });
		assert(refs.agentTrace?.endsWith("agent-trace.jsonl"));
		assert(Object.keys(refs).some(key => key.startsWith("investigationDescendantEvidence")));
		return { recordDirectory, capture: cases[0]! };
	};
	try {
		const prime = await run(derived.casePath, derived.sourceRunDirectory, "prime_ipython", "prime");
		const bundle = await createCaseBundle({ dataDir: root, goalId, goalTitle: "Methods", casePath: prime.capture.path, value: prime.capture.value,
			runtimeBuild: "fixture", agentBundleSha256: sha256("fixture"), capabilitySnapshotId: `caps_${"a".repeat(64)}`, capabilityContentDirectory: harness,
			restoreTree: async () => { throw new Error("The live Case must be self-contained"); } });
		try {
			const importedData = join(root, "imported"); mkdirSync(importedData);
			const imported = importCaseBundle({ path: bundle.path, dataDir: importedData, ensureGoal: () => {}, capabilityContentHash: (_directory, expected) => expected });
			const source = join(importedData, ".pi/runtime/harness", goalId, "evaluation/imported-cases", imported.bundleSha256);
			const casePath = join(source, "node-evaluation/cases", imported.caseRef.caseId, "manifest.json");
			assert.equal(readFileSync(join(dirname(casePath), "input/request.json"), "utf8"), readFileSync(join(dirname(derived.casePath), "input/request.json"), "utf8"));
			assert(existsSync(join(dirname(casePath), "investigation-evidence/manifest.json")), "fresh Prime export includes descendant evidence");
			await run(casePath, source, "pi_builtin", "pi");
			assert.equal(calls, 2); assert.equal(oldCaptures, 0);
			failNext = true;
			await run(casePath, source, "pi_builtin", "failed");
		} finally { bundle.cleanup(); }
	} finally { uninstall(); }
	console.log("Investigation v2 derives historical assignments and replays fresh Prime/Pi without input leakage or frozen tools");
} finally {
	if (savedProfile === undefined) delete process.env.TELOMI_INVESTIGATION_REPLAY_PROFILE;
	else process.env.TELOMI_INVESTIGATION_REPLAY_PROFILE = savedProfile;
	if (savedEval === undefined) delete process.env.TELOMI_EVAL_INSTANCE;
	else process.env.TELOMI_EVAL_INSTANCE = savedEval;
	rmSync(root, { recursive: true, force: true });
}
