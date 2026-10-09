import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { primeExecutionToken } from "../../../extensions/telomi-srt/prime-workspace.js";
import { renderAgentPrompt } from "../../server/agent-runtime/prompt-registry.js";
import { publishInvestigationHandoff } from "../../server/research/investigation-handoff.js";
import { createPiInvestigationTools, createPiInvestigationSandbox, investigationToolView } from "../../server/research/pi-investigation.js";

const root = realpathSync(mkdtempSync(join(tmpdir(), "telomi-pi-investigation-")));
const controller = new AbortController();
const calls: Array<{ path: string; authorization: string | undefined; body: Record<string, unknown> }> = [];
let corrupt = false;
const server = createServer(async (request, response) => {
	let raw = "";
	for await (const chunk of request) raw += chunk;
	const body = JSON.parse(raw) as Record<string, unknown>;
	calls.push({ path: request.url!, authorization: request.headers.authorization, body });
	const operation = request.url === "/v1/wiki" ? String(body.operation) : request.url!.slice(4).replaceAll("-", "_");
	const receipt = publishInvestigationHandoff(root, operation, { status: "found", cues: [{ ref: "N1", cue: "A verified fact", note: "Original evidence" }] });
	if (corrupt) writeFileSync(join(root, receipt.result_ref), "{}\n");
	response.setHeader("content-type", "application/json");
	response.end(JSON.stringify(receipt));
});
await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
assert.ok(address && typeof address !== "string");
const tools = createPiInvestigationTools({ cwd: root, bridge: { baseUrl: `http://127.0.0.1:${address.port}`, token: "test-secret" }, signal: controller.signal });
const call = (name: string, parameters: Record<string, unknown>, signal?: AbortSignal) => {
	const tool = tools.find(item => item.name === name)!;
	return tool.execute("call-test", parameters, signal, undefined, undefined as never);
};

try {
	const value = { status: "found", summary: "Saved evidence", gaps: [], cues: [{ ref: "N1", cue: "A fact" }] };
	const receipt = publishInvestigationHandoff(root, "read_sources", value);
	const view = investigationToolView(root, receipt, "read_sources");
	assert.equal(view.truncated, false);
	assert.deepEqual(view.result, value);
	assert.equal(view.result_ref, receipt.result_ref);
	assert.equal(view.read_path, `/work/${receipt.result_ref}`);
	const sandbox = createPiInvestigationSandbox(root);
	try {
		assert.deepEqual(sandbox.toolDefinitions.map(tool => tool.name), ["read", "write"]);
		const read = sandbox.toolDefinitions.find(tool => tool.name === "read")!;
		const write = sandbox.toolDefinitions.find(tool => tool.name === "write")!;
		const readResult = await read.execute("read-result", { path: view.read_path }, controller.signal, undefined, undefined as never);
		assert.ok(JSON.stringify(readResult.content).includes("Saved evidence"));
		await assert.rejects(write.execute("overwrite-input", { path: view.read_path, content: "changed" }, controller.signal, undefined, undefined as never));
		await write.execute("write-progress", { path: "/work/progress.json", content: "{}" }, controller.signal, undefined, undefined as never);
		assert.equal(readFileSync(join(root, "work", "progress.json"), "utf8"), "{}");
	} finally { await sandbox.close(); }

	assert.throws(() => investigationToolView(root, receipt, "external_search"), /Invalid investigation handoff/);
	assert.throws(() => investigationToolView(root, { ...receipt, result_ref: "../secret.json" }, "read_sources"), /Invalid investigation handoff/);

	const large = { status: "partial", summary: "The configuration is still unknown", gaps: ["Verify the configuration"],
		cues: Array.from({ length: 100 }, (_, index) => ({ ref: `N${index + 1}`, cue: `Fact ${index + 1}`, note: "Evidence ".repeat(1000) })) };
	const largeReceipt = publishInvestigationHandoff(root, "read_sources", large);
	const largeView = investigationToolView(root, largeReceipt, "read_sources");
	assert.equal(largeView.truncated, true);
	assert.ok(JSON.stringify(largeView).length <= 12_000);
	const projection = largeView.result as { summary: string; gaps: { items: string[] }; cues: { items: Array<{ ref: string }>; total_count: number; omitted_count: number } };
	assert.equal(projection.summary, large.summary);
	assert.deepEqual(projection.gaps.items, large.gaps);
	assert.equal(projection.cues.total_count, 100);
	assert.equal(projection.cues.omitted_count, 100 - projection.cues.items.length);
	assert.equal(projection.cues.items[0].ref, "N1");
	assert.deepEqual(JSON.parse(readFileSync(join(root, largeReceipt.result_ref), "utf8")), large);
	writeFileSync(join(root, receipt.result_ref), JSON.stringify({ ...value, summary: "Changed" }));
	assert.throws(() => investigationToolView(root, receipt, "read_sources"));

	assert.deepEqual(tools.map(tool => tool.name), ["wiki_list_topics", "wiki_search", "wiki_read_page", "knowledge_search", "read_sources", "external_search", "write_answer"]);
	const cases: Array<[string, Record<string, unknown>, string]> = [
		["wiki_list_topics", {}, "/v1/wiki"],
		["wiki_search", { query: "scheduler", topic_ref: "T1" }, "/v1/wiki"],
		["wiki_read_page", { path: "P1" }, "/v1/wiki"],
		["knowledge_search", { query: "scheduler" }, "/v1/knowledge-search"],
		["read_sources", { question: "Verify one implementation detail" }, "/v1/read-sources"],
		["external_search", { question: "Find the missing official specification" }, "/v1/external-search"],
		["write_answer", { evidence_refs: ["N1"], requirements: ["Explain the implementation"] }, "/v1/write-answer"],
	];
	for (const [name, parameters, path] of cases) {
		const result = await call(name, parameters);
		const returned = JSON.parse(result.content[0].type === "text" ? result.content[0].text : "null");
		assert.equal(returned.result.cues[0].ref, "N1");
		assert.equal(returned.truncated, false);
		assert.match(returned.result_ref, new RegExp(`^inputs/handoff/${name}-`));
		assert.equal(calls.at(-1)!.path, path);
		assert.equal(calls.at(-1)!.body.agent_session_id, "root");
		assert.equal(calls.at(-1)!.authorization, `Bearer ${primeExecutionToken("test-secret", "root")}`);
	}
	assert.equal(calls.find(item => item.path === "/v1/knowledge-search")!.body.limit, 10);
	assert.equal(calls[1].body.operation, "wiki_search");
	const legacyTools = createPiInvestigationTools({ cwd: root, bridge: { baseUrl: `http://127.0.0.1:${address.port}`, token: "test-secret" }, signal: controller.signal, allowLegacyGithubRead: true });
	const legacy = legacyTools.find(tool => tool.name === "github_read")!;
	await legacy.execute("historical-read", { question: "Check implementation", repository: "owner/repo", ref: "abc", paths: ["README.md"] }, controller.signal, undefined, undefined as never);
	assert.equal(calls.at(-1)!.path, "/v1/github-read");
	assert.equal(calls.at(-1)!.body.repository, "owner/repo");

	const beforeInvalid = calls.length;
	await assert.rejects(call("read_sources", { question: "x", agent_session_id: "sub-forged" }), /Invalid read_sources arguments/);
	await assert.rejects(call("read_sources", { question: "  " }), /Invalid read_sources arguments/);
	await assert.rejects(call("knowledge_search", { query: "x", limit: 30 }), /Invalid knowledge_search arguments/);
	await assert.rejects(call("write_answer", { evidence_refs: ["N1", "N1"], requirements: ["Check"] }), /Invalid write_answer arguments/);
	assert.equal(calls.length, beforeInvalid);
	const cancelled = AbortSignal.abort(new Error("cancel tool"));
	await assert.rejects(call("read_sources", { question: "x" }, cancelled), /cancel tool/);
	assert.equal(calls.length, beforeInvalid);
	corrupt = true;
	await assert.rejects(call("read_sources", { question: "x" }));
	controller.abort(new Error("cancel invocation"));
	await assert.rejects(call("read_sources", { question: "x" }), /cancel invocation/);

	const system = renderAgentPrompt("research", "prime-search", "system", {}, "investigate-pi");
	const prompt = renderAgentPrompt("research", "prime-search", "user", { run_input_json: '{"request_ref":"/work/inputs/request.json"}' }, "investigate-pi");
	assert.ok(system.content.trim());
	assert.ok(prompt.content.includes("/work/inputs/request.json"));
	assert.ok(!system.content.includes("read_handoff"));
	console.log("Pi investigation adapter: verified results, bounded projections, authenticated routes, validation and cancellation passed");
} finally {
	await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
	rmSync(root, { recursive: true, force: true });
}
