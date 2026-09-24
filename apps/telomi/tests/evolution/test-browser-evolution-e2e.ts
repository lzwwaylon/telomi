/**
 * Integration check for the automatic Browser Evolution trigger.
 *
 * Drives the real product completion path: real Prime Search Case capture, the real
 * `RunStateStore` terminal transition that announces a settled Research Run, the real
 * `installBrowserEvolutionTrigger` listener, and the real `EvolutionService` store.
 * No model, Provider, or Browser is involved.
 */
import { replayableChildFiles } from "./provider-child-fixture.js";
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { NodeBacktestService } from "../../server/evaluation/node-backtest.js";
import { livePrimeSearchReplayRecipe, withPrimeSearchNodeEvaluationCapture } from "../../server/evaluation/prime-search-replay.js";
import { installBrowserEvolutionTrigger } from "../../server/evolution/lifecycle.js";
import { BROWSER_EVOLUTION_TARGET_ID } from "../../server/evolution/targets.js";
import { EvolutionService, type EvolutionTarget } from "../../server/evolution/service.js";
import { resetCaseCaptureForTest } from "../../server/observability/case-capture.js";
import { runRecordDir, runtimeContextPath } from "../../server/observability/run-records.js";
import { RunStateStore, type RunStateV2 } from "../../server/research/run-state.js";
import { RunArtifactStore } from "../../server/agent-runtime/artifact-store.js";
import type { SearchBatchExecutor, SearchBatchResult } from "../../server/research/pipeline/search-batch.js";

const root = mkdtempSync(join(tmpdir(), "telomi-browser-evolution-e2e-"));
const workspaceDir = join(root, "data");
const goalId = "goal_browser_e2e";
mkdirSync(join(workspaceDir, goalId, "skills", "prime-search"), { recursive: true });

const browserProvider = {
	provider_id: "browser",
	capability: "authenticated and dynamic website exploration",
	capabilities: ["browser_navigation"],
	evidence_types: ["rendered_page"],
	full_text_availability: "browser_render",
	worker_interface: { kind: "runtime_tool", required_tools: ["browser", "materialize_source"],
		required_skills: ["prime-browser-provider-skill"] },
	candidate_ledger: "work/browser_candidates.json",
} as const;

/** Stands in for the Prime Search Agent: writes the artifacts Runtime captures, calls no model. */
function browserBatchExecutor(childId: string): SearchBatchExecutor {
	return {
		async execute(request) {
			const store = request.artifactStore;
			const bundleSource = join(request.controlDirectory, `capture-bundle-${childId}`);
			mkdirSync(join(bundleSource, "sources", "0001"), { recursive: true });
			const bundle = store.publishDirectory(bundleSource, `artifacts/source-bundles/browser/${childId}`);
			const findOutSource = join(request.controlDirectory, `capture-find-out-${childId}`);
			mkdirSync(findOutSource, { recursive: true });
			const findOutSources = store.publishDirectory(findOutSource, `artifacts/find-out-sources/${childId}`);
			const record = {
				schema_version: 3,
				run_id: request.runId,
				execution_id: `provider-execution:1:browser:${childId}`,
				attempt_id: `attempt:prime:browser:${childId}`,
				provider_id: "browser",
				operations: [{ operation: "prime_agent", request_ref: "prime:1", response_count: 1, source_count: 1, status: "succeeded" }],
				terminal_status: "valid_bundle",
				bundle_ref: bundle.relativePath,
			};
			const fixture = join(request.controlDirectory, "fixture");
			mkdirSync(fixture);
			const resultPath = join(fixture, "result.json");
			writeFileSync(resultPath, JSON.stringify({ execution_records: [record] }));
			replayableChildFiles(fixture, resultPath);
			cpSync(join(fixture, "output/logical-workspaces"), request.logicalWorkspaceCaptureRoot!, { recursive: true });
			cpSync(join(fixture, "run/prime-search-traces"), join(request.controlDirectory, "prime-search-traces"), { recursive: true });
			writeFileSync(join(request.controlDirectory, "prime_search--1.jsonl"), "{}\n");
			writeFileSync(runtimeContextPath(request.controlDirectory, "research"), JSON.stringify({ type: "node_execution",
				node_id: "prime-search-batch-1", trace_ref: "prime_search--1.jsonl" }) + "\n");

			return {
				logicalSources: [],
				sourceBundles: [bundle],
				findOutSources,
				executionRecords: [{ record, artifact: store.publishText("{}\n", `artifacts/search-executions/${childId}.json`) }],
				usage: { inputTokens: 1, outputTokens: 1, costUsd: 0, calls: 1 },
				agentStages: 1,
				toolCalls: 1,
			} as unknown as SearchBatchResult;
		},
	};
}

const pins = {
	harness_snapshot: "harness", workspace_content_hash: "1".repeat(64), knowledge_memory_hash: "memory",
	run_context_snapshot: "2".repeat(64), pipeline: "pipeline", prompt_bundle: "prompt", schema_bundle: "schema",
	model_policy: "model", skill_bundle: "skill", tool_schema: "tool",
};
/** The real transition chain a successful Research Run walks before it settles. */
const PUBLISH_CHAIN = ["search_batch_running", "evidence_materializing", "plan_authoring",
	"plan_selected", "chapters_writing", "citation_compiling", "markdown_gating", "published"] as const;

/** One complete product Research Run: Prime Search Case capture, then a durable terminal state. */
async function runResearch(runId: string, childId: string, settledStates: readonly string[] = PUBLISH_CHAIN): Promise<void> {
	const controlDirectory = runRecordDir(workspaceDir, goalId, runId);
	mkdirSync(controlDirectory, { recursive: true });
	const state = new RunStateStore(controlDirectory);
	let current = state.create({ runId, goalId, question: `Read the newest items for ${childId}.`, language: "en", pins });
	await withPrimeSearchNodeEvaluationCapture(browserBatchExecutor(childId), {
		availableProviders: [browserProvider],
		env: { TELOMI_PRIME_AGENT_ROOT_MODEL: "openai-codex/gpt-5.6-luna",
			TELOMI_PRIME_AGENT_CHILD_MODEL: "openai-codex/gpt-5.6-luna" },
	}).execute({
		goalId,
		runId,
		sequence: 1,
		question: `Read the newest items for ${childId}.`,
		availableProviderIds: ["browser"],
		workspaceDirectory: join(workspaceDir, goalId),
		controlDirectory,
		artifactStore: new RunArtifactStore(controlDirectory),
		temporalContext: { schemaVersion: 1, currentDate: "2026-09-08", timeZone: "Asia/Singapore" },
		signal: new AbortController().signal,
	});
	for (const status of settledStates) {
		const finishedAt = new Date().toISOString();
		const next = {
			...current,
			status,
			updated_at: finishedAt,
			...(status === "published" ? {
				finished_at: finishedAt,
				canonical_report: { relative_path: "report.md", sha256: "3".repeat(64), byte_length: 12 },
			} : {}),
		} as RunStateV2;
		state.save(current, next);
		current = next;
	}
}

const nodeBacktests = new NodeBacktestService({
	workspaceDir,
	listGoalIds: () => [goalId],
	recipes: [livePrimeSearchReplayRecipe],
});
const target: EvolutionTarget = {
	id: BROWSER_EVOLUTION_TARGET_ID,
	ownerAgentId: "prime-search",
	version: 2,
	async collectEvidence() {
		await new Promise(() => {});
		throw new Error("unreachable");
	},
	async innerLoop() {
		throw new Error("The inner loop is out of scope for the trigger");
	},
};

let evolution = new EvolutionService({ workspaceDir, listGoalIds: () => [goalId], targets: [target] });
let lifecycle = installBrowserEvolutionTrigger({
	workspaceDir, nodeBacktests, evolution, listGoalIds: () => [goalId],
});

const browserRuns = (service: EvolutionService) =>
	service.list(goalId).filter((run) => run.targetId === BROWSER_EVOLUTION_TARGET_ID);

try {
	await runResearch("run-e2e-1", "sub-1");
	await lifecycle.idle();
	assert.equal(browserRuns(evolution).length, 0, "one settled Browser execution must not start an Evolution");

	await runResearch("run-e2e-2", "sub-2");
	await lifecycle.idle();
	assert.equal(browserRuns(evolution).length, 0, "two settled Browser executions must not start an Evolution");

	await runResearch("run-e2e-3", "sub-3");
	await lifecycle.idle();
	const started = browserRuns(evolution);
	assert.equal(started.length, 1, "the third settled Browser execution starts exactly one Evolution");
	assert.deepEqual(started[0]!.evidenceRefs.map((ref) => ref.runId), ["run-e2e-1", "run-e2e-2", "run-e2e-3"]);
	assert.equal(started[0]!.evidenceRefs.every((ref) => ref.kind === "browser_provider_execution"), true);

	// A Run that has not settled yet contributes nothing, even though its Case is captured.
	await runResearch("run-e2e-4", "sub-4", ["search_batch_running"]);
	await lifecycle.idle();
	assert.equal(browserRuns(evolution).length, 1, "an unsettled Research Run must not start a second Evolution");

	// The first batch is still active, so a complete second batch waits behind it.
	await runResearch("run-e2e-5", "sub-5");
	await runResearch("run-e2e-6", "sub-6");
	await runResearch("run-e2e-7", "sub-7");
	await lifecycle.idle();
	assert.equal(browserRuns(evolution).length, 1, "one Goal runs at most one Browser Evolution at a time");

	const active = browserRuns(evolution)[0]!;
	assert.equal(evolution.cancel(goalId, active.id).status, "cancelled");
	await lifecycle.idle();
	const second = browserRuns(evolution).find((run) => run.id !== active.id);
	assert.ok(second, "settling an Evolution immediately starts a complete batch that accumulated behind it");
	assert.deepEqual(second.evidenceRefs.map((ref) => ref.runId), ["run-e2e-5", "run-e2e-6", "run-e2e-7"],
		"batch two continues from the cursor and still skips the Run that has not settled");

	// Restart: a new process re-installs over the same directories and re-derives the cursor.
	lifecycle.stop();
	evolution.stop();
	resetCaseCaptureForTest();
	evolution = new EvolutionService({ workspaceDir, listGoalIds: () => [goalId], targets: [target] });
	lifecycle = installBrowserEvolutionTrigger({
		workspaceDir, nodeBacktests, evolution, listGoalIds: () => [goalId],
	});
	await lifecycle.idle();
	assert.equal(browserRuns(evolution).length, 2, "a restart must not replay either persisted batch");

	// The late Run settles now: it was never consumed, so it rejoins in Case capture order.
	const lateControlDirectory = runRecordDir(workspaceDir, goalId, "run-e2e-4");
	const lateState = new RunStateStore(lateControlDirectory);
	const lateFinishedAt = new Date().toISOString();
	lateState.save(lateState.load()!, { ...lateState.load()!, status: "failed", updated_at: lateFinishedAt,
		finished_at: lateFinishedAt, failure: { failure_class: "infrastructure", failed_stage: "search_batch_running",
			message: "Research Run stopped before publication." } } as RunStateV2);
	assert.equal(evolution.cancel(goalId, second.id).status, "cancelled");
	await runResearch("run-e2e-8", "sub-8");
	await runResearch("run-e2e-9", "sub-9");
	await lifecycle.idle();
	const third = browserRuns(evolution).find((run) => ![active.id, second.id].includes(run.id));
	assert.ok(third, "a third settled batch starts once the previous one is settled");
	assert.deepEqual(third.evidenceRefs.map((ref) => ref.runId), ["run-e2e-4", "run-e2e-8", "run-e2e-9"],
		"a Run that settles late rejoins the cursor in Case capture order and is consumed once");
	assert.equal(new Set(browserRuns(evolution).flatMap((run) => run.evidenceRefs)
		.map((ref) => `${ref.runId as string} ${ref.executionId as string}`)).size, 9,
		"every consumed Browser execution appears in exactly one batch");

	// Default mode installs no listener, so a settled Research Run announces into nothing.
	resetCaseCaptureForTest();
	const beforeDefaultMode = browserRuns(evolution).length;
	await runResearch("run-e2e-10", "sub-10");
	await runResearch("run-e2e-11", "sub-11");
	await runResearch("run-e2e-12", "sub-12");
	assert.equal(browserRuns(evolution).length, beforeDefaultMode,
		"with Evaluation off no listener exists, so no Evolution can start");

	console.log("Browser Evolution starts once from the real Research Run completion path and survives restart");
} finally {
	lifecycle.stop();
	evolution.stop();
	resetCaseCaptureForTest();
	rmSync(root, { recursive: true, force: true });
}
