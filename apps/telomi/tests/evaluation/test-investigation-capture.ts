import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { findNodeEvaluationCases, readNodeEvaluationCase, readNodeEvaluationFile } from "../../server/agent-runtime/node-evaluation.js";
import { createInvestigationReplayRecipe, withInvestigationNodeCapture } from "../../server/evaluation/investigation-replay.js";

const root = mkdtempSync(join(tmpdir(), "telomi-investigation-case-"));
const usage = { inputTokens: 17, outputTokens: 9, costUsd: 0.01, calls: 1 };
const wikiSha256 = "a".repeat(64);

function prepare(name: string): string {
	const runDir = join(root, name);
	mkdirSync(join(runDir, "input", "wiki"), { recursive: true });
	mkdirSync(join(runDir, "workspace", "work"), { recursive: true });
	writeFileSync(join(runDir, "prompt.md"), "Read local evidence for this question.\n");
	writeFileSync(join(runDir, "input", "wiki", "page.md"), "A frozen Wiki page\n");
	return runDir;
}

try {
	const runDir = prepare("success");
	const metrics = { usage, toolCalls: 2 };
	let calls = 0;
	const result = await withInvestigationNodeCapture({
		goalDir: root, goalId: "g", runDir, question: "What is implemented?",
		wikiSha256, model: "test/model", thinking: "medium", metrics,
		execute: async () => {
			calls += 1;
			writeFileSync(join(runDir, "interactions.jsonl"), JSON.stringify({ operation: "knowledge_search",
				request: { query: "implementation", limit: 5 }, response: { pages: [], cues: [] } }) + "\n");
			writeFileSync(join(runDir, "trace.jsonl"), '{"type":"message","message":{"role":"assistant"}}\n');
			return { id: "success", question: "What is implemented?", answer: "Nothing recorded.",
				citation_refs: [], gaps: ["implementation detail"], wiki_sha256: wikiSha256 };
		},
	});
	assert.equal(calls, 1);
	assert.equal(result.answer, "Nothing recorded.");
	const cases = findNodeEvaluationCases(runDir, "prime-investigation");
	assert.equal(cases.length, 1);
	const captured = readNodeEvaluationCase(cases[0]!.path, runDir);
	assert.equal(captured.status, "succeeded");
	assert.equal(captured.observed.metrics?.inputTokens, 17);
	assert.equal(captured.observed.metrics?.toolCalls, 2);
	assert.equal(captured.recipe.id, "prime-investigation");
	assert.equal(captured.liveExternalState, false);
	assert.ok(captured.observed.trace);
	assert.ok(captured.request.interactions);
	assert.deepEqual(JSON.parse(readNodeEvaluationFile(cases[0]!.path, captured.request.interactions!)), [{
		kind: "tool", name: "knowledge_search", label: "knowledge_search",
		description: "Frozen local investigation result", arguments: { query: "implementation", limit: 5 },
		result: { pages: [], cues: [] },
	}]);
	assert.equal(readFileSync(join(cases[0]!.path, "..", "input", "wiki", "page.md"), "utf-8"), "A frozen Wiki page\n");
	assert.ok(!readFileSync(cases[0]!.path, "utf-8").includes("PRIME_AGENT_SOURCE_TOKEN"));

	const failedDir = prepare("failure");
	await assert.rejects(withInvestigationNodeCapture({
		goalDir: root, goalId: "g", runDir: failedDir, question: "What is missing?",
		wikiSha256, model: "test/model", thinking: "medium",
		execute: async () => {
			writeFileSync(join(failedDir, "trace.jsonl"), '{"type":"message","message":{"role":"assistant"}}\n');
			writeFileSync(join(failedDir, "workspace", "work", "draft.json"), "{}\n");
			throw new Error("invalid result file");
		},
	}), /invalid result file/u);
	const recovery = findNodeEvaluationCases(failedDir, "prime-investigation");
	assert.equal(recovery.length, 1);
	assert.equal(recovery[0]!.value.status, "failed");
	assert.equal(recovery[0]!.value.observed.error, "invalid result file");
	assert.ok(recovery[0]!.value.observed.terminalWorkspace);
	assert.ok(existsSync(join(recovery[0]!.path, "..", recovery[0]!.value.observed.terminalWorkspace!.ref)));

	const recipe = createInvestigationReplayRecipe({ execute: async (input) => ({
		caseId: input.value.caseId, agentId: "prime-investigation",
		artifact: input.artifactStore.publishText("{}", "test-result.json"),
		usage, turns: 1, toolCalls: 2,
	}) });
	assert.deepEqual(recipe.identity, { id: "prime-investigation", version: 1 });
} finally {
	rmSync(root, { recursive: true, force: true });
}

console.log("Prime Investigation Case Capture and Recovery contracts passed");
