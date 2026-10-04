import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { hashWikiDirectory } from "../../server/wiki/files.js";
import { NodeBacktestService } from "../../server/evaluation/node-backtest.js";
import { serverRuntimeDirForGoal } from "../../server/workspaces/server-runtime-paths.js";
import { RunArtifactStore } from "../../server/agent-runtime/artifact-store.js";
import { readNodeEvaluationCase, type NodeReplayRecipe } from "../../server/agent-runtime/node-evaluation.js";
import { caseCaptureHealth, resetCaseCaptureForTest } from "../../server/observability/case-capture.js";
import { createWikiCompilationReplayRecipe, readWikiCompilationCaseInput, runWikiCompilationNodeEvaluation, runWikiReindexNodeEvaluation } from "../../server/evaluation/wiki-compilation-node-replay.js";
import type { WikiCompilationRequest, WikiCompilationResult } from "../../server/wiki/contracts.js";
import type { WikiReindexRequest, WikiReindexResult } from "../../server/wiki/wiki-compiler.js";

const root = mkdtempSync(join(tmpdir(), "wiki-compilation-case-"));
const env = { TELOMI_WIKI_CURATOR_MODEL: "test/root", TELOMI_PRIME_AGENT_CHILD_MODEL: "test/child", TELOMI_WIKI_CURATOR_THINKING_LEVEL: "low" };
const notes = { schema_version: 1, snapshot_id: "snapshot-1", run_id: "source-run", pipeline: { id: "cornell", version: "1", sha256: "a".repeat(64) }, source_bundle_refs: [], notes: [] };
const goalContext = { title: "Topic navigation", description: "Evidence-grounded methods", language: "en" as const };
const topicPlan = { schema_version: 1 as const, goal_id: "goal", revision: "v1", status: "active" as const, topics: [{ id: "methods", title: "Methods", intent: "Reusable methods", questions: [], include: [], exclude: [] }] };
const usage = { inputTokens: 10, outputTokens: 20, costUsd: 0, calls: 1 };
const signal = new AbortController().signal;
const executionMetadata: Record<string, string> = {
	"workspace-capture.json": JSON.stringify({ schemaVersion: 1, sessionId: "fixture-session", role: "root", applicability: "not-applicable", reason: "stateless-no-file-tools" }),
	"response.json": JSON.stringify({ role: "assistant", content: [{ type: "text", text: "{}" }], stopReason: "stop" }),
	"failure.json": JSON.stringify({ executionMode: "single-completion", error: "injected classification failure" }),
	"effective-system-prompt.md": "Full effective system prompt with SDK and stage instructions.\n",
	"tool-definitions.json": JSON.stringify([{ name: "ipython", description: "Execute Python" }]),
	"mounted-skills.json": JSON.stringify([{ name: "wiki", description: "Read Wiki pages" }]),
	"model-metadata.json": JSON.stringify({ provider: "test", id: "root", thinking: "low" }),
};
const json = (path: string) => JSON.parse(readFileSync(path, "utf8"));
const write = (path: string, text: string) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); };
const cases = (record: string) => readdirSync(join(record, "node-evaluation", "cases")).map(id => {
	const path = join(record, "node-evaluation", "cases", id, "manifest.json");
	return { path, value: readNodeEvaluationCase(path, record) };
});
function request(id: string): WikiCompilationRequest {
	const goalDir = join(root, id, "goal"), runDirectory = join(root, id, "run");
	write(join(goalDir, "wiki", "knowledge", "existing.md"), "Frozen existing page\n");
	write(join(root, "notes.json"), JSON.stringify(notes));
	const store = new RunArtifactStore(runDirectory);
	const artifact = existsSync(join(runDirectory, "notes.json")) ? store.describeFile("notes.json") : store.publishFile(join(root, "notes.json"), "notes.json");
	return { goalDir, runId: id, goalContext, topicPlan, runDirectory, controlDirectory: join(root, id, "control"), rebuild: true,
		cornellNotesSnapshot: { relative_path: artifact.relativePath, sha256: artifact.sha256, byte_length: artifact.byteLength }, env, signal };
}
function trace(directory: string): string {
	const path = join(directory, "sessions", "native.jsonl");
	write(path, `${JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "call1", name: "ipython" }] } })}\n`);
	write(join(directory, "runtime", "input.json"), JSON.stringify({ page: "P1" }));
	for (const [name, content] of Object.entries(executionMetadata)) write(join(directory, "runtime", name), content);
	write(join(directory, "runtime", "logical-workspaces", "root.json"), JSON.stringify({ schemaVersion: 1, guestCwd: "/work", sessionId: "fixture-session", role: "root", mounts: [{ guestPath: "/work", access: "read-write" }] }));
	write(join(directory, "runtime", "logical-workspaces", "root", "work", "asset.bin"), "business binary bytes");
	write(join(directory, "runtime", "logical-workspaces", "root", "work", ".business-state"), "business hidden state");
	write(join(directory, "runtime", "credentials", "secret.json"), "secret");
	write(join(directory, "runtime", "agent", "auth.json"), "secret");
	return path;
}
async function compile(input: WikiCompilationRequest): Promise<WikiCompilationResult> {
	assert.deepEqual(input.goalContext, goalContext);
	assert.deepEqual(input.topicPlan, topicPlan);
	assert.equal(input.rebuild, true);
	assert.equal(input.env?.TELOMI_WIKI_CURATOR_MODEL, "test/root");
	assert.equal(input.env?.TELOMI_WIKI_CURATOR_THINKING_LEVEL, "low");
	assert.deepEqual(json(new RunArtifactStore(input.runDirectory).openFile(input.cornellNotesSnapshot).absolutePath), notes);
	assert.equal(readFileSync(join(input.goalDir, "wiki", "knowledge", "existing.md"), "utf8"), "Frozen existing page\n");
	assert.equal(existsSync(join(input.goalDir, "wiki", "knowledge", "live.md")), false, "Candidate must not read live Goal Wiki");
	write(join(input.runDirectory, "knowledge", "page.md"), "## Grounded details\n");
	return { status: "compiled", compilationId: "fixture", baseKnowledgeSha256: hashWikiDirectory(join(input.goalDir, "wiki", "knowledge")),
		knowledge: new RunArtifactStore(input.runDirectory).describeDirectory("knowledge"), pageCount: 1, usage, agentStages: 1,
		sessionPaths: [trace(input.controlDirectory)], failedBatches: [] };
}
async function reindex(input: WikiReindexRequest): Promise<WikiReindexResult> {
	assert.deepEqual(input.goalContext, goalContext);
	assert.deepEqual(input.topicPlan, topicPlan);
	assert.equal(readFileSync(join(input.knowledgeRoot, "existing.md"), "utf8"), "Frozen existing page\n");
	const knowledgeRoot = join(input.workRoot, "knowledge");
	cpSync(input.knowledgeRoot, knowledgeRoot, { recursive: true });
	write(join(knowledgeRoot, ".topic-index.json"), JSON.stringify({ topic: "methods" }));
	return { knowledgeRoot, pageCount: 1, usage, sessionPaths: [trace(input.workRoot)], failedTopics: [] };
}
function replayInput(source: ReturnType<typeof cases>[number], record: string): Parameters<NodeReplayRecipe["replay"]>[0] {
	return { casePath: source.path, value: source.value, sourceRunDirectory: dirname(dirname(dirname(dirname(source.path)))),
		harnessWorkspaceDirectory: join(root, "live-harness"), recordDirectory: record, workDirectory: join(record, "work"),
		artifactStore: new RunArtifactStore(record), runner: { run: async () => { throw new Error("unexpected model runner"); } },
		candidateCase: { sourceRunId: "candidate-run", capabilitySnapshotId: "caps_test" }, signal };
}
try {
	const observedRequest = request("observed");
	observedRequest.cueOrigins = [{ investigation_id: "a".repeat(24), thread_id: "b".repeat(24),
		artifact_ref: { relative_path: `artifacts/deep-search/${"a".repeat(24)}-1.json`, sha256: "c".repeat(64) } }];
	const observed = await runWikiCompilationNodeEvaluation(observedRequest, { execute: compile });
	assert.equal(observed.pageCount, 1);
	const [source] = cases(observedRequest.controlDirectory);
	assert.ok(source);
	assert.equal(source.value.agentId, "wiki-compilation");
	assert.equal(source.value.recipe.version, 1);
	assert.equal(source.value.status, "succeeded");
	assert.equal(source.value.liveExternalState, false);
	assert.equal(source.value.observed.metrics?.toolCalls, 1, "duplicated session copies count once");
	const inputRoot = join(dirname(source.path), "input");
	assert.equal(readWikiCompilationCaseInput(inputRoot).request.rebuild, true);
	assert.deepEqual(readWikiCompilationCaseInput(inputRoot).cueOrigins, observedRequest.cueOrigins,
		"Wiki Case freezes the investigation/thread and exact Cue artifact identity");
	assert.equal(existsSync(join(dirname(source.path), "observed-output", "rubric.md")), true);
	const traceRoot = join(observedRequest.controlDirectory, source.value.observed.traceDirectories![0]!.ref);
	assert.equal(existsSync(join(traceRoot, "stages", "runtime", "credentials")), false);
	assert.equal(existsSync(join(traceRoot, "stages", "runtime", "agent")), false);
	assert.equal(existsSync(join(traceRoot, "stages", "runtime", "input.json")), true);
	write(join(root, "live-harness", "wiki", "knowledge", "live.md"), "Must never become business input");
	const recipe = createWikiCompilationReplayRecipe({ compile, reindex });
	const candidateInput = replayInput(source, join(root, "candidate"));
	const candidate = await recipe.replay(candidateInput);
	assert.equal(candidate.agentId, "wiki-compilation");
	assert.equal(cases(candidateInput.recordDirectory).length, 1);
	assert.deepEqual(readWikiCompilationCaseInput(join(candidateInput.recordDirectory, "wiki-compilation", "input")).cueOrigins, observedRequest.cueOrigins,
		"Candidate retains frozen provenance instead of reading a live investigation");
	assert.equal(cases(candidateInput.recordDirectory)[0]!.value.capabilitySnapshotId, "caps_test");
	assert.deepEqual(readWikiCompilationCaseInput(inputRoot).topicPlan, topicPlan);
	for (const agentId of ["wiki-curator", "wiki-shard-builder", "wiki-compilation-diagnostic"]) {
		await assert.rejects(recipe.replay({ ...candidateInput, value: { ...source.value, agentId } }), /formal Wiki compilation/u);
	}
	await assert.rejects(recipe.replay({ ...candidateInput, promptOverride: { userPrompt: "old business prompt" } }), /Candidate Agent Bundle/u);
	const tampered = join(root, "tampered");
	cpSync(inputRoot, tampered, { recursive: true });
	write(join(tampered, "topic-plan.json"), "{}");
	assert.throws(() => readWikiCompilationCaseInput(tampered), /hash mismatch/u);

	const reindexRecord = join(root, "reindex-observed");
	await runWikiReindexNodeEvaluation({ knowledgeRoot: join(observedRequest.goalDir, "wiki", "knowledge"), topicPlan, goalContext, env, signal, workRoot: join(root, "reindex-work") },
		{ recordDirectory: reindexRecord, runId: "reindex", execute: reindex });
	const reindexCase = cases(reindexRecord)[0]!;
	assert.equal(reindexCase.value.request.actualModel, "openai-codex/gpt-6-luna");
	assert.deepEqual(reindexCase.value.request.modelPolicy?.preferred, ["openai-codex/gpt-6-luna"]);
	assert.equal(readWikiCompilationCaseInput(join(dirname(reindexCase.path), "input")).request.operation, "reindex");
	assert.equal(existsSync(join(dirname(reindexCase.path), "input", "evidence.json")), false);
	await recipe.replay(replayInput(reindexCase, join(root, "reindex-candidate")));
	const workspace = join(root, "case-interface"), goalId = "goal";
	mkdirSync(join(workspace, goalId), { recursive: true });
	const runtime = serverRuntimeDirForGoal(goalId, workspace);
	cpSync(observedRequest.controlDirectory, join(runtime, "wiki-updates", observedRequest.runId), { recursive: true });
	cpSync(reindexRecord, join(runtime, "topic-plan", "reframes", "reindex"), { recursive: true });
	const service = new NodeBacktestService({ workspaceDir: workspace, listGoalIds: () => [goalId], recipes: [recipe] });
	try {
		const listed = service.listCases(goalId, "wiki-compilation");
		assert.equal(listed.length, 2, "Operations discovers both Wiki Updates and Topic reindex Cases");
		for (const item of listed) {
			const files = service.listCaseFiles(goalId, item.ref);
			assert.ok(files.some(file => file.kind === "agent_trace" && file.ref.endsWith("native.jsonl")));
			assert.ok(files.some(file => file.kind === "runtime_result" && file.ref.endsWith("runtime/input.json")));
			assert.ok(!files.some(file => /credentials|auth\.json/u.test(file.ref)));
			for (const [suffix, content] of [["root/work/asset.bin", "business binary bytes"], ["root/work/.business-state", "business hidden state"]]) {
				const file = files.find(file => file.ref.endsWith(`/runtime/logical-workspaces/${suffix}`));
				assert.ok(file, `Capture must retain logical Workspace business file ${suffix}`);
				assert.equal(readFileSync(service.caseFile(goalId, item.ref, file.ref), "utf8"), content);
			}
			for (const [name, content] of Object.entries(executionMetadata)) {
				const file = files.find(file => file.ref.endsWith(`/runtime/${name}`));
				assert.ok(file, `Capture must expose ${name}`);
				assert.equal(readFileSync(service.caseFile(goalId, item.ref, file.ref), "utf8"), content);
			}

		}
		service.start();
		const replay = service.enqueue(goalId, { agentId: "wiki-compilation", cases: [listed.find(item => item.ref.sourceRunId === observedRequest.runId)!.ref],
			candidate: {}, repetitions: 1, rubricId: "wiki-compilation-v1" });
		let completed = service.read(goalId, replay.id)!;
		while (!["awaiting_evaluation", "failed", "cancelled"].includes(completed.status)) {
			await new Promise(resolve => setTimeout(resolve, 10));
			completed = service.read(goalId, replay.id)!;
		}
		assert.equal(completed.status, "awaiting_evaluation", completed.error);
		const execution = completed.executions[0]!;
		for (const [name, content] of Object.entries(executionMetadata)) {
			const ref = Object.values(execution.refs ?? {}).find(ref => ref.endsWith(`/runtime/${name}`));
			assert.ok(ref, `Replay refs must expose ${name}`);
			assert.equal(readFileSync(service.replayFile(goalId, replay.id, ref), "utf8"), content);
		}
	} finally { service.stop(); }


	for (const kind of ["failed", "cancelled", "partial"] as const) {
		const req = request(kind), controller = new AbortController();
		const error = new Error(`original ${kind}`);
		const execute = async (input: WikiCompilationRequest) => {
			trace(input.controlDirectory);
			if (kind === "cancelled") controller.abort(error);
			if (kind !== "partial") throw error;
			const result = await compile(input);
			return { ...result, failedBatches: [{ batchIndex: 0, sourceIds: [], message: "incomplete", usage }] };
		};
		const run = runWikiCompilationNodeEvaluation({ ...req, signal: controller.signal }, { execute });
		if (kind === "partial") await run; else await assert.rejects(run, thrown => thrown === error);
		const captured = cases(req.controlDirectory)[0]!.value;
		assert.equal(captured.status, kind === "cancelled" ? "cancelled" : "failed");
		assert.ok(captured.observed.terminalWorkspace);
		assert.ok(captured.observed.trace);
		assert.equal(captured.observed.output, undefined);
		if (kind === "partial") assert.ok(existsSync(join(dirname(cases(req.controlDirectory)[0]!.path), "terminal-workspace", "terminal-knowledge", "page.md")), "partial knowledge remains terminal evidence, never an Observed Baseline");
	}
	const retry = request("partial");
	await runWikiCompilationNodeEvaluation({ ...retry, env: { ...env, TELOMI_WIKI_CURATOR_MODEL: "test/changed", TELOMI_WIKI_CURATOR_THINKING_LEVEL: "high" } }, { execute: compile });
	assert.equal(cases(retry.controlDirectory).length, 2, "a resumed execution captures a new Case instead of overwriting its Recovery Case");
	assert.deepEqual(cases(retry.controlDirectory).map(item => item.value.status).sort(), ["failed", "succeeded"]);
	for (const item of cases(retry.controlDirectory)) assert.equal(readWikiCompilationCaseInput(join(dirname(item.path), "input")).request.models.root, "test/root", "Capture must record the resumed model pin, not current settings");
	resetCaseCaptureForTest();
	const failOpen = request("capture-fails");
	write(join(failOpen.controlDirectory, "node-evaluation"), "not a directory");
	assert.equal((await runWikiCompilationNodeEvaluation(failOpen, { execute: compile })).pageCount, 1);
	assert.equal(caseCaptureHealth().failures, 1);
	const drift = request("capture-input-drift");
	await runWikiCompilationNodeEvaluation(drift, { execute: async input => ({ ...await compile(input), baseKnowledgeSha256: "f".repeat(64) }) });
	const driftCase = cases(drift.controlDirectory)[0]!.value;
	assert.equal(driftCase.status, "failed", "a product result built from another base cannot become a quality Case");
	assert.equal(driftCase.observed.output, undefined);
	assert.match(driftCase.observed.error ?? "", /frozen Case input/u);
	assert.ok(caseCaptureHealth().recent.some(item => /frozen Case input/u.test(item.reason)));
	const failingRecipe = createWikiCompilationReplayRecipe({ compile: async () => { throw new Error("model unavailable"); }, reindex });
	const failedReplay = replayInput(source, join(root, "replay-failure"));
	await assert.rejects(failingRecipe.replay(failedReplay), /model unavailable/u);
	assert.equal(cases(failedReplay.recordDirectory)[0]!.value.status, "failed");
	console.log("Formal Wiki compilation capture/replay: frozen compile and reindex, Candidate isolation, failure recovery and capture boundaries passed");
} finally { rmSync(root, { recursive: true, force: true }); }
