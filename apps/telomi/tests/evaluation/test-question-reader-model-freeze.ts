import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunArtifactStore } from "../../server/agent-runtime/artifact-store.js";
import { beginNodeEvaluationCase, finishNodeEvaluationCase } from "../../server/agent-runtime/node-evaluation.js";
import { createRecordedStageReplayRecipes } from "../../server/agent-runtime/recorded-stage-replay.js";
import { prepareNoteReaderReplay } from "../../server/research/pipeline/note-reader-replay.js";
import type { AgentStageRequest, AgentStageRunner, ValidatedStageArtifact } from "../../server/agent-runtime/agent-stage-runtime.js";
import { NodeBacktestService, nodeBacktestRunsDirectory } from "../../server/evaluation/node-backtest.js";
import { serverRuntimeDirForGoal } from "../../server/workspaces/server-runtime-paths.js";

const root = mkdtempSync(join(tmpdir(), "reader-root-model-freeze-"));
const oldRoot = process.env.TELOMI_PRIME_AGENT_ROOT_MODEL;
const services: NodeBacktestService[] = [];
try {
	const application = join(root, "application"), workspace = join(root, "data"), goalId = "goal-reader";
	mkdirSync(join(application, "agents"), { recursive: true });
	writeFileSync(join(application, "agents", "fixture.txt"), "Stable application fixture.\n");
	for (const args of [["init", "--quiet"], ["add", "agents"],
		["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "commit", "--quiet", "-m", "Fixture"]]) {
		execFileSync("git", args, { cwd: application, stdio: "pipe" });
	}
	mkdirSync(join(workspace, goalId), { recursive: true });
	const sourceRun = join(serverRuntimeDirForGoal(goalId, workspace), "runs", "historical");
	const source = join(root, "source"), inputs = join(root, "inputs");
	for (const path of [sourceRun, source, inputs]) mkdirSync(path, { recursive: true });
	writeFileSync(join(source, "catalog.json"), '{"sources":[]}');
	writeFileSync(join(inputs, "context.md"), "Frozen background.");
	writeFileSync(join(inputs, "reader-config.json"), JSON.stringify({ childModel: "fixture/child", language: "en" }));
	const seen: Array<{ model: string; profile: string | undefined }> = [];
	const materialize = <T>(request: AgentStageRequest<T>): ValidatedStageArtifact<T> => {
		mkdirSync(request.workDirectory, { recursive: true });
		const path = join(request.workDirectory, "note.json");
		writeFileSync(path, '{"sections":[]}');
		const value = request.output.validate({ entryPath: path, outputRoot: request.workDirectory, workDirectory: request.workDirectory });
		return { value, artifact: request.artifactStore.publishFile(path, request.output.publishRelativePath),
			submissionCount: 1, validationErrors: [], session: { id: request.stageId, mode: "fresh" },
			turns: 1, toolCalls: 0, toolCounts: {}, usage: { inputTokens: 1, outputTokens: 1, costUsd: 0, calls: 1 },
			sessionPath: join(request.recordDirectory ?? request.controlDirectory, "session.jsonl") };
	};
	const capture = <T>(request: AgentStageRequest<T>, result: ValidatedStageArtifact<T>) => {
		const draft = beginNodeEvaluationCase({ request, recordDirectory: request.recordDirectory ?? request.controlDirectory,
			promptConfig: request.promptConfig!, sessionContextFile: result.sessionPath,
			composedSystemPrompt: request.systemPrompt, actualModel: request.modelPolicy.preferred[0]! });
		assert.ok(draft);
		const captured = finishNodeEvaluationCase(draft, { status: "succeeded", workDirectory: request.workDirectory, result, validationErrors: [] });
		if (captured.status !== "captured") throw new Error("fixture capture failed");
		return captured;
	};
	const request: AgentStageRequest<unknown> = {
		runId: "historical", stageId: "reader", attemptId: "1", role: "note_agent",
		promptConfig: { domain: "research", id: "note-agent", sandboxRole: "report.note_agent", systemVariant: "question-reading", userVariant: "question-reading" },
		session: { key: "historical", policy: "fresh" }, modelPolicy: { preferred: ["historical/note"], reasoning: "medium" },
		systemPrompt: "Historical Prime system", userPrompt: "Historical user question", executionProfile: "prime_ipython",
		workDirectory: join(root, "observed"), controlDirectory: sourceRun, recordDirectory: sourceRun, artifactStore: new RunArtifactStore(sourceRun),
		readonlyMounts: [{ hostPath: source, guestPath: "/source", access: "read-only" }, { hostPath: inputs, guestPath: "/inputs", access: "read-only" }],
		evaluation: { agentId: "note-agent", recipe: { id: "note-agent", version: 3 },
			recipeInput: { mode: "question-reading", question: "Explain the mechanism.", invocationId: "historical" },
			inputGuestPath: "/source", harnessMounts: [], liveExternalState: false },
		output: { kind: "note", entryRelativePath: "note.json", publishRelativePath: "notes/observed.json", validate: () => ({ sections: [] }) },
		signal: new AbortController().signal,
	};
	const original = capture(request, materialize(request));
	const sourceRequest = { ...request, stageId: "source-reader", attemptId: "source", promptConfig: { ...request.promptConfig!, systemVariant: "default", userVariant: "prime-execution" },
		output: { ...request.output, publishRelativePath: "notes/source-observed.json" },
		evaluation: { ...request.evaluation!, recipeInput: { question: "Read one Source", goal: { title: "Research", description: "Evidence" }, discoveryEnabled: false } } };
	const originalSource = capture(sourceRequest, materialize(sourceRequest));
	let switchDuringExecution = true;
	const runner: AgentStageRunner = { async runStage<T>(stage: AgentStageRequest<T>) {
		seen.push({ model: stage.modelPolicy.preferred[0]!, profile: stage.executionProfile });
		assert.equal(stage.modelPolicy.reasoning, "medium", "captured Note thinking remains fixed");
		if (switchDuringExecution) { process.env.TELOMI_PRIME_AGENT_ROOT_MODEL = "fixture/root-c"; switchDuringExecution = false; }
		const result = materialize(stage);
		capture(stage, result);
		return result;
	} };
	const createService = () => {
		const service = new NodeBacktestService({ workspaceDir: workspace, applicationDir: application,
			listGoalIds: () => [goalId], recipes: createRecordedStageReplayRecipes(undefined, undefined, undefined, prepareNoteReaderReplay), runner });
		services.push(service); return service;
	};
	const caseRef = { sourceRunId: "historical", caseId: original.caseId };
	const enqueue = (service: NodeBacktestService, mode: "candidate" | "observed" | "override" = "candidate", sourceCase = false) => service.enqueue(goalId, {
		agentId: "note-agent", cases: [sourceCase ? { sourceRunId: "historical", caseId: originalSource.caseId } : caseRef],
		candidate: { promptMode: mode, ...(mode === "override" ? { promptOverride: { systemPrompt: "Explicit system", userPrompt: "Explicit user" } } : {}) },
		repetitions: 2, rubricId: "root-freeze", });
	const settled = async (service: NodeBacktestService, id: string) => {
		const deadline = Date.now() + 15_000;
		for (;;) {
			const run = service.read(goalId, id)!;
			if (!["queued", "running"].includes(run.status)) return run;
			if (Date.now() > deadline) throw new Error("Replay did not settle");
			await new Promise(resolve => setTimeout(resolve, 5));
		}
	};
	process.env.TELOMI_PRIME_AGENT_ROOT_MODEL = "fixture/root-a";
	const beforeRestart = createService();
	const queued = enqueue(beforeRestart);
	const modelPath = (id: string) => join(nodeBacktestRunsDirectory(workspace, goalId), id, "question-reader-models.json");
	assert.ok(existsSync(modelPath(queued.id)));
	process.env.TELOMI_PRIME_AGENT_ROOT_MODEL = "fixture/root-b";
	const resumed = createService(); resumed.start();
	const first = await settled(resumed, queued.id);
	assert.equal(first.status, "awaiting_evaluation", first.error);
	assert.deepEqual(seen.splice(0), [{ model: "fixture/root-a", profile: "pi_builtin" }, { model: "fixture/root-a", profile: "pi_builtin" }],
		"enqueue pins Root across settings changes, repetitions and service restart");
	const next = enqueue(resumed);
	assert.equal((await settled(resumed, next.id)).status, "awaiting_evaluation");
	assert.deepEqual(seen.splice(0).map(item => item.model), ["fixture/root-c", "fixture/root-c"], "a new Replay selects the new setting");
	for (const mode of ["observed", "override"] as const) {
		const legacy = enqueue(resumed, mode);
		assert.equal((await settled(resumed, legacy.id)).status, "awaiting_evaluation");
		assert.equal(existsSync(modelPath(legacy.id)), false);
		assert.deepEqual(seen.splice(0), [{ model: "historical/note", profile: "prime_ipython" }, { model: "historical/note", profile: "prime_ipython" }]);
	}
	const sourceReplay = enqueue(resumed, "candidate", true);
	assert.equal((await settled(resumed, sourceReplay.id)).status, "awaiting_evaluation");
	assert.deepEqual(seen.splice(0), [{ model: "historical/note", profile: "prime_ipython" }, { model: "historical/note", profile: "prime_ipython" }]);
	assert.equal(existsSync(modelPath(sourceReplay.id)), false);
	resumed.stop();
	const tampered = enqueue(resumed);
	const frozen = JSON.parse(readFileSync(modelPath(tampered.id), "utf8"));
	frozen.policies[0].modelPolicy.preferred = ["tampered/model"];
	writeFileSync(modelPath(tampered.id), JSON.stringify(frozen));
	const missing = enqueue(resumed); rmSync(modelPath(missing.id));
	const recovered = createService(); recovered.start();
	const rejected = await settled(recovered, tampered.id), absent = await settled(recovered, missing.id);
	assert.equal(rejected.status, "failed"); assert.match(rejected.error!, /model policy identity changed/u);
	assert.equal(absent.status, "failed"); assert.match(absent.error!, /no frozen Root model policy/u);
	assert.deepEqual(seen, [], "invalid or missing pins never reach the model");
	console.log("Question Reader Root: enqueue/restart/repetition pins, new selection, historical modes, Source preservation and sidecar integrity passed");
} finally {
	for (const service of services) service.stop();
	if (oldRoot === undefined) delete process.env.TELOMI_PRIME_AGENT_ROOT_MODEL; else process.env.TELOMI_PRIME_AGENT_ROOT_MODEL = oldRoot;
	rmSync(root, { recursive: true, force: true });
}
