import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { RunArtifactStore } from "../../server/agent-runtime/artifact-store.js";
import { finalizeStageOutput, type AgentStageRequest, type AgentStageRunner } from "../../server/agent-runtime/agent-stage-runtime.js";
import { primeKernelPython } from "../../server/agent-runtime/prime-agent-paths.js";
import { bundledAgentSkillPaths, materializeSkills, snapshotSkills } from "../../server/agent-runtime/skill-registry.js";
import { beginNodeEvaluationCase, finishNodeEvaluationCase, readNodeEvaluationCase } from "../../server/agent-runtime/node-evaluation.js";
import { createRecordedStageReplayRecipes, withResearchNodeEvaluationCapture } from "../../server/agent-runtime/recorded-stage-replay.js";
import { hashDirectory, sha256 } from "../../server/lib/hash.js";
import { runtimeControlRoot, serverRuntimeDirForGoal } from "../../server/workspaces/server-runtime-paths.js";
import { runtimeContextPath } from "../../server/observability/run-records.js";
import { NodeBacktestService } from "../../server/evaluation/node-backtest.js";
import { validateInvestigationAnswerFromInput, type InvestigationAnswer } from "../../server/research/investigation-answer.js";
import { runPrimeAnswerStage } from "../../server/research/pipeline/prime-answer-writer.js";

const root = mkdtempSync(join(tmpdir(), "telomi-answer-writer-"));
const workspaceDir = join(root, "data");
const goalId = "goal_answer_fixture";
const harness = join(workspaceDir, goalId);
const inputs = join(harness, "answer-inputs");
const record = join(serverRuntimeDirForGoal(goalId, workspaceDir), "research", "investigations", "parent-investigation");
for (const path of [inputs, record]) mkdirSync(path, { recursive: true });
const requestInput = { schema_version: 1, question: "How is the value computed?", context: "", language: "en",
	requirements: [{ id: "Q1", question: "Explain the assignment chain." }], evidence_refs: ["C1"] };
writeFileSync(join(inputs, "request.json"), JSON.stringify(requestInput));
mkdirSync(join(inputs, "evidence"));
writeFileSync(join(inputs, "evidence", "C1.json"), JSON.stringify({ note: "value = input + 1" }));
mkdirSync(join(inputs, "sources", "S1"), { recursive: true });
writeFileSync(join(inputs, "sources", "S1", "implementation.py"), "value = input + 1\n");
const answer: InvestigationAnswer = { answer: "The input is incremented. <cite>C1</cite>", citation_refs: ["C1"], gaps: [],
	coverage: [{ requirement_id: "Q1", citation_refs: ["C1"], gap: "" }] };
const env: NodeJS.ProcessEnv = { TELOMI_DATA_DIR: workspaceDir,
	PRIME_AGENT_KERNEL_PYTHON: join(root, "fixture-python"), TELOMI_PRIME_AGENT_MODULE_PATH: join(root, "fixture-prime.mjs") };
writeFileSync(env.TELOMI_PRIME_AGENT_MODULE_PATH!, "// Native call is injected; no model or Worker is started.\n");

// Seed the existing Python Skill cache, so the deterministic native-call seam never installs dependencies.
const writingSkill = bundledAgentSkillPaths("research", "report-writer").find((path) => basename(path) === "writing-skill");
assert.ok(writingSkill);
const [stagedSkill] = [...materializeSkills(snapshotSkills([writingSkill]), join(root, "seed-skills")).values()];
assert.ok(stagedSkill);
const environmentHash = sha256(JSON.stringify({ schemaVersion: 1, python: primeKernelPython(env), skill: hashDirectory(stagedSkill) }));
const pythonCache = join(runtimeControlRoot(env.TELOMI_DATA_DIR), "skill-envs", environmentHash);
mkdirSync(join(pythonCache, "site-packages"), { recursive: true });
writeFileSync(join(pythonCache, "requirements.lock"), "");
writeFileSync(join(pythonCache, "ready.json"), JSON.stringify({ environmentHash, lockSha256: sha256("") }));

function stageRequest(workName: string): AgentStageRequest<InvestigationAnswer> {
	return {
		runId: "investigation-fixture-answer-1", stageId: "writer-answer", attemptId: "attempt-1", role: "report_writer",
		promptConfig: { domain: "research", id: "report-writer", sandboxRole: "report.report_writer", userVariant: "answer" },
		session: { key: "answer/fixture", policy: "fresh" }, modelPolicy: { preferred: ["openai-codex/gpt-5.4-mini"], reasoning: "off" },
		systemPrompt: "Use the frozen evidence and return the complete assignment chain.", userPrompt: "Read inputs/request.json.",
		workDirectory: join(root, workName), readonlyMounts: [{ hostPath: inputs, guestPath: "/inputs", access: "read-only" }],
		controlDirectory: record, recordDirectory: record, artifactStore: new RunArtifactStore(record),
		output: { kind: "json_candidate", entryRelativePath: "work/answer.json", publishRelativePath: `artifacts/${workName}.json`,
			validate: ({ entryPath }) => validateInvestigationAnswerFromInput(JSON.parse(readFileSync(entryPath, "utf-8")), inputs) },
		signal: new AbortController().signal,
	};
}
const usage = { inputTokens: 1, outputTokens: 2, costUsd: 0, calls: 1 };
const nativeResult = { usage, toolCalls: 1, agentStages: 1 };

try {
	const successful = stageRequest("success");
	const result = await runPrimeAnswerStage(successful, "success-execution", { env, execute: async (args) => {
		assert.equal(args.rlmMaxDepth, 0);
		assert.deepEqual(args.scopedModels, []);
		assert.deepEqual(args.tools, ["ipython"]);
		assert.equal(args.launchKind, "standalone_answer_writer");
		assert.equal(args.systemPrompt, successful.systemPrompt);
		assert.equal(args.prompt, successful.userPrompt);
		assert.equal(`${args.provider}/${args.model}`, successful.modelPolicy.preferred[0]);
		assert.deepEqual(args.skills.map((path) => basename(path)), ["writing-skill"]);
		assert.ok(args.readonlyRoots?.includes(join(args.cwd, "inputs")));
		assert.equal(readFileSync(join(args.cwd, "inputs", "sources", "S1", "implementation.py"), "utf-8"), "value = input + 1\n");
		assert.equal(args.extraEnv.RLM_MAX_DEPTH, "0");
		mkdirSync(args.sessionDir, { recursive: true });
		writeFileSync(join(args.sessionDir, "native.jsonl"), `${JSON.stringify({ type: "message", message: { role: "user", content: args.prompt } })}\n`);
		writeFileSync(args.conditionsPath, `${JSON.stringify({ system_prompt: { append: args.systemPrompt }, rlm_max_depth: args.rlmMaxDepth })}\n`);
		writeFileSync(join(dirname(args.sessionDir), "sdk-input.json"), '{"private":"fixture"}\n');
		writeFileSync(join(dirname(args.sessionDir), "sdk-events.jsonl"), '{}\n');
		writeFileSync(join(args.cwd, "work", "answer.json"), JSON.stringify(answer));
		return nativeResult;
	} });
	assert.deepEqual(result.value, answer);
	assert.deepEqual(JSON.parse(readFileSync(result.artifact.absolutePath, "utf-8")), answer);
	assert.equal(result.session.mode, "fresh");
	assert.ok(result.sessionPath);
	assert.match(readFileSync(result.sessionPath, "utf-8"), /Read inputs\/request.json/u);
	assert.deepEqual(JSON.parse(readFileSync(`${result.sessionPath}.sessions.json`, "utf-8")).sessions,
		[{ path: basename(result.sessionPath), label: "Answer Writer" }]);

	const stale = stageRequest("stale");
	mkdirSync(join(stale.workDirectory, "agent", "work"), { recursive: true });
	writeFileSync(join(stale.workDirectory, "agent", "work", "answer.json"), JSON.stringify(answer));
	await assert.rejects(runPrimeAnswerStage(stale, "stale-execution", { env, execute: async () => nativeResult }), /bounded regular/u);
	assert.equal(existsSync(join(record, "artifacts", "stale.json")), false, "a failed attempt cannot publish an older answer");
	await assert.rejects(runPrimeAnswerStage(stageRequest("model-error"), "model-error-execution", { env,
		execute: async () => ({ ...nativeResult, rootError: "model balance exhausted" }) }), /model balance exhausted/u);
	const archiveError = stageRequest("archive-error");
	archiveError.recordDirectory = join(root, "archive-error-record");
	mkdirSync(archiveError.recordDirectory, { recursive: true });
	writeFileSync(join(archiveError.recordDirectory, "answer-writer-traces"), "not a directory\n");
	await assert.rejects(runPrimeAnswerStage(archiveError, "archive-error-execution", { env, execute: async (args) => {
		mkdirSync(args.sessionDir, { recursive: true });
		writeFileSync(join(args.sessionDir, "native.jsonl"), "{}\n");
		return { ...nativeResult, rootError: "model balance exhausted" };
	} }), /model balance exhausted/u, "trace archival must not hide the original model error");
	const failedRecord = JSON.parse(readFileSync(runtimeContextPath(archiveError.recordDirectory, "research"), "utf-8").trim().split("\n").at(-1)!);
	assert.equal(failedRecord.status, "failed");
	assert.equal(failedRecord.output.error, "model balance exhausted");
	assert.ok(failedRecord.output.trace_archive_error);
	const escape = stageRequest("escape");
	const external = join(root, "outside-answer.json");
	writeFileSync(external, JSON.stringify(answer));
	await assert.rejects(runPrimeAnswerStage(escape, "escape-execution", { env, execute: async (args) => {
		symlinkSync(external, join(args.cwd, "work", "answer.json"));
		return nativeResult;
	} }), /bounded regular/u);
	writeFileSync(join(inputs, "answer.json"), JSON.stringify(answer));
	await assert.rejects(runPrimeAnswerStage(stageRequest("work-link"), "work-link-execution", { env, execute: async (args) => {
		rmSync(join(args.cwd, "work"), { recursive: true, force: true });
		symlinkSync(join(args.cwd, "inputs"), join(args.cwd, "work"));
		return nativeResult;
	} }), /bounded regular/u, "an input file reached through a linked work directory is not Writer output");

	// Capture must freeze /inputs even within the Goal harness. Replay sees its original bytes and strict validator.
	const captureRequest = stageRequest("capture");
	const captureState: { request?: AgentStageRequest<InvestigationAnswer> } = {};
	const captureRunner: AgentStageRunner = { runStage: async <T>(request: AgentStageRequest<T>) => {
		captureState.request = request as unknown as AgentStageRequest<InvestigationAnswer>;
		throw new Error("capture seam");
	} };
	await assert.rejects(withResearchNodeEvaluationCapture(captureRunner, harness).runStage(captureRequest), /capture seam/u);
	assert.ok(captureState.request);
	const capturedRequest = captureState.request;
	assert.deepEqual(capturedRequest.evaluation?.recipe, { id: "report-writer", version: 2 });
	assert.deepEqual(capturedRequest.evaluation?.recipeInput, { mode: "investigation-answer" });
	assert.deepEqual(capturedRequest.evaluation?.harnessMounts, []);
	const draft = beginNodeEvaluationCase({ request: capturedRequest, recordDirectory: record,
		promptConfig: capturedRequest.promptConfig!, sessionContextFile: join(record, "missing.jsonl"),
		composedSystemPrompt: capturedRequest.systemPrompt, actualModel: capturedRequest.modelPolicy.preferred[0]! });
	assert.ok(draft);
	const answerTraceDirectory = `answer-writer-traces/${basename(result.sessionPath, ".jsonl")}`;
	const capture = finishNodeEvaluationCase(draft, { status: "succeeded", workDirectory: successful.workDirectory, result,
		validationErrors: [], traceDirectories: [join(record, answerTraceDirectory)] });
	assert.equal(capture.status, "captured");
	const value = readNodeEvaluationCase(capture.casePath, record);
	assert.equal(value.mounts.find((mount) => mount.guestPath === "/inputs")?.kind, "run");
	writeFileSync(join(inputs, "request.json"), JSON.stringify({ ...requestInput, evidence_refs: ["C2"] }));
	writeFileSync(join(inputs, "sources", "S1", "implementation.py"), "changed mutable harness bytes\n");
	let outputValue: unknown = answer;
	const replayRunner: AgentStageRunner = { runStage: async <T>(request: AgentStageRequest<T>) => {
		const frozen = request.readonlyMounts.find((mount) => mount.guestPath === "/inputs");
		assert.ok(frozen);
		assert.equal(readFileSync(join(frozen.hostPath, "sources", "S1", "implementation.py"), "utf-8"), "value = input + 1\n");
		assert.equal(request.systemPrompt, captureRequest.systemPrompt);
		assert.equal(request.userPrompt, captureRequest.userPrompt);
		mkdirSync(join(request.workDirectory, "work"), { recursive: true });
		writeFileSync(join(request.workDirectory, "work", "answer.json"), JSON.stringify(outputValue));
		const finalized = await finalizeStageOutput({ artifactStore: request.artifactStore, output: request.output, workDirectory: request.workDirectory });
		return { ...result, value: finalized.value, artifact: finalized.artifact };
	} };
	const replay = { casePath: capture.casePath, value, sourceRunDirectory: record, harnessWorkspaceDirectory: harness,
		recordDirectory: join(root, "replay-record"), workDirectory: join(root, "replay-work"),
		artifactStore: new RunArtifactStore(join(root, "replay-record")), runner: replayRunner, signal: new AbortController().signal };
	const recipe = createRecordedStageReplayRecipes(undefined, validateInvestigationAnswerFromInput).find((item) => item.identity.id === "report-writer");
	assert.ok(recipe);
	const service = new NodeBacktestService({ workspaceDir, listGoalIds: () => [goalId],
		applicationDir: fileURLToPath(new URL("../../", import.meta.url)), recipes: [recipe], runner: replayRunner });
	const listed = service.listCases(goalId, "report-writer");
	assert.equal(listed.length, 1, "Operations discovers Writer Cases in the parent investigation record root");
	const caseRef = listed[0]!.ref;
	assert.equal(caseRef.sourceRunId, captureRequest.runId);
	assert.notEqual(caseRef.sourceRunId, basename(record), "the Writer invocation identity differs from its parent record directory");
	assert.equal(service.readCase(goalId, caseRef).caseId, capture.caseId,
		"Operations resolves the independent Writer invocation via the captured manifest runId");
	assert.equal(service.caseRoots(goalId, caseRef).sourceRunDirectory, record);
	assert.equal(readFileSync(service.caseInputFile(goalId, caseRef, "sources/S1/implementation.py"), "utf-8"), "value = input + 1\n");
	const caseFiles = service.listCaseFiles(goalId, caseRef);
	assert.ok(caseFiles.some((file) => file.ref === "input:request.json"),
		"the Operations Case file allowlist exposes the frozen Writer request");
	const conditionsRef = `run:${answerTraceDirectory}/execution-conditions.jsonl`;
	assert.equal(caseFiles.find((file) => file.ref === conditionsRef)?.kind, "execution_conditions");
	assert.equal(JSON.parse(readFileSync(service.caseFile(goalId, caseRef, conditionsRef), "utf-8")).system_prompt.append, successful.systemPrompt);
	const nativeRef = `run:${answerTraceDirectory}/session/native.jsonl`;
	assert.equal(caseFiles.find((file) => file.ref === nativeRef)?.kind, "agent_trace");
	assert.match(readFileSync(service.caseFile(goalId, caseRef, nativeRef), "utf-8"), /Read inputs\/request.json/u);
	assert.ok(caseFiles.every((file) => !file.ref.includes("sdk-input.json") && !file.ref.includes("sdk-events.jsonl")));
	assert.throws(() => service.caseFile(goalId, caseRef, `run:${answerTraceDirectory}/sdk-input.json`), /Unknown Node Case file/u);
	const replayed = await recipe.replay(replay);
	assert.deepEqual(JSON.parse(readFileSync(replayed.artifact.absolutePath, "utf-8")), answer);
	outputValue = { ...answer, coverage: [] };
	await assert.rejects(recipe.replay(replay), /omitted requested coverage/u);
	const withoutValidator = createRecordedStageReplayRecipes().find((item) => item.identity.id === "report-writer")!;
	await assert.rejects(withoutValidator.replay(replay), /no evidence validator/u);
	await assert.rejects(recipe.replay({ ...replay, value: { ...value, recipeInput: {} } }), /no frozen answer context/u);
	await assert.rejects(recipe.replay({ ...replay, value: { ...value,
		request: { ...value.request, promptConfig: { ...value.request.promptConfig, userVariant: "default" } } } }), /no frozen answer context/u);
} finally {
	rmSync(root, { recursive: true, force: true });
}
