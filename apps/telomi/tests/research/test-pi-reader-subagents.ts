import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { sha256 } from "../../server/lib/hash.js";
import { runPiReaderSubagents, officialReaderSubagentPath } from "../../server/research/pipeline/note-reader-pi-subagents.js";
import { renderPiReaderSystemPrompt, renderNoteAgentSystemPrompt, renderPiReaderChildPrompt } from "../../server/research/pipeline/note-agent-prompt.js";

// Real workers, upstream subagent dispatch, native Pi Sessions and SRT; HTTP model responses are scripted.
const fixture = realpathSync(mkdtempSync(join(tmpdir(), "pi-reader-subagents-")));
const previous = process.env;
const agentDir = join(fixture, "credentials");
process.env = { ...previous, PI_CODING_AGENT_DIR: agentDir };
const originalQuestion = "Original whole question: explain both alpha and beta evidence, preserve every requested distinction.";
const paper = `${"x".repeat(33_000)}\nExact verified evidence.\n`;
const draft = (line: number, scope: string) => ({ status: "found", summary: "Verified assigned evidence", gaps: [], sections: [{
	section_title: `${scope} evidence`, cue_notes: [{ cue: `Verified ${scope} claim`, note: "Exact verified evidence.",
		evidence: [{ source_ref: "S1", source_path: "paper.txt", start_line: line, end_line: line }] }],
}] });
const plan = (notes: string[]) => ({ status: "found", summary: "Verified combined evidence", gaps: [], notes, excluded: [] });
const json = (path: string) => JSON.parse(readFileSync(path, "utf8"));
const errors: unknown[] = [];
let mode: "read" | "cancel" | "single" | "registration-failure" = "read";
let rootTurns = 0;
const childTurns = new Map<string, number>();
const childResults: string[] = [];
const firstResponses: Array<() => void> = [];
let accepted: Array<{ child_id: string; note_path: string; session_id: string; submission: number; task: string }> = [];
let observedPids: number[] = [];
const registered = new Map<string, { id: string; path: string; label: string }>();
const processes = () => execFileSync("ps", ["-axo", "pid=,ppid=,stat=,command="], { encoding: "utf8" }).trim().split("\n")
	.map(line => /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/u.exec(line))
	.filter(match => match !== null)
	.map(match => ({ pid: Number(match[1]), parent: Number(match[2]), state: match[3]!, command: match[4]! }));
const workers = () => processes().filter(process => process.command.includes("note-reader-pi-worker.mjs --mode json") && process.command.includes(basename(fixture)));
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (error) {
	if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
	throw error;
} };
type Action = readonly [string, Record<string, unknown>] | null;
const assignment = (scope: string) => `${basename(fixture)} ${mode}: Read only scope-${scope}; use the original question as background.`;
const parallel = (): Action => ["subagent", { agentScope: "user", cwd: fixture, tasks: ["alpha", "beta"].map(scope => ({
	agent: "reader", task: assignment(scope), cwd: fixture, model: "forbidden-model",
})) }];
const server = createServer(async (request, response) => {
	try {
		let body = "";
		for await (const chunk of request) body += chunk;
		const input = JSON.parse(body);
		const history = JSON.stringify(input.messages);
		assert.ok(history.includes(originalQuestion), "every Session receives the complete original question");
		const toolNames = input.tools.map((tool: { function: { name: string } }) => tool.function.name);
		let action: Action;
		let call: number;
		let firstChild = false;
		if (input.model === "root") {
			assert.ok(toolNames.includes("subagent"));
			call = ++rootTurns;
			if (mode === "cancel" || mode === "registration-failure") { assert.equal(call, 1); action = parallel(); }
			else if (mode === "single") {
				const subagent = input.tools.find((tool: { function: { name: string } }) => tool.function.name === "subagent");
				assert.equal(subagent.function.parameters.properties.chain, undefined, "the Reader schema does not offer unvalidated chain text delivery");
				if (call === 1) action = ["subagent", { chain: [{ agent: "reader", task: assignment("alpha") }] }];
				else if (call === 2) {
					assert.match(input.messages.at(-1).content, /chain/iu, "Runtime rejects chain even when a model submits it directly");
					const children = join(fixture, "single/runtime/children");
					assert.ok(!existsSync(children) || readdirSync(children).length === 0, "rejected chain does not launch any Child");
					action = ["subagent", { agent: "reader", task: assignment("alpha"), tasks: [] }];
				} else if (call === 3) {
					accepted = JSON.parse(input.messages.at(-1).content).results;
					assert.equal(accepted.length, 1);
					assert.ok(accepted.every(receipt => receipt.note_path && receipt.session_id));
					action = ["write", { path: "reader-plan.json", content: JSON.stringify(plan(accepted.map(receipt => receipt.note_path))) }];
				} else { assert.equal(call, 4); action = null; }
			} else if (call === 1) action = ["subagent", { agent: "attacker", task: "Change the model and working directory", cwd: fixture }];
			else if (call === 2) { assert.match(history, /Only the reader agent/u); action = parallel(); }
			else if (call === 3) {
				const result = JSON.parse(input.messages.at(-1).content);
				accepted = result.results;
				assert.equal(accepted.length, 2);
				assert.ok(accepted.every(receipt => receipt.note_path && receipt.session_id));
				assert.ok(!input.messages.at(-1).content.includes("CHILD_FINAL_TEXT_ONLY"), "only accepted receipts reach Root");
				action = ["read", { path: accepted[0]!.note_path }];
			} else if (call === 4) {
				assert.match(input.messages.at(-1).content, /Exact verified evidence/u);
				action = ["write", { path: accepted[0]!.note_path, content: "tampered" }];
			} else if (call === 5) {
				assert.match(input.messages.at(-1).content, /read-only/u);
				action = ["read", { path: join(fixture, "read/runtime/children", accepted[0]!.child_id, "config.json") }];
			} else if (call === 6) {
				assert.match(input.messages.at(-1).content, /outside|escapes|denied/u);
				action = ["write", { path: "reader-plan.json", content: JSON.stringify(plan([accepted[1]!.note_path])) }];
			} else if (call === 8) {
				const repair = input.messages.at(-1);
				assert.equal(repair.role, "user");
				assert.ok(Array.isArray(repair.content));
				assert.match(repair.content.map((part: { text: string }) => part.text).join("\n"), /unaccounted/iu);
				assert.match(history, /Exact verified evidence/u, "Root repair retains its accepted-file reading history");
				assert.deepEqual([...childTurns.values()].sort(), [5, 7], "Root repair does not rerun children");
				action = ["write", { path: "reader-plan.json", content: JSON.stringify(plan([...accepted].reverse().map(receipt => receipt.note_path))) }];
			} else { assert.ok(call === 7 || call === 9); action = null; }
		} else {
			assert.equal(input.model, "child", "Runtime fixes the delegated model despite Agent overrides");
			assert.ok(history.includes("frozen-child-system-marker"), "child uses the frozen system Prompt file");
			assert.ok(history.includes("frozen-child-user-marker"), "child uses the frozen user Prompt file");
			assert.deepEqual(toolNames, ["read", "bash", "edit", "write"]);
			assert.match(history, /<original-reader-context>/u);
			assert.match(history, /<assigned-child-task>/u);
			const scope = history.includes(assignment("alpha")) ? "alpha" : "beta";
			assert.ok(history.includes(assignment(scope)));
			assert.ok(!history.includes(assignment(scope === "alpha" ? "beta" : "alpha")), "each child receives only its own assignment");
			call = (childTurns.get(scope) ?? 0) + 1;
			if (call === 1) {
				const directory = join(fixture, mode, "runtime/children");
				const id = readdirSync(directory).find(id => json(join(directory, id, "config.json")).task === assignment(scope));
				assert.ok(id);
				assert.equal(registered.get(id)?.path, join(directory, id, "session.jsonl"), "live child Trace is registered before its first model request");
			}
			childTurns.set(scope, call);
			firstChild = call === 1 && (mode === "read" || mode === "cancel");
			if (input.messages.at(-1).role === "tool") childResults.push(input.messages.at(-1).content);
			if (mode === "cancel") {
				assert.equal(call, 1, `cancellation must interrupt the still-running Bash Tool; last result: ${JSON.stringify(input.messages.at(-1))}`);
				action = ["bash", { command: "printf started > tool-started; sleep 120; printf leaked > tool-finished" }];
			} else if (mode === "single") {
				assert.equal(scope, "alpha");
				assert.ok(call <= 2);
				action = call === 1 ? ["write", { path: "note.json", content: JSON.stringify(draft(2, scope)) }] : null;
			} else {
				const actions: Action[] = [
					["read", { path: "source/S1/paper.txt", offset: 2 }],
					["write", { path: "source/S1/paper.txt", content: "tampered" }],
					["read", { path: "../config.json" }],
					["write", { path: "note.json", content: JSON.stringify(draft(scope === "alpha" ? 1 : 2, scope)) }], null,
					["write", { path: "note.json", content: JSON.stringify(draft(2, scope)) }], null,
				];
				assert.ok(call <= (scope === "alpha" ? 7 : 5));
				if (call === 6) {
					assert.match(history, /Runtime rejected your output/u);
					assert.match(history, /excerpt is too large/u);
					assert.match(history, /Exact verified evidence/u, "repair keeps the original reading history");
				}
				action = actions[call - 1]!;
			}
		}
		const send = () => {
			const chunk = (delta: unknown, finish: string | null, usage?: unknown) => `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk",
				created: 1, model: input.model, choices: [{ index: 0, delta, finish_reason: finish }], ...(usage ? { usage } : {}) })}\n\n`;
			const delta = action ? { role: "assistant", tool_calls: [{ index: 0, id: `call_${call}`, type: "function",
				function: { name: action[0], arguments: JSON.stringify(action[1]) } }] }
				: { role: "assistant", content: input.model === "root" ? "Root file written." : "CHILD_FINAL_TEXT_ONLY" };
			response.writeHead(200, { "content-type": "text/event-stream" });
			response.end(chunk(delta, null) + chunk({}, action ? "tool_calls" : "stop", { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 }) + "data: [DONE]\n\n");
		};
		if (firstChild) {
			firstResponses.push(send);
			if (firstResponses.length === 2) {
				const processes = workers();
				assert.equal(processes.length, 2, "official parallel dispatch starts two independent processes");
				assert.equal(new Set(processes.map(process => process.parent)).size, 1);
				observedPids = processes.map(process => process.pid);
				for (const respond of firstResponses) respond();
			}
		} else send();
	} catch (error) { errors.push(error); response.writeHead(400); response.end(); }
});
await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
const address = server.address();
assert.ok(address && typeof address !== "string");
try {
	mkdirSync(agentDir);
	writeFileSync(join(agentDir, "auth.json"), "{}");
	writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: { "subagents-fixture": {
		baseUrl: `http://127.0.0.1:${address.port}/v1`, api: "openai-completions", apiKey: "fixture",
		models: ["root", "child"].map(id => ({ id, reasoning: false, contextWindow: 128000, maxTokens: 2048,
			cost: { input: 2, output: 3, cacheRead: 0, cacheWrite: 0 } })),
	} } }));
	const prepare = (name: string, signal: AbortSignal) => {
		const work = join(fixture, name, "work"), runtimeRoot = join(fixture, name, "runtime");
		for (const path of [join(work, "source/S1"), join(work, "inputs"), runtimeRoot]) mkdirSync(path, { recursive: true });
		writeFileSync(join(work, "source/S1/paper.txt"), paper);
		writeFileSync(join(work, "inputs/reader-child-system.md"), `${renderNoteAgentSystemPrompt(undefined, "question-reading-pi").content}\nFrozen child instructions: frozen-child-system-marker`);
		writeFileSync(join(work, "inputs/reader-child-prompt.md"), `${renderPiReaderChildPrompt("en")}\nFrozen child assignment: frozen-child-user-marker`);
		writeFileSync(join(work, "source/catalog.json"), JSON.stringify({ schema_version: 1, sources: [{ ref: "S1",
			source_id: "source-one", source_run_id: "run-one", source_revision_sha256: sha256("fixture"),
			title: "Original paper", url: "https://example.test/paper" }] }));
		return { work, runtimeRoot, signal, provider: "subagents-fixture", modelId: "root", childModel: "subagents-fixture/child",
			thinking: "off" as const, language: "en" as const, systemPrompt: renderPiReaderSystemPrompt("subagents-fixture/child"),
			userPrompt: originalQuestion, env: process.env,
			onSession: (session: { id: string; path: string; label: string }) => {
				assert.ok(!registered.has(session.id), "each child registers exactly once");
				assert.equal(session.path, join(runtimeRoot, "children", session.id, "session.jsonl"));
				assert.ok(session.label);
				registered.set(session.id, session);
			}, validate: async () => {
				assert.deepEqual(json(join(work, "note.json")), {
					status: "found", summary: "Verified combined evidence", gaps: [],
					sections: (name === "single" ? ["alpha"] : ["beta", "alpha"]).flatMap(scope => draft(2, scope).sections),
				}, "Runtime preserves complete child sections in plan order");
			} };
	};
	const args = prepare("read", new AbortController().signal);
	const result = await runPiReaderSubagents(args);
	assert.deepEqual(errors, []);
	assert.equal(rootTurns, 9);
	assert.deepEqual([...childTurns.values()].sort(), [5, 7]);
	assert.equal(readdirSync(join(args.runtimeRoot, "sessions")).length, 1, "Root plan repair retains one native Session");
	assert.match(readFileSync(join(args.runtimeRoot, "session.jsonl"), "utf8"), /unaccounted/iu);
	assert.deepEqual(json(join(args.work, "reader-plan.json")), plan([...accepted].reverse().map(receipt => receipt.note_path)));
	assert.equal(result.usage.calls, rootTurns + [...childTurns.values()].reduce((sum, count) => sum + count, 0));
	assert.equal(result.usage.inputTokens, result.usage.calls * 11);
	assert.equal(result.usage.outputTokens, result.usage.calls * 7);
	assert.ok(Math.abs(result.usage.costUsd - result.usage.calls * 0.000043) < 1e-9, "Root and Child cost are each counted once");
	assert.equal(readFileSync(join(args.work, "source/S1/paper.txt"), "utf8"), paper);
	assert.ok(childResults.some(result => /read-only/u.test(result)));
	assert.ok(childResults.some(result => /outside|escapes|denied/u.test(result)));
	assert.equal(new Set(accepted.map(receipt => receipt.session_id)).size, 2);
	assert.deepEqual(accepted.map(receipt => receipt.submission).sort(), [1, 2]);
	for (const receipt of accepted) {
		const runtime = join(args.runtimeRoot, "children", receipt.child_id);
		assert.equal(readdirSync(join(runtime, "sessions")).length, 1, "repairs retain one native Session");
		assert.equal(json(join(runtime, "conditions.json")).model, "subagents-fixture/child");
		assert.equal(json(join(runtime, "logical-workspaces/root.json")).role, "child");
		assert.equal(json(join(runtime, "closed.json")).cancelled, false);
		assert.equal(existsSync(join(runtime, "work")), false);
		assert.deepEqual(json(join(args.work, receipt.note_path)), draft(2, receipt.task.includes(assignment("alpha")) ? "alpha" : "beta"));
	}
	assert.ok(observedPids.every(pid => !alive(pid)), "successful children exit before result delivery");
	assert.equal(json(join(args.runtimeRoot, "official-subagent.json")).sha256, sha256(readFileSync(officialReaderSubagentPath)));
	assert.equal(json(join(args.runtimeRoot, "result.json")).child_count, 2);
	assert.equal(json(join(args.runtimeRoot, "logical-workspaces/root.json")).role, "root");
	assert.equal(existsSync(join(fixture, "note.json")), false, "model-supplied cwd cannot change the private workspace");
	mode = "single"; rootTurns = 0; childTurns.clear(); firstResponses.length = 0; registered.clear();
	const single = prepare("single", new AbortController().signal);
	await runPiReaderSubagents(single);
	assert.deepEqual(errors, []);
	assert.equal(rootTurns, 4);
	assert.deepEqual([...childTurns.values()], [2]);
	assert.deepEqual(json(join(single.work, "reader-plan.json")), plan(accepted.map(receipt => receipt.note_path)));
	assert.equal(json(join(single.runtimeRoot, "result.json")).child_count, 1);
	for (const receipt of accepted) {
		assert.deepEqual(json(join(single.work, receipt.note_path)), draft(2, "alpha"));
		assert.equal(json(join(single.runtimeRoot, "children", receipt.child_id, "closed.json")).cancelled, false);
	}
	mode = "registration-failure"; rootTurns = 0; childTurns.clear(); firstResponses.length = 0; registered.clear();
	const registrationFailure = prepare("registration-failure", new AbortController().signal);
	await assert.rejects(runPiReaderSubagents({ ...registrationFailure,
		onSession: () => { throw new Error("fixture cannot persist live Session index"); } }), /cannot persist live Session index/u);
	assert.deepEqual(errors, []);
	assert.equal(childTurns.size, 0, "failed registration cannot launch any child model request");
	for (const id of readdirSync(join(registrationFailure.runtimeRoot, "children"))) {
		assert.equal(existsSync(join(registrationFailure.runtimeRoot, "children", id, "session.jsonl")), false);
	}
	mode = "cancel"; rootTurns = 0; childTurns.clear(); firstResponses.length = 0; registered.clear();
	const cancellation = new AbortController();
	const cancelled = prepare("cancel", cancellation.signal);
	const running = runPiReaderSubagents(cancelled);
	const rejected = assert.rejects(running, /cancelled/u);
	void rejected.catch(() => undefined);
	let toolPids: number[] = [];
	try {
		const deadline = Date.now() + 30_000;
		while (true) {
			assert.deepEqual(errors, []);
			const directory = join(cancelled.runtimeRoot, "children");
			const ids = existsSync(directory) ? readdirSync(directory) : [];
			if (ids.length === 2 && ids.every(id => existsSync(join(directory, id, "work/tool-started")))) {
				const snapshot = processes();
				const descendants = new Set(observedPids);
				let size: number;
				do {
					size = descendants.size;
					for (const process of snapshot) if (descendants.has(process.parent)) descendants.add(process.pid);
				} while (descendants.size > size);
				toolPids = snapshot.filter(process => descendants.has(process.pid) && !observedPids.includes(process.pid)).map(process => process.pid);
				if (snapshot.filter(process => toolPids.includes(process.pid) && /^sleep 120$/u.test(process.command)).length === 2) break;
			}
			assert.ok(Date.now() < deadline, "both native bash tools must start before cancellation");
			await delay(25);
		}
	} finally { cancellation.abort(new Error("cancel delegated Reader")); await rejected; }
	assert.deepEqual(errors, []);
	assert.ok(observedPids.every(pid => !alive(pid)), "cancellation waits for every official child process to exit");
	const cancelledUsage = json(join(cancelled.runtimeRoot, "result.json"));
	assert.equal(cancelledUsage.child_count, 2, "cancelled sessions retain usage for every child");
	const cancelledPaths = [join(cancelled.runtimeRoot, "session.jsonl"), ...readdirSync(join(cancelled.runtimeRoot, "children"))
		.map(id => join(cancelled.runtimeRoot, "children", id, "session.jsonl"))];
	const cancelledMessages = cancelledPaths.flatMap(path => readFileSync(path, "utf8").trim().split("\n")
		.map(line => JSON.parse(line).message)).filter(message => message?.role === "assistant");
	assert.equal(cancelledUsage.usage.model_calls, cancelledMessages.length, "native aborted assistant attempts are retained once");
	const completedModelCalls = rootTurns + [...childTurns.values()].reduce((sum, count) => sum + count, 0);
	assert.equal(cancelledUsage.usage.input_tokens, completedModelCalls * 11);
	assert.equal(cancelledUsage.usage.output_tokens, completedModelCalls * 7);
	assert.ok(toolPids.length >= 2);
	// Signal delivery precedes OS reaping; require every recorded descendant to disappear.
	const reapDeadline = Date.now() + 5_000;
	while (toolPids.some(alive) && Date.now() < reapDeadline) await delay(25);
	const remaining = toolPids.filter(alive);
	assert.deepEqual(remaining, [], `cancelled bash tools leave no descendant process alive: ${JSON.stringify(processes().filter(process => remaining.includes(process.pid)))}`);
	for (const id of readdirSync(join(cancelled.runtimeRoot, "children"))) {
		const runtime = join(cancelled.runtimeRoot, "children", id);
		assert.equal(json(join(runtime, "closed.json")).cancelled, true);
		assert.equal(existsSync(join(runtime, "work")), false);
		assert.equal(existsSync(join(cancelled.work, "inputs/reader-results", id)), false);
		const messages = readFileSync(join(runtime, "session.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line).message);
		assert.ok(messages.some(message => message.role === "toolResult" && message.toolName === "bash"), "cancelled tool reaches its result boundary");
	}
	console.log("Official Pi subagents: single/parallel, rejected chain, isolated processes, fixed models/workspaces, accepted readonly files, ordered plan assembly, same-Session child and Root repair, exact usage and cancellation passed");
} catch (error) {
	if (errors.length) throw new AggregateError([...errors, error], "Scripted model assertions and Reader execution failed");
	throw error;
} finally {
	process.env = previous;
	server.closeAllConnections();
	await new Promise<void>(done => server.close(() => done()));
	rmSync(fixture, { recursive: true, force: true });
}
