import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { finalizeStageOutput, type AgentStageRequest, type AgentStageRunner } from "../../server/agent-runtime/agent-stage-runtime.js";
import { Run } from "../../server/research/pipeline/index.js";
import { reportWriterUsesChineseLint } from "../../server/research/pipeline/prime-report-writer.js";
import { RunArtifactStore } from "../../server/agent-runtime/artifact-store.js";
import type { CornellNotesSnapshot } from "../../server/cornell/contracts.js";

const root = mkdtempSync(join(tmpdir(), "telomi-report-run-"));
try {
	await verifyWikiMode();
	console.log("report flow tests passed");
} finally {
	rmSync(root, { recursive: true, force: true });
}

async function verifyWikiMode(): Promise<void> {
	const inputMode = "wiki" as const;
	const runRoot = join(root, inputMode, "run");
	const controlRoot = join(root, inputMode, "control");
	const goalRoot = join(root, inputMode, "goal");
	const wikiRoot = join(root, inputMode, "wiki");
	mkdirSync(wikiRoot, { recursive: true });
	writeFileSync(join(wikiRoot, "index.md"), "# Selected knowledge\n\nSource: https://example.test/source\n", "utf-8");
	const wikiStore = new RunArtifactStore(join(root, inputMode));
	const wiki = wikiStore.describeDirectory("wiki");
	const evidence = fixtureEvidence(`run-${inputMode}`);
	const evidencePath = join(root, inputMode, "evidence.json");
	writeFileSync(evidencePath, `${JSON.stringify(evidence)}\n`, "utf-8");
	const cornellNotesArtifact = wikiStore.describeFile("evidence.json");
	const knowledgeRoot = join(runRoot, "artifacts/report-run/knowledge-snapshot");
	mkdirSync(join(knowledgeRoot, "wiki"), { recursive: true });
	mkdirSync(join(knowledgeRoot, "evidence/one"), { recursive: true });
	mkdirSync(join(knowledgeRoot, "sources/one"), { recursive: true });
	writeFileSync(join(knowledgeRoot, "index.md"), "# Layered knowledge\n");
	writeFileSync(join(knowledgeRoot, "wiki/index.md"), "# Selected knowledge\n\n[Evidence](../evidence/one/note.md)\n");
	writeFileSync(join(knowledgeRoot, "evidence/one/note.md"), "# Evidence\n\n[Source](../../sources/one/document.md)\n");
	writeFileSync(join(knowledgeRoot, "sources/one/document.md"), "# Source\n\nSupported fact.\n\nURL: https://example.test/source\n");
	const knowledge = new RunArtifactStore(runRoot).describeDirectory("artifacts/report-run/knowledge-snapshot");
	const previousRunId = "2026-08-07T00-00-00.000Z";
	const previousReport = join(goalRoot, "wiki", "runs", previousRunId, "report");
	mkdirSync(previousReport, { recursive: true });
	writeFileSync(join(previousReport, "final.md"), "# Previous report\n\nEstablished material.\n");
	mkdirSync(join(root, inputMode, previousRunId), { recursive: true });
	writeFileSync(join(root, inputMode, previousRunId, "run-state.json"), '{"status":"published"}\n');
	const requests: AgentStageRequest<unknown>[] = [];
	const runner: AgentStageRunner = {
		async runStage<T>(request: AgentStageRequest<T>) {
			requests.push(request as AgentStageRequest<unknown>);
			mkdirSync(request.workDirectory, { recursive: true });
			mkdirSync(join(request.workDirectory, "writer-output", "sections"), { recursive: true });
			writeFileSync(join(request.workDirectory, "writer-output", "outline.json"), JSON.stringify({
				title: "Current question report",
				sections: [{
					section_id: "section-001",
					title: "Current findings",
					purpose: "Answer the current question",
					knowledge_refs: ["P1"],
				}],
			}));
			writeFileSync(join(request.workDirectory, "writer-output", "sections", "section-001.md"),
				"A supported fact. <cite>https://example.test/source</cite>");
			writeFileSync(join(request.workDirectory, "writer-output", "manifest.json"), JSON.stringify({
				schema_version: 1,
				sections: [{ section_id: "section-001", title: "Current findings", path: "sections/section-001.md" }],
			}));
			const finalized = await finalizeStageOutput(request);
			const sessionPath = join(controlRoot, `${request.stageId}.jsonl`);
			writeFileSync(sessionPath, "{}\n");
			return {
				value: finalized.value,
				artifact: finalized.artifact,
				submissionCount: 1,
				validationErrors: [],
				session: { id: `prime:${request.stageId}`, mode: "fresh" as const },
				turns: 1,
				toolCalls: 1,
				toolCounts: { submit_stage_output: 1 },
				usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.001, calls: 1 },
				sessionPath,
			};
		},
	};
	const runtime = new Run({
		stageRunner: runner,
		searchBatchExecutor: { execute: async () => { throw new Error("search must not run"); } },
		evidenceMaterializer: { materialize: async () => { throw new Error("screening must not run"); } },
		validateCitationUrls: async () => new Set(),
	});
	const execution = runtime.run({
		runId: `run-${inputMode}`,
		goalId: "goal-test",
		discoveryEnabled: false,
		question: "Compare the selected knowledge input.",
		reportContext: "Write for an expert audience; explain only new findings.",
		language: "zh-CN",
		workspaceDirectory: runRoot,
		controlDirectory: controlRoot,
		goalWorkspaceDirectory: goalRoot,
		providerCatalog: [],
		temporalContext: { schemaVersion: 1, currentDate: "2026-08-08", timeZone: "UTC" },
		pipeline: { id: "pipeline", version: "1", sha256: "c".repeat(64) },
		identityPins: {
			harness_snapshot: "harness", workspace_content_hash: "a".repeat(64), knowledge_memory_hash: "knowledge",
			run_context_snapshot: "d".repeat(64), pipeline: "pipeline",
			prompt_bundle: "prompt", schema_bundle: "schema", model_policy: "model", skill_bundle: "skill", tool_schema: "tool",
		},
		// A Run reaches its Stages with its selections and parameters already frozen.
		env: {
			TELOMI_PRIME_AGENT_ROOT_MODEL: "openai-codex/gpt-5.6-terra",
			TELOMI_PRIME_AGENT_CHILD_MODEL: "openai-codex/gpt-5.6-luna",
			TELOMI_PRIME_REPORT_THINKING_LEVEL: "high",
		},
		signal: new AbortController().signal,
		reportInput: {
			sourceRunId: "source-run",
			cornellNotesArtifact,
				wikiCompilation: {
					status: "reused", compilationId: "wiki-test", baseKnowledgeSha256: wiki.sha256,
					knowledge: wiki, pageCount: 1,
					usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, calls: 0 },
					agentStages: 0, sessionPaths: [], failedBatches: [],
			},
			knowledgeInput: { ref: knowledge.relativePath, sha256: knowledge.sha256, byteLength: knowledge.byteLength },
		},
	});
	const result = await execution;
	assert.equal(result.state.status, "published");
	assert.equal(result.state.usage.input_tokens, 10);
	assert.equal(result.state.usage.output_tokens, 5);
	assert.equal(result.state.usage.model_calls, 1);
	assert.deepEqual(requests.map((request) => [request.stageId, request.role]), [
		["writer-report", "report_writer"],
	]);
	for (const request of requests) {
		assert.deepEqual(request.modelPolicy, {
			preferred: ["openai-codex/gpt-5.6-terra"],
			reasoning: "high",
		}, "Reporter Stage must receive the Prime model policy it actually executes");
		if (request.stageId === "writer-report") assert.deepEqual(request.sandbox?.env, {
			TELOMI_PRIME_AGENT_CHILD_MODEL: "openai-codex/gpt-5.6-luna",
		}, "Writer Stage must carry its actual child model selection");
		const guests = request.readonlyMounts.map((mount) => mount.guestPath);
		assert.equal(guests.includes("/knowledge"), false);
		assert.equal(guests.includes("/wiki"), false);
		assert.deepEqual(request.additionalTools?.map((tool) => tool.name),
			["wiki_search", "wiki_read_page", "wiki_graph_search"]);
		assert.deepEqual(request.fileToolPolicy?.deniedReadPrefixes, ["/wiki", "/work/wiki"]);
		const input = request.readonlyMounts.find((mount) => mount.guestPath === "/inputs")!;
		assert.equal(readFileSync(join(input.hostPath, "task.md"), "utf-8"), "Write for an expert audience; explain only new findings.\n");
		assert.equal(readFileSync(join(input.hostPath, "search-question.md"), "utf-8"), "Compare the selected knowledge input.\n");
		assert.deepEqual(JSON.parse(readFileSync(join(input.hostPath, "materials.json"), "utf-8")), {
			schema_version: 1,
			kind: "wiki",
			refs: ["P1"],
		});
		assert.equal(reportWriterUsesChineseLint(input.hostPath), true,
			"the Writer Runtime must see the Run's report language in the input the Orchestrator actually produces");
		const evidenceIndex = join(input.hostPath, "evidence", "index.md");
		assert.equal(readable(evidenceIndex), false);
		assert.doesNotMatch(request.userPrompt, /\/knowledge/iu);
		if (request.stageId === "writer-report") {
			assert.equal(readable(join(input.hostPath, "routed-evidence", "index.md")), false);
			assert.equal(readable(join(input.hostPath, "routed-evidence", "section-001.md")), false);
			assert.equal(readable(join(input.hostPath, "previous-report.md")), false);
			assert.match(request.userPrompt, /Wiki Prime Report Writer/u);
			assert.equal(readable(join(input.hostPath, "report-outline.json")), false);
		}
	}
	assert.equal(new RunArtifactStore(runRoot).describeDirectory("artifacts/report-run/knowledge-snapshot").sha256,
		knowledge.sha256);
	assert.equal(result.state.report_flow?.knowledge_input?.mode, inputMode);
	assert.equal(result.state.report_flow?.cornell_notes_snapshot?.relative_path, "artifacts/report-run/cornell-notes.json");
	new RunArtifactStore(runRoot).openFile(result.state.report_flow!.cornell_notes_snapshot!);
	assert.equal(new RunArtifactStore(join(root, inputMode)).describeDirectory("wiki").sha256, wiki.sha256);
}

function readable(path: string): boolean {
	try { readFileSync(path); return true; } catch { return false; }
}

function fixtureEvidence(runId: string): CornellNotesSnapshot {
	return {
		schema_version: 1,
		snapshot_id: "snapshot:one",
		run_id: runId,
		pipeline: { id: "pipeline", version: "1", sha256: "c".repeat(64) },
		source_bundle_refs: [],
		notes: [{
			note: { schema_version: 1, source_id: "source:one", sections: [{
				section_title: "Finding", summary: "A supported fact.", cue_notes: [{
					cue: "Fact + support", note: "A supported fact.", evidence: [{
						source_path: "document.md", start_line: 1, end_line: 1, content_sha256: "d".repeat(64),
					}],
				}],
			}] },
			title: "Source", canonical_locator: "https://example.test/source", provider_id: "test",
			provenance_ref: "source:one", source_revision_sha256: "e".repeat(64), members: [],
		}],
	};
}
