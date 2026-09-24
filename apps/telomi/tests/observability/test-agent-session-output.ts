import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { ObservabilityActivityProjection } from "../../server/observability/activity-projection.js";

const root = mkdtempSync(join(tmpdir(), "telomi-agent-session-output-"));
const goalRoot = join(root, "goal-a");
const control = join(goalRoot, "runs", "run-a");
const projection = new ObservabilityActivityProjection();
const message = (text: string) => ({ type: "message", message: { role: "assistant", content: [{ type: "text", text }] } });
const write = (path: string, value: unknown) => {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(value)}\n`);
};
const readWiki = (traceRef: string, lifecycle: "running" | "finished" = "finished") => {
	const ref = projection.registerOutput({ kind: "wiki-agent", goalId: "goal-a", controlDirectory: control,
		traceRoot: goalRoot, traceRef, lifecycle });
	return projection.readOutput("goal-a", ref)!;
};
try {
	// The writer's archived child sessions must be visible beside its native Root session.
	const writer = join(control, "report_writer--writer-a.jsonl");
	write(writer, message("REPORT ROOT"));
	write(writer.replace(".jsonl", "-child-01.jsonl"), message("REPORT CHILD"));
	write(join(control, "report_writer--writer-b-child-01.jsonl"), message("UNRELATED"));
	const writerRef = projection.registerOutput({ kind: "recorded-agent", goalId: "goal-a", runId: "run-a",
		runDirectory: control, agent: "report_writer", executionId: "writer-a", sessionFile: "report_writer--writer-a.jsonl", lifecycle: "finished" });
	assert.doesNotMatch(JSON.stringify(projection.readOutput("goal-a", writerRef)), /REPORT ROOT|REPORT CHILD/,
		"missing manifests must not discover sessions by filename");
	write(`${writer}.sessions.json`, { schemaVersion: 1, sessions: [
		{ path: "report_writer--writer-a.jsonl", label: "Report Root" },
		{ path: "report_writer--writer-a-child-01.jsonl", label: "Section child" },
	] });
	const archived = projection.readOutput("goal-a", writerRef)!;
	assert.match(JSON.stringify(archived), /REPORT CHILD/, "Reporter must expose its preserved Section child trace");
	assert.doesNotMatch(JSON.stringify(archived), /UNRELATED/);

	write(join(control, "prime-search-traces/starting/acquisition-session/session/root.jsonl"), { type: "session", id: "starting" });
	const startingSearch = projection.registerOutput({ kind: "recorded-agent", goalId: "goal-a", runId: "run-a", runDirectory: control,
		agent: "prime_search", executionId: "starting", sessionFile: "prime_search--starting.jsonl", lifecycle: "running" });
	assert.doesNotMatch(JSON.stringify(projection.readOutput("goal-a", startingSearch)), /已完成/,
		"a native Search session header alone does not mean the Agent has finished");

	// One manifest reads both Wiki Roots and their children, including native paths outside control but in this Goal.
	const entity = join(goalRoot, "wiki-shards", "v1", "comp", "batch-001", "sessions", "entity");
	const concept = join(goalRoot, "wiki-shards", "v1", "comp", "batch-001", "sessions", "concept");
	const child = join(control, "work", "session-artifacts");
	const manifest = { schemaVersion: 1, sessions: [
		{ path: relative(control, entity), label: "Entity Root" },
		{ path: relative(control, concept), label: "Concept Root" },
		{ path: relative(control, child), label: "Wiki child" },
		{ path: relative(control, join(child, "sub-a")), label: "Duplicate" },
	] };
	write(join(control, "wiki.sessions.json"), manifest);
	assert.doesNotMatch(JSON.stringify(readWiki("wiki.sessions.json", "running")), /已完成/, "an empty running trace must not claim completion");
	write(join(entity, "a.jsonl"), message("ENTITY TRACE"));
	write(join(concept, "b.jsonl"), message("CONCEPT TRACE"));
	write(join(child, "sub-a", "a.jsonl"), message("WIKI CHILD TRACE"));
	const wiki = readWiki("wiki.sessions.json");
	assert.deepEqual(wiki.lines.map((line) => line.text), ["输出\nENTITY TRACE", "输出\nCONCEPT TRACE", "输出\nWIKI CHILD TRACE"]);
	assert.equal(new Set(wiki.lines.map((line) => line.ref)).size, 3);

	// Live Reporter has no archived Root yet; its adjacent sidecar points at native SDK directories.
	const liveRef = projection.registerOutput({ kind: "recorded-agent", goalId: "goal-a", runId: "run-a", runDirectory: control,
		agent: "report_writer", executionId: "live", sessionFile: "report_writer--live.jsonl", lifecycle: "running" });
	write(join(control, "report_writer--live.jsonl.sessions.json"), { schemaVersion: 1, sessions: [{ path: "work/session-artifacts", label: "Section child" }] });
	assert.match(JSON.stringify(projection.readOutput("goal-a", liveRef)), /WIKI CHILD TRACE/);

	const crashedRef = projection.registerOutput({ kind: "recorded-agent", goalId: "goal-a", runId: "run-a", runDirectory: control,
		agent: "report_writer", executionId: "live", lifecycle: "finished", outcome: "cancelled" });
	assert.match(JSON.stringify(projection.readOutput("goal-a", crashedRef)), /WIKI CHILD TRACE/,
		"a process crash before archival must not lose the live sidecar when the sealed node lacks trace_ref");

	const nativeSession = `${JSON.stringify({ type: "session", id: "live-session" })}\n${JSON.stringify(message("x".repeat(3_000)))}\n`;
	writeFileSync(join(control, "work/session-artifacts/sub-a/a.jsonl"), nativeSession);
	const liveLine = projection.readOutput("goal-a", liveRef)!.lines[0]!;
	writeFileSync(join(control, "report_writer--live.jsonl"), nativeSession);
	write(join(control, "report_writer--live.jsonl.sessions.json"), { schemaVersion: 1, sessions: [{ path: "report_writer--live.jsonl", label: "Report Root" }] });
	assert.equal(projection.readOutput("goal-a", liveRef, { line: liveLine.ref })?.lines[0]?.text.length, 3_003,
		"a truncated line keeps its ref when the session is archived");

	// Old Wiki pointers cannot expose sessions without a current manifest.
	const legacy = "note-wiki/comp/curation/batch-001/curator-runtime/sdk-events.jsonl";
	write(join(control, legacy), { type: "rlm_child_update", child: { id: "sub-a", status: "completed" } });
	write(join(control, dirname(legacy), "session-artifacts", "sub-a", "child.jsonl"), message("LEGACY CHILD TRACE"));
	const curatorRoot = join(goalRoot, "wiki-shards", "v1", "comp", "curator", "batch-001", "sessions", "root.jsonl");
	write(curatorRoot, message("LEGACY ROOT TRACE"));
	assert.doesNotMatch(JSON.stringify(readWiki(legacy)), /LEGACY ROOT TRACE|LEGACY CHILD TRACE/);
	assert.doesNotMatch(JSON.stringify(readWiki(relative(control, join(entity, "a.jsonl")))), /ENTITY TRACE/,
		"old entity session pointers must not bypass the manifest");

	// Manifests never disclose a different Goal or follow symlinks, including intermediate directories.
	const secret = join(root, "goal-b", "secret.jsonl");
	write(secret, message("PRIVATE"));
	symlinkSync(dirname(secret), join(control, "linked"));
	write(join(control, "unsafe.sessions.json"), { schemaVersion: 1, sessions: [
		{ path: relative(control, secret), label: "escape" },
		{ path: "linked/secret.jsonl", label: "link" },
	] });
	assert.doesNotMatch(JSON.stringify(readWiki("unsafe.sessions.json")), /PRIVATE/);
	symlinkSync(goalRoot, join(root, "linked-goal"));
	const linkedBoundary = projection.registerOutput({ kind: "wiki-agent", goalId: "goal-a",
		controlDirectory: join(root, "linked-goal", "runs", "run-a"), traceRoot: join(root, "linked-goal"),
		traceRef: "wiki.sessions.json", lifecycle: "finished" });
	assert.doesNotMatch(JSON.stringify(projection.readOutput("goal-a", linkedBoundary)), /ENTITY TRACE/,
		"the Goal boundary itself must not be a symlink");
	assert.equal(projection.readOutput("other-goal", writerRef), null);
	console.log("Agent traces expose live and archived sessions within their Goal boundary");
} finally {
	rmSync(root, { recursive: true, force: true });
}
