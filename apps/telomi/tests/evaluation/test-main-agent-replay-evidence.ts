import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { prepareMainAgentReplayGoalWorkspace, retainMainAgentReplayEvidence } from "../../server/evaluation/main-agent-replay.js";
import { mainAgentTraceRefs } from "../../server/evaluation/node-backtest.js";
import { RunArtifactStore } from "../../server/agent-runtime/artifact-store.js";
import type { NodeEvaluationCase } from "../../server/agent-runtime/node-evaluation.js";
import { serverRuntimeDirForGoal } from "../../server/workspaces/server-runtime-paths.js";

const root = mkdtempSync(join(tmpdir(), "main-replay-evidence-"));
const put = (path: string, text: string) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); };
try {
	const runDirectory = join(root, "run"), recordDirectory = join(runDirectory, "executions", "candidate_case_1");
	const workspaceDirectory = join(recordDirectory, "main-runtime"), goalId = "replay-goal";
	const sourceRunDirectory = join(root, "source"), harnessWorkspaceDirectory = join(root, "capability");
	put(join(sourceRunDirectory, "workspace/input/wiki/knowledge/page.md"), "Historical knowledge");
	put(join(sourceRunDirectory, "workspace/input/wiki/runs/saved/sources/original.py"), "original source bytes");
	put(join(harnessWorkspaceDirectory, "wiki/knowledge/page.md"), "Later answer that must not leak");
	put(join(harnessWorkspaceDirectory, "wiki/knowledge/future.md"), "Future knowledge");
	put(join(harnessWorkspaceDirectory, "skills/example/SKILL.md"), "Candidate skill");
	const preparation = { value: { agentId: "main-agent" } as NodeEvaluationCase, casePath: join(root, "case/manifest.json"),
		sourceRunDirectory, harnessWorkspaceDirectory, workspaceDirectory, goalId };
	const goalDirectory = await prepareMainAgentReplayGoalWorkspace(preparation);
	assert.equal(readFileSync(join(goalDirectory, "wiki/knowledge/page.md"), "utf8"), "Historical knowledge");
	assert.equal(existsSync(join(goalDirectory, "wiki/knowledge/future.md")), false);
	assert.equal(readFileSync(join(goalDirectory, "skills/example/SKILL.md"), "utf8"), "Candidate skill");
	await assert.rejects(prepareMainAgentReplayGoalWorkspace({ ...preparation, sourceRunDirectory: join(root, "missing"),
		workspaceDirectory: join(root, "missing-replay") }), /frozen pre-turn Goal tree/u);

	// Include one successful result and a failed descendant without an output artifact.
	put(join(goalDirectory, "artifacts/investigations/answer/result.json"), '{"answer":"New answer"}');
	const research = join(serverRuntimeDirForGoal(goalId, workspaceDirectory), "research");
	put(join(research, "investigations/answer/trace.jsonl"), '{"type":"message"}\n');
	put(join(research, "investigations/answer/external-search-1/provider-calls.jsonl"), '{"provider":"example"}\n');
	const reader = join(goalDirectory, ".pi/runtime/note-reading/answer-1");
	put(join(reader, "note_agent--note-reading-answer-1-attempt-1.jsonl"), '{"error":"Reader failed"}\n');
	put(join(reader, "stage/runtime/agent/auth.json"), "SECRET");
	put(join(research, "investigations/answer/runtime/agent/auth.json"), "SECRET");
	put(join(research, "investigations/answer/runtime/home/.credentials"), "SECRET");
	put(join(research, "investigations/answer/runtime/session/sdk-input.json"), '{"generalWeb":{"token":"SECRET"}}');
	put(join(research, "investigations/answer/workspace/.env"), "SECRET");
	put(join(research, "investigations/answer/runtime/worker-bootstrap.json"), '{"token":"SECRET"}');
	put(join(research, "investigations/answer/runtime/session/stdout.txt"), "SECRET");
	retainMainAgentReplayEvidence({ workspaceDirectory, goalId, recordDirectory });
	rmSync(workspaceDirectory, { recursive: true, force: true });
	const evidence = join(recordDirectory, "main-agent-evidence");
	const manifest = JSON.parse(readFileSync(join(evidence, "manifest.json"), "utf8")) as {
		files: Array<{ relativePath: string; sha256: string; byteLength: number }>;
	};
	assert.equal(manifest.files.length, 6, "original sources, Wiki, output, successful and failed descendant traces survive cleanup");
	const refs = Object.values(mainAgentTraceRefs(runDirectory, { id: "candidate_case_1" }));
	assert.equal(refs.length, 7, "Operations exposes every retained file plus its integrity manifest even without a Main trace");
	const store = new RunArtifactStore(evidence);
	for (const file of manifest.files) {
		const actual = store.describeFile(file.relativePath);
		assert.equal(actual.sha256, file.sha256);
		assert.equal(actual.byteLength, file.byteLength);
		assert(refs.includes(`executions/candidate_case_1/main-agent-evidence/${file.relativePath}`));
		assert(!readFileSync(actual.absolutePath, "utf8").includes("SECRET"));
	}
	assert.equal(readFileSync(join(evidence, "goal/wiki/runs/saved/sources/original.py"), "utf8"), "original source bytes");
	assert.equal(readFileSync(join(evidence, "note-reading/answer-1/note_agent--note-reading-answer-1-attempt-1.jsonl"), "utf8"),
		'{"error":"Reader failed"}\n', "the actual Goal-local Reader control directory survives Main cleanup");
	// Retained outputs never feed a later repetition: it starts from the original pre-turn tree.
	const next = await prepareMainAgentReplayGoalWorkspace({ ...preparation, workspaceDirectory: join(root, "next") });
	assert.equal(existsSync(join(next, "artifacts/investigations/answer/result.json")), false);
	const unsafeWorkspace = join(root, "unsafe");
	put(join(unsafeWorkspace, goalId, "artifacts/regular.json"), "{}");
	symlinkSync(join(root, "outside"), join(unsafeWorkspace, goalId, "artifacts/escape"));
	assert.throws(() => retainMainAgentReplayEvidence({ workspaceDirectory: unsafeWorkspace, goalId,
		recordDirectory: join(root, "unsafe-record") }), /must not contain symlinks/u);
	assert.throws(() => retainMainAgentReplayEvidence({ workspaceDirectory: join(root, "removed"), goalId,
		recordDirectory: join(root, "missing-evidence") }), /requires its isolated Goal directory/u);
	console.log("Main Replay retains descendant evidence and restores only historical business inputs");
} finally {
	rmSync(root, { recursive: true, force: true });
}
