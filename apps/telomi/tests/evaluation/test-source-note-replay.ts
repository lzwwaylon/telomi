import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunArtifactStore } from "../../server/agent-runtime/artifact-store.js";
import type { AgentStageRequest, AgentStageRunner, ValidatedStageArtifact } from "../../server/agent-runtime/agent-stage-runtime.js";
import { beginNodeEvaluationCase, finishNodeEvaluationCase, readNodeEvaluationCase } from "../../server/agent-runtime/node-evaluation.js";
import { createRecordedStageReplayRecipes } from "../../server/agent-runtime/recorded-stage-replay.js";
import { validateSourceReaderDraft } from "../../server/research/pipeline/source-reader-contract.js";
import { materializeAgentSourceView } from "../../server/research/pipeline/agent-source-view.js";

const root = mkdtempSync(join(tmpdir(), "telomi-source-note-replay-"));
try {
	const sourceRun = join(root, "source-run"), original = join(root, "original"), source = join(root, "source");
	const work = join(root, "capture-work"), store = new RunArtifactStore(sourceRun);
	for (const path of [sourceRun, original, work]) mkdirSync(path, { recursive: true });
	writeFileSync(join(original, "paper.md"), "# Original evidence\nThe experiment uses four steps.\nThe reported score is 0.8.\n");
	materializeAgentSourceView(original, source, { id: "source-original", title: "Original paper", url: "https://example.invalid/paper",
		providerId: "arxiv", organizationKind: "ungrouped", members: [] });
	const context = { question: "记录这份材料的实验与条件", goal: { title: "Research", description: "Original evidence" },
		discoveryEnabled: false, document: { id: "source-original" } };
	const request: AgentStageRequest<unknown> = {
		runId: "source-run", stageId: "note-agent-original", attemptId: "1", role: "note_agent",
		promptConfig: { domain: "research", id: "note-agent", sandboxRole: "report.note_agent" },
		evaluation: { agentId: "note-agent", recipe: { id: "note-agent", version: 3 }, recipeInput: context,
			inputGuestPath: "/source", harnessMounts: [], liveExternalState: false },
		session: { key: "note-original", policy: "fresh" }, modelPolicy: { preferred: ["fixture/model"] },
		systemPrompt: "Source reading", userPrompt: "Keep the original Source language and citations.",
		workDirectory: work, readonlyMounts: [{ hostPath: source, guestPath: "/source", access: "read-only" }],
		controlDirectory: sourceRun, recordDirectory: sourceRun, artifactStore: store,
		output: { kind: "note", entryRelativePath: "note.json", publishRelativePath: "notes/original.json", validate: () => ({}) },
		signal: new AbortController().signal,
	};
	const observed = join(work, "note.json"); writeFileSync(observed, JSON.stringify({ sections: [] }));
	const observedArtifact = store.publishFile(observed, "observed/note.json");
	const result = <T>(value: T, artifact: ValidatedStageArtifact<T>["artifact"], directory: string): ValidatedStageArtifact<T> => ({
		value, artifact, submissionCount: 1, validationErrors: [], session: { id: "fixture", mode: "fresh" },
		turns: 1, toolCalls: 0, toolCounts: {}, usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, calls: 0 },
		sessionPath: join(directory, "session.jsonl"),
	});
	const draft = beginNodeEvaluationCase({ request, recordDirectory: sourceRun,
		promptConfig: request.promptConfig!, sessionContextFile: join(sourceRun, "session.jsonl"),
		composedSystemPrompt: request.systemPrompt, actualModel: "fixture/model" });
	assert.ok(draft);
	const capture = finishNodeEvaluationCase(draft, { status: "succeeded", workDirectory: work,
		result: result({ sections: [] }, observedArtifact, sourceRun), validationErrors: [] });
	assert.equal(capture.status, "captured");
	if (capture.status !== "captured") throw new Error("Source fixture was not captured");
	const captured = readNodeEvaluationCase(capture.casePath, sourceRun);
	const recipe = createRecordedStageReplayRecipes(undefined, undefined, validateSourceReaderDraft)
		.find(item => item.identity.id === "note-agent")!;
	let sequence = 0;
	const replay = async (output: unknown, recipeInput: unknown = context) => {
		const directory = join(root, `replay-${++sequence}`), artifactStore = new RunArtifactStore(directory);
		mkdirSync(directory, { recursive: true });
		const runner: AgentStageRunner = { async runStage<T>(stage: AgentStageRequest<T>) {
			const path = join(directory, "note.json"); writeFileSync(path, JSON.stringify(output));
			const value = stage.output.validate({ entryPath: path, outputRoot: directory, workDirectory: directory });
			return result(value, artifactStore.publishFile(path, "accepted/note.json"), directory);
		} };
		return recipe.replay({ casePath: capture.casePath, value: { ...captured, recipeInput },
			sourceRunDirectory: sourceRun, harnessWorkspaceDirectory: root, recordDirectory: directory,
			workDirectory: directory, artifactStore, runner, signal: new AbortController().signal });
	};
	const note = (endLine = 3) => ({ sections: [{ section_title: "Experiment", summary: "The experiment has four steps. The score is reported by the Source.",
		cue_notes: [{ cue: "The experiment uses four steps.", note: "The Source reports a score of 0.8 for the four-step experiment.",
			evidence: [{ source_path: "paper.md", start_line: 2, end_line: endLine }] }] }] });
	// Exercise the captured Recipe boundary, rather than calling only the validator in isolation.
	await assert.rejects(replay(note(999)), /line range.*invalid/u);
	await assert.rejects(replay({ sections: [], status: "found" }), /unexpected|exactly|unknown/u);
	await assert.rejects(replay(note(), { ...context, discoveryEnabled: undefined }), /frozen discovery/u);
	await assert.rejects(replay(note(), { ...context, document: { id: "another-source" } }), /identity|frozen Source/u);
	await assert.rejects(replay(note(), { ...context, discoveryEnabled: true }), /discovery/u);
	const accepted = await replay(note());
	const normalized = JSON.parse(readFileSync(accepted.artifact.absolutePath, "utf8"));
	assert.equal(normalized.schema_version, 1);
	assert.equal(normalized.source_id, "source-original");
	assert.equal(normalized.sections[0].section_title, "Experiment", "Chinese questions do not translate Source Notes");
	assert.match(normalized.sections[0].cue_notes[0].evidence[0].content_sha256, /^[a-f0-9]{64}$/u);
	const empty = await replay({ sections: [] });
	assert.deepEqual(JSON.parse(readFileSync(empty.artifact.absolutePath, "utf8")).sections, []);
	console.log("Source Note capture/replay uses production contract validation, preserves Source language, and rejects invalid provenance/discovery.");
} finally { rmSync(root, { recursive: true, force: true }); }
