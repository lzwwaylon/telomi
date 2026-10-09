import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { collectInvestigationUsage } from "../../server/evaluation/investigation-usage.js";

const root = mkdtempSync(join(tmpdir(), "investigation-usage-"));
const runDir = join(root, "run");
const goalDir = join(root, "goal");
const investigationId = "a".repeat(24);
const write = (path: string, rows: unknown[]): void => {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, rows.map(row => JSON.stringify(row)).join("\n") + "\n");
};
const metric = (cost: number) => ({ input_tokens: cost * 10, output_tokens: cost, cost_usd: cost, model_calls: 1, tool_calls: 1 });
const terminal = (agent: string, execution_id: string, cost: number, status = "succeeded") => ({
	type: "node_execution", node_type: "agent", agent, execution_id, status, trace_ref: `${agent}--${execution_id}.jsonl`, output: { metrics: metric(cost) },
});
const message = (responseId: string, cost: number) => ({ type: "message", message: { role: "assistant", provider: "provider", model: "model", responseId,
	usage: { input: cost * 10, output: cost, cost: { total: cost } }, content: [{ type: "toolCall", id: responseId, name: "read", arguments: {} }] } });
const options = { runDir, goalDir, investigationId, rootUsage: { inputTokens: 10, outputTokens: 1, costUsd: 1, calls: 1 }, rootToolCalls: 1 };

try {
	const search = terminal("prime_search", "search", 20);
	write(join(runDir, "external-search-1/runtime--research.jsonl"), [search, search]);
	write(join(runDir, "external-search-1/prime-search-traces/search/acquisition-session/session-artifacts/sub-1/child.jsonl"), [message("child", 15)]);
	write(join(runDir, "runtime--research.jsonl"), [terminal("report_writer", "writer-failed", 2, "failed"), terminal("report_writer", "writer-retry", 3)]);
	write(join(goalDir, `.pi/runtime/note-reading/${investigationId}-1/runtime--research.jsonl`), [terminal("note_agent", "reader", 4)]);
	write(join(goalDir, `.pi/runtime/note-reading/${"b".repeat(24)}-1/runtime--research.jsonl`), [terminal("note_agent", "historical", 99)]);
	write(join(runDir, "input/fake/external-search-9/runtime--research.jsonl"), [terminal("prime_search", "source-copy", 99)]);
	const complete = collectInvestigationUsage(options);
	assert.equal(complete.complete, true);
	assert.deepEqual(complete.usage, { inputTokens: 300, outputTokens: 30, costUsd: 30, calls: 5 }, "Search's inclusive terminal total is counted once, with failed Writer attempt and retry; historical/source copies excluded");
	assert.equal(complete.toolCalls, 5);
	assert.equal(complete.stages.length, 5);
	assert.equal(complete.tokenAccounting.cacheReadTokens, null);
	assert.equal(complete.tokenAccounting.totalTokens, null);

	write(join(runDir, "external-search-2/runtime--research.jsonl"), [{ type: "runtime.agent_bound", agent: "prime_search", execution_id: "failed-search", session_file: "prime_search--failed-search.jsonl" },
		{ type: "node_execution", node_type: "agent", agent: "prime_search", execution_id: "failed-search", status: "failed", trace_ref: "prime_search--failed-search.jsonl", output: { error: "transport" } }]);
	write(join(runDir, "external-search-2/prime_search--failed-search.jsonl"), [message("failed-root", 5)]);
	const childPath = "external-search-2/prime-search-traces/failed-search/acquisition-session/session-artifacts/sub-2";
	write(join(runDir, childPath, "child.jsonl"), [message("failed-child", 6)]);
	write(join(runDir, childPath, "copy.jsonl"), [message("failed-child", 6)]);
	const partial = collectInvestigationUsage(options);
	assert.equal(partial.complete, false, "failed stage without complete terminal metrics stays explicitly partial");
	assert.equal(partial.usage.costUsd, 41, "preserve recorded failed root/child spend without double-counting copied responses");
	assert.ok(partial.missing.length);

	write(join(runDir, "external-search-3/runtime--research.jsonl"), [{ type: "runtime.agent_bound", agent: "prime_search", execution_id: "unfinished", session_file: "prime_search--unfinished.jsonl" }]);
	write(join(runDir, "external-search-3/prime_search--unfinished.jsonl"), [message("unfinished", 7)]);
	const unfinished = collectInvestigationUsage(options);
	assert.equal(unfinished.complete, false);
	assert.equal(unfinished.usage.costUsd, 48);
	assert.ok(unfinished.stages.some(stage => stage.executionId === "unfinished" && stage.status === "unfinished"));

	write(join(runDir, "trace.jsonl"), [message("root-partial", 1)]);
	const missingRoot = collectInvestigationUsage({ ...options, rootUsage: undefined });
	assert.equal(missingRoot.complete, false);
	assert.equal(missingRoot.usage.costUsd, 48, "missing Root summary recovers recorded spend but does not claim complete");
	write(join(runDir, "external-search-4/runtime--research.jsonl"), [{ type: "node_execution", node_type: "agent", agent: "prime_search", execution_id: "known-cost", status: "failed", output: { metrics: { cost_usd: 8 } } }]);
	const knownCost = collectInvestigationUsage(options);
	assert.equal(knownCost.complete, false);
	assert.equal(knownCost.usage.costUsd, 56, "known failed cost remains recorded even when token counts and trace are missing");
	write(join(runDir, "external-search-5/runtime--research.jsonl"), [search]);
	assert.equal(collectInvestigationUsage(options).usage.costUsd, 56, "duplicated terminal execution in a copied directory is not charged again");
	appendFileSync(join(runDir, "runtime--research.jsonl"), "{\"type\":");
	assert.equal(collectInvestigationUsage(options).usage.costUsd, 56, "a truncated Runtime tail cannot erase known spend of earlier attempts");
	const missingWriterRun = join(root, "missing-writer");
	mkdirSync(join(missingWriterRun, "answer-1"), { recursive: true });
	const missingWriter = collectInvestigationUsage({ ...options, runDir: missingWriterRun, goalDir: join(root, "unused-goal") });
	assert.equal(missingWriter.complete, false, "a started Writer with missing Runtime records cannot be treated as zero cost");
	assert.ok(missingWriter.missing.some(item => item.startsWith("writer:")));
	assert.equal(missingWriter.usage.costUsd, 1, "Root known spend is retained despite missing Writer cost");
	console.log("investigation usage counts inclusive Search once, retries and partial spend, excluding copies and historical/source traces");
} finally { rmSync(root, { recursive: true, force: true }); }
