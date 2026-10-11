import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunArtifactStore } from "../../server/agent-runtime/artifact-store.js";
import { beginNodeEvaluationCase, finishNodeEvaluationCase, NodeEvaluationModule } from "../../server/agent-runtime/node-evaluation.js";
import { createRecordedStageReplayRecipes } from "../../server/agent-runtime/recorded-stage-replay.js";
import type { AgentStageRequest, AgentStageRunner, ValidatedStageArtifact } from "../../server/agent-runtime/agent-stage-runtime.js";
import { prepareQuestionReaderReplay } from "../../server/research/pipeline/question-reader-replay.js";
import { renderNoteAgentSystemPrompt, renderPiReaderChildPrompt, renderPiReaderSystemPrompt } from "../../server/research/pipeline/note-agent-prompt.js";

const root = mkdtempSync(join(tmpdir(), "question-reader-replay-"));
const oldRoot = process.env.TELOMI_PRIME_AGENT_ROOT_MODEL, oldChild = process.env.TELOMI_PRIME_AGENT_CHILD_MODEL;
process.env.TELOMI_PRIME_AGENT_ROOT_MODEL = "candidate/root";
process.env.TELOMI_PRIME_AGENT_CHILD_MODEL = "candidate/child";
try {
	const store = new RunArtifactStore(root);
	const source = join(root, "source"), inputs = join(root, "inputs"), work = join(root, "work");
	for (const path of [source, inputs, work]) mkdirSync(path);
	writeFileSync(join(source, "paper.md"), "Frozen original evidence.\n");
	writeFileSync(join(source, "reader-context.json"), JSON.stringify({ original_question: "请解释原始问题。" }));
	writeFileSync(join(inputs, "context.md"), "Frozen user background.\n");
	const entry = join(work, "note.json");
	writeFileSync(entry, '{"sections":[]}\n');
	const artifact = store.publishFile(entry, "observed/note.json");
	const result: ValidatedStageArtifact<unknown> = { value: { sections: [] }, artifact,
		submissionCount: 1, validationErrors: [], session: { id: "historical", mode: "fresh" },
		turns: 1, toolCalls: 1, toolCounts: { ipython: 1 },
		usage: { inputTokens: 1, outputTokens: 1, costUsd: 0, calls: 1 }, sessionPath: join(root, "missing-session.jsonl") };
	const request: AgentStageRequest<unknown> = {
		runId: "historical", stageId: "reading", attemptId: "attempt-1", role: "note_agent",
		promptConfig: { domain: "research", id: "note-agent", sandboxRole: "report.note_agent",
			systemVariant: "question-reading", userVariant: "question-reading" },
		session: { key: "historical", policy: "fresh" }, modelPolicy: { preferred: ["historical/note"], reasoning: "medium" },
		systemPrompt: "Historical Prime prompt", userPrompt: "Frozen original user input",
		workDirectory: work, controlDirectory: root, artifactStore: store,
		readonlyMounts: [{ hostPath: source, guestPath: "/source", access: "read-only" },
			{ hostPath: inputs, guestPath: "/inputs", access: "read-only" }],
		executionProfile: "prime_ipython",
		evaluation: { agentId: "note-agent", recipe: { id: "note-agent", version: 3 },
			recipeInput: { mode: "question-reading", question: "Explain the delegated question.", invocationId: "historical" },
			inputGuestPath: "/source", harnessMounts: [], liveExternalState: false },
		output: { kind: "note", entryRelativePath: "note.json", publishRelativePath: "note.json", validate: () => ({ sections: [] }) },
		signal: new AbortController().signal,
	};
	const draft = beginNodeEvaluationCase({ request, recordDirectory: root, promptConfig: request.promptConfig!,
		sessionContextFile: result.sessionPath, composedSystemPrompt: request.systemPrompt, actualModel: "historical/note" });
	assert.ok(draft);
	const capture = finishNodeEvaluationCase(draft, { status: "succeeded", workDirectory: work, result, validationErrors: [] });
	assert.equal(capture.status, "captured");
	if (capture.status !== "captured") throw new Error("fixture capture failed");
	const module = new NodeEvaluationModule(createRecordedStageReplayRecipes(undefined, undefined, undefined, prepareQuestionReaderReplay));
	const seen: AgentStageRequest<unknown>[] = [];
	const runner: AgentStageRunner = { async runStage<T>(stage: AgentStageRequest<T>) {
		seen.push(stage as AgentStageRequest<unknown>);
		return result as ValidatedStageArtifact<T>;
	} };
	const replay = (mode: "candidate" | "observed" | "override", systemPrompt?: string, casePath = capture.casePath) => module.replay({
		casePath, sourceRunDirectory: root, harnessWorkspaceDirectory: root,
		recordDirectory: join(root, `replay-${mode}`), workDirectory: join(root, `replay-${mode}`, "work"),
		artifactStore: store, runner, promptMode: mode,
		...(systemPrompt === undefined ? {} : { promptOverride: { systemPrompt } }), signal: new AbortController().signal,
	});
	await replay("candidate", renderPiReaderSystemPrompt("candidate/child"));
	const candidate = seen.at(-1)!;
	assert.equal(candidate.executionProfile, "pi_builtin");
	assert.equal(candidate.promptConfig?.systemVariant, "question-reading-pi");
	assert.deepEqual(candidate.modelPolicy, request.modelPolicy, "recipe preserves the model policy; Backtest owns Candidate model freezing");
	assert.equal(candidate.userPrompt, request.userPrompt, "business input stays frozen");
	assert.equal(readFileSync(join(candidate.readonlyMounts[0]!.hostPath, "paper.md"), "utf8"), "Frozen original evidence.\n");
	const candidateInputs = candidate.readonlyMounts.find(mount => mount.guestPath === "/inputs")!.hostPath;
	assert.deepEqual(JSON.parse(readFileSync(join(candidateInputs, "reader-config.json"), "utf8")),
		{ childModel: "candidate/child", language: "zh-CN" });
	assert.equal(readFileSync(join(candidateInputs, "context.md"), "utf8"), "Frozen user background.\n");
	assert.equal(readFileSync(join(candidateInputs, "reader-child-system.md"), "utf8"), renderNoteAgentSystemPrompt(undefined, "question-reading-pi").content);
	assert.equal(readFileSync(join(candidateInputs, "reader-child-prompt.md"), "utf8"), renderPiReaderChildPrompt("zh-CN"));
	assert.equal(existsSync(join(inputs, "reader-child-system.md")), false, "Candidate never writes child Prompts into historical inputs");
	assert.equal((candidate.evaluation?.recipeInput as { readerConfigurationSource: string }).readerConfigurationSource, "candidate-settings");
	assert.equal(JSON.parse(readFileSync(join(root, "replay-candidate", "reader-config-origin.json"), "utf8")).source, "candidate-settings");
	assert.equal(existsSync(join(inputs, "reader-config.json")), false, "historical inputs cannot be modified");
	for (const mode of ["observed", "override"] as const) {
		await replay(mode);
		assert.equal(seen.at(-1)!.executionProfile, "prime_ipython");
		assert.deepEqual(seen.at(-1)!.modelPolicy, request.modelPolicy);
		assert.equal(seen.at(-1)!.systemPrompt, request.systemPrompt);
	}
	await assert.rejects(replay("candidate", renderPiReaderSystemPrompt("changed/child")), /configuration changed/u,
		"a changed current selection cannot silently disagree with the frozen Prompt Bundle");
	writeFileSync(join(inputs, "reader-config.json"), JSON.stringify({ childModel: "frozen/child", language: "en" }));
	const frozenDraft = beginNodeEvaluationCase({ request: { ...request, attemptId: "frozen-config" }, recordDirectory: root,
		promptConfig: request.promptConfig!, sessionContextFile: result.sessionPath,
		composedSystemPrompt: request.systemPrompt, actualModel: "historical/note" });
	assert.ok(frozenDraft);
	const frozenCapture = finishNodeEvaluationCase(frozenDraft, { status: "succeeded", workDirectory: work, result, validationErrors: [] });
	if (frozenCapture.status !== "captured") throw new Error("frozen config fixture capture failed");
	await replay("candidate", renderPiReaderSystemPrompt("frozen/child"), frozenCapture.casePath);
	assert.equal((seen.at(-1)!.evaluation?.recipeInput as { readerConfigurationSource: string }).readerConfigurationSource, "captured");
	assert.deepEqual(JSON.parse(readFileSync(join(seen.at(-1)!.readonlyMounts.find(mount => mount.guestPath === "/inputs")!.hostPath,
		"reader-config.json"), "utf8")), { childModel: "frozen/child", language: "en" });
	const capturePi = (attemptId: string, systemVariant = "question-reading-pi") => {
		const piRequest = { ...request, attemptId, executionProfile: "pi_builtin" as const,
			promptConfig: { ...request.promptConfig!, systemVariant } };
		const piDraft = beginNodeEvaluationCase({ request: piRequest, recordDirectory: root, promptConfig: piRequest.promptConfig,
			sessionContextFile: result.sessionPath, composedSystemPrompt: request.systemPrompt, actualModel: "historical/note" });
		assert.ok(piDraft);
		const piCapture = finishNodeEvaluationCase(piDraft, { status: "succeeded", workDirectory: work, result, validationErrors: [] });
		if (piCapture.status !== "captured") throw new Error("Pi fixture capture failed");
		return piCapture.casePath;
	};
	await assert.rejects(replay("observed", undefined, capturePi("missing-child-prompts")), /frozen child Prompts.*candidate/u);
	writeFileSync(join(inputs, "reader-child-system.md"), "Historical child system unchanged");
	writeFileSync(join(inputs, "reader-child-prompt.md"), "Historical child assignment unchanged");
	const piCase = capturePi("frozen-child-prompts");
	await replay("observed", undefined, piCase);
	const observedInputs = seen.at(-1)!.readonlyMounts.find(mount => mount.guestPath === "/inputs")!.hostPath;
	assert.equal(readFileSync(join(observedInputs, "reader-child-system.md"), "utf8"), "Historical child system unchanged");
	assert.equal(readFileSync(join(observedInputs, "reader-child-prompt.md"), "utf8"), "Historical child assignment unchanged");
	await assert.rejects(replay("observed", undefined, capturePi("unsupported-pi-profile", "reader-comparison")), /supported profile.*candidate/u);
	await replay("candidate", renderPiReaderSystemPrompt("frozen/child"), piCase);
	const refreshedInputs = seen.at(-1)!.readonlyMounts.find(mount => mount.guestPath === "/inputs")!.hostPath;
	assert.equal(readFileSync(join(refreshedInputs, "reader-child-system.md"), "utf8"), renderNoteAgentSystemPrompt(undefined, "question-reading-pi").content);
	assert.equal(readFileSync(join(refreshedInputs, "reader-child-prompt.md"), "utf8"), renderPiReaderChildPrompt("en"));
	assert.equal(readFileSync(join(observedInputs, "reader-child-system.md"), "utf8"), "Historical child system unchanged", "Candidate refresh never mutates frozen observed child Prompts");
	const sourceRequest = { ...request, stageId: "source-reading", attemptId: "source-reading",
		evaluation: { ...request.evaluation!, recipeInput: { question: "Read one Source" } } };
	const sourceDraft = beginNodeEvaluationCase({ request: sourceRequest, recordDirectory: root, promptConfig: request.promptConfig!,
		sessionContextFile: result.sessionPath, composedSystemPrompt: request.systemPrompt, actualModel: "historical/note" });
	assert.ok(sourceDraft);
	const sourceCapture = finishNodeEvaluationCase(sourceDraft, { status: "succeeded", workDirectory: work, result, validationErrors: [] });
	if (sourceCapture.status !== "captured") throw new Error("Source fixture capture failed");
	await replay("candidate", undefined, sourceCapture.casePath);
	assert.equal(seen.at(-1)!.executionProfile, "prime_ipython", "Source reading remains Prime even in Candidate mode");
	assert.deepEqual(seen.at(-1)!.modelPolicy, request.modelPolicy);
	const noInputs = { ...request, stageId: "legacy-no-inputs", attemptId: "legacy-no-inputs", readonlyMounts: request.readonlyMounts.slice(0, 1) };
	const noInputsDraft = beginNodeEvaluationCase({ request: noInputs, recordDirectory: root, promptConfig: request.promptConfig!,
		sessionContextFile: result.sessionPath, composedSystemPrompt: request.systemPrompt, actualModel: "historical/note" });
	assert.ok(noInputsDraft);
	const noInputsCapture = finishNodeEvaluationCase(noInputsDraft, { status: "succeeded", workDirectory: work, result, validationErrors: [] });
	if (noInputsCapture.status !== "captured") throw new Error("no-inputs fixture capture failed");
	await replay("candidate", renderPiReaderSystemPrompt("candidate/child"), noInputsCapture.casePath);
	const legacyInputs = seen.at(-1)!.readonlyMounts.find(mount => mount.guestPath === "/inputs")!.hostPath;
	assert.equal(readFileSync(join(legacyInputs, "context.md"), "utf8"), "", "missing historical context is explicit and empty");
	assert.deepEqual(JSON.parse(readFileSync(join(legacyInputs, "reader-config.json"), "utf8")), { childModel: "candidate/child", language: "zh-CN" });
	console.log("Question Reader Replay: explicit candidate Pi, historical Prime preservation and immutable configuration fallback passed");
} finally {
	if (oldRoot === undefined) delete process.env.TELOMI_PRIME_AGENT_ROOT_MODEL; else process.env.TELOMI_PRIME_AGENT_ROOT_MODEL = oldRoot;
	if (oldChild === undefined) delete process.env.TELOMI_PRIME_AGENT_CHILD_MODEL; else process.env.TELOMI_PRIME_AGENT_CHILD_MODEL = oldChild;
	rmSync(root, { recursive: true, force: true });
}
