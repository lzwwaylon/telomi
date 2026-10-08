import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { currentSessionActivity, ObservabilityActivityProjection } from "../../server/observability/activity-projection.js";
import { wikiStageTraceUsage } from "../../server/wiki/wiki-stage.js";

const root = mkdtempSync(join(tmpdir(), "main-wiki-fork-traces-"));
const runtime = join(root, "attempt", "runtime");
const sessions = join(runtime, "sessions");
const path = join(sessions, "fork.jsonl");
const marker = join(runtime, "main-session-fork.json");
const header = { type: "session", id: "wiki-fork" };
const inherited = { type: "message", id: "copied-main", message: { role: "assistant", timestamp: 1,
	content: [{ type: "text", text: "MAIN HISTORY" }, { type: "toolCall", id: "old-tool", name: "investigate", arguments: {} }],
	usage: { input: 100, output: 50, cost: { total: 10 } } } };
const inheritedResult = { type: "message", id: "copied-tool", message: { role: "toolResult", toolCallId: "old-tool", toolName: "investigate",
	content: [{ type: "text", text: "OLD INVESTIGATION RESULT" }] } };
const fresh = { type: "message", id: "new-selection", message: { role: "assistant", timestamp: 2,
	content: [{ type: "text", text: "NEW WIKI DECISION" }], usage: { input: 3, cacheRead: 4, cacheWrite: 5, output: 6, cost: { total: 0.07 } } } };
const writeSession = (entries: unknown[]) => writeFileSync(path, entries.map(entry => JSON.stringify(entry)).join("\n") + "\n");
try {
	mkdirSync(sessions, { recursive: true });
	writeFileSync(marker, JSON.stringify({ sourceSessionId: "main", forkSessionId: "wiki-fork", initialEntryIds: [inherited.id, inheritedResult.id] }));
	writeSession([header, inherited, inheritedResult]);
	const projection = new ObservabilityActivityProjection();
	writeFileSync(join(root, "selection.sessions.json"), JSON.stringify({ schemaVersion: 1, sessions: [{ path: relative(root, sessions), label: "Wiki Selection" }] }));
	const outputRef = projection.registerOutput({ kind: "wiki-agent", goalId: "goal-a", controlDirectory: root,
		traceRoot: root, traceRef: "selection.sessions.json", lifecycle: "running" });
	assert.deepEqual(wikiStageTraceUsage(root), { inputTokens: 0, outputTokens: 0, costUsd: 0, calls: 0 });
	assert.deepEqual(currentSessionActivity(path), {}, "inherited history is not the new stage's current progress");
	assert.match(projection.readOutput("goal-a", outputRef)!.lines[0]!.text, /等待第一条/);

	writeSession([header, inherited, inheritedResult, fresh]);
	assert.deepEqual(wikiStageTraceUsage(root), { inputTokens: 12, outputTokens: 6, costUsd: 0.07, calls: 1 });
	const output = projection.readOutput("goal-a", outputRef)!;
	assert.equal(output.lines.length, 1);
	assert.equal(output.lines[0]!.text, "输出\nNEW WIKI DECISION");
	assert.equal(output.lines[0]!.ref, "session:wiki-fork#1");
	assert.deepEqual(currentSessionActivity(path), { summary: "NEW WIKI DECISION", at: new Date(2).toISOString() });
	assert.match(readFileSync(path, "utf8"), /MAIN HISTORY.*investigate/u, "native historical entries remain available to replay inspection");
	const compaction = { type: "compaction", id: "new-compaction", summary: "Context summary", usage: { input: 7, output: 8, cost: { total: 0.03 } } };
	writeSession([header, inherited, inheritedResult, fresh, compaction]);
	assert.deepEqual(wikiStageTraceUsage(root), { inputTokens: 19, outputTokens: 14, costUsd: 0.1, calls: 2 },
		"the fork's new native context compaction is billed as a new model call");

	// A sibling session's IDs are not excluded by another fork's marker.
	writeSession([{ ...header, id: "different-session" }, inherited, inheritedResult, fresh]);
	assert.equal(wikiStageTraceUsage(root).calls, 2);
	assert.match(JSON.stringify(projection.readOutput("goal-a", outputRef)), /MAIN HISTORY|OLD INVESTIGATION RESULT/u);
	rmSync(marker);
	assert.equal(wikiStageTraceUsage(root).calls, 2, "ordinary sessions keep their existing accounting");
	console.log("Background Main Wiki traces exclude inherited usage and Activity while retaining native history");
} finally {
	rmSync(root, { recursive: true, force: true });
}
