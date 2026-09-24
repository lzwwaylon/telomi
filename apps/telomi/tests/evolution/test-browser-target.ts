import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bundledAgentSkillPath } from "../../server/agent-runtime/skill-registry.js";
import type { NodeBacktestCaseRef, NodeBacktestRequest, NodeBacktestService } from "../../server/evaluation/node-backtest.js";
import { BROWSER_EVOLUTION_TARGET_ID, createEvolutionTargets } from "../../server/evolution/targets.js";

const root = mkdtempSync(join(tmpdir(), "telomi-browser-evolution-target-"));
const goalDirectory = join(root, "goal");
const runDirectory = join(root, "evolution-run");
const evidenceDirectory = join(runDirectory, "evidence");
const candidateSkillDirectory = join(root, "candidate", "prime-browser-provider-skill");
mkdirSync(evidenceDirectory, { recursive: true });
mkdirSync(join(goalDirectory, "skills", "prime-search"), { recursive: true });
mkdirSync(candidateSkillDirectory, { recursive: true });
writeFileSync(join(candidateSkillDirectory, "SKILL.md"), ["---", "name: prime-browser-provider-skill",
	"description: Candidate Browser Provider Skill.", "---", ""].join("\n"));

const executions = [
	{ runId: "run-a", caseId: "case-a", executionId: "provider-execution:1:browser:child-1" },
	{ runId: "run-b", caseId: "case-b", executionId: "provider-execution:1:browser:child-2" },
	{ runId: "run-c", caseId: "case-c", executionId: "provider-execution:2:browser:child-3" },
];
const caseRoot = join(root, "cases");
mkdirSync(caseRoot, { recursive: true });
for (const [index, execution] of executions.entries()) {
	const directory = join(caseRoot, execution.caseId);
	mkdirSync(directory, { recursive: true });
	const childDirectory = join(caseRoot, `${execution.caseId}-child`);
	mkdirSync(childDirectory, { recursive: true });
	writeFileSync(join(childDirectory, "result.json"), JSON.stringify({ provider_id: "browser", terminal_status: "valid_bundle" }));
	writeFileSync(join(childDirectory, "request.json"), JSON.stringify({ task: `Read the newest items ${index + 1}.` }));
	writeFileSync(join(childDirectory, "task.md"), `Read the newest items ${index + 1}.`);
	writeFileSync(join(childDirectory, "child.jsonl"), JSON.stringify({ child: execution.executionId }));
	writeFileSync(join(directory, "result.json"), `${JSON.stringify({
		schema_version: 1, provider_id: "browser", terminal_status: "valid_bundle",
		execution_records: [
			{ execution_id: execution.executionId, provider_id: "browser", terminal_status: "valid_bundle",
				operations: [{ operation: "prime_agent", request_ref: "prime:1", response_count: 1, source_count: 2, status: "succeeded" }],
				bundle_ref: `artifacts/source-bundles/${execution.caseId}` },
			{ execution_id: "provider-execution:1:github:child-9", provider_id: "github", terminal_status: "valid_bundle" },
		],
	})}\n`);
	writeFileSync(join(directory, "request.json"), `${JSON.stringify({ task: `Read the newest items ${index + 1}.` })}\n`);
	writeFileSync(join(directory, "task.md"), `Read the newest items ${index + 1}.`);
	writeFileSync(join(directory, "child.jsonl"), `${JSON.stringify({ child: execution.executionId })}\n`);
}

const enqueued: NodeBacktestRequest[] = [];
let snapshotSource = "";
let caseFileCalls = 0;
const nodeBacktests = {
		ensureProviderChildCase: async (_goalId: string, ref: NodeBacktestCaseRef, executionId: string) => {
			assert.ok(executionId);
			return { ...ref, caseId: `${ref.caseId}-child` };
		},
	readCase: (_goalId: string, ref: NodeBacktestCaseRef) => ({
		agentId: "provider-child",
		nodeId: `prime-search-batch-${ref.caseId}`,
		capturedAt: "2026-09-05T00:00:00.000Z",
	}),
	listCaseFiles: () => [
		{ ref: "output:result.json", kind: "observed_output", sha256: "", byteLength: 0 },
		{ ref: "run:prime-search-traces/x/child.jsonl", kind: "child_trace", sha256: "", byteLength: 0 },
	],
	listCaseFilePaths: (_goalId: string, ref: NodeBacktestCaseRef) => [
		{ ref: "capability:skills/unrelated/SKILL.md", kind: "capability", sha256: "", byteLength: 0, absolutePath: "must-not-be-mounted" },
		{ ref: "output:result.json", kind: "observed_output", sha256: "", byteLength: 0, absolutePath: join(caseRoot, ref.caseId, "result.json") },
		{ ref: "run:prime-search-traces/x/child.jsonl", kind: "child_trace", sha256: "", byteLength: 0, absolutePath: join(caseRoot, ref.caseId, "child.jsonl") },
	],
	caseFile: (_goalId: string, ref: NodeBacktestCaseRef, fileRef: string) => {
		caseFileCalls += 1;
		return join(caseRoot, ref.caseId, fileRef === "output:result.json" ? "result.json" : "child.jsonl");
	},
	caseInputFile: (_goalId: string, ref: NodeBacktestCaseRef, path: string) => join(caseRoot, ref.caseId, path),
	createCapabilitySnapshot: (_goalId: string, sourceDirectory: string) => {
		snapshotSource = sourceDirectory;
		return { id: "cap-browser-1" };
	},
	enqueue: (_goalId: string, request: NodeBacktestRequest) => {
		enqueued.push(request);
		return { id: "nodebt-browser-1" };
	},
	read: () => ({
		id: "nodebt-browser-1",
		status: "awaiting_evaluation",
		executions: executions.map((execution, index) => ({
			id: `candidate_${execution.caseId}_1`,
			metrics: { durationMs: 10 * (index + 1), inputTokens: 1, outputTokens: 1, costUsd: 0, calls: 1, toolCalls: 2 },
		})),
	}),
} as unknown as NodeBacktestService;

const target = createEvolutionTargets({ workspaceDir: root, nodeBacktests })
	.find((item) => item.id === BROWSER_EVOLUTION_TARGET_ID)!;

try {
	// Evolution baseline resolves the effective Browser Skill, bundled or Goal-overridden.
	assert.deepEqual(target.baselineSkillRoots!(goalDirectory),
		[bundledAgentSkillPath("research", "prime-search", "prime-browser-provider-skill")],
		"Evolution baseline reads the bundled Browser Skill when the Goal ships no override");
	const goalBrowserSkill = join(goalDirectory, "skills", "prime-search", "prime-browser-provider-skill");
	mkdirSync(goalBrowserSkill, { recursive: true });
	writeFileSync(join(goalBrowserSkill, "SKILL.md"), ["---", "name: prime-browser-provider-skill",
		"description: Goal override of the Browser Provider Skill.", "---", ""].join("\n"));
	assert.deepEqual(target.baselineSkillRoots!(goalDirectory), [realpathSync(goalBrowserSkill)],
		"A same-name Goal Skill becomes the effective Browser Skill baseline");

	const evidenceRefs = executions.map((execution) => ({ kind: "browser_provider_execution", ...execution }));
	await assert.rejects(() => target.collectEvidence({
		goalId: "goal", goalDirectory, objective: "o", acceptanceCriteria: ["a"],
		evidenceRefs: evidenceRefs.slice(0, 2), signal: new AbortController().signal,
	}), /exactly 3 Browser Provider executions/u, "a batch is exactly three executions");
	await assert.rejects(() => target.collectEvidence({
		goalId: "goal", goalDirectory, objective: "o", acceptanceCriteria: ["a"],
		evidenceRefs: [evidenceRefs[0]!, { ...evidenceRefs[0]!, executionId: `${evidenceRefs[0]!.executionId}-b` }, { ...evidenceRefs[0]!, executionId: `${evidenceRefs[0]!.executionId}-c` }],
		signal: new AbortController().signal,
	}), /distinct Prime Search Cases/u, "three executions of one Case are not a batch the inner loop can replay");

	const evidence = await target.collectEvidence({
		goalId: "goal", goalDirectory,
		objective: "Improve the Browser Provider Skill.",
		acceptanceCriteria: ["Rules generalize"],
		evidenceRefs,
		signal: new AbortController().signal,
	});
	assert.equal(evidence.manifest.kind, "browser_provider_executions");
	assert.deepEqual(evidence.manifest.browser_skill, {
		name: "prime-browser-provider-skill",
		sha256: (evidence.manifest.browser_skill as { sha256: string }).sha256,
		source: "goal_override",
	}, "Evidence pins the Skill identity a Provider child would load right now");
	const evidenceRuns = evidence.manifest.runs as Array<Record<string, unknown>>;
	assert.deepEqual(evidenceRuns.map((run) => run.execution_id), executions.map((item) => item.executionId));
	assert.deepEqual(evidenceRuns.map((run) => run.case_id), executions.map((item) => item.caseId));
	assert.deepEqual(evidenceRuns.map((run) => run.terminal_status), ["valid_bundle", "valid_bundle", "valid_bundle"]);
	assert.deepEqual(evidenceRuns.map((run) => run.research_task),
		["Read the newest items 1.", "Read the newest items 2.", "Read the newest items 3."]);
	assert.equal(evidence.files.length, 6, "only isolated child artifacts and traces are visible");
	assert.ok(evidence.files.every((file) => file.sourcePath.includes("-child/")), "parent Case files and unrelated capabilities never reach the Agent");
	assert.deepEqual(evidenceRuns.map((run) => run.child_case_ref), executions.map((ref) => ({ sourceRunId: ref.runId, caseId: `${ref.caseId}-child` })));
	assert.ok(caseFileCalls <= 3, "Evidence files come from one scan per Case; caseFile rescans the whole Case per call");

	writeFileSync(join(evidenceDirectory, "manifest.json"), `${JSON.stringify({ evidenceRefs })}\n`);
	// tests/evolution/test-browser-inner-loop.ts covers the loop, its hard gates and the automatic apply.
	assert.equal(enqueued.length, 0, "collecting Evidence must not enqueue a Candidate Replay");
	assert.equal(snapshotSource, "", "collecting Evidence must not build a Candidate Capability Snapshot");

	console.log("Browser Evolution collects three historical Browser executions and owns an iterative inner loop");
} finally {
	rmSync(root, { recursive: true, force: true });
}
