// Prime Search Capture and Candidate Replay store each Source Bundle file once per place that
// reads it: the product artifacts, and the self-contained Case that a Bundle export ships.
// No run-level evaluation copy and no separate Replay `result` copy of the same tree.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { RunArtifactStore } from "../../server/agent-runtime/artifact-store.js";
import { createCaseBundle } from "../../server/evaluation/case-bundle.js";
import { NodeBacktestService } from "../../server/evaluation/node-backtest.js";
import {
	createLivePrimeSearchReplayRecipe,
	withPrimeSearchNodeEvaluationCapture,
} from "../../server/evaluation/prime-search-replay.js";
import { PrimeSearchBatchExecutor } from "../../server/research/pipeline/prime-search-batch.js";
import type { SearchBatchExecutor, SearchBatchResult } from "../../server/research/pipeline/search-batch.js";
import { serverRuntimeDirForGoal } from "../../server/workspaces/server-runtime-paths.js";

const ASSETS = 20;
const root = mkdtempSync(join(tmpdir(), "telomi-prime-search-storage-"));
const workspaceDir = join(root, "data");
const goalId = "goal_prime_storage";
const goalDirectory = join(workspaceDir, goalId);
const sourceRunId = "source-prime-storage";
const runsRoot = join(serverRuntimeDirForGoal(goalId, workspaceDir), "runs");
const sourceRun = join(runsRoot, sourceRunId);
const skill = join(goalDirectory, "skills", "prime-search", "fixture");
mkdirSync(skill, { recursive: true });
writeFileSync(join(skill, "SKILL.md"), "---\nname: fixture\ndescription: Prime Search storage fixture.\n---\n");
mkdirSync(sourceRun, { recursive: true });

/** Publishes one Source Bundle and its organized projection, the way the batch executor does. */
const fixtureBatch: SearchBatchExecutor = {
	async execute(request) {
		const logicalRoot = join(request.logicalWorkspaceCaptureRoot!, "root");
		mkdirSync(join(logicalRoot, "workspace", "work"), { recursive: true });
		writeFileSync(join(logicalRoot, "workspace", "work", "query.json"), "{}\n");
		const store = request.artifactStore;
		const decisions = join(request.controlDirectory, "prime-search-traces", "fixture", "decisions", "organizer");
		mkdirSync(decisions, { recursive: true });
		writeFileSync(join(decisions, "groups.json"), `${JSON.stringify({ schema_version: 1, groups: [], ungrouped: [] })}\n`);
		const bundleSource = join(request.controlDirectory, `fixture-bundle-${request.sequence}`);
		const findOutSource = join(request.controlDirectory, `fixture-find-out-${request.sequence}`);
		for (const directory of [join(bundleSource, "sources", "0001"),
			join(findOutSource, "sources", "group", "members", "github", "candidate-1")]) {
			mkdirSync(join(directory, "assets"), { recursive: true });
			writeFileSync(join(directory, "material.md"), "# Repository\n");
			for (let index = 0; index < ASSETS; index++) {
				writeFileSync(join(directory, "assets", `asset-${index}.bin`), `asset ${index}\n`);
			}
		}
		writeFileSync(join(bundleSource, "source-index.json"), `${JSON.stringify({ schema_version: 1, provider_id: "github",
			sources: [{ path: "sources/0001", candidate_id: "candidate-1", source_id: "source-1", title: "Repository",
				url: "https://github.com/example/repository", files: [] }] })}\n`);
		writeFileSync(join(findOutSource, "manifest.json"), "{}\n");
		const sourceBundle = store.publishDirectory(bundleSource, `artifacts/source-bundles/github/source-${request.sequence}`);
		const organizedSources = store.publishDirectory(findOutSource, `artifacts/find-out-sources/sequence-${request.sequence}`);
		rmSync(bundleSource, { recursive: true });
		rmSync(findOutSource, { recursive: true });
		const record = store.publishText("{}\n", `artifacts/search-executions/github-${request.sequence}.json`);
		return {
			logicalSources: [],
			sourceBundles: [sourceBundle],
			organizedSources,
			executionRecords: [{ record: { provider_id: "github", terminal_status: "valid_bundle" }, artifact: record }],
			usage: { inputTokens: 10, outputTokens: 2, costUsd: 0.01, calls: 2 },
			agentStages: 1,
			toolCalls: 3,
		} as unknown as SearchBatchResult;
	},
};

/** Every on-disk copy of the fixture's asset files below `directory`. */
function assetCopies(directory: string): string[] {
	if (!existsSync(directory)) return [];
	return readdirSync(directory, { recursive: true, encoding: "utf-8" })
		.filter((path) => /(^|\/)asset-\d+\.bin$/u.test(path));
}

/** The trees holding those copies, for a readable failure. */
function copyTrees(directory: string): string {
	return [...new Set(assetCopies(directory).map((path) => path.replace(/\/(?:sources|assets)\/.*$/u, "")))].sort().join(", ");
}

const service = new NodeBacktestService({
	workspaceDir,
	listGoalIds: () => [goalId],
	recipes: [createLivePrimeSearchReplayRecipe()],
});
const originalExecute = PrimeSearchBatchExecutor.prototype.execute;
try {
	await withPrimeSearchNodeEvaluationCapture(fixtureBatch, {
		availableProviders: [],
		env: {
			TELOMI_PRIME_AGENT_ROOT_MODEL: "openai-codex/gpt-5.6-luna",
			TELOMI_PRIME_AGENT_CHILD_MODEL: "openai-codex/gpt-5.6-luna",
			TELOMI_PRIME_SEARCH_THINKING_LEVEL: "high",
		},
	}).execute({
		goalId,
		runId: sourceRunId,
		sequence: 1,
		question: "Find the primary repository.",
		availableProviderIds: ["github"],
		workspaceDirectory: goalDirectory,
		controlDirectory: sourceRun,
		artifactStore: new RunArtifactStore(sourceRun),
		temporalContext: { schemaVersion: 1, currentDate: "2026-11-03", timeZone: "Asia/Singapore" },
		signal: new AbortController().signal,
	});

	service.start();
	const [baseline] = service.listCases(goalId, "prime-search", 10);
	assert.ok(baseline, "the batch is captured as a Case");
	const baselineCase = join(sourceRun, "node-evaluation", "cases", baseline.value.caseId);
	// The product's Bundle and organized projection, plus the Case's self-contained Observed output.
	assert.equal(assetCopies(sourceRun).length, 4 * ASSETS, `Capture copies in ${copyTrees(sourceRun)}`);
	assert.equal(existsSync(join(sourceRun, "artifacts", "node-evaluation")), false,
		"Capture writes its Observed output straight into the Case");
	assert.deepEqual(readdirSync(baselineCase).filter((name) => name.startsWith(".")), [], "no staging is left in the Case");
	for (const path of ["result.json", "source-bundles/1/source-index.json", "find-out-sources/manifest.json",
		"search-executions/1.json", "logical-workspaces/root/workspace/work/query.json", "rubric.md"]) {
		assert.ok(existsSync(join(baselineCase, "observed-output", path)), `Observed output keeps ${path}`);
	}
	assert.equal(existsSync(join(sourceRun, "node-evaluation", "prime-search-input-1")), false);
	assert.equal(service.readCase(goalId, baseline.ref).observed.output?.directory, true);

	PrimeSearchBatchExecutor.prototype.execute = function (request) {
		return fixtureBatch.execute(request);
	};
	const run = service.enqueue(goalId, {
		agentId: "prime-search", cases: [baseline.ref], candidate: {}, repetitions: 1,
		rubricId: "prime-search-provider-environment-v1",
	});
	let completed = service.read(goalId, run.id)!;
	while (!["awaiting_evaluation", "failed", "cancelled"].includes(completed.status)) {
		await new Promise((resolve) => setTimeout(resolve, 10));
		completed = service.read(goalId, run.id)!;
	}
	assert.equal(completed.status, "awaiting_evaluation", completed.error ?? completed.executions[0]?.error);
	const execution = completed.executions[0]!;
	const executionRoot = join(serverRuntimeDirForGoal(goalId, workspaceDir), "evaluation", "node-backtests", run.id,
		"executions", execution.id);
	assert.equal(assetCopies(executionRoot).length, 4 * ASSETS, `Replay copies in ${copyTrees(executionRoot)}`);
	assert.equal(existsSync(join(executionRoot, "result")), false, "the Replay output is the Candidate Case's Observed output");
	const candidate = service.readCase(goalId, execution.candidateCaseRef!);
	assert.equal(execution.artifact.ref,
		`executions/${execution.id}/node-evaluation/cases/${candidate.caseId}/observed-output`);
	assert.equal(execution.artifact.sha256, candidate.observed.output?.sha256);

	// Every consumer of the Replay output still reads it.
	assert.match(readFileSync(service.artifactFile(goalId, run.id, execution.id, "source-bundles/1/source-index.json"), "utf-8"),
		/"provider_id":"github"/u);
	const batch = service.evaluationBatch(goalId, run.id);
	assert.equal(batch.pairs.length, 1);
	for (const output of Object.values(batch.pairs[0]!.outputs)) {
		assert.ok(output.directory && output.files?.some((file) => file.relativePath === "source-bundles/1/sources/0001/assets/asset-0.bin"));
	}
	assert.ok(execution.refs?.sourceIndex?.includes("/artifacts/source-bundles/"),
		`the Source Index ref names the product Bundle: ${execution.refs?.sourceIndex}`);
	const candidateBundle = await createCaseBundle({
		dataDir: workspaceDir, goalId, goalTitle: "Prime Search Storage",
		casePath: join(executionRoot, "node-evaluation", "cases", candidate.caseId, "manifest.json"),
		value: candidate, runtimeBuild: "fixture-runtime", agentBundleSha256: "a".repeat(64),
		restoreTree: async () => undefined,
	});
	try {
		assert.ok(candidateBundle.manifest.files.some((file) =>
			file.path === "case/observed-output/source-bundles/1/sources/0001/assets/asset-0.bin"));
	} finally {
		candidateBundle.cleanup();
	}
	console.log(`Prime Search stores ${4 * ASSETS} asset copies per Capture and per Replay`);
} finally {
	PrimeSearchBatchExecutor.prototype.execute = originalExecute;
	service.stop();
	rmSync(root, { recursive: true, force: true });
}
