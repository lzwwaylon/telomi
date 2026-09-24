// Search Batch 的断点复用按 sequence 给执行现场做键。续跑时 Run 层如果传下不同的
// sequence，复用会静默失效并重烧一整轮采集，所以这里把该不变量钉住。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Run, type SearchBatchRequest, type SearchBatchResult } from "../../server/research/pipeline/index.js";
import { RunStateStore } from "../../server/research/run-state.js";

const root = mkdtempSync(join(tmpdir(), "telomi-search-resume-"));
const workspaceDirectory = join(root, "workspace");
const controlDirectory = join(root, "control");

const batchCalls: Array<{ sequence: number; controlDirectory: string }> = [];

const run = new Run({
	stageRunner: { runStage: async () => { throw new Error("Planner must not run"); } } as never,
	searchBatchExecutor: {
		async execute(request: SearchBatchRequest): Promise<SearchBatchResult> {
			batchCalls.push({ sequence: request.sequence, controlDirectory: request.controlDirectory });
			throw new Error("search_batch_failed");
		},
	},
	evidenceMaterializer: { materialize: async () => { throw new Error("materializer must not run"); } },
	validateCitationUrls: async () => new Set<string>(),
});

const request = {
	runId: "run:search-resume",
	goalId: "goal:search-resume",
	question: "验证采集阶段失败后原地续跑",
		reportContext: "Explain the acquired evidence and explicitly identify missing support.",
	language: "zh-CN",
	workspaceDirectory,
	controlDirectory,
	goalWorkspaceDirectory: join(root, "goal"),
	workspaceRootDirectory: root,
	agentSkillIndexes: { "prime-search": "", "report-writer": "" },
	providerCatalog: [{ id: "arxiv", capability: "papers", sourceClass: "professional" }],
	temporalContext: { schemaVersion: 1 as const, currentDate: "2026-08-23", timeZone: "UTC" },
	pipeline: { id: "test", version: "1", sha256: "c".repeat(64) },
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
} as never;

try {
	await assert.rejects(run.run(request), /search_batch_failed/u);

	const store = new RunStateStore(controlDirectory);
	const failed = store.load();
	assert.equal(failed?.status, "failed");
	assert.equal(failed?.failure?.failed_stage, "search_batch_running");

	// 采集阶段失败以前是不可续跑的终态，Source 全在盘上也只能整轮重来。
	const resumed = store.resume();
	assert.equal(resumed.status, "search_batch_running");
	assert.equal(resumed.resume_attempts, 1);

	await assert.rejects(run.run(request), /search_batch_failed/u);

	assert.equal(batchCalls.length, 2);
	assert.equal(
		batchCalls[1]!.sequence,
		batchCalls[0]!.sequence,
		"续跑必须沿用同一个 sequence，否则 Search Batch 找不到上次留下的执行现场",
	);
	assert.equal(batchCalls[1]!.controlDirectory, batchCalls[0]!.controlDirectory);
} finally {
	rmSync(root, { recursive: true, force: true });
}

console.log("Search Batch resume sequence test passed");
