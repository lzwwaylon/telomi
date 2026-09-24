/** Deterministic API-to-Main-Agent integration with local model and memory transports. */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import type { GoalSnapshot } from "../../shared/types.js";

const root = mkdtempSync(join(tmpdir(), "telomi-connection-serving-"));
const agentDir = join(root, ".pi", "agent");
const workspaceDir = join(root, "workspace");
mkdirSync(agentDir, { recursive: true });
mkdirSync(workspaceDir, { recursive: true });
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.TELOMI_DATA_DIR = root;
process.env.HINDSIGHT_BANK_ID = "connection-serving-test";

interface ReceivedRequest { endpoint: string; authorization: string | undefined }
const received: ReceivedRequest[] = [];
async function startEndpoint(name: string): Promise<{ server: Server; baseUrl: string }> {
	const server = createServer((request, response) => {
		received.push({ endpoint: name, authorization: request.headers.authorization });
		request.resume();
		request.on("end", () => {
			const chunk = (delta: unknown, finish: string | null) => `data: ${JSON.stringify({
				id: "serve", object: "chat.completion.chunk", created: 1, model: "local-1",
				choices: [{ index: 0, delta, finish_reason: finish }],
			})}\n\n`;
			response.writeHead(200, { "content-type": "text/event-stream" });
			response.write(chunk({ role: "assistant", content: name }, null));
			response.write(chunk({}, "stop"));
			response.end("data: [DONE]\n\n");
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	return { server, baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1` };
}
const original = await startEndpoint("original");
const replacement = await startEndpoint("replacement");

// Memory is another system boundary. No product memory service or real model is contacted.
const memory = createServer((request, response) => {
	request.resume();
	response.writeHead(200, { "content-type": "application/json" });
	response.end(JSON.stringify({
		schema_version: 1, unavailable_urls: [],
		status: request.url?.startsWith("/health") ? "healthy" : "completed",
		success: true, results: [], items: [], entities: [], data: [],
		operation_id: "test-operation", document_id: "test-document",
	}));
});
await new Promise<void>((resolve) => memory.listen(0, "127.0.0.1", resolve));
process.env.HINDSIGHT_URL = `http://127.0.0.1:${(memory.address() as AddressInfo).port}/v1/default`;
process.env.TELOMI_RESEARCH_SOURCE_BASE_URL = `http://127.0.0.1:${(memory.address() as AddressInfo).port}`;

const { GoalRunner } = await import("../../server/main-agent/runner.js");
const { GoalService } = await import("../../server/goals/service.js");
const { mountCustomProvidersApi } = await import("../../server/providers/api.js");
const { mountProviderConfigApi } = await import("../../server/providers/config-api.js");
const { mountAuthApi } = await import("../../server/accounts/auth-api.js");
const { writeStoredCredential } = await import("../../server/accounts/stored-credentials.js");
const { clearProviderCredentialTombstone, markProviderCredentialDeleted } =
	await import("../../server/config/credential-tombstones.js");
const runners: InstanceType<typeof GoalRunner>[] = [];
const goals = new GoalService(workspaceDir, {
	async createRunner(input) {
		const runner = new GoalRunner(
			input.workspaceDir, input.goal.id, input.goal.title, input.goalDir, input.onSnapshot,
			input.goal.description, input.getExtraEnv, undefined, undefined, () => false, () => "en",
		);
		runners.push(runner);
		await runner.init();
		await runner.bindExtensions();
		return runner;
	},
	async resumeWikiUpdate() { throw new Error("unexpected Wiki execution"); },
	async executeResearchRun() { throw new Error("unexpected Research execution"); },
	async resumeResearchRun() { throw new Error("unexpected Research resume"); },
});
const app = express();
app.use(express.json());
mountCustomProvidersApi(app);
mountAuthApi(app);
mountProviderConfigApi(app, { mainAgent: goals });
const server = app.listen(0, "127.0.0.1");
await new Promise<void>((resolve) => server.once("listening", resolve));
const apiUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const goalId = "goal_connection_serving";

async function activate(baseUrl: string, apiKey?: string): Promise<void> {
	const response = await fetch(apiUrl + "/api/custom-providers/anthropic", {
		method: "PUT", headers: { "content-type": "application/json" },
		body: JSON.stringify({ baseUrl, apiKey, api: "openai-completions", models: [{ id: "local-1", name: "Local One" }] }),
	});
	assert.equal(response.status, 200, await response.text());
}

async function serveTurn(): Promise<GoalSnapshot> {
	const goal = goals.getGoal(goalId);
	assert.ok(goal);
	const runner = await goals.getRunner(goal);
	let armed = false;
	let finish!: (snapshot: GoalSnapshot) => void;
	const settled = new Promise<GoalSnapshot>((resolve) => { finish = resolve; });
	const unsubscribe = runner.subscribe((event) => {
		if (armed && event.type === "snapshot" && !event.state.isStreaming) finish(event.state);
	});
	try {
		assert.equal((await goals.startRun(goalId, "ping")).queued, false);
		armed = true;
		if (!runner.isRunning()) finish(runner.getSnapshot());
		return await settled;
	} finally {
		unsubscribe();
	}
}

try {
	await activate(original.baseUrl);
	const defaults = await fetch(apiUrl + "/api/provider-config/apply", {
		method: "POST", headers: { "content-type": "application/json" },
		body: JSON.stringify({ defaultProvider: "anthropic", defaultModel: "local-1", defaultThinkingLevel: "off" }),
	});
	assert.equal(defaults.status, 200, await defaults.text());
	goals.ensureImportedGoal(goalId, "Existing Goal");

	const first = await serveTurn();
	assert.equal(first.errorMessage, undefined);
	assert.equal(runners[0].getPreview(), "original");
	assert.deepEqual(received.at(-1), { endpoint: "original", authorization: "Bearer unused" });

	// A Goal lifecycle event goes straight into the Pi session: once, persisted, and never shown in chat.
	const lifecycleEvent = "[EVENT:TEST]\nrecorded through the Goal session";
	assert.equal(await goals.recordGoalEvent(goalId, lifecycleEvent), true);
	assert.equal(await goals.recordGoalEvent(goalId, lifecycleEvent), false, "an event already in the session is not recorded twice");
	assert.match(readFileSync(join(workspaceDir, goalId, "context.jsonl"), "utf-8"), /\[EVENT:TEST\]/u, "the event is part of the session on disk");
	assert.ok(!JSON.stringify(runners[0].getSnapshot().messages).includes("[EVENT:TEST]"), "lifecycle events stay out of chat");

	// The same Goal automatically adopts a same-id connection edit at its next turn.
	await activate(replacement.baseUrl);
	const second = await serveTurn();
	assert.equal(second.errorMessage, undefined);
	assert.equal(runners.length, 1, "the existing Goal keeps its Runner");
	assert.equal(runners[0].getPreview(), "replacement");
	assert.deepEqual(received.at(-1), { endpoint: "replacement", authorization: "Bearer unused" });

	const requestsBeforeDeletion = received.length;
	markProviderCredentialDeleted("anthropic", {});
	const deletedDefault = await fetch(apiUrl + "/api/provider-config/apply", {
		method: "POST", headers: { "content-type": "application/json" },
		body: JSON.stringify({ defaultProvider: "anthropic", defaultModel: "local-1" }),
	});
	assert.equal(deletedDefault.status, 422, "a custom definition cannot bypass deleted-credential validation");
	const afterDeletion = await serveTurn();
	assert.ok(afterDeletion.errorMessage);
	assert.equal(received.length, requestsBeforeDeletion, "a deleted credential cannot send another model request");
	clearProviderCredentialTombstone("anthropic");
	assert.equal((await serveTurn()).errorMessage, undefined);
	assert.equal(runners[0].getPreview(), "replacement");

	// Legacy model definitions and the native credential store may both carry a key. Apply must
	// validate the key that the next real request uses, and keyless edits preserve that authority.
	writeStoredCredential(join(agentDir, "auth.json"), "anthropic", { type: "api_key", key: "old-stored-key" });
	await activate(replacement.baseUrl, "replacement-connection-key");
	assert.equal(received.at(-1)?.authorization, "Bearer replacement-connection-key");
	assert.equal((await serveTurn()).errorMessage, undefined);
	assert.equal(received.at(-1)?.authorization, "Bearer replacement-connection-key");
	await activate(original.baseUrl);
	assert.equal(received.at(-1)?.authorization, "Bearer replacement-connection-key");
	assert.equal((await serveTurn()).errorMessage, undefined);
	assert.deepEqual(received.at(-1), { endpoint: "original", authorization: "Bearer replacement-connection-key" });
	await goals.updateGoalConfig(goalId, { modelId: "anthropic/local-1" });
	assert.equal((await fetch(apiUrl + "/api/auth/anthropic", { method: "DELETE" })).status, 200);
	const requestsBeforeKeyDeletion = received.length;
	assert.ok((await serveTurn()).errorMessage);
	assert.equal(received.length, requestsBeforeKeyDeletion, "deleting the active key cannot turn its connection anonymous");
	console.log("Connection API to existing Main Agent serving path passed");
} finally {
	for (const runner of runners) runner.dispose();
	await Promise.all([server, original.server, replacement.server, memory].map((endpoint) =>
		new Promise<void>((resolve) => endpoint.close(() => resolve()))));
	rmSync(root, { recursive: true, force: true });
}
