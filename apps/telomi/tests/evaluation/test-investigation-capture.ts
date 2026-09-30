import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { findNodeEvaluationCases, readNodeEvaluationCase, readNodeEvaluationFile, type NodeEvaluationInteraction } from "../../server/agent-runtime/node-evaluation.js";
import { createFrozenInvestigationTools, createInvestigationReplayRecipe, withInvestigationNodeCapture } from "../../server/evaluation/investigation-replay.js";

const root = mkdtempSync(join(tmpdir(), "telomi-investigation-case-"));
const usage = { inputTokens: 17, outputTokens: 9, costUsd: 0.01, calls: 1 };
const wikiSha256 = "a".repeat(64);
const externalResponse = {
	status: "found", summary: "Verified from newly acquired official documentation", gaps: [],
	cues: [{ ref: "deep-search:external-1:cue-1", section_title: "Documentation", cue: "implementation",
		note: "The documented feature exists", evidence: [{ source_run_id: "external-1", source_id: "source-1",
			source_revision_sha256: "b".repeat(64), source_path: "documentation.md", start_line: 2, end_line: 3,
			content_sha256: "c".repeat(64), excerpt: "The original evidence" }] }],
	sources: [{ id: "source-1", title: "Official documentation", revision_sha256: "b".repeat(64),
		url: "https://example.org/docs" }],
};
const frozenInteractions: Extract<NodeEvaluationInteraction, { kind: "tool" }>[] = [
	{ kind: "tool", name: "knowledge_search", label: "knowledge_search",
		description: "Frozen investigation Tool result", arguments: { query: "implementation", limit: 5 },
		result: { pages: [], cues: [] } },
	{ kind: "tool", name: "external_search", label: "external_search",
		description: "Frozen investigation Tool result", arguments: { question: "Find missing documentation" },
		result: externalResponse },
];

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
			writeFileSync(join(runDir, "interactions.jsonl"), frozenInteractions.map(({ name, arguments: request, result: response }) =>
				JSON.stringify({ operation: name, request, response })).join("\n") + "\n");
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
	assert.deepEqual(JSON.parse(readNodeEvaluationFile(cases[0]!.path, captured.request.interactions!)), frozenInteractions);

	const replayed: unknown[] = [];
	const frozenTools = createFrozenInvestigationTools(frozenInteractions, true,
		(operation, request, response) => replayed.push({ operation, request, response }));
	frozenTools.replayCall("knowledge_search", { query: "reworded implementation", limit: 5 });
	const projected = frozenTools.replayCall("external_search", { question: "Locate the missing documentation" }) as {
		cues: Array<{ ref: string; evidence: unknown[] }>; sources: Array<{ title: string; url: string }>;
	};
	assert.equal(projected.cues[0]!.ref, "N1");
	assert.deepEqual(projected.sources, [{ title: "Official documentation", url: "https://example.org/docs" }]);
	assert.equal(frozenTools.citationsScope.resolve("N1"), externalResponse.cues[0]!.ref);
	assert.deepEqual(replayed[1], { operation: "external_search", request: { question: "Locate the missing documentation" },
		response: externalResponse });
	frozenTools.assertMatched();
	assert.throws(() => frozenTools.replayCall("external_search", { question: "Extra unsupported search" }), /No frozen Tool/u);
	assert.throws(() => frozenTools.assertMatched(), /No frozen Tool/u);
	const restricted = createFrozenInvestigationTools([frozenInteractions[1]!], false, () => {});
	assert.throws(() => restricted.replayCall("external_search", { question: "Disallowed" }), /disallows external/u);
	assert.throws(() => restricted.assertMatched(), /disallows external/u);
	const legacy = { kind: "tool" as const, name: "github_read", label: "github_read", description: "Historical acquisition",
		arguments: { question: "implementation", repository: "Org/Repo", ref: "v1", paths: ["b.ts", "a.ts"] },
		result: externalResponse };
	const historicalTools = createFrozenInvestigationTools([legacy], true, () => {});
	const historical = historicalTools.replayCall("github_read", { question: "Reworded", repository: "org/repo",
		ref: "v1", paths: ["a.ts", "b.ts"] }) as { cues: Array<{ ref: string }> };
	assert.equal(historical.cues[0]!.ref, "N1");
	historicalTools.assertMatched();
	const changedIdentity = createFrozenInvestigationTools([legacy], true, () => {});
	assert.throws(() => changedIdentity.replayCall("github_read", { ...legacy.arguments, ref: "v2" }), /another repository, ref, or file set/u);
	assert.throws(() => changedIdentity.assertMatched(), /another repository/u);
	const writer = { kind: "tool" as const, name: "write_answer", label: "write_answer", description: "Delegated answer",
		arguments: { evidence_refs: [externalResponse.cues[0]!.ref], requirements: ["Explain implementation"] },
		result: { answer: `The feature exists. <cite>${externalResponse.cues[0]!.ref}</cite>`,
			citation_refs: [externalResponse.cues[0]!.ref], gaps: [],
			coverage: [{ requirement_id: "Q1", citation_refs: [externalResponse.cues[0]!.ref], gap: "" }] } };
	const answerTools = createFrozenInvestigationTools([frozenInteractions[1]!, writer], true, () => {});
	answerTools.replayCall("external_search", { question: "Find documentation" });
	assert.throws(() => answerTools.assertMatched(), /unused/u);
	assert.equal(answerTools.hasFrozenWriter(), true);
	assert.equal(answerTools.evidence.get("N1")?.evidence[0]?.excerpt, "The original evidence");
	assert.ok(!JSON.stringify(answerTools.evidence.get("N1")).includes("source_run_id"), "legacy Replay cannot claim uncaptured original context");
	assert.deepEqual(answerTools.replayCall("write_answer", { evidence_refs: ["N1"], requirements: ["Explain implementation"] }), {
		answer: "The feature exists. <cite>N1</cite>", citation_refs: ["N1"], gaps: [],
		coverage: [{ requirement_id: "Q1", citation_refs: ["N1"], gap: "" }],
	});
	answerTools.assertMatched();
	const changedRequirements = createFrozenInvestigationTools([frozenInteractions[1]!, writer], true, () => {});
	changedRequirements.replayCall("external_search", { question: "Find documentation" });
	assert.throws(() => changedRequirements.replayCall("write_answer", { evidence_refs: ["N1"], requirements: ["Explain a different algorithm"] }), /different evidence or requirements/u);
	assert.throws(() => changedRequirements.assertMatched(), /different evidence/u);
	const writerDir = prepare("with-writer");
	await withInvestigationNodeCapture({ goalDir: root, goalId: "g", runDir: writerDir,
		question: "What is implemented?", context: "Previous implementation discussion", language: "en", wikiSha256,
		model: "test/model", thinking: "medium", metrics, execute: async () => {
			writeFileSync(join(writerDir, "interactions.jsonl"), JSON.stringify({ operation: writer.name, request: writer.arguments, response: writer.result }) + "\n");
			return { id: "with-writer", question: "What is implemented?", ...writer.result, wiki_sha256: wikiSha256 };
		} });
	const writerCase = findNodeEvaluationCases(writerDir, "prime-investigation")[0]!;
	assert.equal(JSON.parse(readFileSync(join(writerCase.path, "..", "input", "request.json"), "utf-8")).context, "Previous implementation discussion");
	assert.equal(JSON.parse(readNodeEvaluationFile(writerCase.path, writerCase.value.request.interactions!))[0].name, "write_answer");
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
