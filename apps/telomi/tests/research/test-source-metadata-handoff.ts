import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AgentStageRequest, AgentStageRunner } from "../../server/agent-runtime/agent-stage-runtime.js";
import { RunArtifactStore } from "../../server/agent-runtime/artifact-store.js";
import { beginNodeEvaluationCase } from "../../server/agent-runtime/node-evaluation.js";
import { sha256 } from "../../server/lib/hash.js";
import { writeInvestigationAnswerInput } from "../../server/research/investigation-answer.js";
import { executeNoteReading, resolveNoteReadingCue, validateNoteReadingDraftFromCorpus } from "../../server/research/note-reading.js";
import { inspectAgentSourceView, materializeAgentSourceView } from "../../server/research/pipeline/agent-source-view.js";
import { materializeOrganizedSources } from "../../server/research/pipeline/organized-sources.js";
import { materializePrimeSources } from "../../server/research/pipeline/prime-search-batch.js";
import { submitProviderCandidateLedger } from "../../server/research/pipeline/prime-search-contract.js";
import { writeSourceAcquisitionMetadata } from "../../server/research/pipeline/source-acquisition-metadata.js";

const root = mkdtempSync(join(tmpdir(), "source-metadata-handoff-"));
try {
	const acquisition = join(root, "acquisition");
	const child = "sub-catalog";
	const workspace = join(acquisition, "provider-executions", child);
	const materials = join(workspace, "work", "materials", "model");
	mkdirSync(materials, { recursive: true });
	writeFileSync(join(materials, "README.md"), "# Example model\nThe model supports voice synthesis.\n");
	const providerId = "fixture-catalog";
	const url = "https://example.invalid/models/example";
	const query = "models(search='voice', sort='created_at')";
	const metadata = { created_at: "2026-01-21T08:56:49.000Z", updated_at: "2026-01-29T08:00:54.000Z",
		repo_id: "example/model", discovery_queries: [query], tags: ["text-to-speech"],
		discovery_lanes: [{ pipeline_tag: "text-to-speech", lane: "trending", rank: 3 },
			{ pipeline_tag: "text-to-speech", lane: "created_range", rank: 8 }],
		candidate_date_evidence: { kind: "associated_paper_month", month: "2026-03", arxiv_tag: "arxiv:2603.25551", model_release_verified: false },
		pdf_url: "https://example.invalid/paper?version=2", document_url: "https://example.invalid/download?access_token=fixture-secret",
		author: { name: "Author", token: "nested-secret" }, language: "/private/host/language",
		artifact_path: "artifacts/private/README.md", provider_artifact_path: "/private/host/material.md",
		access_token: "fixture-secret", hmac: "fixture-hmac", provider_implementation: "internal",
		material_cache_hit: true, huggingface_page: { next_cursor: "private-cursor" },
		card_data: { token: "nested-secret" } };
	writeFileSync(join(workspace, "work", `${providerId}_candidates.json`), JSON.stringify({ candidates: [{
		title: "Example model", url, query, summary: "An acquisition selection, not a Provider assertion.", metadata,
		material_paths: ["work/materials/model"],
	}] }));
	await submitProviderCandidateLedger(acquisition, child, providerId);
	const execution = { execution_id: `provider-execution:1:${providerId}:${child}`, provider_id: providerId,
		workspace_path: `provider-executions/${child}` };
	const items = materializePrimeSources(acquisition, [execution]);
	const item = items[0]!;
	const original = join(acquisition, item.directory);
	const metadataFile = "acquisition-metadata.json";
	assert.ok(existsSync(join(original, metadataFile)), "metadata must exist in the original Source before its revision is frozen");
	const retainedText = readFileSync(join(original, metadataFile), "utf8");
	const retained = JSON.parse(retainedText);
	assert.equal(retained.provenance, "provider_child_candidate_ledger");
	assert.equal(retained.provider_id, providerId, "unknown Providers use the same metadata handoff");
	assert.equal(retained.canonical_locator, url);
	assert.deepEqual(retained.acquisition_context, { query });
	assert.deepEqual(retained.metadata, { created_at: metadata.created_at, updated_at: metadata.updated_at,
		repo_id: metadata.repo_id, discovery_queries: [query], tags: metadata.tags, pdf_url: metadata.pdf_url,
		discovery_lanes: metadata.discovery_lanes, candidate_date_evidence: metadata.candidate_date_evidence });
	assert.match(retained.interpretation, /not.*first public release/iu);
	assert.doesNotMatch(retainedText, /private\/host|fixture-secret|fixture-hmac|private-cursor|nested-secret|internal/u);
	const unsafeMetadata = join(root, "unsafe-metadata");
	mkdirSync(unsafeMetadata);
	writeSourceAcquisitionMetadata(unsafeMetadata, { provider_id: providerId, url, query, metadata: {
		discovery_lanes: [{ ...metadata.discovery_lanes[0], hmac: "nested-secret" }],
		candidate_date_evidence: { ...metadata.candidate_date_evidence, control: { token: "nested-secret" } },
	} });
	assert.deepEqual(JSON.parse(readFileSync(join(unsafeMetadata, metadataFile), "utf8")).metadata, {},
		"known structures cannot carry extra control or secret fields into citable metadata");
	assert.deepEqual(JSON.parse(readFileSync(join(original, "record.json"), "utf8")).metadata, metadata,
		"the complete control record stays archived without becoming Agent evidence");
	const projected = materializeAgentSourceView(original, join(root, "projected"));
	assert.deepEqual(projected.contentFiles.map(file => file.relativePath).sort(), ["README.md", metadataFile].sort());
	assert.equal(existsSync(join(projected.directoryPath, "record.json")), false);
	assert.equal(readFileSync(join(projected.directoryPath, metadataFile), "utf8"), retainedText);
	assert.equal(readFileSync(join(original, "README.md"), "utf8"), "# Example model\nThe model supports voice synthesis.\n");
	const legacy = join(root, "legacy");
	mkdirSync(legacy);
	writeFileSync(join(legacy, "README.md"), "Historical Source.\n");
	writeFileSync(join(legacy, "record.json"), JSON.stringify({ metadata }));
	const legacyView = materializeAgentSourceView(legacy, join(root, "legacy-view"));
	assert.deepEqual(legacyView.contentFiles.map(file => file.relativePath), ["README.md"],
		"view construction never invents citable files outside an old immutable Source revision");
	assert.equal(existsSync(join(legacy, metadataFile)), false);

	const goalDir = join(root, "goal"), runId = "source-run";
	const store = new RunArtifactStore(join(goalDir, "wiki", "runs", runId));
	const organized = materializeOrganizedSources({ artifactStore: store, sequence: 1,
		workingDirectory: join(root, "organization"), organization: { groups: [], ungrouped: [{ candidate_id: item.candidate_id, reason: "one Source" }] },
		members: [{ candidateId: item.candidate_id, sourceId: "source:catalog-model", providerId, title: item.title,
			url, summary: item.summary, sourceDirectory: projected.directoryPath }] });
	const logical = organized.sources[0]!;
	const sourcePath = `${logical.members[0]!.path}/${metadataFile}`;
	const line = retainedText.split("\n").findIndex(value => value.includes('"created_at"')) + 1;
	const laneLine = retainedText.split("\n").findIndex(value => value.includes('"lane": "created_range"')) + 1;
	const qualificationLine = retainedText.split("\n").findIndex(value => value.includes('"model_release_verified": false')) + 1;
	const excerpt = retainedText.split("\n")[line - 1]!;
	const draft = { status: "found", summary: "The retained catalog metadata supplies a creation timestamp.", gaps: [], sections: [{
		section_title: "Repository metadata", cue_notes: [{ cue: "The catalog records a creation timestamp.",
			note: "created_at is retained without treating it as the model's first public release date.",
			evidence: [line, laneLine, qualificationLine].map(number => ({ source_ref: "S1", source_path: sourcePath, start_line: number, end_line: number })) }],
	}] };
	let capturedCorpus = "";
	const runner: AgentStageRunner = { async runStage<T>(request: AgentStageRequest<T>) {
		const corpus = request.readonlyMounts.find(mount => mount.guestPath === "/source")!.hostPath;
		assert.equal(readFileSync(join(corpus, "S1", sourcePath), "utf8"), retainedText);
		const capture = beginNodeEvaluationCase({ request: { ...request, evaluation: { agentId: "note-agent",
			recipe: { id: "note-agent", version: 3 }, recipeInput: { mode: "question-reading" }, inputGuestPath: "/source",
			harnessMounts: [], liveExternalState: false } }, recordDirectory: request.recordDirectory!,
			promptConfig: request.promptConfig!, sessionContextFile: join(root, "missing-session.jsonl"),
			composedSystemPrompt: request.systemPrompt, actualModel: "fixture/model" });
		assert.ok(capture);
		capturedCorpus = join(capture.caseDirectory, "input");
		mkdirSync(request.workDirectory, { recursive: true });
		const entryPath = join(request.workDirectory, "note.json");
		writeFileSync(entryPath, JSON.stringify(draft));
		const value = request.output.validate({ entryPath, outputRoot: request.workDirectory, workDirectory: request.workDirectory });
		return { value, artifact: request.artifactStore.publishFile(entryPath, request.output.publishRelativePath),
			submissionCount: 1, validationErrors: [], session: { id: "fixture", mode: "fresh" }, turns: 1,
			toolCalls: 1, toolCounts: { read: 1 }, usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, calls: 0 },
			sessionPath: join(root, "missing-session.jsonl") };
	} };
	const result = await executeNoteReading({ goalDir, goalId: "goal", question: "What creation metadata was retained?",
		invocationId: "metadata-reading", model: "fixture/model", childModel: "fixture/child", stageRunner: runner,
		signal: new AbortController().signal });
	assert.equal(result.cues[0]!.evidence[0]!.content_sha256, sha256(`${excerpt}\n`));
	assert.equal(result.cues[0]!.evidence[0]!.source_revision_sha256, logical.revisionSha256);
	assert.deepEqual(validateNoteReadingDraftFromCorpus(draft, result.question, "metadata-reading", capturedCorpus), result,
		"frozen Replay retains the metadata bytes after Reader cleanup");
	const resolved = resolveNoteReadingCue(goalDir, result.cues[0]!.ref);
	assert.ok(resolved);
	assert.equal(resolved.evidence[0]!.excerpt, excerpt, "a saved Note citation resolves against the original immutable Source");
	const writerInputs = join(root, "writer-inputs");
	writeInvestigationAnswerInput({ inputRoot: writerInputs, goalDir, request: { schema_version: 1,
		question: result.question, context: "", language: "en", requirements: [{ id: "Q1", question: result.question }], evidence_refs: ["N1"] },
		evidence: [{ ...resolved, ref: "N1" }] });
	assert.equal(readFileSync(join(writerInputs, "sources", "S1", sourcePath), "utf8"), retainedText,
		"Writer receives the same original metadata with resolvable line citations");

	// A Provider file cannot silently replace the Runtime-owned metadata document.
	const collision = join(root, "collision");
	const collisionWorkspace = join(collision, "provider-executions", child);
	mkdirSync(join(collisionWorkspace, "work", "materials", "model"), { recursive: true });
	writeFileSync(join(collisionWorkspace, "work", "materials", "model", metadataFile), "{\"created_at\":\"forged\"}\n");
	writeFileSync(join(collisionWorkspace, "work", `${providerId}_candidates.json`), JSON.stringify({ candidates: [{
		title: "Example model", url, query, summary: "Collision", metadata, material_paths: ["work/materials/model"],
	}] }));
	await submitProviderCandidateLedger(collision, child, providerId);
	assert.throws(() => materializePrimeSources(collision, [execution]), /acquisition-metadata\.json|EEXIST/u);
	assert.ok(inspectAgentSourceView(logical.directoryPath).contentFiles.some(file => file.relativePath === sourcePath));
} finally {
	rmSync(root, { recursive: true, force: true });
}
console.log("Source metadata remains citable across acquisition, Reader cleanup, saved Notes, Writer inputs and Replay");
