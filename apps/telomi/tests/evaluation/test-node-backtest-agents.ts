import {
	recordedStageReplayRecipes,
	RECORDED_STAGE_AGENT_IDS,
	RECORDED_STAGE_RECIPE_VERSIONS,
} from "../../server/agent-runtime/recorded-stage-replay.js";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { AddressInfo } from "node:net";
import express from "express";

import { hashJson, sha256, stableJson } from "../../server/lib/hash.js";
import { listFilesRecursive } from "../../server/lib/fs.js";
import { WORKSPACE_AGENT_IDS } from "../../server/workspaces/agent-layout.js";
import { snapshotSkills } from "../../server/agent-runtime/skill-registry.js";
import { createCaseBundle } from "../../server/evaluation/case-bundle.js";
import { serverRuntimeDirForGoal } from "../../server/workspaces/server-runtime-paths.js";
import { createMainAgentReplayRecipe } from "../../server/evaluation/main-agent-replay.js";
import { createOperationsRouter } from "../../server/evaluation/api.js";
import { NodeBacktestService } from "../../server/evaluation/node-backtest.js";
import {
	beginNodeEvaluationCase,
	finishNodeEvaluationCase,
	readNodeEvaluationCase,
	type NodeReplayRecipe,
} from "../../server/agent-runtime/node-evaluation.js";
import { createProductionResearchStageRunner } from "../../server/research/pipeline/index.js";
import { RunArtifactStore } from "../../server/agent-runtime/artifact-store.js";
import {
	type AgentStageRequest,
	type AgentStageRunner,
	type StageArtifactKind,
	type ValidatedStageArtifact,
} from "../../server/agent-runtime/agent-stage-runtime.js";
import { decideSectionChildren } from "../../server/research/pipeline/report-writer-children.js";
import { getResearchSourceServiceManager } from "../../server/providers/source-service-client.js";

const root = mkdtempSync(join(tmpdir(), "telomi-node-backtest-agents-"));
// Runtime identity belongs to this fixture, not a checkout that may change during the test.
const applicationDir = join(root, "application");
mkdirSync(join(applicationDir, "agents"), { recursive: true });
const applicationFile = join(applicationDir, "agents", "fixture.txt");
writeFileSync(applicationFile, "Fixture Agent Bundle\n");
for (const args of [
	["init", "--quiet"],
	["add", "agents"],
	["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false",
		"-c", "core.hooksPath=/dev/null", "commit", "--quiet", "-m", "Fixture Runtime"],
]) execFileSync("git", args, { cwd: applicationDir, stdio: "pipe" });
const workspaceDir = join(root, "data");
const goalId = "goal_agents";
const goalDirectory = join(workspaceDir, goalId);
const sourceRunId = "source-all-agents";
const sourceRun = join(serverRuntimeDirForGoal(goalId, workspaceDir), "runs", sourceRunId);
const harnesses = {
	baseline: join(root, "baseline"),
	candidate: join(root, "candidate"),
};
mkdirSync(goalDirectory, { recursive: true });
for (const [variant, directory] of Object.entries(harnesses)) {
	mkdirSync(directory, { recursive: true });
	writeFileSync(join(directory, ".gitignore"), "wiki/runs/\n");
	mkdirSync(join(directory, "wiki", "runs", "fixture"), { recursive: true });
	writeFileSync(join(directory, "wiki", "runs", "fixture", "knowledge.md"), `${variant} knowledge\n`);
	for (const agentId of RECORDED_STAGE_AGENT_IDS) {
		const skill = join(directory, "skills", agentId, "fixture");
		mkdirSync(skill, { recursive: true });
		writeFileSync(join(skill, "SKILL.md"), `---\nname: fixture\ndescription: Node replay fixture.\n---\n`);
		writeFileSync(join(skill, "variant.txt"), `${variant}\n`);
	}
}
cpSync(harnesses.baseline, goalDirectory, { recursive: true });
mkdirSync(join(goalDirectory, "wiki", "runs", "unrelated"), { recursive: true });
writeFileSync(join(goalDirectory, "wiki", "runs", "unrelated", "material.bin"), Buffer.alloc(64 * 1024, 1));
mkdirSync(join(goalDirectory, "wiki", "knowledge"), { recursive: true });
writeFileSync(join(goalDirectory, "wiki", "knowledge", "current.md"), "Published knowledge\n");
mkdirSync(join(goalDirectory, "wiki", "runs", "fixture-extra"), { recursive: true });
writeFileSync(join(goalDirectory, "wiki", "runs", "fixture-extra", "unrelated.md"), "Unrelated history\n");
mkdirSync(sourceRun, { recursive: true });
writeFileSync(join(sourceRun, "session.jsonl"), `${JSON.stringify({ type: "message_end" })}\n`);

const cases = new Map<string, string>();
for (const agentId of RECORDED_STAGE_AGENT_IDS) {
	const input = join(sourceRun, "inputs", agentId);
	mkdirSync(input, { recursive: true });
	writeFileSync(join(input, "request.json"), `${JSON.stringify({ agentId })}\n`);
	const store = new RunArtifactStore(sourceRun);
	const workDirectory = join(sourceRun, "capture-work", agentId);
	mkdirSync(workDirectory, { recursive: true });
	const entry = join(workDirectory, "result.json");
	writeFileSync(entry, `${JSON.stringify({ agentId, variant: "observed" })}\n`);
	const artifact = store.publishFile(entry, `observed/${agentId}.json`);
	const request = recordedRequest(agentId, sourceRunId, sourceRun, workDirectory, store);
	const promptConfig = agentId === "cornell-note" ? {
		...request.promptConfig!,
		revisions: { system: { domain: "research" as const, id: agentId, kind: "system" as const,
			variant: "default", revisionId: `pr_${"1".repeat(32)}`, templateSha256: "a".repeat(64),
			source: "managed_revision" as const } },
		requestedSha256: { system: "b".repeat(64), user: "c".repeat(64) },
		composedSystemSha256: "d".repeat(64),
	} : request.promptConfig!;
	const draft = beginNodeEvaluationCase({
		request,
		recordDirectory: sourceRun,
		promptConfig,
		sessionContextFile: join(sourceRun, "missing-session.jsonl"),
		composedSystemPrompt: request.systemPrompt,
		actualModel: request.modelPolicy.preferred[0]!,
	});
	assert.ok(draft);
	const result = stageResult({ agentId, variant: "observed" }, artifact, sourceRun);
	if (agentId === "report-writer") {
		result.sessionPath = join(sourceRun, "report_writer--report-fixture.jsonl");
		writeFileSync(result.sessionPath, "{}\n");
		writeFileSync(join(sourceRun, "report_writer--report-fixture-child-01.jsonl"), "{}\n");
	}
	const logicalWorkspaces = agentId === "report-writer" ? join(sourceRun, "logical-workspaces", agentId) : undefined;
	if (logicalWorkspaces) {
		mkdirSync(join(logicalWorkspaces, "root", "workspace", "inputs"), { recursive: true });
		writeFileSync(join(logicalWorkspaces, "root.json"), `${JSON.stringify({
			schemaVersion: 1,
			guestCwd: "/workspace",
			mounts: [{ guestPath: "/workspace", access: "read-write" }],
		}, null, 2)}\n`);
		writeFileSync(join(logicalWorkspaces, "root", "workspace", "inputs", "materials.json"), "{}\n");
	}
	const capture = finishNodeEvaluationCase(draft!, {
		status: "succeeded",
		workDirectory,
		result,
		validationErrors: [],
		...(logicalWorkspaces ? { logicalWorkspaces } : {}),
	});
	assert.equal(capture.status, "captured");
	if (capture.status === "captured") {
		cases.set(agentId, capture.caseId);
		if (agentId === "cornell-note") {
			const captured = readNodeEvaluationCase(capture.casePath, sourceRun);
			assert.equal(captured.observed.trace?.root, "run");
			assert.equal(captured.observed.trace?.ref, "session.jsonl");
			assert.equal(existsSync(join(dirname(capture.casePath), "agent-trace.jsonl")), false);
			assert.equal(captured.request.promptConfig.revisions?.system?.revisionId, `pr_${"1".repeat(32)}`);
			assert.equal(captured.request.promptConfig.requestedSha256?.user, "c".repeat(64));
			assert.equal(captured.request.promptConfig.composedSystemSha256, "d".repeat(64));
		}
		if (agentId === "report-writer") {
			const captured = readNodeEvaluationCase(capture.casePath, sourceRun);
			assert.equal(captured.observed.logicalWorkspaces?.ref, "logical-workspaces");
			assert.ok(existsSync(join(dirname(capture.casePath), "logical-workspaces", "root", "workspace", "inputs", "materials.json")));
		}
	}
}
const wikiSourceRunId = "wiki-case-run";
cpSync(sourceRun, join(serverRuntimeDirForGoal(goalId, workspaceDir), "wiki-updates", wikiSourceRunId), { recursive: true });
for (const manifestPath of readdirSync(join(serverRuntimeDirForGoal(goalId, workspaceDir), "wiki-updates", wikiSourceRunId, "node-evaluation", "cases"))
	.map((caseId) => join(serverRuntimeDirForGoal(goalId, workspaceDir), "wiki-updates", wikiSourceRunId, "node-evaluation", "cases", caseId, "manifest.json"))
	.filter((path) => existsSync(path))) {
	// A copied Run keeps its own runId, as a real Wiki Update Run would.
	const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as { runId: string };
	writeFileSync(manifestPath, JSON.stringify({ ...manifest, runId: wikiSourceRunId }, null, 2));
}
const brokenCaseDirectory = join(sourceRun, "node-evaluation", "cases", "broken-missing-file");
cpSync(join(sourceRun, "node-evaluation", "cases", cases.get("cornell-note")!), brokenCaseDirectory, { recursive: true });
rmSync(join(brokenCaseDirectory, "system-prompt.txt"));

const writableRoot = join(sourceRun, "writable-capture");
mkdirSync(writableRoot, { recursive: true });
writeFileSync(join(writableRoot, "page.md"), "# Before\n");
const writableWork = join(sourceRun, "writable-work");
mkdirSync(writableWork, { recursive: true });
const writableStore = new RunArtifactStore(sourceRun);
const writableEntry = join(writableWork, "result.json");
writeFileSync(writableEntry, "{}\n");
const writableArtifact = writableStore.publishFile(writableEntry, "observed/writable.json");
const writableRequest = recordedRequest("cornell-note", sourceRunId, sourceRun, writableWork, writableStore);
writableRequest.stageId = "writable-capture";
writableRequest.attemptId = "writable-capture";
writableRequest.evaluation = { ...writableRequest.evaluation!, writableGuestPaths: ["/wiki"] };
writableRequest.writableMounts = [{ hostPath: writableRoot, guestPath: "/wiki", access: "read-write" }];
const writableDraft = beginNodeEvaluationCase({
	request: writableRequest,
	recordDirectory: sourceRun,
	promptConfig: writableRequest.promptConfig!,
	sessionContextFile: join(sourceRun, "missing-writable-session.jsonl"),
	composedSystemPrompt: writableRequest.systemPrompt,
	actualModel: writableRequest.modelPolicy.preferred[0]!,
})!;
writeFileSync(join(writableRoot, "page.md"), "# After\n");
const providerCallLines = [
	{ seq: 1, node_id: writableRequest.stageId, attempt_id: "writable-capture", provider: "github" },
	{ seq: 2, node_id: writableRequest.stageId, attempt_id: "other-attempt", provider: "github" },
	{ seq: 3, node_id: "another-node", attempt_id: "writable-capture", provider: "arxiv" },
	{ seq: 4, node_id: writableRequest.stageId, attempt_id: "writable-capture", provider: "arxiv" },
].map((call) => JSON.stringify(call));
writeFileSync(join(sourceRun, "provider-calls.jsonl"), `${providerCallLines.join("\n")}\n`);
const workspaceSnapshot = {
	input_tree_sha: "a".repeat(64),
	output_tree_sha: null,
	exclude: [".venv", "node_modules"],
	warnings: ["output workspace tree snapshot unavailable: service down"],
};
const writableCapture = finishNodeEvaluationCase(writableDraft, {
	status: "succeeded",
	workDirectory: writableWork,
	result: stageResult({}, writableArtifact, sourceRun),
	validationErrors: [],
	durationMs: 12,
	workspace: workspaceSnapshot,
});
assert.equal(writableCapture.status, "captured");
const writableCase = readNodeEvaluationCase(writableDraft.manifestPath, sourceRun);
assert.notEqual(writableCase.writableMounts?.[0]?.initial.sha256, writableCase.observed.writableMounts?.[0]?.final.sha256);
assert.equal(writableCase.observed.durationMs, 12);
assert.deepEqual(writableCase.workspace, workspaceSnapshot);
assert.equal(writableCase.observed.providerCalls?.ref, "provider-calls.jsonl");
assert.equal(
	readFileSync(join(dirname(writableDraft.manifestPath), "provider-calls.jsonl"), "utf-8"),
	`${providerCallLines[0]}\n${providerCallLines[3]}\n`,
);
assert.equal(writableCase.observed.providerCalls?.sha256, sha256(`${providerCallLines[0]}\n${providerCallLines[3]}\n`));

const staleRequest = recordedRequest("cornell-note", sourceRunId, sourceRun, writableWork, writableStore);
staleRequest.stageId = "removed-report-architect";
staleRequest.evaluation = {
	...staleRequest.evaluation!,
	agentId: "report-architect",
	recipe: { id: "report-architect", version: 1 },
};
const staleDraft = beginNodeEvaluationCase({
	request: staleRequest,
	recordDirectory: sourceRun,
	promptConfig: staleRequest.promptConfig!,
	sessionContextFile: join(sourceRun, "missing-stale-session.jsonl"),
	composedSystemPrompt: staleRequest.systemPrompt,
	actualModel: staleRequest.modelPolicy.preferred[0]!,
})!;
assert.equal(finishNodeEvaluationCase(staleDraft, {
	status: "succeeded",
	workDirectory: writableWork,
	result: stageResult({}, writableArtifact, sourceRun),
	validationErrors: [],
}).status, "captured");

const primeTraceId = "prime-search-batch-fixture";
const primeTracePath = join(sourceRun, `prime_search--${primeTraceId}.jsonl`);
writeFileSync(primeTracePath, `${JSON.stringify({ type: "message", message: { role: "assistant", content: [] } })}\n`);
const primeTraceRoot = join(sourceRun, "prime-search-traces", primeTraceId);
for (const [relativePath, content] of [
	["acquisition-session/session/root.jsonl", "{}\n"],
	["acquisition-session/sdk-events.jsonl", "{}\n"],
	["acquisition-session/session-artifacts/root/sub/child.jsonl", "{}\n"],
	["organizer-session/session/organizer.jsonl", "{}\n"],
	["agent/settings.json", "{}\n"],
	["agent/logs/daemon.log", "fixture\n"],
	["execution-conditions.jsonl", "{}\n"],
	["provider.jsonl", "{}\n"],
	["decisions/organizer/decision.json", "{}\n"],
	["decisions/organizer/groups.json", "{}\n"],
] as const) {
	const path = join(primeTraceRoot, relativePath);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, content);
}
const primeWorkspaceArtifacts = join(goalDirectory, "wiki", "runs", sourceRunId, "artifacts");
for (const relativePath of [
	"search-executions/github.json",
	"source-bundles/github/source/source-index.json",
]) {
	const path = join(primeWorkspaceArtifacts, relativePath);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, "{}\n");
}
const primeOutputSource = join(root, "prime-output");
mkdirSync(primeOutputSource);
writeFileSync(join(primeOutputSource, "result.json"), "{}\n");
const primeOutput = new RunArtifactStore(sourceRun).publishDirectory(primeOutputSource, "observed/prime-search-fixture");
const primeRequest = recordedRequest("cornell-note", sourceRunId, sourceRun, writableWork, writableStore);
primeRequest.stageId = "prime-search-batch-fixture";
primeRequest.role = "prime_search";
primeRequest.evaluation = {
	...primeRequest.evaluation!,
	agentId: "prime-search",
	recipe: { id: "prime-search", version: 4 },
};
const primeDraft = beginNodeEvaluationCase({
	request: primeRequest,
	recordDirectory: sourceRun,
	promptConfig: primeRequest.promptConfig!,
	sessionContextFile: join(sourceRun, "missing-prime-session.jsonl"),
	composedSystemPrompt: primeRequest.systemPrompt,
	actualModel: primeRequest.modelPolicy.preferred[0]!,
})!;
const primeResult = stageResult({}, primeOutput, sourceRun);
primeResult.sessionPath = primeTracePath;
assert.equal(finishNodeEvaluationCase(primeDraft, {
	status: "succeeded",
	workDirectory: writableWork,
	result: primeResult,
	validationErrors: [],
}).status, "captured");

let frozenPrimeHold: Promise<void> | undefined;
let notifyFrozenPrimeStarted: (() => void) | undefined;
let holdFrozenPrime = false;
let failingPrimeCaseId: string | undefined;
let primeReplayCalls = 0;
const frozenPrimeReplayRecipe: NodeReplayRecipe = {
	identity: { id: "prime-search", version: 4 },
	async replay(input) {
		primeReplayCalls++;
		const traceId = "prime-search-replay-fixture";
		const failing = input.value.caseId === failingPrimeCaseId
			|| existsSync(join(input.harnessWorkspaceDirectory, "skills", "prime-search", "fixture", "FAIL"));
		const traceRoot = failing
			? join(input.recordDirectory, "workspaces", "search-batch-1", "runtime")
			: join(input.recordDirectory, "prime-search-traces", traceId);
		for (const [relativePath, content] of [
			["acquisition-session/session/root.jsonl", "{}\n"],
			["acquisition-session/sdk-events.jsonl", "{\"type\":\"rlm_child_update\",\"child\":{\"id\":\"sub-fixture\",\"status\":\"running\"}}\n"],
			["acquisition-session/session-artifacts/root/sub/rlm-subagent.json", "{}\n"],
			["agent/settings.json", "{}\n"],
			["agent/logs/daemon.log", "fixture\n"],
			["execution-conditions.jsonl", "{}\n"],
			["provider.jsonl", "{}\n"],
			["decisions/organizer/decision.json", "{}\n"],
			...(!holdFrozenPrime ? [["decisions/provider-executions/sub/work/provider_candidates.json", "{}\n"]] : []),
		] as const) {
			const path = join(traceRoot, relativePath);
			mkdirSync(dirname(path), { recursive: true });
			writeFileSync(path, content);
		}
		if (holdFrozenPrime) {
			const liveProviderWork = join(input.recordDirectory, "workspaces", "search-batch-1", "agent", "provider-executions", "sub-live", "work");
			mkdirSync(liveProviderWork, { recursive: true });
			writeFileSync(join(liveProviderWork, ".provider-assignment"), "github\n");
			writeFileSync(join(liveProviderWork, "github_candidates.json"), "{}\n");
		}
		writeFileSync(join(input.recordDirectory, `prime_search--${traceId}.jsonl`), `${JSON.stringify({
			type: "message",
			timestamp: "2026-01-01T00:00:00.000Z",
			message: {
				role: "assistant",
				usage: { input: 7, output: 2, cost: { total: 0.01 } },
				content: [{ type: "toolCall" }],
			},
		})}\n`);
		if (holdFrozenPrime) {
			notifyFrozenPrimeStarted?.();
			await frozenPrimeHold;
		}
		if (failing) {
			throw new Error("fixture candidate failure");
		}
		input.artifactStore.publishText("{}\n", "artifacts/search-executions/github.json");
		input.artifactStore.publishText("{}\n", "artifacts/source-bundles/github/source/source-index.json");
		const output = join(input.workDirectory, "output");
		mkdirSync(output, { recursive: true });
		writeFileSync(join(output, "result.json"), '{"schema_version":2,"sources":[],"executions":[]}\n');
		return {
			caseId: input.value.caseId,
			agentId: "prime-search",
			artifact: input.artifactStore.publishDirectory(output, "result"),
			usage: { inputTokens: 1, outputTokens: 1, costUsd: 0, calls: 1 },
			turns: 1,
			toolCalls: 1,
		};
	},
};

const replayed = new Map<string, number>();
const replayPrompts = new Map<string, Array<{ system: string; user: string }>>();
const runner: AgentStageRunner = {
	async runStage<T>(request: AgentStageRequest<T>): Promise<ValidatedStageArtifact<T>> {
		const agentId = request.promptConfig!.id;
		const candidateReplay = request.evaluation?.capabilitySnapshotId;
		if (candidateReplay) {
			assert.equal(request.recordKind, "research");
			assert.match(request.runId, /^nodebt_.+::executions::candidate_/u);
		}
		const capability = request.readonlyMounts.find((mount) => mount.guestPath === "/workspace/skills");
		assert.ok(capability, `${agentId} capability mount is missing`);
		const variant = readFileSync(join(capability!.hostPath, "fixture", "variant.txt"), "utf-8").trim();
		if (agentId === "report-writer") {
			const knowledge = request.readonlyMounts.find((mount) => mount.guestPath === "/knowledge");
			assert.ok(knowledge, "report-writer knowledge mount is missing");
			assert.match(readFileSync(join(knowledge!.hostPath, "knowledge.md"), "utf-8"), /knowledge/u);
		}
		replayed.set(agentId, (replayed.get(agentId) ?? 0) + 1);
		replayPrompts.set(agentId, [
			...(replayPrompts.get(agentId) ?? []),
			{ system: request.systemPrompt, user: request.userPrompt },
		]);
		mkdirSync(request.workDirectory, { recursive: true });
		const entry = join(request.workDirectory, "result.json");
		writeFileSync(entry, `${JSON.stringify({ agentId, variant })}\n`);
		if (agentId === "cornell-note") {
			writeFileSync(join(request.recordDirectory!, "cornell_note--fixture.jsonl"), "{}\n");
			writeFileSync(join(request.recordDirectory!, "runtime--evaluation.jsonl"), "{}\n");
		}
		if (agentId === "report-writer") {
			const runtimeRoot = join(request.recordDirectory!, "work", "runtime", "writer-report-1-execution");
			mkdirSync(join(runtimeRoot, "session"), { recursive: true });
			writeFileSync(join(runtimeRoot, "session", "root.jsonl"), "{}\n");
			mkdirSync(join(runtimeRoot, "session-artifacts", "sub-fixture"), { recursive: true });
			writeFileSync(join(request.recordDirectory!, "report_writer--writer-report-1-child-01.jsonl"), "{}\n");
			writeFileSync(join(request.recordDirectory!, "report_writer--writer-report-1-note-tools.jsonl"), "{}\n");
			writeFileSync(join(request.recordDirectory!, "report_writer--writer-report-1.jsonl"), "{}\n");
			writeFileSync(join(request.recordDirectory!, "runtime--evaluation.jsonl"), `${JSON.stringify({
				type: "node_execution",
				agent: "report_writer",
				execution_id: "writer-report-1-execution",
				trace_ref: "report_writer--writer-report-1.jsonl",
			})}\n`);
			writeFileSync(join(runtimeRoot, "session-artifacts", "sub-fixture", "child.jsonl"), "{}\n");
			writeFileSync(join(runtimeRoot, "root-events.jsonl"), "{}\n");
			writeFileSync(join(runtimeRoot, "kernel-launches.jsonl"), "{}\n");
			writeFileSync(join(runtimeRoot, "initial-prompt.md"), "fixture\n");
			const previousRuntime = join(dirname(runtimeRoot), "writer-report-0-previous");
			mkdirSync(join(previousRuntime, "session"), { recursive: true });
			mkdirSync(join(previousRuntime, "session-artifacts"), { recursive: true });
			writeFileSync(join(previousRuntime, "session", "root.jsonl"), "{}\n");
			writeFileSync(join(previousRuntime, "session-artifacts", "child.jsonl"), "{}\n");
			writeFileSync(join(previousRuntime, "initial-prompt.md"), "stale prompt\n");
			writeFileSync(join(previousRuntime, "root-events.jsonl"), "{}\n");
		}
		const artifact = request.artifactStore.publishFile(entry, request.output.publishRelativePath);
		const result = stageResult({ agentId, variant } as T, artifact, request.recordDirectory ?? request.controlDirectory);
		if (candidateReplay) {
			const draft = beginNodeEvaluationCase({
				request,
				recordDirectory: request.recordDirectory ?? request.controlDirectory,
				promptConfig: request.promptConfig!,
				sessionContextFile: result.sessionPath,
				composedSystemPrompt: request.systemPrompt,
				actualModel: request.modelPolicy.preferred[0]!,
			});
			assert.ok(draft);
			result.evaluationCapture = finishNodeEvaluationCase(draft!, {
				status: "succeeded",
				workDirectory: request.workDirectory,
				result,
				validationErrors: [],
				workspace: { input_tree_sha: "1".repeat(64), output_tree_sha: "2".repeat(64), exclude: ["node_modules"] },
			});
		}
		return result;
	},
};

const productionRunner = createProductionResearchStageRunner({ env: {} }, {
	runStage: async () => { throw new Error("Unexpected generic Stage routing"); },
});

assert.deepEqual(decideSectionChildren({
	children: [{ id: "a", status: "done" }, { id: "b", status: "done" }],
	expected: 1,
}), {
	kind: "failed",
	message: "Prime Report Writer root spawned 2 Section children for 1 Sections",
});
assert.deepEqual(decideSectionChildren({ children: [], expected: 0 }), { kind: "ready" });
assert.deepEqual(decideSectionChildren({ children: [{ id: "a", status: "done" }], expected: 1 }), { kind: "ready" });
assert.deepEqual(decideSectionChildren({ children: [], expected: 1 }), {
	kind: "failed", message: "Prime Report Writer root spawned 0 Section children for 1 Sections",
});
for (const status of ["queued", "running", undefined] as const) {
	assert.deepEqual(decideSectionChildren({ children: [{ id: "a", status }], expected: 1 }), {
		kind: "failed", message: "Prime Report Writer child state was not terminal after RLM quiescence",
	});
}
for (const status of ["error", "cancelled"] as const) {
	assert.deepEqual(decideSectionChildren({ children: [{ id: "a", status, error: "stopped" }], expected: 1 }), {
		kind: "failed", message: `Section child a ended '${status}': stopped`,
	});
}
await assert.rejects(
	productionRunner.runStage({ ...recordedRequest("cornell-note", sourceRunId, sourceRun,
		join(sourceRun, "routing-note"), new RunArtifactStore(sourceRun)), readonlyMounts: [],
		output: { kind: "cornell_note", entryRelativePath: "cornell-note.json",
			publishRelativePath: "routing/cornell-note.json", validate: () => ({}) } }),
	/requires the bounded \/source mount/u,
	"Cornell Note must route through the Prime production runner",
);
await assert.rejects(
	productionRunner.runStage({ ...recordedRequest("report-writer", sourceRunId, sourceRun,
		join(sourceRun, "routing-report"), new RunArtifactStore(sourceRun)), stageId: "writer-report", readonlyMounts: [] }),
	/requires the bounded \/inputs mount/u,
	"Report Writer must route through the Prime production runner",
);

const service = new NodeBacktestService({
	workspaceDir,
	applicationDir,
	listGoalIds: () => [goalId],
	recipes: [
		createMainAgentReplayRecipe(),
		frozenPrimeReplayRecipe,
		...recordedStageReplayRecipes,
	],
	runner,
});
let server: ReturnType<ReturnType<typeof express>["listen"]> | undefined;

try {
	service.start();
	const app = express();
	app.use(express.json());
	app.use(createOperationsRouter({
		getGoal: (id: string) => id === goalId ? { id } as never : undefined,
		ensureImportedGoal: (id: string) => ({ id } as never),
	}, service, "eval", join(workspaceDir, "operations-exchange")));
	server = app.listen(0, "127.0.0.1");
	await new Promise<void>((resolveListen) => server!.once("listening", resolveListen));
	const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	assert.deepEqual(service.status().recipes, [
		"cornell-note@3",
		"main-agent@1",
		"prime-search@4",
		"report-writer@2",
	]);
	assert.equal(service.status().runtimeBuildMatchesDisk, true);
	assert.equal(service.listCases(goalId, "report-architect", 10).length, 0,
		"Case listing must hide Nodes whose replay Recipe is no longer registered");
	const listedCases = service.listCases(goalId, "cornell-note", 10);
	assert.ok(listedCases.some(({ ref }) => ref.sourceRunId === wikiSourceRunId),
		"Wiki Update Cases must use the unified Case interface");
	const casesResponse = await fetch(`${baseUrl}/operations/v1/goals/${goalId}/cases?agentId=cornell-note&limit=10`);
	assert.equal(casesResponse.status, 200, await casesResponse.clone().text());
	const primeFilesResponse = await fetch(`${baseUrl}/operations/v1/goals/${goalId}/cases/${sourceRunId}/${primeDraft.caseId}/files`);
	assert.equal(primeFilesResponse.status, 200, await primeFilesResponse.clone().text());
	const primeFiles = (await primeFilesResponse.json() as { files: Array<{ ref: string; kind: string }> }).files;
	for (const expected of [
		{ ref: "input:request.json", kind: "input" },
		{ ref: "output:result.json", kind: "observed_output" },
		{ ref: `run:prime-search-traces/${primeTraceId}/provider.jsonl`, kind: "provider_trace" },
		{ ref: `run:prime-search-traces/${primeTraceId}/acquisition-session/session-artifacts/root/sub/child.jsonl`, kind: "child_trace" },
		{ ref: `run:prime-search-traces/${primeTraceId}/decisions/organizer/decision.json`, kind: "organizer_decision" },
		{ ref: `run:prime-search-traces/${primeTraceId}/agent/settings.json`, kind: "prime_trace_file" },
		{ ref: `run:prime-search-traces/${primeTraceId}/agent/logs/daemon.log`, kind: "prime_trace_file" },
		{ ref: `run:prime-search-traces/${primeTraceId}/execution-conditions.jsonl`, kind: "execution_conditions" },
		{ ref: "workspace:artifacts/search-executions/github.json", kind: "search_execution" },
		{ ref: "workspace:artifacts/source-bundles/github/source/source-index.json", kind: "source_bundle_index" },
	]) {
		assert.ok(primeFiles.some((file) => file.ref === expected.ref && file.kind === expected.kind),
			`Prime Search Case files must include ${expected.ref}`);
		const fileResponse = await fetch(`${baseUrl}/operations/v1/goals/${goalId}/cases/${sourceRunId}/${primeDraft.caseId}/file?ref=${encodeURIComponent(expected.ref)}`);
		assert.equal(fileResponse.status, 200, await fileResponse.clone().text());
	}
	const reportCaseFilesResponse = await fetch(`${baseUrl}/operations/v1/goals/${goalId}/cases/${sourceRunId}/${cases.get("report-writer")!}/files`);
	const reportCaseFiles = (await reportCaseFilesResponse.json() as { files: Array<{ ref: string }> }).files;
	assert.ok(reportCaseFiles.some((file) => file.ref === "run:report_writer--report-fixture-child-01.jsonl"),
		"Report Writer Case must expose sibling child traces");
	const frozenPrimeRun = service.enqueue(goalId, {
		agentId: "prime-search",
		cases: [{ sourceRunId, caseId: primeDraft.caseId }],
		candidate: {},
		repetitions: 1,
		rubricId: "prime-search-trace-fixture",
	});
	assert.equal((await waitForEvaluation(service, frozenPrimeRun.id)).status, "awaiting_evaluation");
	const frozenPrimeResponse = await fetch(`${baseUrl}/operations/v1/goals/${goalId}/replays/${frozenPrimeRun.id}`);
	assert.equal(frozenPrimeResponse.status, 200, await frozenPrimeResponse.clone().text());
	const frozenPrime = await frozenPrimeResponse.json() as {
		run: { runtimeBuild?: string; executions: Array<{ refs?: Record<string, string> }> };
	};
	const frozenRefs = frozenPrime.run.executions[0]?.refs;
	const providerLogRef = frozenRefs?.providerLog;
	assert.ok(providerLogRef, "Frozen Prime Search replay must project its Provider Trace");
	assert.ok(frozenRefs?.candidateLedger1, "Frozen Prime Search replay must project Candidate Ledgers");
	assert.ok(frozenRefs?.childMetadata1, "Frozen Prime Search replay must project child metadata");
	assert.ok(frozenRefs?.sourceIndex1, "Frozen Prime Search replay must project Source Indexes");
	assert.ok(frozenRefs?.searchExecution1, "Frozen Prime Search replay must project Search Execution Records");
	assert.ok(frozenRefs?.organizerRawDecision, "Frozen Prime Search replay must project the raw Organizer decision");
	assert.ok(frozenRefs?.agentSettings, "Frozen Prime Search replay must project Prime settings");
	assert.ok(frozenRefs?.executionConditions, "Frozen Prime Search replay must project execution conditions");
	assert.ok(frozenRefs?.sdkEvents, "Frozen Prime Search replay must project SDK lifecycle events");
	assert.ok(frozenPrime.run.runtimeBuild, "Frozen Candidate Run must pin the Runtime build identity");
	const frozenPrimeTraceResponse = await fetch(`${baseUrl}/operations/v1/goals/${goalId}/replays/${frozenPrimeRun.id}/files?ref=${encodeURIComponent(providerLogRef!)}`);
	assert.equal(frozenPrimeTraceResponse.status, 200, await frozenPrimeTraceResponse.clone().text());
	let releaseHeldPrime!: () => void;
	frozenPrimeHold = new Promise<void>((resolve) => { releaseHeldPrime = resolve; });
	const heldPrimeStarted = new Promise<void>((resolve) => { notifyFrozenPrimeStarted = resolve; });
	holdFrozenPrime = true;
	const heldPrimeRun = service.enqueue(goalId, {
		agentId: "prime-search",
		cases: [{ sourceRunId, caseId: primeDraft.caseId }],
		candidate: {},
		repetitions: 1,
		rubricId: "prime-search-running-trace-fixture",
	});
	try {
		await heldPrimeStarted;
		const runningResponse = await fetch(`${baseUrl}/operations/v1/goals/${goalId}/replays/${heldPrimeRun.id}`);
		assert.equal(runningResponse.status, 200, await runningResponse.clone().text());
		const running = await runningResponse.json() as {
			run: { status: string; activeExecution?: { status: string; refs?: Record<string, string> } };
		};
		assert.equal(running.run.status, "running");
		assert.equal(running.run.activeExecution?.status, "running");
		const sdkEventsRef = running.run.activeExecution?.refs?.sdkEvents;
		assert.ok(sdkEventsRef, "Running Candidate replay must project SDK lifecycle events");
		const candidateLedgerRef = running.run.activeExecution?.refs?.candidateLedger1;
		assert.match(candidateLedgerRef ?? "", /workspaces\/search-batch-1\/agent\/provider-executions\/sub-live\/work\/github_candidates\.json$/u,
			"Running Candidate replay must project submitted Candidate Ledgers from the live Agent workspace");
		const liveTraceResponse = await fetch(`${baseUrl}/operations/v1/goals/${goalId}/replays/${heldPrimeRun.id}/files?ref=${encodeURIComponent(sdkEventsRef!)}`);
		assert.equal(liveTraceResponse.status, 200, await liveTraceResponse.clone().text());
		const liveLedgerResponse = await fetch(`${baseUrl}/operations/v1/goals/${goalId}/replays/${heldPrimeRun.id}/files?ref=${encodeURIComponent(candidateLedgerRef!)}`);
		assert.equal(liveLedgerResponse.status, 200, await liveLedgerResponse.clone().text());
	} finally {
		releaseHeldPrime();
		frozenPrimeHold = undefined;
		notifyFrozenPrimeStarted = undefined;
		holdFrozenPrime = false;
	}
	const heldPrimeCompleted = await waitForEvaluation(service, heldPrimeRun.id);
	assert.equal(heldPrimeCompleted.status, "awaiting_evaluation");
	if (!("mode" in heldPrimeCompleted) || heldPrimeCompleted.mode !== "candidate-replay") {
		throw new Error("Expected Candidate Replay run");
	}
	assert.equal(heldPrimeCompleted.activeExecution, undefined);
	const failingHarness = join(root, "failing-candidate");
	cpSync(harnesses.candidate, failingHarness, { recursive: true });
	const failingSkill = join(failingHarness, "skills", "prime-search", "fixture");
	mkdirSync(failingSkill, { recursive: true });
	writeFileSync(join(failingSkill, "SKILL.md"), "---\nname: fixture\ndescription: Failed replay fixture.\n---\n");
	writeFileSync(join(failingSkill, "FAIL"), "fixture\n");
	const failingSnapshot = service.createCapabilitySnapshot(goalId, failingHarness);
	const failedPrimeRun = service.enqueue(goalId, {
		agentId: "prime-search",
		cases: [{ sourceRunId, caseId: primeDraft.caseId }],
		candidate: { capabilitySnapshotId: failingSnapshot.id },
		repetitions: 1,
		rubricId: "prime-search-failed-trace-fixture",
	});
	const failedPrime = await waitForEvaluation(service, failedPrimeRun.id);
	assert.equal(failedPrime.status, "failed");
	assert.ok("pairs" in failedPrime);
	assert.equal(failedPrime.executions.length, 1, "Failed Candidate replay must persist its partial execution");
	assert.equal(failedPrime.pairs.length, 1, "Failed Candidate replay must remain inspectable as a blind pair");
	assert.equal(failedPrime.executions[0]?.status, "failed");
	assert.match(failedPrime.executions[0]?.error ?? "", /fixture candidate failure/u);
	assert.equal(failedPrime.executions[0]?.metrics.inputTokens, 7);
	assert.ok(failedPrime.executions[0]?.refs?.providerLog, "Failed Prime Search replay must expose native Trace refs");
	const failedBatch = service.evaluationBatch(goalId, failedPrimeRun.id);
	assert.equal(failedBatch.pairs.length, 1, "Failed replay evidence must be readable through the evaluation interface");
	assert.match(Object.values(failedBatch.pairs[0]!.outputs).map((output) => output.content ?? "").join("\n"),
		/fixture candidate failure/u);
	const failedProviderTraceResponse = await fetch(`${baseUrl}/operations/v1/goals/${goalId}/replays/${failedPrimeRun.id}/files?ref=${encodeURIComponent(failedPrime.executions[0]!.refs!.providerLog!)}`);
	assert.equal(failedProviderTraceResponse.status, 200, await failedProviderTraceResponse.clone().text());
	const batchCases = [{ sourceRunId, caseId: primeDraft.caseId }];
	for (const attemptId of ["batch-middle", "batch-last"]) {
		const draft = beginNodeEvaluationCase({
			request: { ...primeRequest, attemptId }, recordDirectory: sourceRun,
			promptConfig: primeRequest.promptConfig!, sessionContextFile: join(sourceRun, "missing-prime-session.jsonl"),
			composedSystemPrompt: primeRequest.systemPrompt, actualModel: primeRequest.modelPolicy.preferred[0]!,
		})!;
		assert.equal(finishNodeEvaluationCase(draft, {
			status: "succeeded", workDirectory: writableWork, result: primeResult, validationErrors: [],
		}).status, "captured");
		batchCases.push({ sourceRunId, caseId: draft.caseId });
	}
	failingPrimeCaseId = batchCases[1]!.caseId;
	const fullBatch = await waitForEvaluation(service, service.enqueue(goalId, {
		agentId: "prime-search", cases: batchCases, candidate: {}, repetitions: 1,
		rubricId: "continue-after-case-failure",
	}).id);
	failingPrimeCaseId = undefined;
	assert.equal(fullBatch.status, "failed", "one failed Case still fails the batch");
	assert.deepEqual(fullBatch.executions.map((entry) => entry.status), ["completed", "failed", "completed"],
		`failure in the middle Case must not prevent the last Case from being evaluated: ${fullBatch.error ?? "no run error"}`);
	assert.equal(fullBatch.pairs.length, 3, "all attempted Cases retain review evidence");

	let releaseCancelledPrime!: () => void;
	frozenPrimeHold = new Promise<void>((resolve) => { releaseCancelledPrime = resolve; });
	const cancelledPrimeStarted = new Promise<void>((resolve) => { notifyFrozenPrimeStarted = resolve; });
	holdFrozenPrime = true;
	const callsBeforeCancel = primeReplayCalls;
	const cancelledBatch = service.enqueue(goalId, {
		agentId: "prime-search", cases: batchCases, candidate: {}, repetitions: 1, rubricId: "cancel-stops-batch",
	});
	try {
		await cancelledPrimeStarted;
		service.cancel(goalId, cancelledBatch.id);
	} finally {
		releaseCancelledPrime();
		frozenPrimeHold = undefined;
		notifyFrozenPrimeStarted = undefined;
		holdFrozenPrime = false;
	}
	while (service.status().active > 0) await new Promise((resolve) => setTimeout(resolve, 5));
	assert.equal(service.read(goalId, cancelledBatch.id)?.status, "cancelled");
	assert.equal(primeReplayCalls, callsBeforeCancel + 1, "cancellation must stop the remaining Cases");
	const candidateSnapshot = service.createCapabilitySnapshot(goalId, harnesses.candidate);
	assert.throws(() => service.enqueue(goalId, {
		agentId: "cornell-note",
		cases: [{ sourceRunId, caseId: cases.get("cornell-note")! }],
		candidate: { expectedRuntimeBuild: "different-build" },
		rubricId: "runtime-build-mismatch",
	}), /expected Runtime build/u);
	writeFileSync(applicationFile, "Changed Agent Bundle\n");
	try {
		assert.equal(service.status().runtimeBuildMatchesDisk, false);
		assert.throws(() => service.enqueue(goalId, {
			agentId: "cornell-note",
			cases: [{ sourceRunId, caseId: cases.get("cornell-note")! }],
			candidate: {},
			rubricId: "runtime-disk-drift",
		}), /repository is .*restart Telomi/u);
	} finally {
		writeFileSync(applicationFile, "Fixture Agent Bundle\n");
	}
	assert.equal(service.status().runtimeBuildMatchesDisk, true);
	assert.throws(() => service.enqueue(goalId, {
		agentId: "cornell-note",
		cases: [{ sourceRunId, caseId: cases.get("cornell-note")! }],
		candidate: {
			expectedRuntimeBuild: service.status().runtimeBuild,
			expectedAgentBundleSha256: "f".repeat(64),
		},
		rubricId: "agent-bundle-mismatch",
	}), /expected Agent Bundle/u);
	assert.throws(() => service.enqueue(goalId, {
		agentId: "cornell-note",
		cases: [{ sourceRunId, caseId: cases.get("cornell-note")! }],
		candidate: { capabilitySnapshotId: candidateSnapshot.id },
		rubricId: "missing-candidate-prompt",
	}), /Candidate Capability Bundle requires promptMode/u);
	const candidateRun = service.enqueue(goalId, {
		agentId: "cornell-note",
		cases: [{ sourceRunId, caseId: cases.get("cornell-note")! }],
		candidate: { capabilitySnapshotId: candidateSnapshot.id, promptMode: "observed" },
		repetitions: 1,
		rubricId: "cornell-note-skill-candidate-v1",
	});
	assert.equal(candidateRun.candidate.promptBundle?.source, "observed");
	assert.equal(candidateRun.candidate.promptBundle?.cases[0]?.systemPrompt, "cornell-note system");
	assert.equal(candidateRun.candidate.promptBundle?.cases[0]?.userPrompt, "cornell-note user");
	const candidateCompleted = await waitForEvaluation(service, candidateRun.id);
	assert.equal(candidateCompleted.status, "awaiting_evaluation", candidateCompleted.error ?? "unexpected status");
	assert.deepEqual(replayPrompts.get("cornell-note")?.at(-1), {
		system: "cornell-note system",
		user: "cornell-note user",
	});
	assert.deepEqual(candidateCompleted.executions.map((execution) => ({
		variant: execution.variant,
		content: JSON.parse(readFileSync(
			service.artifactFile(goalId, candidateRun.id, execution.id),
			"utf-8",
		)) as { variant: string },
	})), [
		{ variant: "candidate", content: { agentId: "cornell-note", variant: "candidate" } },
	]);
	const candidatePair = service.evaluationBatch(goalId, candidateRun.id).pairs[0]!;
	assert.deepEqual(Object.values(candidatePair.outputs).map((output) =>
		JSON.parse(output.content ?? "{}") as { variant: string }).map((output) => output.variant).sort(),
	["candidate", "observed"]);
	const overriddenRun = service.enqueue(goalId, {
		agentId: "cornell-note",
		cases: [{ sourceRunId, caseId: cases.get("cornell-note")! }],
		candidate: {
			capabilitySnapshotId: candidateSnapshot.id,
			promptMode: "override",
			promptOverride: { systemPrompt: "candidate system", userPrompt: "candidate user" },
		},
		repetitions: 1,
		rubricId: "cornell-note-prompt-candidate-v1",
	});
	assert.equal(overriddenRun.candidate.promptBundle?.source, "override");
	assert.equal(overriddenRun.candidate.promptBundle?.cases[0]?.systemPrompt, "candidate system");
	assert.equal(overriddenRun.candidate.promptOverride, undefined,
		"Resolved Candidate Bundle must not duplicate Prompt text outside promptBundle");
	assert.notEqual(overriddenRun.candidate.capabilityBundleHash, candidateRun.candidate.capabilityBundleHash,
		"Candidate Capability Bundle identity must include its Prompt Bundle");
	assert.equal((await waitForEvaluation(service, overriddenRun.id)).status, "awaiting_evaluation");
	assert.deepEqual(replayPrompts.get("cornell-note")?.at(-1), {
		system: "candidate system",
		user: "candidate user",
	});
	assert.throws(() => service.enqueue(goalId, {
		agentId: "cornell-note",
		cases: [{ sourceRunId, caseId: cases.get("cornell-note")! }],
		baseline: {},
		candidate: {},
		rubricId: "legacy-paired-request",
	} as never), /Observed Baseline comes from each Node Case/u);
	const recordedRuns = new Map<string, string>();
	for (const agentId of RECORDED_STAGE_AGENT_IDS) {
		const run = service.enqueue(goalId, {
			agentId,
			cases: [{ sourceRunId, caseId: cases.get(agentId)! }],
			candidate: { promptMode: "observed" },
			repetitions: 1,
			rubricId: `${agentId}-v1`,
		});
		const completed = await waitForEvaluation(service, run.id);
		assert.equal(completed.status, "awaiting_evaluation", completed.error ?? "unexpected status");
		assert.equal(completed.executions.length, 1);
		const execution = completed.executions[0]!;
		assert.equal(execution.candidateCaseRef?.sourceRunId, `${run.id}::executions::${execution.id}`);
		const candidateCase = service.readCase(goalId, execution.candidateCaseRef!);
		assert.equal(candidateCase.capabilitySnapshotId, run.candidate.capabilitySnapshotId);
		assert.equal(candidateCase.workspace?.input_tree_sha, "1".repeat(64));
		assert.equal(candidateCase.workspace?.output_tree_sha, "2".repeat(64));
		recordedRuns.set(agentId, run.id);
	}
	const cornellTraceRunId = recordedRuns.get("cornell-note")!;
	const cornellTraceResponse = await fetch(`${baseUrl}/operations/v1/goals/${goalId}/replays/${cornellTraceRunId}`);
	const cornellTraceRun = await cornellTraceResponse.json() as { run: { executions: Array<{ refs?: Record<string, string> }> } };
	assert.ok(cornellTraceRun.run.executions[0]?.refs?.agentTrace,
		"Frozen Cornell Note replay must project its Agent Trace");
	assert.ok(cornellTraceRun.run.executions[0]?.refs?.runtimeTrace,
		"Frozen Cornell Note replay must project its Runtime Trace");
	const reportTraceRunId = recordedRuns.get("report-writer")!;
	const reportTraceResponse = await fetch(`${baseUrl}/operations/v1/goals/${goalId}/replays/${reportTraceRunId}`);
	const reportTraceRun = await reportTraceResponse.json() as { run: { executions: Array<{ refs?: Record<string, string> }> } };
	assert.ok(reportTraceRun.run.executions[0]?.refs?.reportChildTrace1,
		"Frozen Report Writer replay must project native child sessions");
	assert.ok(reportTraceRun.run.executions[0]?.refs?.reportRootEvents,
		"Frozen Report Writer replay must project native Root events");
	assert.match(reportTraceRun.run.executions[0]?.refs?.agentTrace ?? "", /runtime\/writer-report-1-execution\/session\/root\.jsonl$/u,
		"Frozen Report Writer replay must expose the isolated native Root session as its primary Agent Trace");
	assert.equal(reportTraceRun.run.executions[0]?.refs?.reportChildTrace2, undefined,
		"Previous execution children must not be included in current replay evidence");
	assert.match(reportTraceRun.run.executions[0]?.refs?.reportInitialPrompt ?? "", /writer-report-1-execution\/initial-prompt\.md$/u);
	assert.ok(Object.values(reportTraceRun.run.executions[0]?.refs ?? {}).every((ref) => !ref.includes("writer-report-0-previous")));
	for (const agentId of RECORDED_STAGE_AGENT_IDS) {
		assert.equal(replayed.get(agentId), agentId === "cornell-note" ? 3 : 1);
	}
	const missingPromptResponse = await fetch(`${baseUrl}/operations/v1/goals/${goalId}/replays`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			agentId: "report-writer",
			cases: [{ sourceRunId, caseId: cases.get("report-writer")! }],
			candidate: {},
			rubricId: "missing-report-writer-prompt",
		}),
	});
	assert.equal(missingPromptResponse.status, 400);
	assert.match(await missingPromptResponse.text(), /Candidate Capability Bundle requires promptMode/u);
	const createResponse = await fetch(`${baseUrl}/operations/v1/goals/${goalId}/replays`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			agentId: "report-writer",
			cases: [{ sourceRunId, caseId: cases.get("report-writer")! }],
			candidate: { promptMode: "observed" },
			repetitions: 1,
			rubricId: "report-writer-v1",
		}),
	});
	assert.equal(createResponse.status, 202, await createResponse.clone().text());
	const created = await createResponse.json() as { run: { id: string } };
	const httpReplay = await waitForEvaluation(service, created.run.id);
	assert.equal(httpReplay.status, "awaiting_evaluation", httpReplay.error ?? "unexpected status");
	const httpSnapshot = service.readCapabilitySnapshot(goalId, httpReplay.candidate.capabilitySnapshotId);
	const httpSnapshotContent = join(serverRuntimeDirForGoal(goalId, workspaceDir), httpSnapshot.ref);
	assert.equal(existsSync(join(httpSnapshotContent, "wiki", "runs", "unrelated")), false,
		"Replay snapshots must not copy unrelated Wiki Run history");
	assert.equal(readFileSync(join(httpSnapshotContent, "wiki", "runs", "fixture", "knowledge.md"), "utf-8"),
		"baseline knowledge\n", "A Case's explicit historical Wiki mount remains replayable");
	assert.equal(readFileSync(join(httpSnapshotContent, "wiki", "knowledge", "current.md"), "utf-8"),
		"Published knowledge\n");
	assert.equal(existsSync(join(httpSnapshotContent, "wiki", "runs", "fixture-extra")), false,
		"Selecting a Wiki mount must not include siblings sharing its name prefix");
	writeFileSync(join(goalDirectory, "wiki", "runs", "unrelated", "material.bin"), "History changed\n");
	assert.equal(service.createCapabilitySnapshot(goalId, goalDirectory, ["wiki/runs/fixture"]).id, httpSnapshot.id,
		"Unrelated history must not invalidate an otherwise identical Capability Snapshot");
	assert.equal(service.createCapabilitySnapshot(goalId, goalDirectory, ["wiki/runs/fixture/"]).id, httpSnapshot.id,
		"A trailing slash on a historical directory mount must preserve its contents");
	assert.throws(() => service.createCapabilitySnapshot(goalId, goalDirectory, ["wiki/../outside"]), /safe relative path/u);
	writeFileSync(join(goalDirectory, "wiki", "knowledge", "current.md"), "Updated knowledge\n");
	assert.notEqual(service.createCapabilitySnapshot(goalId, goalDirectory, ["wiki/runs/fixture"]).id, httpSnapshot.id);
	assert.equal(readFileSync(join(httpSnapshotContent, "wiki", "knowledge", "current.md"), "utf-8"), "Published knowledge\n");
	const batchResponse = await fetch(`${baseUrl}/operations/v1/goals/${goalId}/replays/${created.run.id}/evaluation-batch`);
	assert.equal(batchResponse.status, 200, await batchResponse.clone().text());
	const batch = await batchResponse.json() as { batch: { pairs: Array<{
		pairId: string;
		outputs: Record<"A" | "B", { content?: string }>;
	}> } };
	assert.equal(batch.batch.pairs.length, 1);
	// Persist the pre-filter format independently: old Snapshot IDs still bind the entire Wiki.
	for (const name of ["阿.md", "中.md"]) {
		writeFileSync(join(goalDirectory, "wiki", "knowledge", name), name);
		writeFileSync(join(goalDirectory, "skills", "cornell-note", "fixture", name), name);
	}
	for (const locale of ["en", "zh"]) {
		const compare = new Intl.Collator(locale).compare;
		const wikiDirectory = join(goalDirectory, "wiki");
		const legacyHash = sha256(stableJson({
			skills: WORKSPACE_AGENT_IDS.map((agentId) => ({ agentId,
				sha256: hashJson(snapshotSkills([join(goalDirectory, "skills", agentId)]).skills.map((skill) => ({
					name: skill.name, sha256: hashJson([...skill.files].sort((a, b) => compare(a.relativePath, b.relativePath))),
				}))) })),
			wiki: hashJson(listFilesRecursive(wikiDirectory).sort(compare).map((path) => ({
				path, sha256: sha256(readFileSync(join(wikiDirectory, path))),
			}))),
		}));
		const legacySnapshot = { ...httpSnapshot, id: `caps_${legacyHash}`, workspaceContentHash: legacyHash,
			ref: `evaluation/capability-snapshots/caps_${legacyHash}/content` };
		const legacyContent = join(serverRuntimeDirForGoal(goalId, workspaceDir), legacySnapshot.ref);
		cpSync(goalDirectory, legacyContent, { recursive: true });
		writeFileSync(join(dirname(legacyContent), "manifest.json"), JSON.stringify(legacySnapshot));
		if (locale === "zh") {
			assert.throws(() => service.readCapabilitySnapshot(goalId, legacySnapshot.id), /content changed/u, "retired sort order is rejected");
			continue;
		}
		assert.deepEqual(service.readCapabilitySnapshot(goalId, legacySnapshot.id), legacySnapshot);
		const legacyRun = await waitForEvaluation(service, service.enqueue(goalId, {
			agentId: "report-writer", cases: [{ sourceRunId, caseId: cases.get("report-writer")! }],
			candidate: { capabilitySnapshotId: legacySnapshot.id, promptMode: "observed" }, repetitions: 1, rubricId: "legacy-snapshot",
		}).id);
		assert.equal(legacyRun.status, "awaiting_evaluation", legacyRun.error ?? "unexpected status");
		const legacyCaseRef = { sourceRunId, caseId: cases.get("report-writer")! };
		const legacyBundle = await createCaseBundle({
			dataDir: workspaceDir, goalId, goalTitle: "Legacy Snapshot", value: service.readCase(goalId, legacyCaseRef),
			casePath: join(sourceRun, "node-evaluation", "cases", legacyCaseRef.caseId, "manifest.json"),
			runtimeBuild: service.status().runtimeBuild, agentBundleSha256: service.status().agentBundleSha256,
			capabilitySnapshotId: legacySnapshot.id, capabilityContentDirectory: legacyContent,
			restoreTree: async () => { throw new Error("This Case has no workspace trees"); },
		});
		try {
			const importedWorkspace = join(root, "legacy-import");
			const importer = new NodeBacktestService({ workspaceDir: importedWorkspace, listGoalIds: () => [goalId], recipes: [] });
			importer.importBundle(legacyBundle.path, (id) => mkdirSync(join(importedWorkspace, id), { recursive: true }));
			assert.equal(importer.readCapabilitySnapshot(goalId, legacySnapshot.id).workspaceContentHash, legacyHash);
			assert.equal(importer.importBundle(legacyBundle.path, () => undefined).capabilitySnapshotId, legacySnapshot.id,
				"Re-import validates an already registered legacy Snapshot using its original identity");
		} finally {
			legacyBundle.cleanup();
		}
		const legacyManifestPath = join(dirname(legacyContent), "manifest.json");
		writeFileSync(legacyManifestPath, JSON.stringify({ ...legacySnapshot, workspaceContentHash: "0".repeat(64) }));
		assert.throws(() => service.readCapabilitySnapshot(goalId, legacySnapshot.id), /manifest is invalid/u);
		writeFileSync(legacyManifestPath, JSON.stringify(legacySnapshot));
		writeFileSync(join(legacyContent, "wiki", "knowledge", "阿.md"), "Changed content");
		assert.throws(() => service.readCapabilitySnapshot(goalId, legacySnapshot.id), /content changed/u,
			"Current sorting must reject changed contents");
	}
	for (const label of ["A", "B"] as const) {
		const outputResponse = await fetch(`${baseUrl}/operations/v1/goals/${goalId}/replays/${created.run.id}/evaluation-batch/${batch.batch.pairs[0]!.pairId}/outputs/${label}/artifact`);
		assert.equal(outputResponse.status, 200, await outputResponse.clone().text());
		assert.equal(await outputResponse.text(), batch.batch.pairs[0]!.outputs[label].content);
	}
	const judgmentResponse = await fetch(`${baseUrl}/operations/v1/goals/${goalId}/replays/${created.run.id}/judgments`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ judgments: [{ pairId: batch.batch.pairs[0]!.pairId, winner: "B" }] }),
	});
	assert.equal(judgmentResponse.status, 404, "Judgment belongs to the external evaluation environment, not the Telomi Operations Listener");
	// Live Health Check is gone: a direct-input body is rejected by the public contract, never queued.
	const directInputResponse = await fetch(`${baseUrl}/operations/v1/goals/${goalId}/replays`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ agentId: "cornell-note", input: { question: "new source note question" } }),
	});
	assert.equal(directInputResponse.status, 400);
	assert.match(await directInputResponse.text(), /ReplayRequest is invalid/u);
	console.log("All recorded Research Agent adapters replay through the unified Node Backtest interface");
} finally {
	if (server) await new Promise<void>((resolveClose) => server!.close(() => resolveClose()));
	service.stop();
	// Workspace tree snapshots autostart the research-source-service; close it like app.ts does on shutdown.
	await getResearchSourceServiceManager().close().catch(() => undefined);
	rmSync(root, { recursive: true, force: true });
}

function recordedRequest(
	agentId: typeof RECORDED_STAGE_AGENT_IDS[number],
	runId: string,
	recordDirectory: string,
	workDirectory: string,
	artifactStore: RunArtifactStore,
): AgentStageRequest<unknown> {
	const roles = {
		"cornell-note": "cornell_note",
		"report-writer": "report_writer",
	} as const;
	const kinds: Record<typeof agentId, StageArtifactKind> = {
		"cornell-note": "cornell_note",
		"report-writer": "writer_chapters",
	};
	const knowledgeMount = agentId === "report-writer" ? {
		hostPath: join(harnesses.baseline, "wiki", "runs", "fixture"),
		guestPath: "/knowledge",
		access: "read-only" as const,
	} : undefined;
	return {
		runId,
		stageId: `${agentId}-1`,
		attemptId: "1",
		role: roles[agentId],
		promptConfig: { domain: "research", id: agentId, sandboxRole: `report.${roles[agentId]}` as never },
		evaluation: {
			agentId,
			recipe: { id: agentId, version: RECORDED_STAGE_RECIPE_VERSIONS[agentId] },
			recipeInput: {},
			inputRelativePath: `inputs/${agentId}`,
			harnessMounts: [
				{ guestPath: "/workspace/skills", workspaceRelativePath: `skills/${agentId}` },
				...(knowledgeMount ? [{ guestPath: "/knowledge", workspaceRelativePath: "wiki/runs/fixture" }] : []),
			],
			liveExternalState: false,
		},
		session: { key: agentId, policy: "fresh" },
		modelPolicy: { preferred: ["openai-codex/gpt-5.4-mini"] },
		systemPrompt: `${agentId} system`,
		userPrompt: `${agentId} user`,
		workDirectory,
		readonlyMounts: [
			{ hostPath: join(recordDirectory, "inputs", agentId), guestPath: "/inputs", access: "read-only" },
			...(knowledgeMount ? [knowledgeMount] : []),
			{ hostPath: join(harnesses.baseline, "skills", agentId), guestPath: "/workspace/skills", access: "read-only" },
		],
		controlDirectory: recordDirectory,
		recordDirectory,
		artifactStore,
		output: { kind: kinds[agentId], publishRelativePath: `replays/${agentId}.json`, validate: () => ({}) },
		signal: new AbortController().signal,
	};
}

function stageResult<T>(
	value: T,
	artifact: ReturnType<RunArtifactStore["publishFile"]> | ReturnType<RunArtifactStore["publishDirectory"]>,
	sessionRoot: string,
): ValidatedStageArtifact<T> {
	return {
		value,
		artifact,
		submissionCount: 1,
		validationErrors: [],
		session: { id: "test", mode: "fresh" },
		turns: 1,
		toolCalls: 1,
		toolCounts: { submit_stage_output: 1 },
		usage: { inputTokens: 10, outputTokens: 2, costUsd: 0.01, calls: 1 },
		sessionPath: join(sessionRoot, "session.jsonl"),
	};
}

async function waitForEvaluation(service: NodeBacktestService, runId: string, runGoalId = goalId) {
	for (let attempt = 0; attempt < 200; attempt += 1) {
		const run = service.read(runGoalId, runId)!;
		if (run.status === "awaiting_evaluation" || run.status === "completed" || run.status === "failed") return run;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(`Node Backtest '${runId}' did not finish`);
}
