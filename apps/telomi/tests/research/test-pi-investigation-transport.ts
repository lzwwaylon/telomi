import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Agent, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { primeExecutionToken } from "../../../extensions/telomi-srt/prime-workspace.js";
import { createPiInvestigationTools } from "../../server/research/pi-investigation.js";
import { startPrimeSourceBridge } from "../../server/research/pipeline/prime-search-batch.js";
import { ResearchSourceRegistry } from "../../server/research/sources/registry.js";

const root = mkdtempSync(join(tmpdir(), "pi-investigation-transport-"));
const originalDispatcher = getGlobalDispatcher();
const originalEval = process.env.TELOMI_EVAL_INSTANCE;
process.env.TELOMI_EVAL_INSTANCE = "1";
const shortDispatcher = new Agent({ headersTimeout: 200, bodyTimeout: 0 });
const invoker = new AbortController();
const counts = new Map<string, number>();
let releaseDropped!: () => void;
const droppedWork = new Promise<void>(resolve => { releaseDropped = resolve; });
let markStarted!: () => void;
const startedDropped = new Promise<void>(resolve => { markStarted = resolve; });
let markCancelledStarted!: () => void, releaseCancelled!: () => void;
const cancelledStarted = new Promise<void>(resolve => { markCancelledStarted = resolve; });
const cancelledWork = new Promise<void>(resolve => { releaseCancelled = resolve; });
const bridge = await startPrimeSourceBridge(new ResearchSourceRegistry(), new Set(), {
	workspaceDirectory: root, temporalContext: { schemaVersion: 1, currentDate: "2026-10-08", timeZone: "UTC" }, signal: invoker.signal,
}, root, { runDir: root, nodeId: "transport-test", attemptId: "1" }, { investigation: {
	knowledgeSearch: async () => ({}), readSources: async () => ({}),
	externalSearch: async question => {
		counts.set(question, (counts.get(question) ?? 0) + 1);
		if (question === "slow") await delay(1_500);
		if (question === "dropped") { markStarted(); await droppedWork; }
		if (question === "cancel running") { markCancelledStarted(); await cancelledWork; }
		if (question === "rejected") throw new Error("Evidence acquisition rejected");
		return { status: "found", cues: [{ ref: "N1", cue: "Verified evidence" }] };
	},
} });
const tools = (baseUrl: string) => createPiInvestigationTools({ cwd: root, bridge: { ...bridge, baseUrl }, signal: invoker.signal });
const call = (baseUrl: string, id: string, question: string, signal?: AbortSignal) =>
	tools(baseUrl).find(tool => tool.name === "external_search")!.execute(id, { question }, signal, undefined, undefined as never);
let proxyCalls = 0;
const proxy = createServer(async (request, response) => {
	const chunks: Buffer[] = [];
	for await (const chunk of request) chunks.push(Buffer.from(chunk));
	const ordinal = ++proxyCalls;
	if (JSON.parse(Buffer.concat(chunks).toString()).question === "lost") { response.destroy(); return; }
	const upstream = httpRequest(`${bridge.baseUrl}${request.url}`, { method: "POST", headers: request.headers }, result => {
		response.writeHead(result.statusCode ?? 500, { "content-type": "application/json" });
		result.pipe(response);
	});
	upstream.on("error", () => response.destroy());
	upstream.end(Buffer.concat(chunks));
	if (ordinal === 1) { await startedDropped; response.destroy(); }
	if (ordinal === 2) releaseDropped();
});
await new Promise<void>(resolve => proxy.listen(0, "127.0.0.1", resolve));
const address = proxy.address();
assert.ok(address && typeof address !== "string");
const proxyUrl = `http://127.0.0.1:${address.port}`;
const direct = async (id: string, question: string) => {
	const response = await fetch(`${bridge.baseUrl}/v1/external-search`, {
		method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${primeExecutionToken(bridge.token, "root")}` },
		body: JSON.stringify({ agent_session_id: "root", request_id: id, question }),
	});
	return { status: response.status, value: await response.json() };
};
try {
	setGlobalDispatcher(shortDispatcher);
	await call(bridge.baseUrl, "slow-call", "slow");
	assert.equal(counts.get("slow"), 1, "Long tools outlive the model transport's shorter header deadline");
	setGlobalDispatcher(originalDispatcher);
	const result = await call(proxyUrl, "dropped-call", "dropped");
	assert.ok(JSON.stringify(result).includes("Verified evidence"));
	assert.equal(proxyCalls, 2, "A dropped connection is retried once");
	assert.equal(counts.get("dropped"), 1, "Retry joins the original backend operation rather than acquiring twice");
	const replayed = await call(bridge.baseUrl, "dropped-call", "dropped");
	assert.deepEqual(replayed, result, "Completed request returns the same immutable receipt");
	assert.equal(counts.get("dropped"), 1);
	assert.equal((await direct("dropped-call", "different question")).status, 422, "One request ID cannot refer to different work");
	assert.equal(counts.has("different question"), false);
	await assert.rejects(call(bridge.baseUrl, "rejected-call", "rejected"), /Evidence acquisition rejected/);
	assert.equal(counts.get("rejected"), 1, "Business failures do not trigger transport retries");
	const beforeLost = proxyCalls;
	await assert.rejects(call(proxyUrl, "lost-call", "lost"), /transport failed.*UND_ERR_SOCKET/u);
	assert.equal(proxyCalls - beforeLost, 2, "Connection loss has a bounded retry, not an unbounded acquisition loop");
	const cancellation = new AbortController();
	const pending = call(bridge.baseUrl, "cancel-running", "cancel running", cancellation.signal);
	await cancelledStarted;
	cancellation.abort(new Error("cancel running tool"));
	await assert.rejects(pending, /cancel running tool/);
	assert.equal(counts.get("cancel running"), 1, "In-flight cancellation is not retried");
	releaseCancelled();
	const before = proxyCalls;
	await assert.rejects(call(proxyUrl, "cancelled", "cancelled", AbortSignal.abort(new Error("cancel tool"))), /cancel tool/);
	assert.equal(proxyCalls, before, "Cancellation does not acquire or retry");
	console.log("Pi investigation: long waits, lost-response recovery, stable receipts, request identity and no retry of business errors passed");
} finally {
	releaseDropped(); releaseCancelled(); setGlobalDispatcher(originalDispatcher);
	await shortDispatcher.close();
	await new Promise<void>(resolve => proxy.close(() => resolve()));
	await bridge.close(); rmSync(root, { recursive: true, force: true });
	if (originalEval === undefined) delete process.env.TELOMI_EVAL_INSTANCE;
	else process.env.TELOMI_EVAL_INSTANCE = originalEval;
}
