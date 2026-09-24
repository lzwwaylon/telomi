import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CornellNoteProcessor } from "../../server/research/cornell-note.js";
import type { LogicalSource } from "../../server/research/research-types.js";
import {
	finalizeStageOutput,
	type AgentStageRequest,
	type ValidatedStageArtifact,
} from "../../server/agent-runtime/agent-stage-runtime.js";
import {
	Run,
	RuntimeCornellNotesMaterializer,
	cornellNoteArtifactPath,
	dedupeLogicalSources,
	type SearchBatchRequest,
} from "../../server/research/pipeline/index.js";
import { RunArtifactStore } from "../../server/agent-runtime/artifact-store.js";
import { PRIME_MODEL_DEFINITIONS_ENV } from "../../server/agent-runtime/prime-agent-paths.js";
import { RunStateStore } from "../../server/research/run-state.js";

const root = mkdtempSync(join(tmpdir(), "telomi-cornell-notes-"));
try {
	const documents: LogicalSource[] = [
		source("source:a", "https://example.test/a", "a".repeat(64)),
		source("source:b", "https://example.test/b", "b".repeat(64)),
		source("source:c", "https://example.test/c", "c".repeat(64)),
	];
	let processorCalls = 0;
		const processor: CornellNoteProcessor = {
			async process(input) {
				processorCalls += 1;
				return { notes: input.sources.map((document) => ({
					source: document,
				artifactRef: `artifacts/cornell-notes/${document.id}.json`,
				note: {
					schema_version: 1,
					source_id: document.id,
					sections: document.id === "source:c" ? [] : [{
						section_title: "Topic",
						summary: `Summary for ${document.id}`,
						cue_notes: [{
							cue: "Cue + keyword",
							note: `Note for ${document.id}`,
							evidence: [{ source_path: "document.md", start_line: 1, end_line: 1,
								content_sha256: "f".repeat(64) }],
						}],
					}],
				},
				})), failures: [] };
			},
		};
	const materializer = new RuntimeCornellNotesMaterializer(processor);
	const firstResult = await materializer.materialize(request(1, documents));
	const first = firstResult.evidence;
	assert.deepEqual(firstResult.failures, []);
	assert.equal(first.schema_version, 1);
	assert.equal(first.notes.length, 3, "an empty partial Note is still a completed Source review");
	assert.ok(!("screening" in first));
	assert.ok(!("evidence_note_refs" in first));

	const secondResult = await materializer.materialize({ ...request(2, documents), previousSnapshot: first });
	const second = secondResult.evidence;
	assert.equal(processorCalls, 1, "unchanged Source revisions must reuse embedded Cornell Notes");
	assert.deepEqual(second.notes, first.notes);
	const upgraded = (await materializer.materialize({
		...request(3, documents),
		pipeline: { id: "pipeline", version: "2", sha256: "e".repeat(64) },
		previousSnapshot: second,
	})).evidence;
	assert.equal(processorCalls, 2, "a changed Cornell pipeline must reprocess unchanged Sources");
	assert.equal(upgraded.pipeline.version, "2");
	const previousWithUnrelatedNote = {
		...second,
		notes: [...second.notes, {
			...second.notes[0]!,
			note: { ...second.notes[0]!.note, source_id: "source:unrelated" },
			canonical_locator: "https://example.test/unrelated",
			source_revision_sha256: "e".repeat(64),
			members: second.notes[0]!.members.map((member) => ({
				...member,
				source_id: "source:unrelated",
				canonical_locator: "https://example.test/unrelated",
			})),
		}],
	};
	const filtered = (await materializer.materialize({ ...request(3, documents), previousSnapshot: previousWithUnrelatedNote })).evidence;
	assert.deepEqual(filtered.notes.map((record) => record.note.source_id), documents.map((document) => document.id),
		"cross-Run cache must not inject Notes for Sources absent from the current Search result");

	documents[0] = source("source:a", "https://example.test/a", "d".repeat(64));
	const third = (await materializer.materialize({ ...request(4, documents), previousSnapshot: second })).evidence;
	assert.equal(processorCalls, 3, "a changed Source revision must run the Agent again");
	assert.equal(third.notes.length, 3);
	assert.equal(dedupeLogicalSources([
		source("source:incremental", "https://example.test/incremental", "1".repeat(64)),
		source("source:incremental", "https://example.test/incremental", "2".repeat(64)),
	])[0]?.revisionSha256, "2".repeat(64), "the latest Logical Source revision replaces its earlier batch revision");

	const checkpointStore = new RunArtifactStore(root);
	checkpointStore.publishText(
		`${JSON.stringify(first.notes[0]!.note)}\n`,
		cornellNoteArtifactPath(6, documents[0]!.id, documents[0]!.revisionSha256),
	);
	let resumedSourceIds: string[] = [];
	const resumedFromFiles = await new RuntimeCornellNotesMaterializer({
		async process(input) {
			resumedSourceIds = input.sources.map((document) => document.id);
			return {
				notes: input.sources.map((document) => ({
					source: document,
					artifactRef: `artifacts/cornell-notes/sequence-6/${document.id.slice(7)}.json`,
					note: { schema_version: 1, source_id: document.id, sections: [] },
				})),
				failures: [],
			};
		},
	}).materialize({ ...request(6, documents), artifactStore: checkpointStore });
	assert.deepEqual(resumedSourceIds, ["source:b", "source:c"],
		"resume must reuse per-Source Note artifacts published before the Snapshot");
	assert.deepEqual(resumedFromFiles.evidence.notes.map((record) => record.note.source_id),
		["source:a", "source:b", "source:c"]);

	const degraded = await new RuntimeCornellNotesMaterializer({
		async process(input) {
			return {
				notes: input.sources.filter((document) => document.id !== "source:b").map((document) => ({
					source: document,
					artifactRef: `artifacts/cornell-notes/${document.id}.json`,
					note: {
						schema_version: 1,
						source_id: document.id,
						sections: [],
					},
				})),
				failures: [{ source: input.sources[1]!, message: "invalid Cornell section" }],
			};
		},
	}).materialize(request(5, documents));
	assert.deepEqual(degraded.evidence.notes.map((record) => record.note.source_id), ["source:a", "source:c"]);
	assert.deepEqual(degraded.failures, [{
		source_id: "source:b",
		title: "source:b",
		canonical_locator: "https://example.test/b",
		failure_class: "agent_stage_failed",
		message: "invalid Cornell section",
	}]);

	const runWorkspace = join(root, "degraded-run", "workspace");
	const runControl = join(root, "degraded-run", "control");
	const bundleDirectory = join(root, "degraded-run", "bundle");
	const findOutDirectory = join(root, "degraded-run", "find-out");
	for (const directory of [bundleDirectory, findOutDirectory]) {
		mkdirSync(directory, { recursive: true });
		writeFileSync(join(directory, "manifest.json"), "{}\n");
	}
	const runSources = [
		source("source:run-a", "https://example.test/run-a", "1".repeat(64)),
		source("source:run-b", "https://example.test/run-b", "2".repeat(64)),
	];
	writeFileSync(join(root, "parent-model-definitions.json"), "{}\n");
	let writerCalls = 0;
	let wikiEnvironment: NodeJS.ProcessEnv | undefined;
	const degradedRun = new Run({
		wikiAgent: { async compile(request) {
			wikiEnvironment = request.env;
			throw new Error("Controlled Wiki compiler stop after configuration handoff");
		} },
		publishWikiCompilation: async () => { throw new Error("Unexpected Wiki publication"); },
		stageRunner: {
			async runStage<T>(stageRequest: AgentStageRequest<T>): Promise<ValidatedStageArtifact<T>> {
				writerCalls++;
				const inputs = stageRequest.readonlyMounts.find((mount) => mount.guestPath === "/inputs")!;
				const projectedFailures = JSON.parse(readFileSync(join(inputs.hostPath, "cornell-failures.json"), "utf-8")) as {
					failed_source_count: number;
					failed_sources: Array<Record<string, unknown>>;
				};
				assert.equal(projectedFailures.failed_source_count, 1);
				assert.equal(projectedFailures.failed_sources[0]?.title, "source:run-b");
				assert.equal("source_id" in projectedFailures.failed_sources[0]!, false,
					"Report Agent must not receive Runtime Source IDs");
				mkdirSync(stageRequest.workDirectory, { recursive: true });
				mkdirSync(join(stageRequest.workDirectory, "writer-output", "sections"), { recursive: true });
				writeFileSync(join(stageRequest.workDirectory, "writer-output", "outline.json"), JSON.stringify({
					title: "Degraded Cornell report",
					sections: [{
						section_id: "section-001",
						title: "Available evidence",
						purpose: "Report available evidence and its coverage limitation.",
						cornell_notes_refs: ["@1"],
					}],
				}));
				writeFileSync(join(stageRequest.workDirectory, "writer-output", "sections", "section-001.md"),
					"The available Source supports this finding. <cite>https://example.test/run-a</cite>\n\nOne Source Note was unavailable, so coverage is incomplete.\n");
				writeFileSync(join(stageRequest.workDirectory, "writer-output", "manifest.json"), JSON.stringify({
					schema_version: 1,
					sections: [{ section_id: "section-001", path: "sections/section-001.md", title: "Available evidence" }],
				}));
				const finalized = await finalizeStageOutput(stageRequest);
				return {
					value: finalized.value,
					artifact: finalized.artifact,
					submissionCount: 1,
					validationErrors: [],
					session: { id: stageRequest.stageId, mode: "fresh" },
					turns: 1,
					toolCalls: 1,
					toolCounts: { submit_stage_output: 1 },
					usage: { inputTokens: 1, outputTokens: 1, costUsd: 0, calls: 1 },
					sessionPath: join(runControl, `${stageRequest.stageId}.jsonl`),
				};
			},
		} as never,
		searchBatchExecutor: {
			async execute(searchRequest: SearchBatchRequest) {
				const bundle = searchRequest.artifactStore.publishDirectory(bundleDirectory, "artifacts/source-bundles/test");
				return {
					logicalSources: searchRequest.runId === "run:no-results" ? [] : runSources,
					sourceBundles: [bundle],
					findOutSources: searchRequest.artifactStore.publishDirectory(
						findOutDirectory, "artifacts/find-out-sources/sequence-1",
					),
					executionRecords: [],
					usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, calls: 0 },
					agentStages: 0,
					toolCalls: 0,
				};
			},
		},
		evidenceMaterializer: {
			async materialize(materializeRequest) {
				if (["run:all-failed", "run:no-results"].includes(materializeRequest.runId)) {
					return {
						evidence: {
							schema_version: 1 as const,
							snapshot_id: "snapshot:all-failed",
							run_id: materializeRequest.runId,
							pipeline: materializeRequest.pipeline,
							source_bundle_refs: materializeRequest.sourceBundleRefs,
							notes: [],
						},
						failures: materializeRequest.sources.map((source) => ({
							source_id: source.id,
							title: source.title,
							canonical_locator: source.url,
							failure_class: "agent_stage_failed" as const,
							message: "invalid Cornell section",
						})),
					};
				}
				return {
					evidence: {
						schema_version: 1,
						snapshot_id: "snapshot:degraded",
						run_id: materializeRequest.runId,
						pipeline: materializeRequest.pipeline,
						source_bundle_refs: materializeRequest.sourceBundleRefs,
						notes: [{
							note: { schema_version: 1, source_id: runSources[0]!.id, sections: [{
								section_title: "Finding",
								summary: "The available Source supports the finding.",
								cue_notes: [{
									cue: "Finding + support",
									note: "The available Source supports the finding.",
									evidence: [{ source_path: "document.md", start_line: 1, end_line: 1,
										content_sha256: "5".repeat(64) }],
								}],
							}] },
							title: runSources[0]!.title,
							canonical_locator: runSources[0]!.url,
							provider_id: runSources[0]!.providerId,
							provenance_ref: "provider:test:run-a",
							source_revision_sha256: runSources[0]!.revisionSha256,
							members: [],
						}],
					},
					failures: [{
						source_id: runSources[1]!.id,
						title: runSources[1]!.title,
						canonical_locator: runSources[1]!.url,
						failure_class: "agent_stage_failed" as const,
						message: "invalid Cornell section",
					}],
				};
			},
		},
		validateCitationUrls: async () => new Set<string>(),
	});
	const degradedRequest = {
		runId: "run:degraded",
		goalId: "goal:degraded",
		question: "Continue after one Cornell Source fails.",
		reportContext: "Explain the acquired evidence and explicitly identify missing support.",
		language: "en",
		workspaceDirectory: runWorkspace,
		controlDirectory: runControl,
		goalWorkspaceDirectory: join(root, "degraded-run", "goal"),
		workspaceRootDirectory: root,
		agentSkillIndexes: { "prime-search": "", "cornell-note": "", "report-writer": "" },
		providerCatalog: [{ id: "test", capability: "test", sourceClass: "professional" }],
		temporalContext: { schemaVersion: 1, currentDate: "2026-08-28", timeZone: "UTC" },
		pipeline: { id: "pipeline", version: "1", sha256: "3".repeat(64) },
		identityPins: {
			harness_snapshot: "harness", workspace_content_hash: "a".repeat(64), knowledge_memory_hash: "knowledge",
			run_context_snapshot: "4".repeat(64), pipeline: "pipeline", prompt_bundle: "prompt",
			schema_bundle: "schema", model_policy: "model", skill_bundle: "skill", tool_schema: "tool",
		},
		topicPlan: { schema_version: 1, goal_id: "goal:degraded", revision: "test-v1", status: "active", topics: [{ id: "evidence", title: "Evidence", intent: "Research evidence", questions: [], include: [], exclude: [] }] },
		env: { [PRIME_MODEL_DEFINITIONS_ENV]: join(root, "parent-model-definitions.json"), TELOMI_RUNTIME_SENTINEL: "retained", TELOMI_PRIME_REPORT_THINKING_LEVEL: "high", TELOMI_PRIME_AGENT_ROOT_MODEL: "test/root", TELOMI_PRIME_AGENT_CHILD_MODEL: "test/child", TELOMI_RESEARCH_CORNELL_NOTE_MODEL: "test/note" },
		signal: new AbortController().signal,
	};
	const degradedResult = await degradedRun.run(degradedRequest as never);
	assert.ok(wikiEnvironment, "Research must start the independent Wiki Update");
	assert.equal(wikiEnvironment.TELOMI_PRIME_AGENT_CHILD_MODEL, undefined, "Wiki must resolve current child configuration");
	assert.equal(wikiEnvironment.TELOMI_PRIME_AGENT_ROOT_MODEL, undefined);
	assert.equal(wikiEnvironment.TELOMI_RESEARCH_CORNELL_NOTE_MODEL, undefined);
	assert.equal(wikiEnvironment.TELOMI_PRIME_REPORT_THINKING_LEVEL, undefined);
	assert.equal(wikiEnvironment[PRIME_MODEL_DEFINITIONS_ENV], undefined, "Wiki must freeze its own connection definitions");
	assert.equal(wikiEnvironment.TELOMI_RUNTIME_SENTINEL, "retained");
	assert.equal(degradedRequest.env.TELOMI_PRIME_AGENT_CHILD_MODEL, "test/child", "parent Run pins remain intact");
	const degradedState = new RunStateStore(runControl).load()!;
	assert.equal(degradedResult.state.status, "published",
		"a failed Cornell Source must still produce a published report");
	assert.equal(degradedState.failure, undefined);
	assert.equal(degradedState.cornell_note_snapshots.length, 1);
	assert.equal(degradedState.cornell_note_failure_manifests?.length, 1);
	assert.equal(degradedState.cornell_note_failure_count, 1);
	const failureManifest = JSON.parse(readFileSync(join(
		runWorkspace,
		degradedState.cornell_note_failure_manifests![0]!.relative_path,
	), "utf-8")) as { failures: Array<{ source_id: string }> };
	assert.deepEqual(failureManifest.failures.map((failure) => failure.source_id), ["source:run-b"]);
	const allFailedWorkspace = join(root, "all-failed-run", "workspace");
	const allFailedControl = join(root, "all-failed-run", "control");
	await assert.rejects(degradedRun.run({
		...degradedRequest,
		runId: "run:all-failed",
		goalId: "goal:all-failed",
		workspaceDirectory: allFailedWorkspace,
		controlDirectory: allFailedControl,
		goalWorkspaceDirectory: join(root, "all-failed-run", "goal"),
	} as never), /All 2 Cornell Note Agents failed/u);
	const allFailedState = new RunStateStore(allFailedControl).load()!;
	assert.equal(allFailedState.status, "failed");
	assert.equal(allFailedState.failure?.failed_stage, "evidence_materializing");
	assert.equal(allFailedState.cornell_note_failure_count, 2);
	const beforeEmpty = writerCalls;
	const emptyControl = join(root, "empty-run", "control");
	await assert.rejects(degradedRun.run({
		...degradedRequest,
		runId: "run:no-results", goalId: "goal:no-results",
		workspaceDirectory: join(root, "empty-run", "workspace"),
		controlDirectory: emptyControl,
		goalWorkspaceDirectory: join(root, "empty-run", "goal"),
	} as never), /no usable source evidence/);
	assert.equal(writerCalls, beforeEmpty, "a complete Search with zero Sources must not start Writer");
	const emptyState = new RunStateStore(emptyControl).load()!;
	assert.equal(emptyState.failure?.failed_stage, "evidence_materializing");
	assert.equal(emptyState.cornell_note_snapshots.length, 1, "retain the empty evidence snapshot for diagnosis");
	console.log("Cornell Note materialization tests passed");
} finally {
	rmSync(root, { recursive: true, force: true });
}

function request(sequence: number, documents: LogicalSource[]) {
	return {
		runId: "run:test",
		sequence,
		question: "What is supported?",
		goal: { title: "Test Goal", description: "" },
		discoveryEnabled: false,
		sources: documents,
		sourceBundleRefs: ["artifacts/source-bundles/bundle-1"],
		pipeline: { id: "pipeline", version: "1", sha256: "f".repeat(64) },
		workspaceDir: root,
		controlDir: join(root, "control"),
		signal: new AbortController().signal,
	};
}

function source(id: string, url: string, revision: string): LogicalSource {
	return {
		id,
		title: id,
		url,
		providerId: "provider-test",
		sourceIdentity: id,
		revisionSha256: revision,
		directoryPath: root,
		organizationKind: "ungrouped",
		members: [],
	};
}
