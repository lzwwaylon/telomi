import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runPiReader } from "../../server/research/pipeline/note-reader-pi.js";
import { renderNoteAgentSystemPrompt } from "../../server/research/pipeline/note-agent-prompt.js";

// The real Pi SDK and SRT tools run against a scripted local HTTP model, never a live Provider.
const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-reader-")));
const previous = process.env;
const agentDir = join(root, "credentials");
process.env = { ...previous, PI_CODING_AGENT_DIR: agentDir };
const errors: unknown[] = [];
let turn = 0, mode: "read" | "failure" | "cancel" = "read";
const controller = new AbortController();
const toolResults: string[] = [];
const readingActions = [
	["bash", { command: "rg -n 'target evidence' source", timeout: 10 }],
	["read", { path: "source/paper.txt" }],
	["read", { path: "source/paper.txt", offset: 2001 }],
	["write", { path: "source/paper.txt", content: "must be denied" }],
	["read", { path: "../runtime/private.txt" }],
	["write", { path: "note.json", content: '{"answer":"draft"}' }],
	null,
	["edit", { path: "note.json", oldText: "draft", newText: "target evidence" }],
	null,
] as const;
let actions: ReadonlyArray<readonly [string, Record<string, unknown>] | null> = readingActions;
const server = createServer(async (request, response) => {
	try {
		let body = "";
		for await (const chunk of request) body += chunk;
		const input = JSON.parse(body);
		if (mode === "cancel") { controller.abort(new Error("cancel Reader")); response.destroy(); return; }
		if (mode === "failure") { response.writeHead(401, { "content-type": "application/json" }); response.end('{"error":{"message":"fixture unauthorized"}}'); return; }
		assert.deepEqual(input.tools.map((tool: { function: { name: string } }) => tool.function.name), ["read", "bash", "edit", "write"]);
		assert.ok(JSON.stringify(input.messages).includes("original question marker"));
		const last = input.messages.at(-1);
		if (last.role === "tool") toolResults.push(JSON.stringify(last.content));
		assert.ok(turn < actions.length, "unexpected extra model turn");
		const action = actions[turn++];
		if (actions === readingActions && turn === 8) {
			assert.ok(JSON.stringify(input.messages).includes("fixture invalid draft"));
			assert.ok(JSON.stringify(input.messages).includes("target evidence"), "repair retains original reading history");
		}
		const chunk = (delta: unknown, finish: string | null) => `data: ${JSON.stringify({ id: "local", object: "chat.completion.chunk", created: 1, model: "reader", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
		const delta = action ? { role: "assistant", tool_calls: [{ index: 0, id: `call_${turn}`, type: "function", function: { name: action[0], arguments: JSON.stringify(action[1]) } }] }
			: { role: "assistant", content: "File written." };
		response.writeHead(200, { "content-type": "text/event-stream" });
		response.end(chunk(delta, null) + chunk({}, action ? "tool_calls" : "stop") + "data: [DONE]\n\n");
	} catch (error) { errors.push(error); response.writeHead(400); response.end(); }
});
await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
const address = server.address();
assert.ok(address && typeof address !== "string");
try {
	mkdirSync(agentDir);
	writeFileSync(join(agentDir, "auth.json"), "{}");
	writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: { "reader-fixture": {
		baseUrl: `http://127.0.0.1:${address.port}/v1`, api: "openai-completions", apiKey: "fixture",
		models: [{ id: "reader", reasoning: false, contextWindow: 128000, maxTokens: 2048 }],
	} } }));
	const prompt = renderNoteAgentSystemPrompt(undefined, "question-reading-pi").content;
	assert.ok(!/IPython|spawn subprocesses/u.test(prompt));
	const work = join(root, "work"), runtimeRoot = join(root, "runtime");
	for (const path of [join(work, "source"), join(work, "inputs"), runtimeRoot]) mkdirSync(path, { recursive: true });
	const paper = [...Array.from({ length: 2000 }, (_, i) => String(i + 1)), "target evidence"].join("\n");
	writeFileSync(join(work, "source/paper.txt"), paper);
	writeFileSync(join(runtimeRoot, "private.txt"), "host-private-marker");
	let validations = 0;
	const args = { work, runtimeRoot, provider: "reader-fixture", modelId: "reader", thinking: "off" as const,
		systemPrompt: prompt, userPrompt: "original question marker", env: process.env, signal: controller.signal,
		validate: async () => { validations++; assert.equal(JSON.parse(readFileSync(join(work, "note.json"), "utf8")).answer, "target evidence", "fixture invalid draft"); } };
	const result = await runPiReader(args);
	assert.deepEqual(errors, []);
	assert.equal(validations, 2);
	assert.equal(result.usage.calls, actions.length);
	for (const name of ["self-review.json", "self-review-prompt.md", "draft-note.json", "tool-output/reader-review"]) {
		assert.ok(!existsSync(join(runtimeRoot, name)), "delivery must not create self-review artifacts");
	}
	assert.ok(toolResults.some(text => text.includes("L2001 | target evidence")));
	assert.ok(toolResults.some(text => text.includes("offset=2001")));
	assert.ok(!toolResults.some(text => text.includes("host-private-marker")));
	assert.equal(readFileSync(join(work, "source/paper.txt"), "utf8"), paper);
	assert.equal(readdirSync(join(runtimeRoot, "sessions")).length, 1, "repairs reuse one native Session");
	const metadata = JSON.parse(readFileSync(join(runtimeRoot, "result.json"), "utf8"));
	assert.deepEqual(metadata.tool_counts, { bash: 1, read: 3, write: 2, edit: 1 });
	assert.equal(metadata.framework, "pi");
	assert.ok(readFileSync(join(runtimeRoot, "effective-system-prompt.md"), "utf8").includes("Use read to examine files"));
	mode = "failure";
	await assert.rejects(runPiReader({ ...args, runtimeRoot: join(root, "failed") }), /unauthorized/);
	assert.equal(validations, 2, "Provider failures do not validate stale output or spend repair turns");
	mode = "cancel";
	await assert.rejects(runPiReader({ ...args, runtimeRoot: join(root, "cancelled") }), /cancelled/);
	assert.equal(validations, 2);
	assert.deepEqual(errors, []);
	console.log("Native Pi Reader: search, continuation, readonly inputs, private paths, same-session file repair, Provider failure and cancellation passed");
} finally {
	process.env = previous;
	await new Promise<void>(done => server.close(() => done()));
	rmSync(root, { recursive: true, force: true });
}
