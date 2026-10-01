import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Value } from "@sinclair/typebox/value";

import { sha256 } from "../../server/lib/hash.js";
import { publishInvestigationHandoff } from "../../server/main-agent/investigation-handoff.js";
import { createMainAgentSandbox, createMainAgentSandboxProxyTools } from "../../server/main-agent/main-agent-sandbox.js";
import { MainWorkspaceRuntime } from "../../server/main-agent/main-workspace-runtime.js";
import { createDeliverInvestigationTool, createInvestigateTool } from "../../server/main-agent/tools/investigate.js";
import type { InvestigationResult } from "../../server/research/investigate.js";
import { runInInvestigationThread } from "../../server/research/investigation-threads.js";
import { ensureGoalWorkspace } from "../../server/workspaces/goal-project.js";
import { openMainAgentFiles } from "../../server/workspaces/main-agent-files.js";
import { serverRuntimeDirForGoalDir } from "../../server/workspaces/server-runtime-paths.js";

const root = realpathSync(mkdtempSync(join(tmpdir(), "telomi-investigation-handoff-")));
const goalId = "goal_handoff";
const goalDir = join(root, goalId);
const invocationId = "completed-investigation";
const id = sha256(`${goalId}\0${invocationId}`).slice(0, 24);
const result: InvestigationResult = {
	id, question: "Explain the saved evidence", answer: "A saved finding <cite>C1</cite>.",
	citation_refs: ["C1"], gaps: ["A remaining uncertainty"], wiki_sha256: sha256("wiki"),
};
let sandbox: ReturnType<typeof createMainAgentSandbox> | undefined;

try {
	ensureGoalWorkspace({ goalDir, goalId, title: "File handoff" });
	mkdirSync(join(goalDir, "attachments"), { recursive: true });
	// An already validated completed investigation exercises the tool without a model or Provider.
	const runDir = join(serverRuntimeDirForGoalDir(goalDir), "research", "investigations", id);
	mkdirSync(runDir, { recursive: true });
	writeFileSync(join(runDir, "request.json"), JSON.stringify({
		goalId, id, question: result.question, context: "", language: "en", allowExternal: false,
	}));
	writeFileSync(join(runDir, "result.json"), JSON.stringify(result));
	const threaded = await runInInvestigationThread({
		goalDir, executionId: "2".repeat(24), question: result.question, title: "Saved evidence review",
	}, async () => ({ ...result, id: "2".repeat(24) }));
	assert.ok(threaded.thread_id, "Runtime assigns a durable thread identity");

	const runtime = new MainWorkspaceRuntime(goalDir, goalId, root);
	const session = runtime.prepare({ conversationId: "handoff-turn" });
	sandbox = createMainAgentSandbox(goalDir, session);
	const tool = createInvestigateTool(goalDir, {
		goalId, getOutputLanguage: () => "en",
		exposeInvestigationResult: (artifact) => runtime.exposeInvestigationResult(session.id, artifact),
	});
	assert.equal(Value.Check(tool.parameters, { question: result.question, thread_id: "1".repeat(24), title: "Follow up" }), true);
	for (const invalid of [
		{ thread_id: "invented-id" }, { thread_id: "../outside" }, { title: "" }, { title: "x".repeat(121) },
	]) assert.equal(Value.Check(tool.parameters, { question: result.question, ...invalid }), false);
	const response = await tool.execute(invocationId, { question: result.question });
	const text = response.content.find((item) => item.type === "text");
	assert.equal(text?.type, "text");
	if (text?.type !== "text") throw new Error("Expected a text receipt");
	const receipt = JSON.parse(text.text);
	assert.deepEqual(Object.keys(receipt).sort(), ["byte_length", "investigation_id", "result_ref", "sha256"]);
	assert.equal(receipt.result_ref, `/artifacts/investigations/${id}/result.json`);
	assert.equal(receipt.investigation_id, id);
	assert.equal(text.text.includes(result.answer), false, "tool output must not inject the answer");
	assert.deepEqual(response.details, receipt);

	const mounted = join(session.sandboxDir, "artifacts", "investigations", id, "result.json");
	const saved = join(goalDir, "artifacts", "investigations", id, "result.json");
	const content = readFileSync(mounted);
	assert.deepEqual(JSON.parse(content.toString()), result);
	assert.equal(sha256(content), receipt.sha256);
	assert.equal(content.byteLength, receipt.byte_length);
	assert.deepEqual(readFileSync(saved), content);
	const nativeTools = createMainAgentSandboxProxyTools(() => sandbox);
	const nativeRead = await nativeTools.find((entry) => entry.name === "read")!.execute("review", { path: receipt.result_ref });
	assert.ok(nativeRead.content.some((item) => item.type === "text" && item.text.includes(JSON.stringify(result.answer))),
		"native read must see a result published after the sandbox was created");
	const catalogPath = "/artifacts/investigation-threads/recent.json";
	const catalogRead = await nativeTools.find((entry) => entry.name === "read")!.execute("threads", { path: catalogPath });
	assert.ok(catalogRead.content.some((item) => item.type === "text" && item.text.includes(threaded.thread_id!)),
		"Main discovers Runtime-assigned thread identities through the mounted catalog");
	await assert.rejects(nativeTools.find((entry) => entry.name === "write")!.execute("rename-thread", {
		path: catalogPath, content: "overwritten",
	}), /read-only/u, "Main cannot rewrite Runtime's thread directory");
	await assert.rejects(nativeTools.find((entry) => entry.name === "write")!.execute("overwrite", {
		path: receipt.result_ref, content: "overwritten",
	}), /read-only/u, "the result mount remains read-only");
	await sandbox.close();
	sandbox = undefined;
	const files = openMainAgentFiles(goalDir, {
		workDirectory: session.workDirectory, artifactsDirectory: join(session.sandboxDir, "artifacts"),
	});
	try {
		const resolved = files.resolve(receipt.result_ref);
		assert.equal(resolved.kind, "file");
		if (resolved.kind === "file") assert.equal(resolved.absolutePath, mounted);
	} finally { files.close(); }

	const delivery = await createDeliverInvestigationTool(goalDir).execute("delivery", { investigation_id: id });
	assert.deepEqual(delivery.content, [{ type: "text", text: result.answer }]);
	assert.equal((await runtime.publish(session.id)).status, "no_change", "Runtime handoff is not an Agent write");
	assert.equal(existsSync(session.sandboxDir), false);
	assert.deepEqual(JSON.parse(readFileSync(saved, "utf8")), result, "handoff survives Turn cleanup");
	assert.deepEqual(publishInvestigationHandoff(goalDir, result).receipt, receipt, "identical publication is idempotent");
	assert.throws(() => publishInvestigationHandoff(goalDir, { ...result, answer: "different" }), /hash changed/u);

	const next = runtime.prepare({ conversationId: "next-turn" });
	assert.deepEqual(readFileSync(join(next.sandboxDir, "artifacts", "investigations", id, "result.json")), content);
	for (const filename of ["index.json", "recent.json"]) {
		assert.ok(existsSync(join(next.sandboxDir, "artifacts", "investigation-threads", filename)),
			"each Turn mounts a fresh Runtime-generated thread catalog");
	}
	const threadedHandoff = publishInvestigationHandoff(goalDir, threaded);
	assert.equal(threadedHandoff.receipt.thread_id, threaded.thread_id);
	runtime.exposeInvestigationResult(next.id, threadedHandoff.artifact);
	assert.equal(JSON.parse(readFileSync(join(next.sandboxDir, "artifacts", threadedHandoff.artifact.relative_path), "utf8")).thread_id,
		threaded.thread_id);
	assert.throws(() => publishInvestigationHandoff(goalDir, { ...threaded, thread_id: "../outside" }), /Invalid investigation thread id/u);
	await runtime.abort(next.id);
	const historicalFiles = openMainAgentFiles(goalDir);
	try {
		const resolved = historicalFiles.resolve(receipt.result_ref);
		if (resolved.kind !== "file") throw new Error("Expected a historical artifact");
		assert.equal(resolved.absolutePath, saved);
	} finally { historicalFiles.close(); }

	const { artifact } = publishInvestigationHandoff(goalDir, result);
	const tampered = runtime.prepare({ conversationId: "tampered-result" });
	assert.throws(() => runtime.exposeInvestigationResult(tampered.id, { ...artifact, sha256: "0".repeat(64) }), /hash changed/u);
	writeFileSync(join(tampered.sandboxDir, "artifacts", artifact.relative_path), "tampered");
	assert.throws(() => runtime.exposeInvestigationResult(tampered.id, artifact), /hash changed/u);
	await assert.rejects(runtime.publish(tampered.id), /may only modify artifacts\/main/u);

	const unrelated = runtime.prepare({ conversationId: "unrelated-write" });
	writeFileSync(join(unrelated.sandboxDir, "unowned.txt"), "unowned");
	runtime.exposeInvestigationResult(unrelated.id, artifact);
	await assert.rejects(runtime.publish(unrelated.id), /may only modify artifacts\/main/u,
		"exposing a trusted artifact must not accept unrelated Agent writes");
	assert.equal(existsSync(dirname(saved)), true);
	console.log("Investigation file handoff tests passed");
} finally {
	await sandbox?.close();
	rmSync(root, { recursive: true, force: true });
}
