import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { AgentStageRequest } from "../../server/agent-runtime/agent-stage-runtime.js";
import { RunArtifactStore } from "../../server/agent-runtime/artifact-store.js";
import { findNodeEvaluationCases, readNodeEvaluationCase } from "../../server/agent-runtime/node-evaluation.js";
import { agentSessionPath, runtimeContextPath } from "../../server/observability/run-records.js";
import { manifestSessionSections } from "../../server/observability/session-traces.js";
import { getResearchSourceServiceManager } from "../../server/providers/source-service-client.js";
import { PrimeNoteAgentStageRunner } from "../../server/research/pipeline/prime-note-agent.js";
import { renderPiReaderSystemPrompt, renderNoteAgentSystemPrompt, renderPiReaderChildPrompt } from "../../server/research/pipeline/note-agent-prompt.js";
import { sha256 } from "../../server/lib/hash.js";

// The production Stage, official subprocess dispatch and SRT run against a local scripted model.
const fixture = realpathSync(mkdtempSync(join(tmpdir(), "pi-reader-stage-")));
const agentDir = join(fixture, "credentials");
const question = "Original question: find the exact saved evidence.";
const note = { status: "found", summary: "Complete saved evidence", gaps: [], sections: [{ section_title: "Saved evidence", cue_notes: [{
	cue: "The Source contains saved evidence", note: "Exact saved evidence.", evidence: [{ source_ref: "S1", source_path: "paper.txt", start_line: 1, end_line: 1 }],
}] }] };
const json = (path: string) => JSON.parse(readFileSync(path, "utf8"));
let mode: "success" | "child-failure" = "success";
let rootTurns = 0, childTurns = 0;
let records = "", trace = "";
const errors: unknown[] = [];
const server = createServer(async (request, response) => {
	try {
		let body = "";
		for await (const chunk of request) body += chunk;
		const input = JSON.parse(body);
		assert.ok(JSON.stringify(input.messages).includes(question));
		let action: readonly [string, Record<string, unknown>] | undefined;
		let call: number;
		if (input.model === "root") {
			call = ++rootTurns;
			if (call === 1) action = ["subagent", { agent: "reader", task: "Find the exact saved evidence." }];
			else if (mode === "success" && call === 2) {
				const receipt = JSON.parse(input.messages.at(-1).content).results[0];
				action = ["write", { path: "reader-plan.json", content: JSON.stringify({ status: "found", summary: note.summary,
					gaps: [], notes: [receipt.note_path], excluded: [] }) }];
			} else assert.ok(call <= (mode === "success" ? 3 : 4), "Root receives only bounded same-Session repairs");
		} else {
			assert.equal(input.model, "child");
			assert.ok(JSON.stringify(input.messages).includes("stage-frozen-child-system-marker"));
			assert.ok(JSON.stringify(input.messages).includes("stage-frozen-child-user-marker"));
			call = ++childTurns;
			if (call === 1) {
				const index = json(`${trace}.sessions.json`);
				assert.equal(index.sessions.length, 2, "Root and child are in the live index before child model execution");
				assert.ok(index.sessions.some((session: { id: string }) => session.id.startsWith("sub-")));
				assert.equal(manifestSessionSections(records, `${basename(trace)}.sessions.json`)?.length, 2,
					"the existing Trace reader resolves live Root and child files");
				action = ["read", { path: "source/S1/paper.txt" }];
			} else if (mode === "child-failure") {
				assert.equal(call, 2);
				response.writeHead(401, { "content-type": "application/json" });
				response.end('{"error":{"message":"fixture child unauthorized"}}');
				return;
			} else if (call === 2) action = ["write", { path: "note.json", content: JSON.stringify(note) }];
			else assert.equal(call, 3);
		}
		const chunk = (delta: unknown, finish: string | null, usage?: unknown) => `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk",
			created: 1, model: input.model, choices: [{ index: 0, delta, finish_reason: finish }], ...(usage ? { usage } : {}) })}\n\n`;
		const delta = action ? { role: "assistant", tool_calls: [{ index: 0, id: `call_${call}`, type: "function",
			function: { name: action[0], arguments: JSON.stringify(action[1]) } }] } : { role: "assistant", content: "Finished." };
		response.writeHead(200, { "content-type": "text/event-stream" });
		response.end(chunk(delta, null) + chunk({}, action ? "tool_calls" : "stop", { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 }) + "data: [DONE]\n\n");
	} catch (error) { errors.push(error); response.writeHead(400); response.end(); }
});
await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
const address = server.address();
assert.ok(address && typeof address !== "string");
try {
	mkdirSync(agentDir);
	writeFileSync(join(agentDir, "auth.json"), "{}");
	writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: { "stage-fixture": {
		baseUrl: `http://127.0.0.1:${address.port}/v1`, api: "openai-completions", apiKey: "fixture",
		models: ["root", "child"].map(id => ({ id, reasoning: false, contextWindow: 128000, maxTokens: 2048,
			cost: { input: 2, output: 3, cacheRead: 0, cacheWrite: 0 } })),
	} } }));
	const runner = new PrimeNoteAgentStageRunner({ async runStage(): Promise<never> { throw new Error("unexpected delegate"); } }, {
		env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, TELOMI_PRIME_AGENT_MODULE_PATH: join(fixture, "must-not-launch-prime") },
	});
	for (mode of ["success", "child-failure"] as const) {
		rootTurns = 0; childTurns = 0;
		records = join(fixture, mode, "records");
		const work = join(records, "stage"), source = join(fixture, mode, "source"), inputs = join(fixture, mode, "inputs");
		for (const path of [records, join(source, "S1"), inputs]) mkdirSync(path, { recursive: true });
		writeFileSync(join(source, "S1/paper.txt"), "Exact saved evidence.\n");
		writeFileSync(join(source, "catalog.json"), JSON.stringify({ schema_version: 1, sources: [{ ref: "S1", source_id: "source-one",
			source_run_id: "run-one", source_revision_sha256: sha256("fixture"), title: "Original paper", url: "https://example.test/paper" }] }));
		writeFileSync(join(inputs, "context.md"), question);
		writeFileSync(join(inputs, "reader-child-system.md"), `${renderNoteAgentSystemPrompt(undefined, "question-reading-pi").content}\nFrozen child instructions: stage-frozen-child-system-marker`);
		writeFileSync(join(inputs, "reader-child-prompt.md"), `${renderPiReaderChildPrompt("en")}\nFrozen child assignment: stage-frozen-child-user-marker`);
		writeFileSync(join(inputs, "reader-config.json"), JSON.stringify({ childModel: "stage-fixture/child", language: "en" }));
		trace = agentSessionPath(records, "note_agent", "reader-attempt-1");
		const request: AgentStageRequest<typeof note> = { runId: mode, stageId: "reader", attemptId: "attempt-1", role: "note_agent",
			recordKind: "research", session: { key: "reader", policy: "fresh" }, executionProfile: "pi_builtin",
			evaluation: { agentId: "note-agent", recipe: { id: "note-agent", version: 1 },
				recipeInput: { question }, inputGuestPath: "/inputs", harnessMounts: [], liveExternalState: false },
			promptConfig: { domain: "research", id: "note-agent", sandboxRole: "report.note_agent", userVariant: "question-reading", systemVariant: "question-reading-pi" },
			modelPolicy: { preferred: ["stage-fixture/root"], reasoning: "off" }, systemPrompt: renderPiReaderSystemPrompt("stage-fixture/child"),
			userPrompt: question, workDirectory: work, controlDirectory: records, recordDirectory: records,
			readonlyMounts: [{ hostPath: source, guestPath: "/source", access: "read-only" }, { hostPath: inputs, guestPath: "/inputs", access: "read-only" }],
			artifactStore: new RunArtifactStore(join(fixture, mode, "published")), signal: new AbortController().signal,
			output: { kind: "note", entryRelativePath: "note.json", publishRelativePath: "note.json", validate: ({ entryPath }) => {
				const value = json(entryPath); assert.deepEqual(value, note); return value;
			} },
		};
		if (mode === "success") {
			const unsupportedWork = join(records, "unsupported-profile-stage");
			await assert.rejects(runner.runStage({ ...request, workDirectory: unsupportedWork,
				promptConfig: { ...request.promptConfig!, systemVariant: "reader-comparison" } }), /Unsupported Pi Reader profile/u);
			assert.equal(existsSync(unsupportedWork), false, "historical experimental profiles fail before creating a workspace");
			const missingInputs = join(fixture, "missing-child-prompts");
			mkdirSync(missingInputs);
			writeFileSync(join(missingInputs, "context.md"), question);
			writeFileSync(join(missingInputs, "reader-config.json"), JSON.stringify({ childModel: "stage-fixture/child", language: "en" }));
			const missingWork = join(records, "missing-prompts-stage");
			await assert.rejects(runner.runStage({ ...request, workDirectory: missingWork,
				readonlyMounts: request.readonlyMounts.map(mount => mount.guestPath === "/inputs" ? { ...mount, hostPath: missingInputs } : mount) }), /frozen child Prompts/u);
			assert.equal(existsSync(missingWork), false, "missing frozen child Prompts cannot leave a partial Stage workspace");
			assert.equal(rootTurns + childTurns, 0, "rejected profiles never start a model");
			assert.equal(existsSync(`${trace}.sessions.json`), false, "rejected profiles do not register phantom sessions");
			const result = await runner.runStage(request);
			assert.match(result.session.id, /^pi:/u);
			assert.equal(result.toolCounts.ipython, undefined);
			assert.equal(result.usage.calls, rootTurns + childTurns);
			assert.equal(existsSync(work), false, "accepted Stage removes its transient workspace");
			assert.equal(result.evaluationCapture?.status, "captured");
			const captured = findNodeEvaluationCases(records, "note-agent");
			assert.equal(captured.length, 1);
			const value = readNodeEvaluationCase(captured[0]!.path, records);
			assert.equal(value.status, "succeeded");
			assert.equal(value.observed.traceDirectories?.length, 2, "Root and child directories remain hash-valid after cleanup");
			assert.ok(value.observed.traceDirectories!.every(directory => directory.ref.includes("-reader-runtime/")));
			const sessions = manifestSessionSections(records, `${basename(trace)}.sessions.json`)!;
			assert.equal(sessions.length, 2);
			assert.ok(sessions.every(session => session.path.includes("-reader-runtime/")));
			const retained = dirname(sessions.find(session => session.label === "Reader Root")!.path);
			const childId = json(`${trace}.sessions.json`).sessions.find((session: { id: string }) => session.id.startsWith("sub-")).id;
			const receipt = json(join(retained, "reader-results", childId, "1/receipt.json"));
			const bytes = readFileSync(join(retained, "reader-results", childId, "1/note.json"), "utf8");
			assert.equal(sha256(bytes), receipt.note_sha256);
			assert.deepEqual(JSON.parse(bytes), note);
			assert.ok(readFileSync(sessions[1]!.path, "utf8").includes(question), "retained child Trace remains readable after cleanup");
		} else {
			await assert.rejects(runner.runStage(request), /invalid after 3 attempts/u);
			const sessions = manifestSessionSections(records, `${basename(trace)}.sessions.json`)!;
			assert.equal(sessions.length, 2);
			const messages = sessions.flatMap(session => readFileSync(session.path, "utf8").trim().split("\n").map(line => JSON.parse(line).message));
			const calls = messages.filter(message => message?.role === "assistant");
			const events = readFileSync(runtimeContextPath(records, "research"), "utf8").trim().split("\n").map(line => JSON.parse(line));
			const failed = events.find(event => event.type === "node_execution" && event.status === "failed");
			assert.ok(failed);
			assert.equal(failed.output.metrics.model_calls, calls.length, "failed Stage includes all failed-child assistant attempts");
			assert.equal(failed.output.metrics.input_tokens, calls.reduce((sum, message) => sum + message.usage.input, 0));
			const toolCalls = sessions.reduce((sum, session) => {
				const path = join(dirname(session.path), "tool-events.jsonl");
				return sum + (existsSync(path) ? readFileSync(path, "utf8").trim().split("\n")
					.map(line => JSON.parse(line)).filter(event => event.type === "tool_execution_start").length : 0);
			}, 0);
			assert.ok(toolCalls > 0);
			assert.equal(failed.output.metrics.tool_calls, toolCalls, "failed Stage retains the actual Root and child tool-start count");
			assert.ok(calls.some(message => message.model === "child" && message.stopReason === "error"));
			assert.ok(existsSync(work), "failed Stage preserves its workspace for diagnostics");
			const captured = findNodeEvaluationCases(records, "note-agent");
			assert.equal(captured.length, 1);
			assert.equal(captured[0]!.value.status, "failed", "failed Stage capture remains readable with its retained workspace");
		}
		assert.deepEqual(errors, []);
	}
	console.log("Production Pi Reader Stage: routing, live/retained Trace index, immutable receipts, cleanup and failed-child usage passed");
} finally {
	await getResearchSourceServiceManager().close();
	server.closeAllConnections();
	await new Promise<void>(done => server.close(() => done()));
	rmSync(fixture, { recursive: true, force: true });
}
