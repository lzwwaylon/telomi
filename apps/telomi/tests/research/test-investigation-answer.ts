import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AgentStageRequest, AgentStageRunner } from "../../server/agent-runtime/agent-stage-runtime.js";
import { sha256 } from "../../server/lib/hash.js";
import { executeInvestigationAnswer, validateInvestigationAnswerFromInput, writeInvestigationAnswerInput,
	type InvestigationAnswer, type InvestigationAnswerEvidence, type InvestigationAnswerRequest } from "../../server/research/investigation-answer.js";

const root = mkdtempSync(join(tmpdir(), "investigation-answer-"));
try {
	const goalDir = join(root, "goal");
	const sequence = join(goalDir, "wiki", "runs", "run-1", "artifacts", "find-out-sources", "sequence-1");
	const sourceRoot = join(sequence, "sources", "one");
	mkdirSync(sourceRoot, { recursive: true });
	const original = "  value = speech_tokens\nreturn projection(value)\n";
	writeFileSync(join(sourceRoot, "model.py"), original);
	const dependency = "def projection(value):\n    return value * 2\n";
	writeFileSync(join(sourceRoot, "dependency.py"), dependency);
	const revision = sha256("source-revision");
	writeFileSync(join(sequence, "manifest.json"), JSON.stringify({ sources: [{
		source_id: "source:one", title: "Implementation", revision_sha256: revision, path: "sources/one",
	}] }));
	const request: InvestigationAnswerRequest = { schema_version: 1, question: "Explain the input and projection.",
		context: "Continue the implementation discussion.", language: "en",
		requirements: [{ id: "Q1", question: "Where does value originate?" }, { id: "Q2", question: "How is it projected?" }],
		evidence_refs: ["N1"] };
	const evidence: InvestigationAnswerEvidence = { ref: "N1", section_title: "Forward", cue: "value origin", note: "value comes from speech tokens",
		evidence: [{ source_run_id: "run-1", source_id: "source:one", source_revision_sha256: revision,
			source_path: "model.py", start_line: 1, end_line: 1, content_sha256: sha256("  value = speech_tokens\n"),
			excerpt: "value = speech_tokens", title: "Implementation", url: "https://example.org/model" }] };
	const inputRoot = join(root, "input");
	const secondCue: InvestigationAnswerEvidence = { ...evidence, ref: "N2", cue: "projection", note: "projection doubles its input",
		evidence: [{ ...evidence.evidence[0]!, source_path: "dependency.py", start_line: 2, end_line: 2,
			content_sha256: sha256("    return value * 2\n"), excerpt: "return value * 2" }] };
	writeInvestigationAnswerInput({ inputRoot, request: { ...request, evidence_refs: ["N1", "N2"] }, evidence: [evidence, secondCue], goalDir });
	const frozenEvidence = JSON.parse(readFileSync(join(inputRoot, "evidence", "N1.json"), "utf-8"));
	const frozenSecondCue = JSON.parse(readFileSync(join(inputRoot, "evidence", "N2.json"), "utf-8"));
	assert.equal(frozenEvidence.evidence[0].excerpt, "  value = speech_tokens", "freeze original bytes, not the trimmed display excerpt");
	assert.deepEqual(frozenEvidence.evidence[0].context, { kind: "original_source", ref: "S1", path: "sources/S1", files_ref: "sources/S1-files.json" });
	assert.deepEqual(frozenSecondCue.evidence[0].context, frozenEvidence.evidence[0].context, "Cues of the same Source share one inventory ref");
	assert.deepEqual(JSON.parse(readFileSync(join(inputRoot, frozenEvidence.evidence[0].context.files_ref), "utf-8")), ["dependency.py", "model.py"]);
	assert.deepEqual(readdirSync(join(inputRoot, "sources")).sort(), ["S1", "S1-files.json"], "materialize one Source and one shared index");
	assert.equal(frozenEvidence.evidence[0].url, evidence.evidence[0]!.url);
	assert.equal(frozenEvidence.evidence[0].source_revision_sha256, revision);
	assert.equal(readFileSync(join(inputRoot, "sources", "S1", "model.py"), "utf-8"), original,
		"Writer can read the subsequent projection as original context");
	assert.equal(readFileSync(join(inputRoot, "sources", "S1", "dependency.py"), "utf-8"), dependency, "dependency bytes are available in the frozen Source");
	assert.throws(() => writeInvestigationAnswerInput({ inputRoot: join(root, "outside-path"), request,
		evidence: [{ ...evidence, evidence: [{ ...evidence.evidence[0]!, source_path: "../private.py" }] }], goalDir }), /outside its Source view/u);
	writeFileSync(join(sourceRoot, "model.py"), "value = text_tokens\n");
	writeFileSync(join(sourceRoot, "dependency.py"), "def projection(value):\n    return value * 3\n");
	assert.equal(readFileSync(join(inputRoot, "sources", "S1", "model.py"), "utf-8"), original, "Goal changes cannot mutate Writer input");
	assert.equal(readFileSync(join(inputRoot, "sources", "S1", "dependency.py"), "utf-8"), dependency, "Goal changes cannot mutate frozen dependencies");
	assert.throws(() => writeInvestigationAnswerInput({ inputRoot: join(root, "changed"), request, evidence: [evidence], goalDir }), /bytes changed/u);
	assert.throws(() => writeInvestigationAnswerInput({ inputRoot: join(root, "revision"), request,
		evidence: [{ ...evidence, evidence: [{ ...evidence.evidence[0]!, source_revision_sha256: "b".repeat(64) }] }], goalDir }), /revision is unavailable/u);
	assert.throws(() => writeInvestigationAnswerInput({ inputRoot: join(root, "unknown"), request, evidence: [] }), /unassigned evidence/u);
	const legacy = join(root, "legacy");
	writeInvestigationAnswerInput({ inputRoot: legacy, request, evidence: [{ ...evidence,
		evidence: [{ source_path: "model.py", start_line: 1, end_line: 1, excerpt: "value = speech_tokens" }] }] });
	assert.equal(JSON.parse(readFileSync(join(legacy, "evidence", "N1.json"), "utf-8")).evidence[0].context.kind, "excerpt_only");

	const answer: InvestigationAnswer = { answer: "The input is speech tokens. <cite>N1</cite> Projection dimensions remain unknown.",
		citation_refs: ["N1"], gaps: ["Projection dimensions remain unknown."], coverage: [
			{ requirement_id: "Q1", citation_refs: ["N1"], gap: "" },
			{ requirement_id: "Q2", citation_refs: [], gap: "Projection dimensions remain unknown." },
		] };
	assert.deepEqual(validateInvestigationAnswerFromInput(answer, inputRoot), answer, "partial answers preserve explicit gaps");
	const legacyEvidence = JSON.parse(readFileSync(join(legacy, "evidence", "N1.json"), "utf-8"));
	legacyEvidence.evidence[0].context = { kind: "original_source", ref: "S1", path: "sources/S1", files: ["model.py"] };
	writeFileSync(join(legacy, "evidence", "N1.json"), JSON.stringify(legacyEvidence));
	assert.deepEqual(validateInvestigationAnswerFromInput(answer, legacy), answer, "historical inline inventories remain valid frozen inputs");
	assert.throws(() => validateInvestigationAnswerFromInput({ ...answer, coverage: answer.coverage.slice(0, 1) }, inputRoot), /omitted requested coverage/u);
	assert.throws(() => validateInvestigationAnswerFromInput({ ...answer, citation_refs: ["N3"] }, inputRoot), /unknown or duplicate/u);
	assert.throws(() => validateInvestigationAnswerFromInput({ ...answer, gaps: [] }, inputRoot), /omitted a coverage gap/u);
	assert.throws(() => validateInvestigationAnswerFromInput({ ...answer, answer: "No citation", citation_refs: [] }, inputRoot), /coverage evidence is absent/u);
	assert.throws(() => validateInvestigationAnswerFromInput({ ...answer, coverage: [answer.coverage[0], answer.coverage[0]] }, inputRoot), /coverage is invalid/u);
	const noEvidence = join(root, "no-evidence");
	writeInvestigationAnswerInput({ inputRoot: noEvidence, request: { ...request, evidence_refs: [] }, evidence: [] });
	const missing: InvestigationAnswer = { answer: "No original implementation was found.", citation_refs: [], gaps: ["Input unavailable", "Projection unavailable"],
		coverage: request.requirements.map((part, index) => ({ requirement_id: part.id, citation_refs: [], gap: ["Input unavailable", "Projection unavailable"][index]! })) };
	assert.deepEqual(validateInvestigationAnswerFromInput(missing, noEvidence), missing);

	let called = false;
	const runner: AgentStageRunner = { runStage: async <T>(stage: AgentStageRequest<T>) => {
		called = true;
		assert.equal(stage.role, "report_writer");
		assert.equal(stage.promptConfig?.userVariant, "answer");
		assert.equal(stage.session.policy, "fresh");
		assert.deepEqual(stage.readonlyMounts, [{ hostPath: inputRoot, guestPath: "/inputs", access: "read-only" }]);
		assert.equal(stage.output.kind, "json_candidate");
		assert.equal(stage.output.entryRelativePath, "work/answer.json");
		assert.match(stage.systemPrompt, /inputs\/request.json/u);
		mkdirSync(join(stage.workDirectory, "work"), { recursive: true });
		const path = join(stage.workDirectory, "work", "answer.json");
		writeFileSync(path, JSON.stringify(answer));
		const value = stage.output.validate({ entryPath: path, outputRoot: stage.workDirectory, workDirectory: stage.workDirectory });
		return { value, artifact: stage.artifactStore.publishFile(path, stage.output.publishRelativePath),
			submissionCount: 1, validationErrors: [], session: { id: "fixture", mode: "fresh" }, turns: 1,
			toolCalls: 1, toolCounts: { ipython: 1 }, usage: { inputTokens: 1, outputTokens: 1, costUsd: 0, calls: 1 }, sessionPath: "trace.jsonl" };
	} };
	assert.deepEqual(await executeInvestigationAnswer({ inputRoot, recordDirectory: join(root, "writer"), goalDir,
		invocationId: "answer-fixture", env: {}, signal: new AbortController().signal, stageRunner: runner,
		modelPolicy: { preferred: ["test/model"], reasoning: "off" } }), answer);
	assert.equal(called, true);
} finally {
	rmSync(root, { recursive: true, force: true });
}
