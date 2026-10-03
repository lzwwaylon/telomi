import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { findNodeEvaluationCases, readNodeEvaluationCase, readNodeEvaluationFile, type NodeEvaluationInteraction } from "../../server/agent-runtime/node-evaluation.js";
import { publishInvestigationHandoff } from "../../server/research/investigation-handoff.js";
import { createFrozenInvestigationReplayPlan, stageFrozenInvestigationReplayPlan, createFrozenInvestigationTools, createInvestigationReplayRecipe, resolveInvestigationReplayResult, withInvestigationNodeCapture } from "../../server/evaluation/investigation-replay.js";
import type { InvestigationAnswer } from "../../server/research/investigation-answer.js";

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
	assert.ok(!("handoff_mode" in JSON.parse(readFileSync(join(cases[0]!.path, "..", "input", "request.json"), "utf-8"))),
		"historical v1 captures keep their implicit inline protocol");
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
	assert.throws(() => createFrozenInvestigationReplayPlan(frozenInteractions),
		/requires a captured Writer assignment; use promptMode 'observed'/u,
		"Candidate coordination without a frozen Writer must fail before launching the Root model");
	const continuedPlan = createFrozenInvestigationReplayPlan([writer], externalResponse.cues);
	assert.deepEqual(continuedPlan.steps, [{ step: 1, operation: "write_answer",
		arguments: { evidence_refs: ["N1"], requirements: ["Explain implementation"] } }]);
	const acquiredPlan = createFrozenInvestigationReplayPlan([frozenInteractions[1]!, writer]);
	assert.deepEqual(acquiredPlan.steps[1]!.arguments, continuedPlan.steps[0]!.arguments,
		"Replay plans use the same mapped refs whether evidence is restored or acquired by an earlier frozen operation");
	const plannedTools = createFrozenInvestigationTools([frozenInteractions[1]!, writer], true, () => {});
	for (const step of acquiredPlan.steps) plannedTools.replayCall(step.operation as Parameters<typeof plannedTools.replayCall>[0], step.arguments);
	plannedTools.assertMatched();
	assert.ok(!JSON.stringify(acquiredPlan).includes("The feature exists"), "Replay plans expose assignments without revealing observed answers");
	const continuedTools = createFrozenInvestigationTools([writer], true, () => {}, externalResponse.cues);
	assert.equal(continuedTools.citationsScope.project(externalResponse.cues[0]!.ref), "N1");
	const continuedAnswer = continuedTools.replayCall("write_answer", { evidence_refs: ["N1"], requirements: ["Explain implementation"] }) as InvestigationAnswer;
	assert.equal(continuedAnswer.answer, "The feature exists. <cite>N1</cite>", "restored thread evidence can reach the Writer without replaying search");
	continuedTools.assertMatched();
	const answerTools = createFrozenInvestigationTools([frozenInteractions[1]!, writer], true, () => {});
	answerTools.replayCall("external_search", { question: "Find documentation" });
	assert.throws(() => answerTools.assertMatched(), /unused/u);
	assert.equal(answerTools.hasFrozenWriter(), true);
	assert.equal(answerTools.evidence.get("N1")?.evidence[0]?.excerpt, "The original evidence");
	assert.ok(!JSON.stringify(answerTools.evidence.get("N1")).includes("source_run_id"), "legacy Replay cannot claim uncaptured original context");
	const delegatedAnswer = answerTools.replayCall("write_answer", { evidence_refs: ["N1"], requirements: ["Explain implementation"] }) as InvestigationAnswer;
	assert.deepEqual(delegatedAnswer, {
		answer: "The feature exists. <cite>N1</cite>", citation_refs: ["N1"], gaps: [],
		coverage: [{ requirement_id: "Q1", citation_refs: ["N1"], gap: "" }],
	});
	answerTools.assertMatched();
	const workspace = join(root, "file-replay");
	const receipt = publishInvestigationHandoff(workspace, "write_answer", delegatedAnswer);
	const normalization = { workspace, lastAnswer: delegatedAnswer, id: "file-replay",
		question: "What is implemented?", wikiSha256 };
	const publicAnswer = { answer: delegatedAnswer.answer, citation_refs: delegatedAnswer.citation_refs, gaps: delegatedAnswer.gaps };
	const normalized = resolveInvestigationReplayResult({ ...normalization, value: { answer_ref: receipt } });
	assert.deepEqual(normalized, { ...publicAnswer, id: normalization.id, question: normalization.question, wiki_sha256: wikiSha256 });
	assert.deepEqual(resolveInvestigationReplayResult({ ...normalization, value: { answer_ref: receipt.result_ref } }), normalized);
	assert.deepEqual(resolveInvestigationReplayResult({ ...normalization, value: publicAnswer }), normalized,
		"historical inline Root outputs retain the same normalized contract");
	assert.equal(answerTools.citationsScope.restore(normalized).answer, writer.result.answer,
		"file handoff preserves the frozen Writer's durable citation identity");
	assert.throws(() => resolveInvestigationReplayResult({ ...normalization, value: { answer_ref: receipt },
		lastAnswer: { ...delegatedAnswer, answer: "A newer Writer answer." } }), /without rewriting/u);
	assert.throws(() => resolveInvestigationReplayResult({ ...normalization, value: { answer_ref: receipt },
		lastAnswer: undefined }), /without rewriting/u);
	assert.throws(() => resolveInvestigationReplayResult({ ...normalization,
		value: { answer_ref: receipt, ...publicAnswer } }), /only answer_ref/u);
	assert.throws(() => resolveInvestigationReplayResult({ ...normalization,
		value: { answer_ref: { ...receipt, operation: "read_sources" } } }), /handoff|operation/iu);
	const changedRequirements = createFrozenInvestigationTools([frozenInteractions[1]!, writer], true, () => {});
	changedRequirements.replayCall("external_search", { question: "Find documentation" });
	assert.throws(() => changedRequirements.replayCall("write_answer", { evidence_refs: ["N1"], requirements: ["Explain a different algorithm"] }), /different evidence or requirements/u);
	assert.throws(() => changedRequirements.assertMatched(), /different evidence/u);
	const writerDir = prepare("with-writer");
	stageFrozenInvestigationReplayPlan(join(root, "uncaptured-original-input"), writerDir, continuedPlan);
	await withInvestigationNodeCapture({ goalDir: root, goalId: "g", runDir: writerDir,
		question: "What is implemented?", context: "Previous implementation discussion", language: "en", wikiSha256, handoffMode: "file", threadId: "b".repeat(24),
		model: "test/model", thinking: "medium", metrics, execute: async () => {
			writeFileSync(join(writerDir, "interactions.jsonl"), JSON.stringify({ operation: writer.name, request: writer.arguments, response: writer.result }) + "\n");
			return { id: "with-writer", question: "What is implemented?", ...writer.result, wiki_sha256: wikiSha256 };
		} });
	const writerCase = findNodeEvaluationCases(writerDir, "prime-investigation")[0]!;
	const writerRequest = JSON.parse(readFileSync(join(writerCase.path, "..", "input", "request.json"), "utf-8"));
	const capturedPlanPath = join(writerCase.path, "..", "input", "replay-plan.json");
	const capturedPlanBytes = readFileSync(capturedPlanPath, "utf-8");
	assert.deepEqual(JSON.parse(capturedPlanBytes), continuedPlan, "Candidate Case must freeze the plan its Prompt names");
	const observedReplayDir = prepare("observed-candidate-case");
	stageFrozenInvestigationReplayPlan(join(writerCase.path, "..", "input"), observedReplayDir);
	const restoredPlanBytes = readFileSync(join(observedReplayDir, "workspace", "inputs", "replay-plan.json"), "utf-8");
	assert.equal(restoredPlanBytes, capturedPlanBytes, "Observed Replay restores the captured plan bytes without regenerating them");
	assert.equal(readFileSync(join(observedReplayDir, "input", "replay-plan.json"), "utf-8"), capturedPlanBytes,
		"A subsequent Case capture retains the same reproducible plan");
	assert.equal(readFileSync(capturedPlanPath, "utf-8"), capturedPlanBytes, "Restoration must leave the source Case unchanged");
	const restoredTools = createFrozenInvestigationTools([writer], true, () => {}, externalResponse.cues);
	for (const step of JSON.parse(restoredPlanBytes).steps) restoredTools.replayCall(step.operation, step.arguments);
	restoredTools.assertMatched();
	const legacyReplayDir = prepare("observed-legacy-case");
	stageFrozenInvestigationReplayPlan(join(cases[0]!.path, "..", "input"), legacyReplayDir);
	assert.equal(existsSync(join(legacyReplayDir, "workspace", "inputs", "replay-plan.json")), false,
		"Legacy observed Cases gain no fabricated Replay plan");
	assert.equal(writerRequest.context, "Previous implementation discussion");
	assert.equal(writerRequest.handoff_mode, "file");
	assert.equal(writerRequest.thread_id, "b".repeat(24));
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
