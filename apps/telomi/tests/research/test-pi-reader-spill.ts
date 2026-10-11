import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { ExtensionAPI, ExtensionContext, ExtensionHandler, ToolResultEvent, ToolResultEventResult } from "@earendil-works/pi-coding-agent";
import { runPiReader } from "../../server/research/pipeline/note-reader-pi.js";
import { readerOutputFiles } from "../../server/research/pipeline/reader-output-files.js";

// Native SDK tools and SRT with scripted HTTP responses; follow the actual model-visible spill paths.
const fixture = realpathSync(mkdtempSync(join(tmpdir(), "pi-reader-spill-")));
const previous = process.env;
const agentDir = join(fixture, "credentials");
mkdirSync(agentDir);
process.env = { ...previous, PI_CODING_AGENT_DIR: agentDir };
const ownedTemporaryFiles: string[] = [];
const temporary = (name = `pi-bash-${randomUUID().replaceAll("-", "")}.log`) => {
	const path = join(tmpdir(), name); ownedTemporaryFiles.push(path); return path;
};
let hook: ExtensionHandler<ToolResultEvent, ToolResultEventResult> | undefined;
const api = new Proxy({} as ExtensionAPI, { get: (_target, property) => {
	assert.equal(property, "on", "publication uses only the result hook API");
	return (event: string, handler: typeof hook) => { assert.equal(event, "tool_result"); hook = handler; return () => {}; };
} });
const context = {} as ExtensionContext;
const event = (source: string, toolName = "bash"): ToolResultEvent => ({ type: "tool_result", toolCallId: "fixture", toolName,
	input: {}, content: [{ type: "text", text: `Full output: ${source}` }], details: { fullOutputPath: source },
	isError: false });
const invoke = async (source: string, toolName = "bash") => {
	assert.ok(hook);
	return await hook(event(source, toolName), context);
};
const publishedDirectory = join(fixture, "unit", "tool-output");
mkdirSync(publishedDirectory, { recursive: true });
let foreignOutput = "";

let turn = 0;
let continuation = "";
let originalPath = "";
let results: string[] = [];
const nativePaths: string[] = [];
const errors: unknown[] = [];
const bashCommand = 'for ((i=1;i<=10000;i++)); do printf "%0120d\\n" "$i"; done; printf "END_MARKER\\n"';
type Action = readonly [string, Record<string, unknown>];
const server = createServer(async (request, response) => {
	try {
		let body = "";
		for await (const chunk of request) body += chunk;
		const input = JSON.parse(body);
		assert.deepEqual(input.tools.map((tool: { function: { name: string } }) => tool.function.name), ["read", "bash", "edit", "write"]);
		turn++;
		let action: Action | undefined;
		if (turn === 1) {
			action = ["bash", { command: bashCommand }];
		} else {
			results.push(input.messages.at(-1).content);
			if (turn === 2) {
				const match = /Full output: (\/[^\s\]]+)/u.exec(results[0]!);
				assert.ok(match, `truncated native output provides a continuation path; actual Tool result: ${results[0]}`);
				continuation = match[1]!;
				originalPath = join(tmpdir(), basename(continuation));
				assert.ok(existsSync(originalPath), "the original SDK temporary file still exists");
				ownedTemporaryFiles.push(originalPath);
			}
			const actions: Action[] = [
				["read", { path: continuation, offset: 10001, limit: 1 }],
				["write", { path: continuation, content: "tampered" }],
				["read", { path: originalPath, offset: 1, limit: 1 }],
				["read", { path: foreignOutput, offset: 1, limit: 1 }],
				["read", { path: `/tool-output/${basename(foreignOutput)}`, offset: 1, limit: 1 }],
				["bash", { command: `printf tampered > '${continuation}'` }],
			];
			if (turn <= 7) action = actions[turn - 2]!;
			else assert.equal(turn, 8);
		}
		const chunk = (delta: unknown, finish: string | null, usage?: unknown) => `data: ${JSON.stringify({ id: "spill-fixture", object: "chat.completion.chunk",
			created: 1, model: input.model, choices: [{ index: 0, delta, finish_reason: finish }], ...(usage ? { usage } : {}) })}\n\n`;
		const delta = action === undefined ? { role: "assistant", content: "Spill continuation and permissions checked." }
			: { role: "assistant", tool_calls: [{ index: 0, id: `call_${turn}`, type: "function", function: { name: action[0], arguments: JSON.stringify(action[1]) } }] };
		response.writeHead(200, { "content-type": "text/event-stream" });
		response.end(chunk(delta, null) + chunk({}, action === undefined ? "stop" : "tool_calls", { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }) + "data: [DONE]\n\n");
	} catch (error) { errors.push(error); response.writeHead(400); response.end(); }
});
await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
const address = server.address();
assert.ok(address && typeof address !== "string");
try {
	await readerOutputFiles(publishedDirectory)(api);
	const source = temporary();
	writeFileSync(source, "OTHER_SESSION_MARKER");
	const published = await invoke(source);
	assert.deepEqual(published, { content: [{ type: "text", text: `Full output: /tool-output/${basename(source)}` }],
		details: { fullOutputPath: `/tool-output/${basename(source)}` } });
	foreignOutput = join(publishedDirectory, basename(source));
	assert.equal(readFileSync(foreignOutput, "utf8"), "OTHER_SESSION_MARKER");
	assert.equal(await invoke(source, "read"), undefined, "non-native tools cannot publish arbitrary paths");
	const assertRejected = async (path: string, toolName = "bash") => {
		const result = await invoke(path, toolName);
		assert.ok(result);
		assert.equal(result.isError, true, "publication failure returns an error result instead of throwing into an SDK-swallowed hook error");
		assert.deepEqual(result.details, {});
		assert.match(JSON.stringify(result.content), /Could not publish native tool output/u);
	};
	writeFileSync(source, "must not overwrite");
	await assertRejected(source);
	assert.equal(readFileSync(foreignOutput, "utf8"), "OTHER_SESSION_MARKER", "collision cannot overwrite an existing accepted spill");
	const symlink = temporary(); symlinkSync(source, symlink); await assertRejected(symlink);
	const fifo = temporary(); execFileSync("mkfifo", [fifo]); await assertRejected(fifo);
	const hardlink = temporary(); linkSync(source, hardlink); await assertRejected(hardlink);
	const outside = join(fixture, basename(temporary())); writeFileSync(outside, "outside SDK temp location"); await assertRejected(outside);
	const nonSdk = temporary(`other-${randomUUID()}.txt`); writeFileSync(nonSdk, "not an SDK output"); await assertRejected(nonSdk);
	assert.equal(await invoke(source, "codemode"), undefined);
	assert.ok(!readdirSync(join(fixture, "unit")).some(name => name.startsWith(".reader-output-")), "failed publication removes staging files");

	writeFileSync(join(agentDir, "auth.json"), "{}");
	writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: { "spill-fixture": {
		baseUrl: `http://127.0.0.1:${address.port}/v1`, api: "openai-completions", apiKey: "fixture",
		models: [{ id: "scripted", reasoning: false, contextWindow: 128000, maxTokens: 4096,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
	} } }));
	{
		turn = 0; continuation = ""; originalPath = ""; results = []; nativePaths.length = 0;
		const work = join(fixture, "bash", "work"), runtimeRoot = join(fixture, "bash", "runtime");
		for (const path of [work, runtimeRoot, join(work, "source"), join(work, "inputs")]) mkdirSync(path, { recursive: true });
		await runPiReader({ work, runtimeRoot, provider: "spill-fixture", modelId: "scripted", thinking: "off",
			systemPrompt: "Read complete truncated tool outputs using their continuation paths.", userPrompt: "Produce a truncated output and recover its full content, preserving Session boundaries.",
			env: process.env, signal: new AbortController().signal, validate: async () => { assert.equal(turn, 8); },
			onEvent: event => {
				if (event.type === "tool_execution_end" && event.result.details && typeof event.result.details === "object"
					&& "fullOutputPath" in event.result.details && typeof event.result.details.fullOutputPath === "string") nativePaths.push(event.result.details.fullOutputPath);
			} });
		assert.deepEqual(errors, []);
		assert.match(results[1]!, /END_MARKER/u, `the spill must be readable through SRT: ${continuation}\n${results[1]}`);
		assert.match(continuation, /^\/tool-output\/pi-bash-[a-f0-9]+\.log$/u);
		assert.ok(nativePaths.includes(continuation), "native details.fullOutputPath uses the same published path");
		assert.match(results[2]!, /read-only/u, "write cannot mutate a published spill");
		assert.match(results[3]!, /outside|escapes|denied/u, "the old native host-temp path is not made readable");
		assert.match(results[4]!, /outside|escapes|denied/u, "another Session's host output directory is not readable");
		assert.match(results[5]!, /ENOENT|not found|does not exist/iu, "another Session's basename is absent from this Session's mount");
		assert.match(results[6]!, /read-only|permission denied|operation not permitted/iu, "native bash cannot bypass the read-only mount");
		const accepted = join(runtimeRoot, "tool-output", basename(continuation));
		assert.equal(readFileSync(accepted, "utf8"), readFileSync(originalPath, "utf8"), "publication and failed writes preserve exact native bytes");
		assert.ok(!results.slice(1).some(result => result.includes("OTHER_SESSION_MARKER")));
		foreignOutput = accepted;
		console.log(`Pi Reader bash: exact spill continuation, read-only output, host-temp denial and Session isolation passed`);
	}
} catch (error) {
	if (errors.length) throw new AggregateError([...errors, error], "Scripted spill model assertions and Reader execution failed");
	throw error;
} finally {
	process.env = previous;
	server.closeAllConnections();
	await new Promise<void>(done => server.close(() => done()));
	for (const path of ownedTemporaryFiles) rmSync(path, { force: true });
	rmSync(fixture, { recursive: true, force: true });
}
