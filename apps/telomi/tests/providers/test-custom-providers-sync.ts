import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const root = mkdtempSync(join(tmpdir(), "custom-providers-sync-"));
process.env.PI_CODING_AGENT_DIR = root;
mkdirSync(root, { recursive: true });

test("sync reclassifies stored models and appends what new listings expose", async () => {
	// A catalog that now serves a speech listing; the stored entry predates classification.
	const upstream = createServer((req, res) => {
		const body = req.url === "/v1/models" ? { data: [{ id: "chat-1", name: "Chat One" }, { id: "bge-m3" }] }
			: req.url === "/v1/models?output_modalities=speech" ? { data: [{ id: "voice-1", architecture: { output_modalities: ["speech"] }, supported_voices: ["eve"] }] }
			: undefined;
		if (!body) { res.statusCode = 404; res.end("{}"); return; }
		res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(body));
	});
	await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
	const baseUrl = `http://127.0.0.1:${(upstream.address() as { port: number }).port}/v1`;
	// pi merges an entry without its own model list into the built-in Provider of the same id.
	const builtinAdjustment = { baseUrl: `${baseUrl}/adjusted` };
	// A hand-written connection without a model list yet is still discovered.
	writeFileSync(join(root, "models.json"), JSON.stringify({ providers: { gateway: { api: "openai-completions", baseUrl, models: [{ id: "chat-1" }, { id: "bge-m3" }, { id: "hand-added" }] }, anthropic: builtinAdjustment, bare: { api: "openai-completions", baseUrl }, picked: { api: "openai-completions", baseUrl, userSelectedModels: true, models: [{ id: "bge-m3" }] } } }));
	writeFileSync(join(root, "auth.json"), "{}");
	const { startCustomProvidersSync } = await import("../../server/providers/sync.js");
	const events: string[] = [];
	const sync = startCustomProvidersSync({ initialDelayMs: 24 * 60 * 60 * 1000, intervalMs: 24 * 60 * 60 * 1000, onEvent: (event) => events.push(event.kind === "provider-synced" ? `synced:${event.added.join(",")}:${event.total}` : event.kind === "provider-skipped" ? `skipped:${event.provider}` : event.kind) });
	try {
		await sync.runNow();
		const file = JSON.parse(readFileSync(join(root, "models.json"), "utf-8"));
		assert.deepEqual(file.providers.anthropic, builtinAdjustment, "an adjustment of a built-in Provider is neither discovered into nor dropped");
		assert.ok(events.includes("skipped:anthropic"), events.join(" "));
		assert.deepEqual(file.providers.bare.models.map((model: { id: string }) => model.id), ["chat-1", "bge-m3", "voice-1"]);
		const stored = file.providers.gateway.models;
		assert.deepEqual(stored, [
			{ id: "chat-1", name: "Chat One", capabilities: ["chat"] },
			{ id: "bge-m3", capabilities: ["embedding"] },
			{ id: "hand-added" },
			{ id: "voice-1", capabilities: ["tts"], supportedVoices: ["eve"] },
		], "known ids take the listing's classification in place; hand-added ids stay; new listings append");
		assert.ok(events.includes("synced:voice-1:4"), events.join(" "));
		assert.deepEqual(file.providers.picked.models, [{ id: "bge-m3", capabilities: ["embedding"] }], "a ticked selection is refreshed in place and never grows");
		assert.ok(events.includes("tick-end"));
	} finally {
		sync.stop();
		await new Promise<void>((resolve) => upstream.close(() => resolve()));
		rmSync(root, { recursive: true, force: true });
	}
});

test("an entry that only adjusts a built-in Provider stays on disk without becoming a connection", async () => {
	mkdirSync(root, { recursive: true });
	const adjustment = { baseUrl: "https://adjusted.invalid" };
	const local = { api: "openai-completions", baseUrl: "http://127.0.0.1:9/v1", models: [{ id: "chat-1" }] };
	const bare = { api: "openai-completions", baseUrl: "http://127.0.0.1:9/v1" };
	writeFileSync(join(root, "models.json"), JSON.stringify({ providers: { anthropic: adjustment, local, removable: local, bare } }));
	writeFileSync(join(root, "auth.json"), "{}");
	const { default: express } = await import("express");
	const { loadCustomProviders, writeCustomProvider } = await import("../../server/providers/custom-models.js");
	const { listConnections } = await import("../../server/providers/connections-api.js");
	const { mountCustomProvidersApi } = await import("../../server/providers/api.js");
	const app = express(); app.use(express.json()); mountCustomProvidersApi(app);
	const server = app.listen(0, "127.0.0.1");
	await new Promise<void>((resolve) => server.once("listening", resolve));
	try {
		const stored = () => JSON.parse(readFileSync(join(root, "models.json"), "utf-8")).providers;
		const loaded = loadCustomProviders().providers ?? {};
		assert.deepEqual(Object.keys(loaded), ["local", "removable", "bare"]);
		assert.deepEqual(loaded.bare?.models, [], "a connection not yet discovered reads as having no models");
		const connections = await listConnections();
		const kinds = connections.connections.filter((item) => ["anthropic", "local", "bare"].includes(item.id)).map((item) => `${item.id}:${item.kind}`);
		assert.ok(kinds.includes("local:custom") && kinds.includes("bare:custom") && !kinds.includes("anthropic:custom"), `the adjustment is not listed as a custom connection: ${kinds.join(" ")}`);
		writeCustomProvider("local", { ...local, models: [{ id: "chat-2" }] } as never);
		const { port } = server.address() as { port: number };
		const listed = await (await fetch(`http://127.0.0.1:${port}/api/custom-providers`)).json() as { providers: Array<{ id: string }> };
		assert.deepEqual(listed.providers.map((provider) => provider.id), ["bare", "local", "removable"]);
		assert.equal((await fetch(`http://127.0.0.1:${port}/api/custom-providers/removable`, { method: "DELETE" })).status, 200);
		assert.equal((await fetch(`http://127.0.0.1:${port}/api/custom-providers/anthropic`, { method: "DELETE" })).status, 200);
		assert.deepEqual(stored(), { anthropic: adjustment, local: { ...local, models: [{ id: "chat-2" }] }, bare }, "writes and deletes keep the adjustment");
	} finally {
		await new Promise<void>((resolve) => server.close(() => resolve()));
		rmSync(root, { recursive: true, force: true });
	}
});
