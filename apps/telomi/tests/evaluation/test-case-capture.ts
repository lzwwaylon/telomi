import { withResearchNodeEvaluationCapture } from "../../server/agent-runtime/recorded-stage-replay.js";
/**
 * Phase 3 的 Case Capture 组合缝检查。
 *
 * 覆盖：没有组合 Evaluation 的进程不写 Evaluation Case；正式 Capture 失败不改变产品结果，
 * 只记录结构化警告；Candidate Evidence 保持 fail-closed；产品模块不再 import
 * Evaluation 实现。
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import {
	caseCapture,
	caseCaptureHealth,
	installCaseCapture,
	recordCaseCaptureFailure,
	resetCaseCaptureForTest,
	type CaseCaptureHooks,
} from "../../server/observability/case-capture.js";
import { beginNodeEvaluationCase, type NodeEvaluationCaptureSpec } from "../../server/agent-runtime/node-evaluation.js";
import { RunArtifactStore } from "../../server/agent-runtime/artifact-store.js";
import {
	type AgentStageRequest,
	type AgentStageRunner,
	type ValidatedStageArtifact,
} from "../../server/agent-runtime/agent-stage-runtime.js";
import { runWikiShardNodeEvaluation } from "../../server/evaluation/wiki-replay.js";
import { runPodcastWriterNodeEvaluation } from "../../server/evaluation/podcast-replay.js";
import { runScheduleReviewNodeEvaluation } from "../../server/evaluation/schedule-review-replay.js";
import { parseScheduleReviewOutput } from "../../server/research/schedules/review-contract.js";
import { withPrimeSearchNodeEvaluationCapture } from "../../server/evaluation/prime-search-replay.js";
import type { SearchBatchRequest, SearchBatchResult } from "../../server/research/pipeline/search-batch.js";

const serverRoot = fileURLToPath(new URL("../../server/", import.meta.url));
const root = mkdtempSync(join(tmpdir(), "telomi-case-capture-"));
const modelEnv = { TELOMI_PRIME_AGENT_ROOT_MODEL: "test/root", TELOMI_PRIME_AGENT_CHILD_MODEL: "test/child", TELOMI_RESEARCH_CORNELL_NOTE_MODEL: "test/note", TELOMI_WIKI_MAINTAINER_MODEL: "test/root" };

// ---------------------------------------------------------------------------
// 依赖方向：产品模块不得 import Evaluation 实现。
// ---------------------------------------------------------------------------

/** Composition roots and Evolution may depend on Evaluation; plan §5.2 and §5.3. */
const EVALUATION_DEPENDENTS_ALLOWED = ["evaluation/", "evolution/"];
const IMPORT = /(?:^|\n)\s*import\s+(?!type[\s{])[^;'"]*?from\s*["']([^"']+)["']|(?:^|\n)\s*import\s*["']([^"']+)["']/gu;

function serverFiles(directory: string): string[] {
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) return serverFiles(path);
		return entry.name.endsWith(".ts") ? [path] : [];
	});
}

const violations = serverFiles(serverRoot).flatMap((path) => {
	const relativePath = relative(serverRoot, path).replaceAll("\\", "/");
	if (EVALUATION_DEPENDENTS_ALLOWED.some((prefix) => relativePath.startsWith(prefix))) return [];
	return [...readFileSync(path, "utf-8").matchAll(IMPORT)]
		.map((match) => match[1] ?? match[2]!)
		.filter((specifier) => /(^|\/)evaluation\//u.test(specifier))
		.map((specifier) => `${relativePath} imports ${specifier}`);
});
assert.deepEqual(violations, [],
	"Product modules must not import Evaluation implementations; go through server/observability/case-capture.ts "
	+ "(type-only imports are allowed because they load no Evaluation code)");

// ---------------------------------------------------------------------------
// 未组合 Evaluation：没有 Hook，产品路径不写 Case。
// ---------------------------------------------------------------------------

resetCaseCaptureForTest();
assert.equal(caseCapture(), undefined, "a process that does not compose Evaluation installs no Case Capture hooks");

const specs: Array<NodeEvaluationCaptureSpec | undefined> = [];
const recordDirectory = join(root, "record");
const workDirectory = join(root, "work");
const harnessDirectory = join(root, "harness");
for (const directory of [recordDirectory, workDirectory, harnessDirectory]) mkdirSync(directory, { recursive: true });

function stageRequest(): AgentStageRequest<unknown> {
	return {
		runId: "run-1",
		stageId: "stage-1",
		attemptId: "1",
		role: "cornell_note",
		recordKind: "research",
		promptConfig: { domain: "research", id: "cornell-note", sandboxRole: "research.cornell-note" } as never,
		session: { key: "cornell-note", policy: "fresh" },
		modelPolicy: { preferred: ["openai-codex/gpt-5.4-mini"] },
		systemPrompt: "system",
		userPrompt: "user",
		workDirectory,
		readonlyMounts: [],
		controlDirectory: recordDirectory,
		recordDirectory,
		artifactStore: new RunArtifactStore(recordDirectory),
		output: { kind: "json", publishRelativePath: "artifacts/out.json", validate: () => ({}) },
		signal: new AbortController().signal,
	} as unknown as AgentStageRequest<unknown>;
}

const recordingRunner: AgentStageRunner = {
	runStage: async (request) => {
		specs.push(request.evaluation);
		return {} as unknown as ValidatedStageArtifact<never>;
	},
};

await recordingRunner.runStage(stageRequest());
await withResearchNodeEvaluationCapture(recordingRunner, harnessDirectory).runStage(stageRequest());
assert.equal(specs[0], undefined, "the undecorated product Stage Runner carries no Case Capture spec");
assert.equal(specs[1]?.agentId, "cornell-note", "the Capture decorator adds the Case Capture spec");

// 无 spec 的请求写不出 Case 目录；有 spec 的会写出来。这是没有 Hook 时在磁盘上的含义。
assert.equal(beginNodeEvaluationCase({
	request: stageRequest(),
	recordDirectory,
	promptConfig: { domain: "research", id: "cornell-note", sandboxRole: "research.cornell-note" },
	sessionContextFile: join(recordDirectory, ".missing"),
	composedSystemPrompt: "system",
	actualModel: "openai-codex/gpt-5.4-mini",
}), undefined);
assert.ok(!existsSync(join(recordDirectory, "node-evaluation")),
	"a request without a Capture spec must not create any Node Evaluation Case directory");

const captured = beginNodeEvaluationCase({
	request: { ...stageRequest(), evaluation: specs[1]! },
	recordDirectory,
	promptConfig: { domain: "research", id: "cornell-note", sandboxRole: "research.cornell-note" },
	sessionContextFile: join(recordDirectory, ".missing"),
	composedSystemPrompt: "system",
	actualModel: "openai-codex/gpt-5.4-mini",
});
assert.ok(captured, "capture mode creates a Case draft");
assert.ok(existsSync(join(recordDirectory, "node-evaluation", "cases")));

// ---------------------------------------------------------------------------
// Hook 安装与失败健康度。
// ---------------------------------------------------------------------------

resetCaseCaptureForTest();
installCaseCapture({ mainAgent: () => undefined } as unknown as CaseCaptureHooks);
assert.ok(caseCapture(), "the composition root installs the hooks");
recordCaseCaptureFailure("main-agent", new Error("disk full"));
const health = caseCaptureHealth();
assert.equal(health.enabled, true);
assert.equal(health.failures, 1);
assert.equal(health.recent.at(-1)?.node, "main-agent");
assert.match(health.recent.at(-1)?.reason ?? "", /disk full/u);

// ---------------------------------------------------------------------------
// 正式 Capture fail-open：Capture 不可用时产品结果照常返回。
// ---------------------------------------------------------------------------

/** A regular file where a record directory is expected: every capture write fails with ENOTDIR. */
const brokenRecordDirectory = join(root, "broken-record");
writeFileSync(brokenRecordDirectory, "not a directory\n");
assert.ok(statSync(brokenRecordDirectory).isFile());

resetCaseCaptureForTest();
const podcastResult = { title: "T", sections: [], artifactRoot: join(root, "podcast"), rootModel: "r", childModel: "c" };
const podcast = await runPodcastWriterNodeEvaluation({
	sourceText: "# Report\n",
	sessionDir: brokenRecordDirectory,
	title: "T",
	language: "en",
	audience: "engineers",
	generationBrief: { durablePreference: null, generationInstruction: null },
	emitProgress: () => undefined,
	observe: () => undefined,
	signal: new AbortController().signal,
}, {
	env: modelEnv,
	recordDirectory: brokenRecordDirectory,
	runId: "run-1",
	execute: async () => podcastResult,
});
assert.equal(podcast, podcastResult, "Podcast Writer capture failure must not change the product result");
assert.ok(caseCaptureHealth().failures >= 1, "the capture failure is recorded for the Operations status");

resetCaseCaptureForTest();
const shardResult = { knowledgeRoot: join(root, "wiki"), pageCount: 1, usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, calls: 0 }, sessionPaths: [] };
const shard = await runWikiShardNodeEvaluation({
	goal: "goal",
	evidence: { entries: [] } as never,
	topicPlan: {} as never,
	workRoot: join(root, "wiki-work"),
	sessionRoot: join(root, "wiki-session"),
	batch: { id: "b", index: 0, total: 1, sourceIds: [] },
	signal: new AbortController().signal,
}, {
	env: modelEnv,
	recordDirectory: brokenRecordDirectory,
	runId: "run-1",
	execute: async () => shardResult,
});
assert.equal(shard, shardResult, "Wiki Shard Builder capture failure must not change the product result");
assert.ok(caseCaptureHealth().failures >= 1);

resetCaseCaptureForTest();
const schedule = { question: "What changed?", monitoringScope: "Monitor releases.", reportContext: "Write for the team.", runs: [] };
const review = await runScheduleReviewNodeEvaluation({
	language: "en",
	goalId: "goal-1",
	workspaceDir: root,
	reviewId: "review-1",
	schedule,
	previousReview: null,
	signal: new AbortController().signal,
	env: modelEnv,
	root: brokenRecordDirectory,
}, {
	execute: async () => ({ decision: "no_change" }),
	validate: (output) => parseScheduleReviewOutput(output, schedule),
});
assert.deepEqual(review, { decision: "no_change" },
	"Research Schedule Reviewer capture failure must not change the recorded Review");
assert.ok(caseCaptureHealth().failures >= 1);

// ---------------------------------------------------------------------------
// Prime Search：正式 Capture fail-open，Candidate Evidence fail-closed。
// ---------------------------------------------------------------------------

function searchBatchRequest(): SearchBatchRequest {
	return {
		goalId: "goal-1",
		runId: "run-1",
		sequence: 1,
		question: "question",
		availableProviderIds: [],
		workspaceDirectory: harnessDirectory,
		controlDirectory: brokenRecordDirectory,
		artifactStore: new RunArtifactStore(root),
		temporalContext: {} as never,
		signal: new AbortController().signal,
	} as unknown as SearchBatchRequest;
}

resetCaseCaptureForTest();
let plainExecutions = 0;
const plainExecutor = {
	execute: async (request: SearchBatchRequest) => {
		plainExecutions += 1;
		assert.equal(request.logicalWorkspaceCaptureRoot, undefined,
			"the fail-open fallback runs the plain product executor");
		return {} as unknown as SearchBatchResult;
	},
};

await withPrimeSearchNodeEvaluationCapture(plainExecutor, { availableProviders: [], env: modelEnv }).execute(searchBatchRequest());
assert.equal(plainExecutions, 1, "Prime Search capture failure must not fail the product batch");
assert.ok(caseCaptureHealth().failures >= 1);

resetCaseCaptureForTest();
await assert.rejects(
	withPrimeSearchNodeEvaluationCapture(plainExecutor, {
		env: modelEnv,
		availableProviders: [],
		candidateCase: { sourceRunId: "run-1", capabilitySnapshotId: "caps_1" },
	}).execute(searchBatchRequest()),
	"Candidate Replay Evidence stays fail-closed when the Case cannot be captured",
);
assert.equal(plainExecutions, 1, "the fail-closed path must not fall back to a plain execution");
assert.equal(caseCaptureHealth().failures, 0, "Candidate Evidence failures are not production capture warnings");

rmSync(root, { recursive: true, force: true });
console.log("Case Capture gating, dependency direction, fail-open and fail-closed checks passed");
