import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pinWikiModelSelection } from "../../server/wiki/compilation-runtime.js";
import { hashWikiDirectory } from "../../server/wiki/files.js";
import { NodeBacktestService } from "../../server/evaluation/node-backtest.js";
import { serverRuntimeDirForGoal } from "../../server/workspaces/server-runtime-paths.js";
import { RunArtifactStore } from "../../server/agent-runtime/artifact-store.js";
import { frozenInteractionLedger, readNodeEvaluationCase, readNodeEvaluationFile, type NodeEvaluationInteraction, type NodeReplayRecipe } from "../../server/agent-runtime/node-evaluation.js";
import { caseCaptureHealth, resetCaseCaptureForTest } from "../../server/observability/case-capture.js";
import { createWikiCompilationReplayRecipe, readWikiCompilationCaseInput, runWikiCompilationNodeEvaluation, runWikiReindexNodeEvaluation } from "../../server/evaluation/wiki-compilation-node-replay.js";
import type { WikiCompilationRequest, WikiCompilationResult } from "../../server/wiki/contracts.js";
import type { WikiReindexRequest, WikiReindexResult } from "../../server/wiki/wiki-compiler.js";
import { noteWikiEntries } from "../../server/wiki/note-entries.js";
import type { SourceNotesSnapshot } from "../../server/notes/contracts.js";
import { writeDeferredWikiEvidence } from "../../server/wiki/deferred-evidence.js";
import type { WikiMainSessionContext } from "../../server/main-agent/wiki-context.js";

const root = mkdtempSync(join(tmpdir(), "wiki-compilation-case-"));
const env = { TELOMI_WIKI_COMPILATION_MODEL: "test/root", TELOMI_PRIME_AGENT_CHILD_MODEL: "test/child", TELOMI_WIKI_COMPILATION_THINKING_LEVEL: "low" };
const notes = { schema_version: 1, snapshot_id: "snapshot-1", run_id: "source-run", pipeline: { id: "note", version: "1", sha256: "a".repeat(64) }, source_bundle_refs: [], notes: [] };
const goalContext = { title: "Topic navigation", description: "Evidence-grounded methods", language: "en" as const };
const topicPlan = { schema_version: 1 as const, goal_id: "goal", revision: "v1", status: "active" as const, topics: [{ id: "methods", title: "Methods", intent: "Reusable methods", questions: [], include: [], exclude: [] }] };
const usage = { inputTokens: 10, outputTokens: 20, costUsd: 0, calls: 1 };
const signal = new AbortController().signal;
const curationReview = { investigationId: "d".repeat(24), question: "Which finding belongs in the Wiki?",
	answer: "The cited investigation answer.", usefulFindings: ["An enduring mechanism"],
	excludedFindings: [{ finding: "An incidental detail", reason: "Not useful for this Goal" }] };
const curationInstructions = "Maintain reusable mechanisms; exclude the user-rejected release trivia.";
const reportContext = { runId: 'source-run', markdown: '## Published report\nKeep the supported mechanism and its conditions.\n' };
const mainSession: WikiMainSessionContext = { schema_version: 1, goalId: "goal", sessionId: "main-conversation",
	systemPrompt: "Frozen Main context with global preferences.", model: "test/main", thinking: "high",
	messages: [{ role: "user", content: "Keep technical mechanisms; omit release trivia.", timestamp: 1 }] };
const memoryInteraction: NodeEvaluationInteraction = { kind: "tool", name: "search_user_memory", label: "User Memory",
	description: "Read Goal and global preferences", arguments: { query: "Wiki collection preferences" },
	result: { content: [{ type: "text", text: "The user prefers reusable technical mechanisms." }], details: {} } };
const pendingSnapshot: SourceNotesSnapshot = { ...notes, schema_version: 1, snapshot_id: "pending-snapshot", run_id: "pending-run", notes: [{
	title: "Pending model evidence", canonical_locator: "https://example.test/model", provider_id: "test", provenance_ref: "provider:test",
	source_revision_sha256: "e".repeat(64), members: [], note: { schema_version: 1, source_id: "pending-source", sections: [{
		section_title: "Mechanism", summary: "Pending context", cue_notes: [{ cue: "The model uses a reusable mechanism.",
			note: "Original deferred detail.", evidence: [{ source_path: "model.md", start_line: 1, end_line: 1, content_sha256: "f".repeat(64) }] }],
	}] },
}] };
const deferredEvidence = { snapshots: [pendingSnapshot], entryIds: noteWikiEntries(pendingSnapshot).map(entry => entry.id) };
const executionMetadata: Record<string, string> = {
	"workspace-capture.json": JSON.stringify({ schemaVersion: 1, sessionId: "fixture-session", role: "root", applicability: "not-applicable", reason: "stateless-no-file-tools" }),
	"response.json": JSON.stringify({ role: "assistant", content: [{ type: "text", text: "{}" }], stopReason: "stop" }),
	"response-attempt-1.json": JSON.stringify({ role: "assistant", content: [{ type: "text", text: "{} }" }], stopReason: "stop" }),
	"response-attempt-2.json": JSON.stringify({ role: "assistant", content: [{ type: "text", text: "{}" }], stopReason: "stop" }),
	"agent-context-attempt-1.json": JSON.stringify({ messages: [{ role: "user", content: "Original classification input" }], tools: [], validationAttempt: 1, transportAttempt: 1 }),
	"agent-context-attempt-2.json": JSON.stringify({ messages: [{ role: "user", content: "Original classification input" }, { role: "assistant", content: [{ type: "text", text: "{} }" }] }, { role: "user", content: "Exact validation feedback" }], tools: [], validationAttempt: 2, transportAttempt: 1 }),
	"validation-errors.jsonl": `${JSON.stringify({ validationAttempt: 1, responseAttempt: 1, error: "Unexpected trailing JSON character" })}\n`,
	"failure.json": JSON.stringify({ executionMode: "bounded-validation-completion", error: "injected classification failure" }),
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
		notesSnapshot: { relative_path: artifact.relativePath, sha256: artifact.sha256, byte_length: artifact.byteLength }, env, signal };
}
function trace(directory: string, inherited = false): string {
	const path = join(directory, "sessions", "native.jsonl");
	write(path, [
		...(inherited ? [{ type: 'session', id: 'background-fork' }, { type: 'message', id: 'inherited-main',
			message: { role: 'assistant', content: [{ type: 'toolCall', id: 'old-main-call', name: 'investigate' }] } }] : []),
		{ type: 'message', id: 'current-stage', message: { role: "assistant", content: [{ type: "toolCall", id: "call1", name: "ipython" }] } },
	].map(entry => JSON.stringify(entry)).join('\n') + '\n');
	if (inherited) write(join(directory, 'main-session-fork.json'), JSON.stringify({ forkSessionId: 'background-fork', initialEntryIds: ['inherited-main'] }));
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
	if (input.reportContext !== undefined) assert.deepEqual(input.reportContext, reportContext, 'Replay reads the frozen published report');
	if (input.mainSession !== undefined) assert.deepEqual(input.mainSession, mainSession, "Candidate uses the frozen Main context and model selection");
	if (input.memoryReplay !== undefined) {
		assert.deepEqual(input.memoryReplay, input.mainSession ? [memoryInteraction] : [], "Replay never uses live memory, including legacy Cases");
		const lookup = frozenInteractionLedger(input.memoryReplay);
		if (input.mainSession) assert.deepEqual(lookup("search_user_memory", { query: "Wiki collection preferences" }), memoryInteraction.result);
		assert.throws(() => lookup("search_user_memory", { query: "Changed query" }), /No frozen Tool interaction/u);
	}
	if (input.curationReviews !== undefined) assert.deepEqual(input.curationReviews, [curationReview], "Candidate reads the frozen review, never a later live review");
	if (input.curationInstructions !== undefined) assert.equal(input.curationInstructions, curationInstructions);
	if (input.deferredEvidence !== undefined) assert.deepEqual(input.deferredEvidence,
		input.deferredEvidence.entryIds.length ? deferredEvidence : { snapshots: [], entryIds: [] }, "Candidate uses the frozen deferred evidence");
	assert.deepEqual(input.goalContext, goalContext);
	assert.deepEqual(input.topicPlan, topicPlan);
	assert.equal(input.rebuild, true);
	assert.equal(input.env?.TELOMI_WIKI_COMPILATION_MODEL, "test/root");
	assert.equal(input.env?.TELOMI_WIKI_COMPILATION_THINKING_LEVEL, "low");
	assert.deepEqual(json(new RunArtifactStore(input.runDirectory).openFile(input.notesSnapshot).absolutePath), notes);
	assert.equal(readFileSync(join(input.goalDir, "wiki", "knowledge", "existing.md"), "utf8"), "Frozen existing page\n");
	assert.equal(existsSync(join(input.goalDir, "wiki", "knowledge", "live.md")), false, "Candidate must not read live Goal Wiki");
	write(join(input.runDirectory, "knowledge", "page.md"), "## Grounded details\n");
	if (input.mainSession) write(join(input.controlDirectory, "runtime", "memory-searches.jsonl"), `${JSON.stringify(memoryInteraction)}\n`);
	const nativeSession = trace(input.controlDirectory, Boolean(input.mainSession));
	return { status: "compiled", compilationId: "fixture", baseKnowledgeSha256: hashWikiDirectory(join(input.goalDir, "wiki", "knowledge")),
		knowledge: new RunArtifactStore(input.runDirectory).describeDirectory("knowledge"), pageCount: 1, usage, agentStages: 1,
		sessionPaths: [input.mainSession ? dirname(nativeSession) : nativeSession], failedBatches: [] };
}
async function reindex(input: WikiReindexRequest): Promise<WikiReindexResult> {
 assert.equal(input.env?.TELOMI_WIKI_COMPILATION_MODEL, "test/root", "reindex uses the same frozen Wiki role model");
 assert.equal(input.env?.TELOMI_WIKI_COMPILATION_THINKING_LEVEL, "low", "reindex uses the same frozen Wiki role depth");
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
	observedRequest.curationReviews = structuredClone([curationReview]);
	observedRequest.curationInstructions = curationInstructions;
	observedRequest.reportContext = structuredClone(reportContext);
	observedRequest.mainSession = structuredClone(mainSession);
	observedRequest.deferredEvidence = structuredClone(deferredEvidence);
	observedRequest.cueOrigins = [{ investigation_id: "a".repeat(24), thread_id: "b".repeat(24),
		artifact_ref: { relative_path: `artifacts/deep-search/${"a".repeat(24)}-1.json`, sha256: "c".repeat(64) } }];
	const observed = await runWikiCompilationNodeEvaluation(observedRequest, { execute: compile });
	assert.equal(observed.pageCount, 1);
	const selected = json(join(observedRequest.controlDirectory, "wiki-model-selection.json"));
	assert.deepEqual(Object.keys(selected).sort(), ["TELOMI_WIKI_COMPILATION_MODEL", "TELOMI_WIKI_COMPILATION_THINKING_LEVEL"]);
	assert.equal(selected.TELOMI_WIKI_COMPILATION_MODEL, "test/root");
	assert.equal(selected.TELOMI_WIKI_COMPILATION_THINKING_LEVEL, "low");
 const legacyControl = join(root, "legacy-model-selection");
 write(join(legacyControl, "wiki-model-selection.json"), JSON.stringify(env));
 const restored = pinWikiModelSelection(legacyControl, { ...env, TELOMI_WIKI_COMPILATION_MODEL: "test/changed", TELOMI_WIKI_COMPILATION_THINKING_LEVEL: "high" });
 assert.equal(restored.TELOMI_WIKI_COMPILATION_MODEL, "test/root", "legacy saved selections preserve the original Wiki model");
 assert.equal(restored.TELOMI_WIKI_COMPILATION_THINKING_LEVEL, "low", "legacy saved selections preserve the original Wiki depth");
 assert.deepEqual(Object.keys(json(join(legacyControl, "wiki-model-selection.json"))).sort(), ["TELOMI_WIKI_COMPILATION_MODEL", "TELOMI_WIKI_COMPILATION_THINKING_LEVEL"], "retired child configuration is removed from persisted Wiki selections");

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
	assert.deepEqual(readWikiCompilationCaseInput(inputRoot).request.curationReviews, [curationReview]);
	assert.equal(readWikiCompilationCaseInput(inputRoot).request.curationInstructions, curationInstructions);
	assert.deepEqual(readWikiCompilationCaseInput(inputRoot).deferredEvidence, deferredEvidence);
	assert.deepEqual(readWikiCompilationCaseInput(inputRoot).mainSession, mainSession);
	assert.deepEqual(readWikiCompilationCaseInput(inputRoot).reportContext, reportContext);
	assert.ok(source.value.request.interactions, "Actual memory queries and results are captured as frozen interactions");
	assert.deepEqual(JSON.parse(readNodeEvaluationFile(source.path, source.value.request.interactions)), [memoryInteraction]);
	observedRequest.curationReviews[0]!.answer = "Changed live answer after capture";
	observedRequest.curationInstructions = "Changed live editorial request after capture";
	observedRequest.reportContext.markdown = 'Changed report after capture';
	observedRequest.mainSession.messages[0]!.content = "Changed live conversation after capture";
	observedRequest.mainSession.model = "test/changed-main";
	observedRequest.deferredEvidence.snapshots[0]!.notes[0]!.note.sections[0]!.cue_notes[0]!.note = "Changed live pending detail";
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
	assert.deepEqual(readWikiCompilationCaseInput(join(candidateInput.recordDirectory, "wiki-compilation", "input")).request.curationReviews, [curationReview]);
	assert.equal(readWikiCompilationCaseInput(join(candidateInput.recordDirectory, "wiki-compilation", "input")).request.curationInstructions, curationInstructions);
	assert.deepEqual(readWikiCompilationCaseInput(join(candidateInput.recordDirectory, "wiki-compilation", "input")).deferredEvidence, deferredEvidence);
	assert.deepEqual(readWikiCompilationCaseInput(join(candidateInput.recordDirectory, "wiki-compilation", "input")).mainSession, mainSession);
	assert.deepEqual(readWikiCompilationCaseInput(join(candidateInput.recordDirectory, 'wiki-compilation', 'input')).reportContext, reportContext);
	assert.equal(cases(candidateInput.recordDirectory)[0]!.value.capabilitySnapshotId, "caps_test");
	assert.deepEqual(readWikiCompilationCaseInput(inputRoot).topicPlan, topicPlan);
	const legacyRequest = request("legacy-without-review");
	await runWikiCompilationNodeEvaluation(legacyRequest, { execute: compile });
	const legacyCase = cases(legacyRequest.controlDirectory)[0]!;
	// Simulate an older, local fixture. Real historical Cases remain immutable.
	const legacyInput = join(dirname(legacyCase.path), "input");
	rmSync(join(legacyInput, "deferred-evidence.json"));
	const legacyStore = new RunArtifactStore(dirname(legacyCase.path));
	write(join(legacyInput, "input-manifest.json"), JSON.stringify({ schema_version: 1,
		files: legacyStore.describeDirectory("input").files.filter(file => file.relativePath !== "input-manifest.json") }));
	const legacyArtifact = legacyStore.describeDirectory("input");
	legacyCase.value.input = { ...legacyCase.value.input, sha256: legacyArtifact.sha256,
		byteLength: legacyArtifact.byteLength, fileCount: legacyArtifact.files.length };
	write(legacyCase.path, JSON.stringify(legacyCase.value));
	readNodeEvaluationCase(legacyCase.path, legacyRequest.controlDirectory);
	assert.equal(readWikiCompilationCaseInput(join(dirname(legacyCase.path), "input")).request.curationReviews, undefined,
		"historical Cases without a curation review remain readable without fabricated context");
	assert.equal(readWikiCompilationCaseInput(join(dirname(legacyCase.path), "input")).request.curationInstructions, undefined);
	assert.equal(readWikiCompilationCaseInput(join(dirname(legacyCase.path), "input")).deferredEvidence, undefined);
	assert.equal(readWikiCompilationCaseInput(legacyInput).mainSession, undefined,
		"legacy Cases do not infer missing Main history from a live Goal");
	assert.equal(readWikiCompilationCaseInput(legacyInput).reportContext, undefined);
	await recipe.replay(replayInput(legacyCase, join(root, "legacy-candidate")));
	const defaultPendingRequest = request("default-pending-capture");
	writeDeferredWikiEvidence(defaultPendingRequest.goalDir, deferredEvidence);
	await runWikiCompilationNodeEvaluation(defaultPendingRequest, { execute: compile });
	const defaultPendingCase = cases(defaultPendingRequest.controlDirectory)[0]!;
	assert.deepEqual(readWikiCompilationCaseInput(join(dirname(defaultPendingCase.path), "input")).deferredEvidence, deferredEvidence,
		"the Capture boundary pins the actual pending ledger even when the caller omits the field");
	const emptyRequest = request("empty-base-transport");
	rmSync(join(emptyRequest.goalDir, "wiki", "knowledge"), { recursive: true });
	mkdirSync(join(emptyRequest.goalDir, "wiki", "knowledge", "bootstrap"), { recursive: true });
	const emptyCompile = async (input: WikiCompilationRequest): Promise<WikiCompilationResult> => {
		assert.ok(existsSync(join(input.goalDir, "wiki", "knowledge")), "an existing empty base retains its meaning across transport");
		const knowledgeRoot = join(input.runDirectory, "empty-knowledge");
		mkdirSync(knowledgeRoot, { recursive: true });
		return { status: "compiled", compilationId: "empty-fixture", baseKnowledgeSha256: hashWikiDirectory(join(input.goalDir, "wiki", "knowledge")),
			knowledge: new RunArtifactStore(input.runDirectory).describeDirectory("empty-knowledge"), pageCount: 0, usage,
			agentStages: 0, sessionPaths: [], failedBatches: [] };
	};
	await runWikiCompilationNodeEvaluation(emptyRequest, { execute: emptyCompile });
	const emptyCase = cases(emptyRequest.controlDirectory)[0]!;
	const emptyCaseRoot = dirname(emptyCase.path), transportedRoot = join(root, "empty-case-import");
	// Export/import only declared file assets, as CAS does. Empty directories have no assets.
	for (const file of new RunArtifactStore(emptyCaseRoot).describeDirectory("input").files) {
		write(join(transportedRoot, "input", file.relativePath), readFileSync(join(emptyCaseRoot, "input", file.relativePath), "utf8"));
	}
	assert.equal(existsSync(join(transportedRoot, "input", "previous-edition")), false);
	assert.equal(readWikiCompilationCaseInput(join(transportedRoot, "input")).request.has_previous_edition, true);
	await createWikiCompilationReplayRecipe({ compile: emptyCompile, reindex }).replay({
		...replayInput(emptyCase, join(root, "empty-import-candidate")), casePath: join(transportedRoot, "manifest.json"),
	});
	const missingNonemptyBase = join(root, "missing-nonempty-base");
	cpSync(inputRoot, missingNonemptyBase, { recursive: true });
	rmSync(join(missingNonemptyBase, "previous-edition"), { recursive: true });
	assert.throws(() => readWikiCompilationCaseInput(missingNonemptyBase), /hash mismatch/u,
		"a missing previous Edition with declared content still fails closed");
	for (const agentId of ["unregistered-wiki", "unsupported-wiki", "wiki-compilation-diagnostic"]) {
		await assert.rejects(recipe.replay({ ...candidateInput, value: { ...source.value, agentId } }), /formal Wiki compilation/u);
	}
	await assert.rejects(recipe.replay({ ...candidateInput, promptOverride: { userPrompt: "old business prompt" } }), /Candidate Agent Bundle/u);
	const tampered = join(root, "tampered");
	cpSync(inputRoot, tampered, { recursive: true });
	write(join(tampered, "topic-plan.json"), "{}");
	assert.throws(() => readWikiCompilationCaseInput(tampered), /hash mismatch/u);
	const tamperedDeferred = join(root, "tampered-deferred");
	cpSync(inputRoot, tamperedDeferred, { recursive: true });
	write(join(tamperedDeferred, "deferred-evidence.json"), JSON.stringify({ snapshots: [], entryIds: [] }));
	assert.throws(() => readWikiCompilationCaseInput(tamperedDeferred), /hash mismatch/u);
	const tamperedMain = join(root, "tampered-main");
	cpSync(inputRoot, tamperedMain, { recursive: true });
	write(join(tamperedMain, "main-session.json"), JSON.stringify({ ...mainSession, goalId: "another-goal" }));
	assert.throws(() => readWikiCompilationCaseInput(tamperedMain), /hash mismatch/u);
	write(join(tamperedMain, "input-manifest.json"), JSON.stringify({ schema_version: 1,
		files: new RunArtifactStore(root).describeDirectory("tampered-main").files.filter(file => file.relativePath !== "input-manifest.json") }));
	assert.throws(() => readWikiCompilationCaseInput(tamperedMain), /Main session.*Case Goal/u,
		"even a hash-valid context from another Goal cannot enter the replay");
	const crossGoalRequest = request("cross-goal-context");
	crossGoalRequest.mainSession = { ...mainSession, goalId: "another-goal" };
	await assert.rejects(runWikiCompilationNodeEvaluation(crossGoalRequest, { execute: async () => { throw new Error("must not execute"); } }), /another Goal/u);

	const reindexRecord = join(root, "reindex-observed");
	await runWikiReindexNodeEvaluation({ knowledgeRoot: join(observedRequest.goalDir, "wiki", "knowledge"), topicPlan, goalContext, env, signal, workRoot: join(root, "reindex-work") },
		{ recordDirectory: reindexRecord, runId: "reindex", execute: reindex });
	const reindexCase = cases(reindexRecord)[0]!;
	assert.equal(reindexCase.value.request.actualModel, "test/root");
	assert.deepEqual(reindexCase.value.request.modelPolicy?.preferred, ["test/root"]);
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
			if (item.ref.sourceRunId === observedRequest.runId) {
				const fork = files.find(file => file.ref.endsWith('/main-session-fork.json'));
				assert.ok(fork, 'Operations lists the Main fork boundary beside retained native history');
				assert.equal(fork.kind, 'execution_metadata');
				assert.deepEqual(json(service.caseFile(goalId, item.ref, fork.ref)), {
					forkSessionId: 'background-fork', initialEntryIds: ['inherited-main'],
				}, 'Operations downloads the actual inherited-entry boundary');
			}
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
		const forkRef = Object.values(execution.refs ?? {}).find(ref => ref.endsWith('/main-session-fork.json'));
		assert.ok(forkRef, 'Settled Replay refs expose the same Main fork metadata');
		assert.deepEqual(json(service.replayFile(goalId, replay.id, forkRef)), {
			forkSessionId: 'background-fork', initialEntryIds: ['inherited-main'],
		});
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
		const capturedTrace = join(req.controlDirectory, captured.observed.traceDirectories![0]!.ref);
		for (const [name, content] of Object.entries(executionMetadata)) {
			assert.equal(readFileSync(join(capturedTrace, "stages", "runtime", name), "utf8"), content, `Failed Case retains ${name}`);
		}
		assert.equal(captured.observed.output, undefined);
		if (kind === "partial") assert.ok(existsSync(join(dirname(cases(req.controlDirectory)[0]!.path), "terminal-workspace", "terminal-knowledge", "page.md")), "partial knowledge remains terminal evidence, never an Observed Baseline");
	}
	const retry = request("partial");
	await runWikiCompilationNodeEvaluation({ ...retry, env: { ...env, TELOMI_WIKI_COMPILATION_MODEL: "test/changed", TELOMI_WIKI_COMPILATION_THINKING_LEVEL: "high" } }, { execute: compile });
	assert.equal(cases(retry.controlDirectory).length, 2, "a resumed execution captures a new Case instead of overwriting its Recovery Case");
	assert.deepEqual(cases(retry.controlDirectory).map(item => item.value.status).sort(), ["failed", "succeeded"]);
	for (const item of cases(retry.controlDirectory)) {
  const pinned = readWikiCompilationCaseInput(join(dirname(item.path), "input")).request.models;
  assert.equal(pinned.root, "test/root", "Capture must record the resumed model pin, not current settings");
  assert.equal(pinned.thinking, "low", "Resume preserves the original Wiki thinking depth");
  assert.equal(Object.hasOwn(pinned, "child"), false, "Wiki capture no longer freezes a Prime child model");
 }
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
