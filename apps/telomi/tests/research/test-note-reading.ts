import assert from "node:assert/strict";
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AgentStageRequest, AgentStageRunner, ValidatedStageArtifact } from "../../server/agent-runtime/agent-stage-runtime.js";
import { withNoteAgentCapture } from "../../server/agent-runtime/recorded-stage-replay.js";
import { beginNodeEvaluationCase } from "../../server/agent-runtime/node-evaluation.js";
import { installCaseCapture } from "../../server/observability/case-capture.js";
import { renderNoteAgentSystemPrompt } from "../../server/research/pipeline/note-agent-prompt.js";
import { sha256 } from "../../server/lib/hash.js";
import { writeTaskContext } from "../../server/research/task-context.js";
import { executeNoteReading, resolveNoteReadingCue, searchSavedNoteReadingCues,
	validateNoteReadingDraftFromCorpus } from "../../server/research/note-reading.js";

const root = mkdtempSync(join(tmpdir(), "note-reading-contract-"));
const uninstallCapture = installCaseCapture({ noteAgent: withNoteAgentCapture });
try {
	const goalDir = join(root, "goal");
	const sequence = join(goalDir, "wiki", "runs", "run-1", "artifacts", "find-out-sources", "sequence-1");
	const member = "members/github/candidate-one";
	const source = join(sequence, "sources", "source-one");
	mkdirSync(join(source, member, "finetuning"), { recursive: true });
	writeFileSync(join(source, member, "finetuning", "sft.py"), "loss = logits.cross_entropy(labels)\n  optimizer.step()  \n");
	writeFileSync(join(sequence, "manifest.json"), JSON.stringify({
		schema_version: 3, sequence: 1, sources: [{
			source_id: "source:one", title: "Model code", path: "sources/source-one",
			organization_kind: "ungrouped", organization_reason: "single repository",
			revision_sha256: sha256("pinned-source"),
			members: [{ candidate_id: "candidate:one", source_id: "source:member-one",
				provider_id: "github", title: "Model code", canonical_locator: "https://github.com/example/model",
				path: member, summary: "training code" }],
		}],
	}));
	let calls = 0;
	const contexts: Array<{ original_question: string; preferred_source_refs: string[]; known_cues: Array<{
		status: string; evidence: Array<{ status: string; source_refs: string[]; recheck_reasons: string[] }>;
	}> }> = [];
	const capturedInputs: string[] = [];
	const taskContext = "Focus on the loss formula and tensor dimensions.\n用户熟悉深度学习。\n";
	const taskContextFile = writeTaskContext(join(root, "task-inputs"), taskContext);
	const run = async (candidate: unknown, invocationId: string,
		options: Pick<Parameters<typeof executeNoteReading>[0], "knownCues" | "originalQuestion" | "preferredSourceRunId" | "taskContextFile"> = {}) => executeNoteReading({
		goalDir, goalId: "goal", question: "How is the loss computed?", invocationId,
		...options,
		signal: new AbortController().signal,
		model: "test/model", thinkingLevel: "medium",
		stageRunner: {
			async runStage<T>(request: AgentStageRequest<T>): Promise<ValidatedStageArtifact<T>> {
				calls++;
				assert.equal(request.systemPrompt, renderNoteAgentSystemPrompt(undefined, "question-reading").content,
					"question reading receives the same shared quality rules as Source reading");
				assert.equal(request.promptConfig?.revisions?.system?.variant, "question-reading");
				assert.deepEqual(request.readonlyMounts.map((mount) => ({ guestPath: mount.guestPath, access: mount.access })),
					[{ guestPath: "/source", access: "read-only" }, { guestPath: "/inputs", access: "read-only" }],
					"task context receives a separate read-only mount without granting a Goal mount");
				const taskInputs = request.readonlyMounts.find((mount) => mount.guestPath === "/inputs")!;
				const expectedTaskContext = options.taskContextFile ? taskContext : "";
				assert.equal(readFileSync(join(taskInputs.hostPath, "context.md"), "utf8"), expectedTaskContext);
				assert.match(request.userPrompt, /source\/reader-context\.json/u);
				const contextText = readFileSync(join(request.readonlyMounts[0]!.hostPath, "reader-context.json"), "utf-8");
				contexts.push(JSON.parse(contextText));
				const captured = beginNodeEvaluationCase({ request, recordDirectory: request.recordDirectory!,
					promptConfig: request.promptConfig!, sessionContextFile: join(root, "missing-session.json"),
					composedSystemPrompt: request.systemPrompt, actualModel: "test/model" });
				assert.ok(captured, "the existing Cornell observer captures incremental inputs");
				const capturedInput = join(captured.caseDirectory, "input");
				capturedInputs.push(capturedInput);
				assert.equal(readFileSync(join(capturedInput, "reader-context.json"), "utf-8"), contextText,
					"navigation is frozen alongside the original Source bytes");
				const capturedContext = captured.base.mounts.find((mount) => mount.guestPath === "/inputs")!;
				assert.equal(capturedContext.kind, "run", "task context is frozen as Case input rather than bundled harness data");
				if (capturedContext.kind === "run") assert.equal(readFileSync(join(captured.runDirectory,
					capturedContext.directory.ref, "context.md"), "utf8"), expectedTaskContext);
				const catalog = JSON.parse(readFileSync(join(request.readonlyMounts[0]!.hostPath, "catalog.json"), "utf-8"));
				assert.equal(catalog.sources.length, options.preferredSourceRunId ? 3 : 1);
				assert.equal(catalog.sources[0].source_id, "source:one");
				assert.equal(catalog.sources[0].source_revision_sha256, sha256(options.preferredSourceRunId ? "new-source" : "pinned-source"));
				assert.equal(catalog.sources[0].readable_file_count, 1, "task preferences are absent from the original evidence catalog");
				const path = join(request.workDirectory, "note.json");
				mkdirSync(request.workDirectory, { recursive: true });
				writeFileSync(path, JSON.stringify(candidate));
				const value = request.output.validate({ entryPath: path, outputRoot: request.workDirectory,
					workDirectory: request.workDirectory });
				assert.deepEqual(validateNoteReadingDraftFromCorpus(candidate, "How is the loss computed?",
					invocationId, request.readonlyMounts[0]!.hostPath), value,
					"captured Source replay applies the same evidence contract");
				return { value, artifact: request.artifactStore.publishFile(path, request.output.publishRelativePath),
					submissionCount: 1, validationErrors: [], session: { id: "note-reading-test", mode: "fresh" },
					turns: 1, toolCalls: 1, toolCounts: { ipython: 1 },
					usage: { inputTokens: 1, outputTokens: 1, costUsd: 0, calls: 1 }, sessionPath: "trace.jsonl" };
			},
		} satisfies AgentStageRunner,
	});
	const draft = { status: "found", summary: "Cross entropy is applied to labels.", gaps: [], sections: [{
		section_title: "Training", cue_notes: [{ cue: "Loss + cross entropy", note: "Training applies cross entropy to logits and labels.",
			evidence: [{ source_ref: "S1", source_path: `${member}/finetuning/sft.py`, start_line: 1, end_line: 1 }] }],
	}] };
	const found = await run(draft, "found-1", { taskContextFile });
	assert.equal(contexts[0]!.original_question, "How is the loss computed?");
	assert.deepEqual(contexts[0]!.known_cues, []);
	assert.deepEqual(validateNoteReadingDraftFromCorpus(draft, found.question, "found-1", capturedInputs[0]!), found,
		"the original corpus remains replayable after temporary Source cleanup");
	rmSync(join(capturedInputs[0]!, "reader-context.json"));
	assert.deepEqual(validateNoteReadingDraftFromCorpus(draft, found.question, "found-1", capturedInputs[0]!), found,
		"older frozen Cases without Reader context remain compatible");
	assert.equal(found.cues[0]!.ref, "deep-search:found-1:cue-1");
	assert.equal(found.cues[0]!.evidence[0]!.content_sha256,
		sha256("loss = logits.cross_entropy(labels)\n"));
	assert.equal(found.cues[0]!.evidence[0]!.excerpt, "loss = logits.cross_entropy(labels)");
	assert.equal(resolveNoteReadingCue(goalDir, found.cues[0]!.ref)?.evidence[0]?.excerpt,
		"loss = logits.cross_entropy(labels)");
	assert.equal(searchSavedNoteReadingCues(goalDir, "loss cross entropy")[0]?.ref, found.cues[0]!.ref);
	await run(draft, "found-1");
	assert.equal(calls, 1, "same invocation reuses its validated artifact");
	await run(draft, "incremental-1", { originalQuestion: "Explain the training flow for a constrained deployment.", knownCues: found.cues });
	assert.equal(contexts.at(-1)!.original_question, "Explain the training flow for a constrained deployment.");
	assert.equal(contexts.at(-1)!.known_cues[0]!.status, "verified");
	assert.deepEqual(contexts.at(-1)!.known_cues[0]!.evidence[0]!.source_refs, ["S1"]);
	const formattedExcerptCue = { ...found.cues[0]!, evidence: [{ ...found.cues[0]!.evidence[0]!,
		start_line: 2, end_line: 2, excerpt: "optimizer.step()", content_sha256: sha256("  optimizer.step()  \n") }] };
	const foreignCue = { ...found.cues[0]!, evidence: [{ ...found.cues[0]!.evidence[0]!, source_id: "source:foreign" }] };
	const legacyCue = { ...found.cues[0]!, canonical_locator: "https://github.com/example/model", evidence: [{
		source_path: `${member}/finetuning/sft.py`, start_line: 1, end_line: 1, excerpt: "loss = logits.cross_entropy(labels)" }] };
	await run(draft, "navigation-1", { knownCues: [
		legacyCue,
		foreignCue,
		{ ...found.cues[0]!, evidence: [{ ...found.cues[0]!.evidence[0]!, source_path: "../../outside.py" }] },
		formattedExcerptCue,
	] });
	assert.equal(contexts.at(-1)!.known_cues[0]!.status, "verified", "legacy excerpt and locator map to original Source lines");
	assert.deepEqual(contexts.at(-1)!.known_cues[1]!.evidence[0]!.source_refs, [], "foreign Source identities grant no access");
	assert.equal(contexts.at(-1)!.known_cues[2]!.status, "recheck_required", "unsafe paths never resolve outside declared Source files");
	assert.equal(contexts.at(-1)!.known_cues[3]!.status, "verified", "the original line hash verifies an existing formatted Cornell display excerpt");
	assert.equal(resolveNoteReadingCue(goalDir, "deep-search:unknown:cue-1"), null);
	const absent = await run({ status: "not_found", summary: "No matching implementation was found.",
		gaps: ["The saved Source has no data loader."], sections: [] }, "absent-1");
	assert.equal(absent.cues.length, 0);
	await assert.rejects(run({ ...draft, sections: [{ section_title: "Training", cue_notes: [{ ...draft.sections[0]!.cue_notes[0],
		evidence: [{ source_ref: "S1", source_path: "not-a-file.py", start_line: 1, end_line: 1 }] }] }] }, "bad-1"),
		/undeclared Source path/u);
	await assert.rejects(run({ ...draft, sections: [{ section_title: "Training", cue_notes: [{ ...draft.sections[0]!.cue_notes[0],
		evidence: [{ source_ref: "S1", source_path: "reader-context.json", start_line: 1, end_line: 1 }] }] }] }, "context-citation"),
		/undeclared Source path/u, "Reader navigation never becomes citable evidence");
	await assert.rejects(run({ ...draft, sections: [{ section_title: "Training", cue_notes: [{ ...draft.sections[0]!.cue_notes[0],
		evidence: [{ source_ref: "S1", source_path: "inputs/context.md", start_line: 1, end_line: 1 }] }] }] }, "task-context-citation", { taskContextFile }),
		/undeclared Source path/u, "user preferences cannot become Source evidence");
	const newSequence = join(goalDir, "wiki", "runs", "run-2", "artifacts", "find-out-sources", "sequence-1");
	cpSync(sequence, newSequence, { recursive: true });
	const fallbackSequence = join(goalDir, "wiki", "runs", "run-1", "artifacts", "find-out-sources", "sequence-2");
	cpSync(sequence, fallbackSequence, { recursive: true });
	const fallbackManifest = JSON.parse(readFileSync(join(fallbackSequence, "manifest.json"), "utf-8"));
	fallbackManifest.sequence = 2;
	fallbackManifest.sources[0].source_id = "source:fallback";
	writeFileSync(join(fallbackSequence, "manifest.json"), JSON.stringify(fallbackManifest));
	const newManifest = JSON.parse(readFileSync(join(newSequence, "manifest.json"), "utf-8"));
	newManifest.sources[0].revision_sha256 = sha256("new-source");
	newManifest.sources.push({ ...newManifest.sources[0], source_id: "source:two", path: "sources/source-two",
		members: [{ ...newManifest.sources[0].members[0], canonical_locator: "https://github.com/example/other" }] });
	cpSync(join(newSequence, "sources", "source-one"), join(newSequence, "sources", "source-two"), { recursive: true });
	writeFileSync(join(newSequence, "manifest.json"), JSON.stringify(newManifest));
	await run(draft, "new-source-1", { knownCues: [...found.cues, legacyCue], preferredSourceRunId: "run-2" });
	assert.deepEqual(contexts.at(-1)!.preferred_source_refs, ["S1", "S3"], "new acquisition refs are prioritized while the older allowed Source remains a fallback");
	assert.deepEqual(contexts.at(-1)!.known_cues[0]!.evidence[0]!.recheck_reasons,
		["source_run_changed", "source_revision_changed"], "equal line bytes do not conceal a Source version change");
	assert.deepEqual(contexts.at(-1)!.known_cues[1]!.evidence[0]!.recheck_reasons, ["ambiguous_source"],
		"a legacy locator matching multiple allowed Sources requires rechecking");
	rmSync(join(goalDir, "wiki", "runs", "run-2"), { recursive: true });
	rmSync(fallbackSequence, { recursive: true });
	writeFileSync(join(source, member, "finetuning", "sft.py"), "loss = broken\n");
	await run(draft, "changed-bytes-1", { knownCues: [...found.cues, legacyCue] });
	assert.deepEqual(contexts.at(-1)!.known_cues[0]!.evidence[0]!.recheck_reasons,
		["content_hash_changed"], "changed original bytes require rechecking even under the same Source revision");
	assert.deepEqual(contexts.at(-1)!.known_cues[1]!.evidence[0]!.recheck_reasons, ["excerpt_changed"],
		"older anchors without hashes still require exact original-line excerpt matching");
	assert.throws(() => resolveNoteReadingCue(goalDir, found.cues[0]!.ref), /evidence changed/u);
} finally {
	uninstallCapture();
	rmSync(root, { recursive: true, force: true });
}
