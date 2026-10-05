import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { RunArtifactStore } from "../../server/agent-runtime/artifact-store.js";
import type { AgentStageRequest, AgentStageRunner, ValidatedStageArtifact } from "../../server/agent-runtime/agent-stage-runtime.js";
import { readExternalSources } from "../../server/research/external-search.js";
import { resolveNoteReadingCue } from "../../server/research/note-reading.js";
import { materializeOrganizedSources } from "../../server/research/pipeline/organized-sources.js";
import type { SearchBatchRequest, SearchBatchExecutor, SearchBatchResult } from "../../server/research/pipeline/search-batch.js";

const root = mkdtempSync(join(tmpdir(), "telomi-external-search-"));
const usage = { inputTokens: 3, outputTokens: 2, costUsd: 0, calls: 1 };
const goalDir = join(root, "goal");
const runDir = join(root, "investigation");
const investigationId = "a".repeat(24);
const sourceRunId = `external-${investigationId}-1`;
const question = "What does the current paper document?";
const content = "The current paper documents the feature.\nIt supports the requested behavior.\n";

function materialize(store: RunArtifactStore, workingDirectory: string, text: string) {
	const material = join(workingDirectory, "material");
	mkdirSync(material, { recursive: true });
	writeFileSync(join(material, "paper.md"), text);
	return materializeOrganizedSources({ artifactStore: store, sequence: 1, workingDirectory,
		members: [{ candidateId: "candidate-paper", sourceId: "source-paper", providerId: "arxiv",
			title: "Official paper", url: "https://arxiv.org/abs/2601.00001", summary: "Feature description",
			sourceDirectory: material }], organization: { groups: [],
			ungrouped: [{ candidate_id: "candidate-paper", reason: "Directly relevant paper" }] } });
}

try {
	// A lexically later historical Run has the same Source identity and an obsolete revision.
	const previous = materialize(new RunArtifactStore(join(goalDir, "wiki", "runs", "zz-previous")),
		join(root, "previous-build"), "The previous paper lacks the feature.\n");
	let searches = 0;
	let readings = 0;
	let statusChecks = 0;
	let acquired: ReturnType<typeof materialize> | undefined;
	const sourceStatus = { async verifyIfStale(maxAgeMs: number) {
		statusChecks++;
		assert.ok(maxAgeMs > 0);
	}, excludedSourceIds: () => ["github"] };
	const executor: SearchBatchExecutor = {
		async execute(request: SearchBatchRequest): Promise<SearchBatchResult> {
			searches++;
			assert.equal(request.question, question);
			assert.equal(request.goalId, "goal");
			assert.ok(request.availableProviderIds.includes("arxiv"), "general acquisition includes a non-GitHub Provider");
			assert.ok(!request.availableProviderIds.includes("github"), "unavailable Providers are excluded");
			assert.ok(request.controlDirectory.startsWith(runDir));
			assert.equal(request.workspaceDirectory, goalDir);
			acquired = materialize(request.artifactStore, join(request.controlDirectory, "test-source-build"), content);
			assert.equal(acquired.sources[0]!.id, previous.sources[0]!.id);
			assert.notEqual(acquired.sources[0]!.revisionSha256, previous.sources[0]!.revisionSha256);
			return { logicalSources: acquired.sources, organizedSources: acquired.artifact, sourceBundles: [],
				executionRecords: [], usage, agentStages: 1, toolCalls: 1 };
		},
	};
	const stageRunner: AgentStageRunner = {
		async runStage<T>(request: AgentStageRequest<T>): Promise<ValidatedStageArtifact<T>> {
			readings++;
			const corpus = request.readonlyMounts[0]!.hostPath;
			const catalog = JSON.parse(readFileSync(join(corpus, "catalog.json"), "utf-8")) as {
				sources: Array<{ ref: string; source_id: string; source_run_id: string; source_revision_sha256: string }>;
			};
			assert.equal(catalog.sources.length, 1);
			assert.equal(catalog.sources[0]!.source_run_id, sourceRunId, "Cornell reads the newly acquired revision");
			assert.equal(catalog.sources[0]!.source_revision_sha256, acquired!.sources[0]!.revisionSha256);
			const path = `${acquired!.sources[0]!.members[0]!.path}/paper.md`;
			assert.equal(readFileSync(join(corpus, catalog.sources[0]!.ref, path), "utf-8"), content);
			const draft = { status: "found", summary: "The feature is documented.", gaps: [], sections: [{
				section_title: "Feature", cue_notes: [{ cue: "Feature description", note: "The current paper documents the feature.",
					evidence: [{ source_ref: catalog.sources[0]!.ref, source_path: path, start_line: 1, end_line: 1 }] }] }] };
			mkdirSync(request.workDirectory, { recursive: true });
			const output = join(request.workDirectory, "note.json");
			writeFileSync(output, JSON.stringify(draft));
			const value = request.output.validate({ entryPath: output, outputRoot: request.workDirectory,
				workDirectory: request.workDirectory });
			return { value, artifact: request.artifactStore.publishFile(output, request.output.publishRelativePath),
				submissionCount: 1, validationErrors: [], session: { id: "note-test", mode: "fresh" },
				turns: 1, toolCalls: 1, toolCounts: { ipython: 1 }, usage, sessionPath: "trace.jsonl" };
		},
	};
	const input = { goalDir, goalId: "goal", runDir, investigationId, sequence: 1, question,
		signal: new AbortController().signal, env: { TELOMI_NOTE_AGENT_MODEL: "test/model" },
		searchBatchExecutor: executor, sourceStatus, stageRunner };
	const result = await readExternalSources(input);
	assert.equal(searches, 1);
	assert.equal(readings, 1);
	assert.ok(statusChecks > 0);
	assert.equal(result.status, "found");
	assert.equal(result.sources[0]!.id, acquired!.sources[0]!.id);
	assert.equal(result.sources[0]!.revision_sha256, acquired!.sources[0]!.revisionSha256);
	assert.equal(result.cues[0]!.evidence[0]!.source_run_id, sourceRunId);
	assert.equal(resolveNoteReadingCue(goalDir, result.cues[0]!.ref)?.evidence[0]!.excerpt,
		"The current paper documents the feature.");
	assert.ok(existsSync(join(goalDir, "wiki", "runs", sourceRunId, "artifacts", "find-out-sources", "sequence-1")));
	assert.deepEqual(await readExternalSources(input), result);
	assert.equal(searches, 1, "same invocation reuses the validated acquisition");
	assert.equal(readings, 1, "same invocation reuses the validated Cornell result");
	await assert.rejects(readExternalSources({ ...input, question: "A different gap" }), /different|another|belongs/u);

	let failedControl = "";
	let failedStaging = "";
	await assert.rejects(readExternalSources({ ...input, sequence: 2, searchBatchExecutor: {
		async execute(request) {
			failedControl = request.controlDirectory;
			failedStaging = request.artifactStore.root;
			mkdirSync(failedControl, { recursive: true });
			writeFileSync(join(failedControl, "interrupted-acquisition.json"), "{}\n");
			mkdirSync(failedStaging, { recursive: true });
			writeFileSync(join(failedStaging, "unfinished-source.txt"), "not yet validated\n");
			throw new Error("acquisition failed");
		},
	} }), /acquisition failed/u);
	assert.ok(existsSync(join(failedControl, "interrupted-acquisition.json")), "failed acquisition retains its control record");
	assert.ok(existsSync(join(failedStaging, "unfinished-source.txt")), "failed acquisition retains recoverable staging");
	assert.ok(!existsSync(join(goalDir, "wiki", "runs", `external-${investigationId}-2`)), "incomplete Sources are never published");
	assert.equal(readings, 1, "Cornell does not read a failed acquisition");
} finally {
	rmSync(root, { recursive: true, force: true });
}

console.log("Generic external acquisition, Source publication and Cornell reading contracts passed");
