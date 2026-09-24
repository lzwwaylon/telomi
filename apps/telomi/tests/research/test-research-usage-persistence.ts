import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { appendResearchNodeRecord } from "../../server/observability/run-records.js";
import type { ResearchModelUsage } from "../../server/agent-runtime/model-usage.js";
import { Run, type CornellNotesMaterializeRequest, type SearchBatchRequest } from "../../server/research/pipeline/index.js";
import { RunStateStore } from "../../server/research/run-state.js";

const root = mkdtempSync(join(tmpdir(), "telomi-research-usage-"));
const workspaceDirectory = join(root, "workspace");
const controlDirectory = join(root, "control");
const sourceDirectory = join(root, "source");
const bundleDirectory = join(root, "bundle");
const findOutDirectory = join(root, "find-out");
for (const directory of [sourceDirectory, bundleDirectory, findOutDirectory]) mkdirSync(directory, { recursive: true });
writeFileSync(join(sourceDirectory, "source.json"), "{}\n");
writeFileSync(join(bundleDirectory, "bundle.json"), "{}\n");
writeFileSync(join(findOutDirectory, "manifest.json"), "{}\n");

let usageRecorded!: () => void;
let releaseMaterializer!: () => void;
const usageReady = new Promise<void>((resolve) => { usageRecorded = resolve; });
const materializerHold = new Promise<void>((resolve) => { releaseMaterializer = resolve; });
let recordLateUsage: ((usage: ResearchModelUsage) => void) | undefined;

function recordAgentUsage(
	id: string,
	status: "succeeded" | "failed",
	usage: { inputTokens: number; outputTokens: number; costUsd: number; calls: number },
): void {
	const now = new Date().toISOString();
	appendResearchNodeRecord(controlDirectory, {
		node_id: id,
		node_type: "agent",
		agent: id,
		execution_id: id,
		status,
		group_id: null,
		depends_on: [],
		input: {},
		output: { metrics: {
			input_tokens: usage.inputTokens,
			output_tokens: usage.outputTokens,
			cost_usd: usage.costUsd,
			model_calls: usage.calls,
		} },
		time: { started_at: now, finished_at: now, duration_ms: 0 },
	});
}

const runtime = new Run({
	stageRunner: { runStage: async () => { throw new Error("Unexpected Agent stage"); } } as never,
	searchBatchExecutor: {
		async execute(request: SearchBatchRequest) {
			recordAgentUsage("search", "succeeded", { inputTokens: 2, outputTokens: 1, costUsd: 0.02, calls: 1 });
			return {
				logicalSources: [{
					id: "source:one",
					title: "One source",
					url: "https://example.test/one",
					providerId: "test",
					sourceIdentity: "one",
					revisionSha256: "a".repeat(64),
					directoryPath: sourceDirectory,
					organizationKind: "ungrouped" as const,
					members: [],
				}],
				sourceBundles: [request.artifactStore.publishDirectory(
					bundleDirectory,
					"artifacts/source-bundles/test",
				)],
				findOutSources: request.artifactStore.publishDirectory(
					findOutDirectory,
					"artifacts/find-out-sources/sequence-1",
				),
				executionRecords: [],
				usage: { inputTokens: 2, outputTokens: 1, costUsd: 0.02, calls: 1 },
				agentStages: 1,
				toolCalls: 0,
			};
		},
	},
	evidenceMaterializer: {
		async materialize(request: CornellNotesMaterializeRequest) {
			recordLateUsage = request.onAgentStageCompleted;
			const noteUsage = { inputTokens: 10, outputTokens: 5, costUsd: 0.1, calls: 2 };
			recordAgentUsage("note-success", "succeeded", noteUsage);
			request.onAgentStageCompleted?.(noteUsage);
			usageRecorded();
			await materializerHold;
			recordAgentUsage("note-failure", "failed", { inputTokens: 7, outputTokens: 3, costUsd: 0.07, calls: 1 });
			throw new Error("stop_after_usage_assertion");
		},
	},
	validateCitationUrls: async () => new Set<string>(),
});

const execution = runtime.run({
	runId: "run:usage-persistence",
	goalId: "goal:usage-persistence",
	question: "Persist usage while Cornell Notes are still materializing.",
		reportContext: "Explain the acquired evidence and explicitly identify missing support.",
	language: "en",
	workspaceDirectory,
	controlDirectory,
	goalWorkspaceDirectory: join(root, "goal"),
	workspaceRootDirectory: root,
	agentSkillIndexes: { "prime-search": "", "cornell-note": "", "report-writer": "" },
	providerCatalog: [{ id: "test", capability: "test", sourceClass: "professional" }],
	temporalContext: { schemaVersion: 1, currentDate: "2026-08-28", timeZone: "UTC" },
	pipeline: { id: "test", version: "1", sha256: "b".repeat(64) },
	identityPins: {
		harness_snapshot: "harness",
		workspace_content_hash: "a".repeat(64),
		knowledge_memory_hash: "knowledge",
		run_context_snapshot: "d".repeat(64),
		pipeline: "pipeline",
		prompt_bundle: "prompt",
		schema_bundle: "schema",
		model_policy: "model",
		skill_bundle: "skill",
		tool_schema: "tool",
	},
	env: {},
	signal: new AbortController().signal,
} as never);

await usageReady;
let assertionError: unknown;
let terminal: ReturnType<RunStateStore["load"]>;
try {
	const live = new RunStateStore(controlDirectory).load();
	assert.equal(live?.status, "evidence_materializing");
	assert.equal(live?.usage.input_tokens, 12, "completed Cornell usage must be persisted before the batch ends");
	assert.equal(live?.usage.output_tokens, 6);
	assert.equal(live?.usage.model_calls, 3);
	assert.ok(Math.abs((live?.usage.cost_usd ?? 0) - 0.12) < 1e-9);
	assert.equal(live?.usage.agent_stages, 2);
} catch (error) {
	assertionError = error;
} finally {
	releaseMaterializer();
	await execution.catch(() => undefined);
	const lateUsage = { inputTokens: 4, outputTokens: 2, costUsd: 0.04, calls: 1 };
	recordAgentUsage("note-late-success", "succeeded", lateUsage);
	recordLateUsage?.(lateUsage);
	terminal = new RunStateStore(controlDirectory).load();
	rmSync(root, { recursive: true, force: true });
}
if (assertionError) throw assertionError;
assert.equal(terminal?.status, "failed");
assert.equal(terminal?.usage.input_tokens, 23, "failed and late Agent usage must be included in terminal state");
assert.equal(terminal?.usage.output_tokens, 11);
assert.equal(terminal?.usage.model_calls, 5);
assert.ok(Math.abs((terminal?.usage.cost_usd ?? 0) - 0.23) < 1e-9);
assert.equal(terminal?.usage.agent_stages, 3);

console.log("Research usage persistence test passed");
