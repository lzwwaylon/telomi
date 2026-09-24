import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { sha256 } from "../../server/lib/hash.js";
import { createCaseBundle } from "../../server/evaluation/case-bundle.js";
import { NodeBacktestService } from "../../server/evaluation/node-backtest.js";
import { producesBrowserEvolutionEvidence } from "../../server/evolution/targets.js";
import {
	createLivePrimeSearchReplayRecipe,
	type PrimeSearchReplayExecutionInput,
	withPrimeSearchNodeEvaluationCapture,
} from "../../server/evaluation/prime-search-replay.js";
import { createRlmChildLogicalWorkspaceSnapshotter } from "../../server/agent-runtime/logical-workspace-snapshot.js";
import { RunArtifactStore } from "../../server/agent-runtime/artifact-store.js";
import type { SearchBatchExecutor, SearchBatchResult } from "../../server/research/pipeline/search-batch.js";
import { PrimeSearchBatchExecutor } from "../../server/research/pipeline/prime-search-batch.js";
import { serverRuntimeDirForGoal } from "../../server/workspaces/server-runtime-paths.js";

const root = mkdtempSync(join(tmpdir(), "telomi-prime-live-replay-"));
const workspaceDir = join(root, "data");
const goalId = "goal_prime_live";
const goalDirectory = join(workspaceDir, goalId);
const sourceRunId = "source-prime-live";
const sourceRun = join(serverRuntimeDirForGoal(goalId, workspaceDir), "runs", sourceRunId);
const candidateRoot = join(root, "candidate");
const material = "# Runtime Eval\n\nPrimary repository evidence.\n";
for (const [variant, directory] of [["baseline", goalDirectory], ["candidate", candidateRoot]] as const) {
	const skill = join(directory, "skills", "prime-search", "fixture");
	mkdirSync(skill, { recursive: true });
	writeFileSync(join(skill, "SKILL.md"), `---\nname: fixture\ndescription: Prime Search ${variant} fixture.\n---\n`);
	writeFileSync(join(skill, "variant.txt"), `${variant}\n`);
}
mkdirSync(sourceRun, { recursive: true });

const childWorkspace = join(root, "child-workspace");
const childCaptures = join(root, "child-captures");
mkdirSync(join(childWorkspace, "work"), { recursive: true });
writeFileSync(join(childWorkspace, "work", "input.txt"), "initial\n");
const snapshotChildWorkspace = createRlmChildLogicalWorkspaceSnapshotter({
	guestCwd: "/workspace",
	mounts: [{ hostPath: childWorkspace, guestPath: "/workspace", access: "read-write" }],
}, childCaptures);
snapshotChildWorkspace({ type: "rlm_child_update", child: { id: "sub-provider-1", status: "running" } });
writeFileSync(join(childWorkspace, "work", "input.txt"), "mutated\n");
snapshotChildWorkspace({ type: "rlm_child_update", child: { id: "sub-provider-1", status: "running", activity: "changed" } });
assert.equal(readFileSync(join(childCaptures, "provider", "sub-provider-1", "workspace", "work", "input.txt"), "utf-8"), "initial\n",
	"Provider child input must be captured on its first running event, before its execution workspace exists");

const captureExecutor: SearchBatchExecutor = {
	async execute(request) {
		assert.ok(request.logicalWorkspaceCaptureRoot, "Prime Search evaluation must provide a logical Workspace capture root");
		const logicalRoot = join(request.logicalWorkspaceCaptureRoot, "root");
		mkdirSync(join(logicalRoot, "workspace", "work"), { recursive: true });
		writeFileSync(join(logicalRoot, "workspace", "work", "query.json"), "{}\n");
		writeFileSync(`${logicalRoot}.json`, `${JSON.stringify({
			schemaVersion: 1,
			guestCwd: "/workspace",
			mounts: [{ guestPath: "/workspace", access: "read-write" }],
		}, null, 2)}\n`);
		if (request.workspaceSnapshot) {
			request.workspaceSnapshot.input_tree_sha = "1".repeat(64);
			request.workspaceSnapshot.output_tree_sha = "2".repeat(64);
		}
		writeFileSync(join(request.controlDirectory, "provider-calls.jsonl"), `${JSON.stringify({
			seq: 1,
			node_id: `prime-search-batch-${request.sequence}`,
			attempt_id: request.attemptId,
			sub_execution_id: "sub-3171269c",
			provider: "github",
			at: "2026-09-05T00:00:00.000Z",
			latency_ms: 1,
			request: { query: request.question, purpose: "fixture", criterion_ids: [], max_results: 1 },
			response: { status: "ok", cache: "miss", doc_ids: ["runtime-eval"], material_sha256: [sha256(material)] },
		})}\n`);
		const store = request.artifactStore;
		const decisions = join(request.controlDirectory, "prime-search-traces", "fixture", "decisions", "organizer");
		mkdirSync(decisions, { recursive: true });
		writeFileSync(join(decisions, "groups.json"), `${JSON.stringify({ schema_version: 1, groups: [], ungrouped: [{
			candidate_id: "candidate:github",
			reason: "/private/candidate-private-path/source",
		}] })}\n`);
		const bundleSource = join(request.controlDirectory, "capture-bundle");
		const source = join(bundleSource, "sources", "0001");
		mkdirSync(source, { recursive: true });
		writeFileSync(join(source, "material.md"), material);
		writeFileSync(join(source, "record.json"), `${JSON.stringify({
			title: "Runtime Eval",
			summary: "Primary repository evidence.",
			metadata: { github_record: { id: "runtime-eval", title: "Runtime Eval",
				url: "https://github.com/example/runtime-eval", snippet: "Primary replay health implementation.",
				metadata: { repository: "example/runtime-eval" } } },
		})}\n`);
		writeFileSync(join(bundleSource, "source-index.json"), `${JSON.stringify({ schema_version: 1, provider_id: "github", sources: [{
			path: "sources/0001", candidate_id: "candidate-1", source_id: "source-1", title: "Runtime Eval",
			url: "https://github.com/example/runtime-eval", files: [],
		}] })}\n`);
		const sourceBundle = store.publishDirectory(bundleSource, `artifacts/source-bundles/github/source-${request.sequence}`);
		const findOutSource = join(request.controlDirectory, `capture-find-out-${request.sequence}`);
		mkdirSync(findOutSource, { recursive: true });
		writeFileSync(join(findOutSource, "manifest.json"), "{}\n");
		const sourceConfig = join(findOutSource, "source", "config.json");
		mkdirSync(join(sourceConfig, ".."), { recursive: true });
		writeFileSync(sourceConfig, '{"upstream":true}\n');
		chmodSync(sourceConfig, 0o444);
		const findOutSources = store.publishDirectory(findOutSource, `artifacts/find-out-sources/sequence-${request.sequence}`);
		const record = store.publishText("{}\n", `artifacts/search-executions/github-${request.sequence}.json`);
		return {
			logicalSources: [{ id: "source-1", title: "Runtime Eval", url: "https://github.com/example/runtime-eval",
				providerId: "github", sourceIdentity: "source-1", revisionSha256: "a".repeat(64),
				directoryPath: "/private/candidate-private-path/source", organizationKind: "ungrouped", members: [] }],
			sourceBundles: [sourceBundle],
			findOutSources,
			executionRecords: [{ record: { provider_id: "github", terminal_status: "valid_bundle" }, artifact: record }],
			usage: { inputTokens: 10, outputTokens: 2, costUsd: 0.01, calls: 2 },
			agentStages: 1,
			toolCalls: 3,
		} as unknown as SearchBatchResult;
	},
};
const githubProvider = {
	provider_id: "github",
	capability: "Repository search",
	capabilities: ["github_repositories"],
	evidence_types: ["repository"],
	full_text_availability: "full",
	worker_interface: { kind: "python_skill", required_skills: ["github"] },
	candidate_ledger: "work/github_candidates.json",
} as const;
const captureOptions = {
	availableProviders: [githubProvider],
	env: {
		TELOMI_PRIME_AGENT_ROOT_MODEL: "openai-codex/gpt-5.6-luna",
		TELOMI_PRIME_AGENT_CHILD_MODEL: "openai-codex/gpt-5.6-luna",
		TELOMI_PRIME_SEARCH_THINKING_LEVEL: "high",
	},
};
const captureInput: Parameters<SearchBatchExecutor["execute"]>[0] = {
	goalId,
	runId: sourceRunId,
	sequence: 2,
	question: "Find the primary implementation of replay health checks.",
	availableProviderIds: ["github"],
	workspaceDirectory: goalDirectory,
	controlDirectory: sourceRun,
	artifactStore: new RunArtifactStore(sourceRun),
	temporalContext: { schemaVersion: 1, currentDate: "2026-09-02", timeZone: "Asia/Singapore" },
	signal: new AbortController().signal,
};
await assert.rejects(withPrimeSearchNodeEvaluationCapture({
	async execute() { throw new Error("Interrupted acquisition"); },
}, captureOptions).execute(captureInput), /Interrupted acquisition/);
await withPrimeSearchNodeEvaluationCapture(captureExecutor, captureOptions).execute(captureInput);

// Evolution-only capture keeps a batch only when the predicate accepts it; failures and rejected
// batches leave no Case behind, and the product result is unchanged.
{
	const filteredRun = join(serverRuntimeDirForGoal(goalId, workspaceDir), "runs", "filtered-run");
	mkdirSync(filteredRun, { recursive: true });
	const filteredInput = { ...captureInput, runId: "filtered-run", controlDirectory: filteredRun, artifactStore: new RunArtifactStore(filteredRun) };
	const cases = () => existsSync(join(filteredRun, "node-evaluation", "cases"))
		? readdirSync(join(filteredRun, "node-evaluation", "cases")) : [];
	const githubOnly = await withPrimeSearchNodeEvaluationCapture(captureExecutor, {
		...captureOptions, keep: producesBrowserEvolutionEvidence,
	}).execute({ ...filteredInput, sequence: 10 });
	assert.equal(githubOnly.executionRecords[0]?.record.provider_id, "github");
	assert.deepEqual(cases(), [], "a batch without a valid Browser child is not Evolution evidence");
	await assert.rejects(withPrimeSearchNodeEvaluationCapture({
		async execute() { throw new Error("Interrupted acquisition"); },
	}, { ...captureOptions, keep: () => true }).execute(filteredInput), /Interrupted acquisition/);
	assert.deepEqual(cases(), [], "a failed batch is never Evolution evidence");
	await withPrimeSearchNodeEvaluationCapture(captureExecutor, { ...captureOptions, keep: () => true }).execute({ ...filteredInput, sequence: 11 });
	assert.equal(cases().length, 1, "an accepted batch is captured as usual");
	assert.equal(producesBrowserEvolutionEvidence({ executionRecords: [
		{ record: { provider_id: "browser", terminal_status: "failed" } },
		{ record: { provider_id: "browser", terminal_status: "valid_bundle" } },
	] } as unknown as SearchBatchResult), true);
	rmSync(filteredRun, { recursive: true, force: true });
}

const liveRecipe = createLivePrimeSearchReplayRecipe({
	async execute(input) {
		assert.equal(existsSync(join(input.caseInputDirectory, "workspace")), false);
		const captured = JSON.parse(readFileSync(join(input.caseInputDirectory, "request.json"), "utf-8")) as CapturedPrimeSearchRequest;
		assert.equal(captured.thinking_level, "high");
		await withPrimeSearchNodeEvaluationCapture(captureExecutor, {
			availableProviders: [githubProvider],
			env: {
				TELOMI_PRIME_AGENT_ROOT_MODEL: captured.models.root,
				TELOMI_PRIME_AGENT_CHILD_MODEL: captured.models.child,
				TELOMI_PRIME_SEARCH_THINKING_LEVEL: captured.thinking_level,
			},
			...(input.candidateCase ? { candidateCase: input.candidateCase } : {}),
			...(input.promptOverride?.userPrompt ? { rootUserPromptOverride: input.promptOverride.userPrompt } : {}),
		}).execute(replayRequest(input, captured));
		const variant = readFileSync(
			join(input.harnessWorkspaceDirectory, "skills", "prime-search", "fixture", "variant.txt"),
			"utf-8",
		).trim();
		const artifact = input.artifactStore.publishText(`${JSON.stringify({ variant })}\n`, "result.json");
		return { artifact, usage: { inputTokens: 1, outputTokens: 1, costUsd: 0, calls: 1 }, turns: 1, toolCalls: 1 };
	},
});
const service = new NodeBacktestService({
	workspaceDir,
	listGoalIds: () => [goalId],
	recipes: [liveRecipe],
});

try {
	service.start();
	const cases = service.listCases(goalId, "prime-search", 10);
	assert.equal(cases.length, 2, "retrying the same Run and sequence must retain both attempts without a Case collision");
	assert.equal(new Set(cases.map((item) => item.value.attemptId)).size, 2);
	const liveCase = cases.find((item) => item.value.status === "succeeded")!;
	assert.equal(liveCase.value.recipe.version, 4);
	const rejectedCase = join(root, "rejected-thinking");
	mkdirSync(join(rejectedCase, "input"), { recursive: true });
	const frozenInput = join(sourceRun, "node-evaluation", "cases", liveCase.value.caseId, "input");
	const frozenRequest = JSON.parse(readFileSync(join(frozenInput, "request.json"), "utf-8"));
	writeFileSync(join(rejectedCase, "input", "root-user-prompt.txt"), readFileSync(join(frozenInput, "root-user-prompt.txt")));
	for (const thinking_level of [undefined, "invalid"]) {
		writeFileSync(join(rejectedCase, "input", "request.json"), JSON.stringify({ ...frozenRequest, thinking_level }));
		await assert.rejects(createLivePrimeSearchReplayRecipe().replay({
			casePath: join(rejectedCase, "manifest.json"), value: liveCase.value,
			sourceRunDirectory: sourceRun, harnessWorkspaceDirectory: goalDirectory,
			recordDirectory: rejectedCase, workDirectory: rejectedCase, artifactStore: new RunArtifactStore(rejectedCase),
			runner: { async runStage() { throw new Error("invalid Case must not run"); } }, signal: new AbortController().signal,
		}), /Prime Search Case request is invalid/u);
	}

	assert.equal(liveCase.value.liveExternalState, true);
	assert.equal(liveCase.value.observed.metrics?.turns, 2,
		"Prime Search turns must count model calls rather than Agent stages");
	assert.ok(existsSync(join(sourceRun, "node-evaluation", "cases", liveCase.value.caseId, "observed-output", "logical-workspaces", "root", "workspace", "work", "query.json")),
		"captured Prime Search logical Workspaces must become immutable observed evidence");
	const liveObservedOutput = join(sourceRun, "node-evaluation", "cases", liveCase.value.caseId, "observed-output");
	for (const relativePath of [
		"result.json",
		"source-bundles/1/source-index.json",
		"search-executions/1.json",
		"decisions/organizer/groups.json",
		"rubric.md",
	]) assert.ok(existsSync(join(liveObservedOutput, relativePath)),
		`Prime Search v2 blind artifact must include ${relativePath}`);
	const observedOutput = readFileSync(join(
		sourceRun,
		"node-evaluation",
		"cases",
		liveCase.value.caseId,
		"observed-output",
		"result.json",
	), "utf-8");
	assert.doesNotMatch(observedOutput, /candidate-private-path/u, "blind artifact must not expose variant paths");
	const observedDecision = readFileSync(join(
		sourceRun,
		"node-evaluation",
		"cases",
		liveCase.value.caseId,
		"observed-output",
		"decisions",
		"organizer",
		"groups.json",
	), "utf-8");
	assert.doesNotMatch(observedDecision, /candidate-private-path/u, "blind decisions must redact absolute paths");
	assert.match(readFileSync(join(
		sourceRun,
		"node-evaluation",
		"cases",
		liveCase.value.caseId,
		"observed-output",
		"rubric.md",
	), "utf-8"), /Candidate Ledgers.*Source Bundles/su);
	const candidate = service.createCapabilitySnapshot(goalId, candidateRoot);
	const run = service.enqueue(goalId, {
		agentId: "prime-search",
		cases: [liveCase.ref],
		candidate: { capabilitySnapshotId: candidate.id },
		repetitions: 2,
		rubricId: "prime-search-provider-environment-v1",
	});
	const completed = await waitFor(service, run.id);
	assert.equal(completed.status, "awaiting_evaluation", completed.error);
	assert.equal(completed.executions.length, 2);
	for (const execution of completed.executions) {
		assert.ok(execution.candidateCaseRef);
		assert.equal(execution.candidateCaseRef!.sourceRunId, `${run.id}::executions::${execution.id}`);
		const captured = service.readCase(goalId, execution.candidateCaseRef!);
		assert.equal(captured.capabilitySnapshotId, candidate.id);
		assert.equal(captured.workspace?.input_tree_sha, "1".repeat(64));
		assert.ok(captured.observed.providerCalls);
		const candidateCaseDirectory = join(serverRuntimeDirForGoal(goalId, workspaceDir), "evaluation", "node-backtests", run.id,
			"executions", execution.id, "node-evaluation", "cases", captured.caseId);
		assert.equal(
			JSON.parse(readFileSync(join(candidateCaseDirectory, captured.observed.providerCalls!.ref), "utf-8"))
				.sub_execution_id,
			"sub-3171269c",
		);
		assert.ok(service.listCases(goalId, "prime-search", 10)
			.some(({ ref }) => ref.sourceRunId === execution.candidateCaseRef!.sourceRunId && ref.caseId === execution.candidateCaseRef!.caseId));
	}
	const bundledExecution = completed.executions[0]!;
	const bundledCase = service.readCase(goalId, bundledExecution.candidateCaseRef!);
	const bundle = await createCaseBundle({
		dataDir: workspaceDir,
		goalId,
		goalTitle: "Prime Search Fixture",
		casePath: join(serverRuntimeDirForGoal(goalId, workspaceDir), "evaluation", "node-backtests", run.id,
			"executions", bundledExecution.id, "node-evaluation", "cases", bundledCase.caseId, "manifest.json"),
		value: bundledCase,
		runtimeBuild: "fixture-runtime",
		agentBundleSha256: "a".repeat(64),
		capabilitySnapshotId: candidate.id,
		capabilityContentDirectory: join(serverRuntimeDirForGoal(goalId, workspaceDir), "evaluation", "capability-snapshots", candidate.id, "content"),
		restoreTree: async (treeSha, destination) => {
			if (treeSha.startsWith("1")) return writeFileSync(join(destination, "workspace.txt"), "fixture\n");
			const bundleRoot = join(destination, "artifacts", "source-bundles", "github", "bundle");
			const source = join(bundleRoot, "sources", "0001");
			mkdirSync(source, { recursive: true });
			writeFileSync(join(source, "material.md"), material);
			writeFileSync(join(source, "record.json"), `${JSON.stringify({ title: "Runtime Eval", summary: "Primary repository evidence.",
				metadata: { github_record: { id: "runtime-eval", title: "Runtime Eval", url: "https://github.com/example/runtime-eval",
					snippet: "Primary replay health implementation.", metadata: { repository: "example/runtime-eval" } } } })}\n`);
			writeFileSync(join(bundleRoot, "source-index.json"), `${JSON.stringify({ schema_version: 1, provider_id: "github", sources: [{
				path: "sources/0001", candidate_id: "candidate-1", source_id: "source-1", title: "Runtime Eval",
				url: "https://github.com/example/runtime-eval", files: [],
			}] })}\n`);
		},
	});
	assert.ok(bundle.manifest.workspace);
	assert.ok(bundle.manifest.files.some((file) => file.path === "case/observed-output/logical-workspaces/root/workspace/work/query.json"));
	assert.ok(bundle.manifest.provider_calls);
	assert.equal(bundle.manifest.files.some((file) => file.path.startsWith("providers/")), false);
	assert.equal(bundle.manifest.capability_snapshot_id, candidate.id);
	assert.equal(bundle.manifest.agent_id, "prime-search");
	assert.equal(bundle.manifest.node_id, "prime-search-batch-2");
	const importedWorkspace = join(root, "imported-data");
	const importedService = new NodeBacktestService({ workspaceDir: importedWorkspace, listGoalIds: () => [goalId], recipes: [liveRecipe] });
	try {
		const imported = importedService.importBundle(bundle.path, (id) => mkdirSync(join(importedWorkspace, id), { recursive: true }));
		importedService.start();
		const importedRun = importedService.enqueue(goalId, {
			agentId: "prime-search",
			cases: [imported.caseRef],
			candidate: { capabilitySnapshotId: candidate.id, promptMode: "observed" },
			repetitions: 1,
			rubricId: "prime-search-provider-environment-v1",
		});
		const importedCompleted = await waitFor(importedService, importedRun.id);
		assert.equal(importedCompleted.status, "awaiting_evaluation", importedCompleted.error);
		assert.equal(importedCompleted.executions[0]?.status, "completed");
	} finally {
		importedService.stop();
	}
	bundle.cleanup();
	assert.deepEqual(completed.executions.map((execution) => ({
		variant: execution.variant,
		output: JSON.parse(readFileSync(service.artifactFile(goalId, run.id, execution.id), "utf-8")) as { variant: string },
	})).map(({ variant, output }) => [variant, output.variant]), [
		["candidate", "candidate"],
		["candidate", "candidate"],
	]);
	assert.equal(service.evaluationBatch(goalId, run.id).pairs.length, 2);
	console.log("Prime Search Candidate Replay compares repeated Candidate outputs with the Observed Baseline");
	await withPrimeSearchNodeEvaluationCapture(captureExecutor, captureOptions).execute({
		...captureInput, sequence: 3, availableProviderIds: ["github", "unavailable-provider"],
	});
	const unavailableCase = service.listCases(goalId, "prime-search", 10)
		.find((item) => item.value.nodeId === "prime-search-batch-3")!;
	assert.ok(unavailableCase);
	const production = new NodeBacktestService({ workspaceDir, listGoalIds: () => [goalId],
		recipes: [createLivePrimeSearchReplayRecipe()] });
	const originalExecute = PrimeSearchBatchExecutor.prototype.execute;
	let batchCalls = 0;
	try {
		PrimeSearchBatchExecutor.prototype.execute = async function (request) {
			batchCalls++;
			// Stop the broken path before it could invoke a model; the correct path reaches the existing Provider guard.
			assert.ok(request.availableProviderIds.includes("unavailable-provider"), "Replay must not silently drop a captured Provider");
			return originalExecute.call(this, request);
		};
		production.start();
		const failed = await waitFor(production, production.enqueue(goalId, {
			agentId: "prime-search", cases: [unavailableCase.ref], candidate: {}, repetitions: 1,
			rubricId: "prime-search-provider-environment-v1",
		}).id);
		assert.equal(failed.status, "failed");
		assert.match(failed.executions[0]?.error ?? failed.error ?? "", /unknown available Provider 'unavailable-provider'/);
		assert.equal(batchCalls, 1);
	} finally {
		production.stop();
		PrimeSearchBatchExecutor.prototype.execute = originalExecute;
	}
} finally {
	service.stop();
	rmSync(root, { recursive: true, force: true });
}

async function waitFor(service: NodeBacktestService, runId: string) {
	while (true) {
		const run = service.read(goalId, runId)!;
		if (["awaiting_evaluation", "failed", "cancelled"].includes(run.status)) return run;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

interface CapturedPrimeSearchRequest {
	goal_id: string;
	run_id: string;
	sequence: number;
	question: string;
	available_provider_ids: string[];
	temporal_context: Parameters<SearchBatchExecutor["execute"]>[0]["temporalContext"];
	models: { root: string; child: string };
	thinking_level?: string;
}

function replayRequest(input: PrimeSearchReplayExecutionInput, captured: CapturedPrimeSearchRequest) {
	const workspaceDirectory = join(input.recordDirectory, "candidate-workspace");
	mkdirSync(workspaceDirectory, { recursive: true });
	return {
		goalId: captured.goal_id,
		runId: captured.run_id,
		sequence: captured.sequence,
		question: captured.question,
		availableProviderIds: captured.available_provider_ids,
		workspaceDirectory,
		controlDirectory: input.recordDirectory,
		artifactStore: input.artifactStore,
		temporalContext: captured.temporal_context,
		signal: input.signal,
	};
}
