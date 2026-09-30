import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AgentStageRequest, AgentStageRunner, ValidatedStageArtifact } from "../../server/agent-runtime/agent-stage-runtime.js";
import { renderCornellNoteAgentSystemPrompt } from "../../server/research/pipeline/cornell-note-agent-prompt.js";
import { sha256 } from "../../server/lib/hash.js";
import { executeDeepSearch, resolveDeepSearchCue, searchSavedDeepSearchCues,
	validateDeepSearchDraftFromCorpus } from "../../server/research/deep-search.js";

const root = mkdtempSync(join(tmpdir(), "deep-search-contract-"));
try {
	const goalDir = join(root, "goal");
	const sequence = join(goalDir, "wiki", "runs", "run-1", "artifacts", "find-out-sources", "sequence-1");
	const member = "members/github/candidate-one";
	const source = join(sequence, "sources", "source-one");
	mkdirSync(join(source, member, "finetuning"), { recursive: true });
	writeFileSync(join(source, member, "finetuning", "sft.py"), "loss = logits.cross_entropy(labels)\noptimizer.step()\n");
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
	const run = async (candidate: unknown, invocationId: string) => executeDeepSearch({
		goalDir, goalId: "goal", question: "How is the loss computed?", invocationId,
		signal: new AbortController().signal,
		model: "test/model", thinkingLevel: "medium",
		stageRunner: {
			async runStage<T>(request: AgentStageRequest<T>): Promise<ValidatedStageArtifact<T>> {
				calls++;
				assert.equal(request.systemPrompt, renderCornellNoteAgentSystemPrompt(undefined, "deep-search").content,
					"question reading receives the same shared quality rules as Source reading");
				assert.equal(request.promptConfig?.revisions?.system?.variant, "deep-search");
				const catalog = JSON.parse(readFileSync(join(request.readonlyMounts[0]!.hostPath, "catalog.json"), "utf-8"));
				assert.equal(catalog.sources.length, 1);
				assert.equal(catalog.sources[0].source_id, "source:one");
				assert.equal(catalog.sources[0].source_revision_sha256, sha256("pinned-source"));
				const path = join(request.workDirectory, "cornell-note.json");
				mkdirSync(request.workDirectory, { recursive: true });
				writeFileSync(path, JSON.stringify(candidate));
				const value = request.output.validate({ entryPath: path, outputRoot: request.workDirectory,
					workDirectory: request.workDirectory });
				assert.deepEqual(validateDeepSearchDraftFromCorpus(candidate, "How is the loss computed?",
					invocationId, request.readonlyMounts[0]!.hostPath), value,
					"captured Source replay applies the same evidence contract");
				return { value, artifact: request.artifactStore.publishFile(path, request.output.publishRelativePath),
					submissionCount: 1, validationErrors: [], session: { id: "deep-search-test", mode: "fresh" },
					turns: 1, toolCalls: 1, toolCounts: { ipython: 1 },
					usage: { inputTokens: 1, outputTokens: 1, costUsd: 0, calls: 1 }, sessionPath: "trace.jsonl" };
			},
		} satisfies AgentStageRunner,
	});
	const draft = { status: "found", summary: "Cross entropy is applied to labels.", gaps: [], sections: [{
		section_title: "Training", cue_notes: [{ cue: "Loss + cross entropy", note: "Training applies cross entropy to logits and labels.",
			evidence: [{ source_ref: "S1", source_path: `${member}/finetuning/sft.py`, start_line: 1, end_line: 1 }] }],
	}] };
	const found = await run(draft, "found-1");
	assert.equal(found.cues[0]!.ref, "deep-search:found-1:cue-1");
	assert.equal(found.cues[0]!.evidence[0]!.content_sha256,
		sha256("loss = logits.cross_entropy(labels)\n"));
	assert.equal(found.cues[0]!.evidence[0]!.excerpt, "loss = logits.cross_entropy(labels)");
	assert.equal(resolveDeepSearchCue(goalDir, found.cues[0]!.ref)?.evidence[0]?.excerpt,
		"loss = logits.cross_entropy(labels)");
	assert.equal(searchSavedDeepSearchCues(goalDir, "loss cross entropy")[0]?.ref, found.cues[0]!.ref);
	await run(draft, "found-1");
	assert.equal(calls, 1, "same invocation reuses its validated artifact");
	assert.equal(resolveDeepSearchCue(goalDir, "deep-search:unknown:cue-1"), null);
	const absent = await run({ status: "not_found", summary: "No matching implementation was found.",
		gaps: ["The saved Source has no data loader."], sections: [] }, "absent-1");
	assert.equal(absent.cues.length, 0);
	await assert.rejects(run({ ...draft, sections: [{ section_title: "Training", cue_notes: [{ ...draft.sections[0]!.cue_notes[0],
		evidence: [{ source_ref: "S1", source_path: "not-a-file.py", start_line: 1, end_line: 1 }] }] }] }, "bad-1"),
		/undeclared Source path/u);
	writeFileSync(join(source, member, "finetuning", "sft.py"), "loss = broken\n");
	assert.throws(() => resolveDeepSearchCue(goalDir, found.cues[0]!.ref), /evidence changed/u);
} finally {
	rmSync(root, { recursive: true, force: true });
}
