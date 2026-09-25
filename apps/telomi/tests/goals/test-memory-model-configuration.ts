import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import express from "express";

const root = mkdtempSync(join(tmpdir(), "memory-config-"));
process.env.PI_CODING_AGENT_DIR = root;
mkdirSync(root, { recursive: true });
writeFileSync(join(root, "models.json"), JSON.stringify({ providers: {
	local: { api: "openai-completions", baseUrl: "http://127.0.0.1:9/v1", models: [{ id: "first" }, { id: "second" }] },
} }));
const { loadCustomProviders, saveCustomProviders } = await import("../../server/providers/custom-models.js");
const { saveSettings, loadSettings } = await import("../../server/config/settings.js");
const { mountProviderConfigApi } = await import("../../server/providers/config-api.js");
const { HindsightRuntimeManager } = await import("../../server/goals/memory/hindsight-runtime.js");

test("memory configuration validates global inheritance before publishing defaults", async () => {
	saveSettings({ defaultProvider: "local", defaultModel: "first", memoryModels: { llm: {}, retain: {}, reflect: {}, consolidation: {} } });
	const manager = new HindsightRuntimeManager({});
	const app = express();
	app.use(express.json());
	mountProviderConfigApi(app, { memory: manager, mainAgent: { describeMainAgentConfiguration: () => ({ inheritedModel: "local/first", inheritedSource: "settings", inheritedThinkingLevel: "off", pendingGoalIds: [], overrides: [] }) } });
	const server = app.listen(0, "127.0.0.1");
	await new Promise<void>((resolve) => server.once("listening", resolve));
	const address = server.address();
	assert.ok(address && typeof address === "object");
	try {
		const response = await fetch(`http://127.0.0.1:${address.port}/api/provider-config/apply`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ defaultProvider: "openai-codex", defaultModel: "gpt-5.4-mini" }) });
		assert.equal(response.status, 422);
		assert.equal(loadSettings().defaultModel, "first");
		const view = await fetch(`http://127.0.0.1:${address.port}/api/provider-config/memory`).then((r) => r.json());
		assert.equal(view.target.llm.model, "local/first");
		assert.equal(view.active, null, "a resolved target is not an active service");
	} finally {
		await manager.close();
		await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
		rmSync(root, { recursive: true, force: true });
	}
});

test("applied Memory settings reach all startup consumers and rotate credentials without restarting", async () => {
	const { EventEmitter } = await import("node:events");
	const { PassThrough } = await import("node:stream");
	const { createServer } = await import("node:http");
	const { writeStoredCredential } = await import("../../server/accounts/stored-credentials.js");
	mkdirSync(root, { recursive: true });
	const requests: Array<{ model: unknown; auth: string | undefined }> = [];
	let release: (() => void) | undefined;
	let record = false;
	let rejectConnection = false;
	const upstream = createServer(async (req, res) => {
		let text = "";
		for await (const chunk of req) text += chunk;
		if (rejectConnection) { res.writeHead(401).end(); return; }
		if (record) requests.push({ model: JSON.parse(text).model, auth: req.headers.authorization });
		if (record && requests.length === 1) await new Promise<void>((resolve) => { release = resolve; });
		res.writeHead(200, { "content-type": "text/event-stream" }).end(`data: ${JSON.stringify({ id: "local-check", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: "OK" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
	});
	upstream.listen(0, "127.0.0.1");
	await new Promise<void>((resolve) => upstream.once("listening", resolve));
	const address = upstream.address();
	assert.ok(address && typeof address === "object");
	writeFileSync(join(root, "models.json"), JSON.stringify({ providers: { local: { api: "openai-completions", baseUrl: `http://127.0.0.1:${address.port}/v1`, models: [{ id: "first" }, { id: "second" }] } } }));
	writeStoredCredential(join(root, "auth.json"), "local", { type: "api_key", key: "first-key" });
	const settings = { defaultProvider: "local", defaultModel: "first", memoryModels: { llm: {}, retain: {}, reflect: { model: "local/second" }, consolidation: {} },
		embedding: { memory: { connection: "hindsight-local", model: "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2" } } };
	saveSettings(settings);
	const executable = join(root, "hindsight-api");
	writeFileSync(executable, "");
	let alive = false;
	let currentEnv: NodeJS.ProcessEnv = {};
	let spawns = 0;
	let failNextSpawn = false;
	const children: import("../../server/goals/memory/hindsight-runtime.js").ManagedHindsightChildProcess[] = [];
	let conflictAfterSpawn = false;
	let rejectDrain = false;
	let nativeDraining = false;
	const manager = new HindsightRuntimeManager({
		env: { TELOMI_HINDSIGHT_EXECUTABLE: executable, HINDSIGHT_API_REFLECT_LLM_MODEL: "stale", HINDSIGHT_API_LLM_1_MODEL: "hidden-fallback", HINDSIGHT_API_LLM_TIMEOUT: "123", HINDSIGHT_API_DATABASE_URL: "pg0://preserved-memory" },
		fetcher: async (url) => {
			const control = String(url).includes("telomi-configuration");
			if (control) {
				if (String(url).endsWith("/drain")) { nativeDraining = true; if (rejectDrain) return new Response(JSON.stringify({ activeOperations: 1 })); }
				if (String(url).endsWith("/status") && rejectDrain) return new Response(null, { status: 503 });
				if (String(url).endsWith("/resume")) nativeDraining = false;
			}
			if (!control && alive && conflictAfterSpawn) {
				conflictAfterSpawn = false; rejectDrain = true;
				saveSettings({ ...loadSettings(), memoryModels: { ...settings.memoryModels, llm: { model: "local/first" } } });
			}
			return new Response(JSON.stringify(control ? { activeOperations: 0 } : {}), { status: alive ? 200 : 503 });
		},
		spawnProcess: (_command, _args, options) => {
			spawns++; alive = true; nativeDraining = false; currentEnv = options.env!;
			const child = new EventEmitter() as import("../../server/goals/memory/hindsight-runtime.js").ManagedHindsightChildProcess;
			children.push(child);
			child.exitCode = null; child.stdout = new PassThrough(); child.stderr = new PassThrough();
			child.kill = () => { alive = false; child.exitCode = 0; queueMicrotask(() => child.emit("exit", 0, null)); return true; };
			if (failNextSpawn) { failNextSpawn = false; queueMicrotask(() => { alive = false; child.exitCode = 1; child.emit("exit", 1, null); }); }
			return child;
		},
	});
	const app = express();
	app.use(express.json());
	mountProviderConfigApi(app, { memory: manager, mainAgent: { describeMainAgentConfiguration: () => ({ inheritedModel: "local/first", inheritedSource: "settings", inheritedThinkingLevel: "off", pendingGoalIds: [], overrides: [] }) } });
	const api = app.listen(0, "127.0.0.1");
	await new Promise<void>((resolve) => api.once("listening", resolve));
	const apiAddress = api.address();
	assert.ok(apiAddress && typeof apiAddress === "object");
	const submit = (path: string, body: unknown, method = "POST") => fetch(`http://127.0.0.1:${apiAddress.port}${path}`, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
	// A global default answers before Memory has adopted it; the service replacement runs behind the answer.
	const settled = async () => { while (["validating", "applying"].includes(manager.describeConfiguration().status)) await new Promise((resolve) => setTimeout(resolve, 5)); };
	try {
		const catalog = loadCustomProviders();
		catalog.providers!.local.capability = "audio-recognition";
		saveCustomProviders(catalog);
		assert.equal((await submit("/api/provider-config/memory/apply", settings.memoryModels)).status, 422,
			"An audio-only declaration cannot serve Memory even when its endpoint answers a chat probe");
		assert.equal(spawns, 0);
		delete catalog.providers!.local.capability;
		saveCustomProviders(catalog);
		const staged = await submit("/api/provider-config/memory/pending", settings.memoryModels, "PUT");
		assert.equal(staged.status, 200);
		assert.equal(spawns, 0, "saving for later cannot start or replace the service");
		const discarded = await fetch(`http://127.0.0.1:${apiAddress.port}/api/provider-config/memory/pending`, { method: "DELETE" });
		assert.equal(discarded.status, 200);
		assert.equal((await discarded.json()).pending, null);
		assert.equal((await submit("/api/provider-config/memory/apply", settings.memoryModels)).status, 200);
		assert.equal(currentEnv.HINDSIGHT_API_REFLECT_LLM_MODEL, "second");
		assert.equal(currentEnv.HINDSIGHT_API_RETAIN_LLM_MODEL, "first");
		assert.equal(currentEnv.HINDSIGHT_API_CONSOLIDATION_LLM_MODEL, "first");
		assert.equal(currentEnv.HINDSIGHT_API_LLM_1_MODEL, undefined);
		assert.equal(currentEnv.HINDSIGHT_API_LLM_TIMEOUT, "123", "Runtime timeout policy is retained");
		const call = () => fetch(`${currentEnv.HINDSIGHT_API_LLM_BASE_URL}/chat/completions`, { method: "POST", headers: { authorization: `Bearer ${currentEnv.HINDSIGHT_API_LLM_API_KEY}`, "content-type": "application/json" }, body: JSON.stringify({ model: "first", messages: [] }) });
		record = true;
		const first = call();
		while (!release) await new Promise((resolve) => setTimeout(resolve, 5));
		writeStoredCredential(join(root, "auth.json"), "local", { type: "api_key", key: "second-key" });
		assert.equal((await call()).status, 200);
		release();
		assert.equal((await first).status, 200);
		assert.deepEqual(requests, [{ model: "first", auth: "Bearer first-key" }, { model: "first", auth: "Bearer second-key" }]);
		assert.equal(spawns, 1, "credential rotation does not stop a persistent service");
		record = false;
		rejectConnection = true;
		const rejected = await submit("/api/provider-config/apply", { defaultProvider: "local", defaultModel: "second" });
		assert.equal(rejected.status, 200, "the default is saved at once; Memory adopts it behind the answer");
		// The answer does not wait for Memory: its adoption has started, or on a fast failure already ended.
		assert.ok(["validating", "applying", "failed"].includes((await rejected.json()).memoryConfiguration.status), "Memory adoption runs behind the answer");
		await settled();
		assert.equal(loadSettings().defaultModel, "second");
		assert.equal(manager.describeConfiguration().status, "failed");
		assert.equal(manager.describeConfiguration().active?.llm.model, "local/first");
		assert.equal(spawns, 1, "invalid credentials preserve the usable service");
		rejectConnection = false;
		assert.equal((await submit("/api/provider-config", { taskModels: { browserEvolution: "local/first" }, stageThinkingLevels: { "browserEvolution.evolution": "low" } }, "PATCH")).status, 200);
		const appliedDefaults = await submit("/api/provider-config/apply", { defaultProvider: "local", defaultModel: "second" });
		assert.equal(appliedDefaults.status, 200);
		const combined = await appliedDefaults.json();
		assert.equal(combined.consumers.find((consumer: { id: string }) => consumer.id === "browserEvolution").effectiveModel, "local/first");
		assert.equal(combined.consumers.find((consumer: { id: string }) => consumer.id === "primeRoot").effectiveModel, "local/second");
		assert.equal(loadSettings().stageThinkingLevels?.["browserEvolution.evolution"].level, "low");
		await settled();
		assert.equal(currentEnv.HINDSIGHT_API_LLM_MODEL, "second");
		assert.equal(manager.describeConfiguration().active?.llm.model, "local/second");
		assert.equal(spawns, 2);
		failNextSpawn = true;
		assert.equal((await submit("/api/provider-config/memory/apply", { ...settings.memoryModels, llm: { model: "local/first" } })).status, 422);
		assert.equal(manager.describeConfiguration().status, "failed");
		assert.equal(manager.describeConfiguration().active?.llm.model, "local/second");
		assert.equal(manager.describeConfiguration().target.llm.model, "local/first");
		assert.equal(currentEnv.HINDSIGHT_API_LLM_MODEL, "second", "failed replacement restores the prior service");
		assert.equal(currentEnv.HINDSIGHT_API_DATABASE_URL, "pg0://preserved-memory");
		assert.equal(loadSettings().memoryModels?.llm.model, undefined);
		children.at(-1)!.kill();
		await new Promise((resolve) => setImmediate(resolve));
		await manager.ensureReady();
		assert.equal(manager.describeConfiguration().active?.llm.model, "local/second", "restart reports restored serving config, not failed target");
		assert.equal((await submit("/api/provider-config/memory/apply", { ...settings.memoryModels, llm: { model: "local/first" } })).status, 200);
		const beforeGlobal = spawns;
		assert.equal((await submit("/api/provider-config/apply", { defaultProvider: "local", defaultModel: "first" })).status, 200);
		await settled();
		assert.equal(spawns, beforeGlobal, "global defaults do not replace explicit Memory overrides");
		assert.equal((await submit("/api/provider-config/memory/apply", settings.memoryModels)).status, 200);
		assert.equal(manager.describeConfiguration().active?.llm.source, "settings");
		conflictAfterSpawn = true;
		assert.equal((await submit("/api/provider-config/memory/apply", { ...settings.memoryModels, llm: { model: "local/second" } })).status, 422);
		assert.equal(manager.describeConfiguration().active?.llm.model, "local/second", "an undrainable replacement is reported as the actual service");
		assert.match(manager.describeConfiguration().error ?? "", /rollback could not drain/);
		assert.equal(loadSettings().memoryModels?.llm.model, "local/first", "concurrent saved configuration is preserved");
		rejectDrain = false;
		assert.equal(nativeDraining, true);
		assert.equal((await submit("/api/provider-config/memory/apply", { ...settings.memoryModels, llm: { model: "local/second" } })).status, 200);
		assert.equal(nativeDraining, false, "reapplying the active target resumes admission after a failed rollback drain");
		assert.equal((await submit("/api/provider-config/memory/apply", { ...settings.memoryModels, llm: { model: "local/first" } })).status, 200);
		saveSettings({ ...loadSettings(), deletedProviderCredentials: ["local"] });
		assert.equal((await call()).status, 502, "deleted credentials cannot resurrect from process environment");
		assert.ok(!JSON.stringify(manager.describeConfiguration()).includes("second-key"));
	} finally {
		release?.();
		await manager.close();
		await new Promise<void>((resolve, reject) => api.close((error) => error ? reject(error) : resolve()));
		await new Promise<void>((resolve, reject) => upstream.close((error) => error ? reject(error) : resolve()));
		rmSync(root, { recursive: true, force: true });
	}
});

test("native Hindsight boundary drains HTTP and background execution without cancelling them", async () => {
	const { execFile } = await import("node:child_process");
	const { promisify } = await import("node:util");
	const { fileURLToPath } = await import("node:url");
	const result = await promisify(execFile)(fileURLToPath(new URL("../../services/hindsight/.venv/bin/python", import.meta.url)), ["-B", fileURLToPath(new URL("./memory-boundary-check.py", import.meta.url))]);
	assert.match(result.stdout, /native HTTP and worker admission passed/);
});

test("without saved Memory settings the built-in default serves and legacy environment is ignored", async () => {
	const { readStoredCredentials, writeStoredCredential } = await import("../../server/accounts/stored-credentials.js");
	const { DEFAULT_MEMORY_MODELS } = await import("../../server/goals/memory/model-settings.js");
	mkdirSync(root, { recursive: true });
	writeFileSync(join(root, "models.json"), JSON.stringify({ providers: { shared: { api: "openai-completions", baseUrl: "http://127.0.0.1:9/v1", models: [{ id: "first" }] } } }));
	writeStoredCredential(join(root, "auth.json"), "shared", { type: "api_key", key: "shared-key" });
	saveSettings({ defaultProvider: "shared", defaultModel: "first", memory: { bankId: "keep-existing-bank" } });
	const env = {
		HINDSIGHT_API_LLM_PROVIDER: "openai", HINDSIGHT_API_LLM_MODEL: "legacy", HINDSIGHT_API_LLM_BASE_URL: "http://127.0.0.1:9/v2", HINDSIGHT_API_LLM_API_KEY: "legacy-key",
		HINDSIGHT_API_RERANKER_PROVIDER: "cohere", HINDSIGHT_API_RERANKER_COHERE_MODEL: "rank", HINDSIGHT_API_RERANKER_COHERE_API_KEY: "legacy-key",
	};
	const manager = new HindsightRuntimeManager({ env });
	try {
		const view = manager.describeConfiguration();
		assert.deepEqual(view.settings, DEFAULT_MEMORY_MODELS);
		assert.equal(view.target.llm.model, "shared/first", "roles inherit the global LLM default");
		assert.equal(loadSettings().memoryModels, undefined, "nothing is written on the environment's behalf");
		assert.deepEqual(Object.keys(readStoredCredentials(join(root, "auth.json"))), ["shared"]);
		assert.equal(loadSettings().memory?.bankId, "keep-existing-bank");
		assert.ok(!JSON.stringify(view).includes("legacy"));
	} finally {
		await manager.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("Memory forwarding rejects connection replacement and deletion during native auth", async (context) => {
	const { ModelRuntime } = await import("@earendil-works/pi-coding-agent");
	const { createServer } = await import("node:http");
	const { mountCustomProvidersApi } = await import("../../server/providers/api.js");
	const { mountAuthApi } = await import("../../server/accounts/auth-api.js");
	const { MemoryModelTransport } = await import("../../server/goals/memory/model-transport.js");
	const { resolveMemoryModels } = await import("../../server/goals/memory/model-settings.js");
	mkdirSync(root, { recursive: true });
	writeFileSync(join(root, "models.json"), "{}");
	writeFileSync(join(root, "auth.json"), "{}");
	saveSettings({ defaultProvider: "race", defaultModel: "chat", memoryModels: { llm: {}, retain: {}, reflect: {}, consolidation: {} } });
	const received: Array<{ path: string; auth?: string }> = [];
	const upstream = createServer(async (req, res) => {
		let text = "";
		for await (const chunk of req) text += chunk;
		received.push({ path: req.url!, auth: req.headers.authorization });
		// Without a model chosen for the probe, Connection Apply checks the endpoint's listing instead.
		if (!text) { res.writeHead(200, { "content-type": "application/json" }).end('{"data":[{"id":"chat"}]}'); return; }
		if (JSON.parse(text).stream) res.writeHead(200, { "content-type": "text/event-stream" }).end(`data: ${JSON.stringify({ id: "check", choices: [{ index: 0, delta: { role: "assistant", content: "OK" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
		else res.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}');
	});
	await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
	const address = upstream.address(); assert.ok(address && typeof address === "object");
	const app = express(); app.use(express.json()); mountCustomProvidersApi(app); mountAuthApi(app);
	const server = app.listen(0, "127.0.0.1");
	await new Promise<void>((resolve) => server.once("listening", resolve));
	const apiAddress = server.address(); assert.ok(apiAddress && typeof apiAddress === "object");
	const update = async (path: string, key: string) => {
		const response = await fetch(`http://127.0.0.1:${apiAddress.port}/api/custom-providers/race`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ baseUrl: `http://127.0.0.1:${address.port}/${path}`, api: "openai-completions", apiKey: key, models: [{ id: "chat", name: "Chat", reasoning: false }] }) });
		assert.equal(response.status, 200);
	};
	const transport = new MemoryModelTransport();
	let release = () => {};
	try {
		await update("old", "old-key");
		const { env } = await transport.register(resolveMemoryModels(loadSettings()));
		const forward = () => fetch(`${env.HINDSIGHT_API_LLM_BASE_URL}/chat/completions`, { method: "POST", headers: { authorization: `Bearer ${env.HINDSIGHT_API_LLM_API_KEY}`, "content-type": "application/json" }, body: '{"model":"chat","messages":[]}' });
		const nativeAuth = ModelRuntime.prototype.getAuth;
		const observed: Array<{ change: string; status: number; forwarded: number }> = [];
		let rotationUsesCurrentCredential = false;
		for (const change of ["replace", "delete", "rotate"] as const) {
			await update("old", "old-key");
			let entered!: () => void;
			const authStarted = new Promise<void>((resolve) => { entered = resolve; });
			const hold = new Promise<void>((resolve) => { release = resolve; });
			let held = false;
			const mock = context.mock.method(ModelRuntime.prototype, "getAuth", async function (this: InstanceType<typeof ModelRuntime>, ...args: Parameters<typeof nativeAuth>) {
				const captured = change === "delete" ? await nativeAuth.apply(this, args) : undefined;
				if (!held) { held = true; entered(); await hold; }
				return captured ?? nativeAuth.apply(this, args);
			});
			const pending = forward();
			await authStarted;
			if (change === "delete") {
				const response = await fetch(`http://127.0.0.1:${apiAddress.port}/api/auth/race`, { method: "DELETE" }); assert.equal(response.status, 200);
			} else await update(change === "replace" ? "new" : "old", "new-key");
			received.length = 0; // Connection Apply's probe is separate from the held Memory request.
			release();
			const response = await pending;
			mock.mock.restore();
			observed.push({ change, status: response.status, forwarded: received.length });
			if (change === "rotate") rotationUsesCurrentCredential = received.at(-1)?.auth === "Bearer new-key";
		}
		const { loadCustomProviders, writeCustomProvider } = await import("../../server/providers/custom-models.js");
		const { validateMemoryModels } = await import("../../server/goals/memory/model-settings.js");
		writeCustomProvider("race", { ...loadCustomProviders().providers!.race!, headers: { Authorization: "Bearer explicit-header" } });
		received.length = 0;
		saveSettings({ ...loadSettings(), defaultProvider: "race", defaultModel: "chat" });
		await validateMemoryModels(loadSettings(), true);
		const validatedAuth = received.at(-1)?.auth;
		assert.equal((await forward()).status, 200);
		const matchingHeaders = validatedAuth === received.at(-1)?.auth;
		const explicitHeaderMatched = validatedAuth === "Bearer explicit-header";
		const omitAuth = context.mock.method(ModelRuntime.prototype, "getAuth", async function (this: InstanceType<typeof ModelRuntime>, ...args: Parameters<typeof nativeAuth>) {
			const value = await nativeAuth.apply(this, args);
			return value ? { ...value, auth: { ...value.auth, headers: { ...value.auth.headers, authorization: null } } } : value;
		});
		received.length = 0;
		await validateMemoryModels(loadSettings(), true);
		assert.equal((await forward()).status, 200);
		const omittedAuthMatched = received.length === 2 && received.every((request) => request.auth === undefined);
		omitAuth.mock.restore();
		assert.deepEqual({ observed, matchingHeaders, rotationUsesCurrentCredential, explicitHeaderMatched, omittedAuthMatched }, { observed: [{ change: "replace", status: 502, forwarded: 0 }, { change: "delete", status: 502, forwarded: 0 }, { change: "rotate", status: 200, forwarded: 1 }], matchingHeaders: true, rotationUsesCurrentCredential: true, explicitHeaderMatched: true, omittedAuthMatched: true });
	} finally {
		release(); context.mock.restoreAll(); await transport.close();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await new Promise<void>((resolve) => upstream.close(() => resolve()));
		rmSync(root, { recursive: true, force: true });
	}
});

test("Memory forwards Anthropic Messages and OpenAI Responses clients with managed credentials", async () => {
	const { createServer } = await import("node:http");
	const { writeStoredCredential } = await import("../../server/accounts/stored-credentials.js");
	const { MemoryModelTransport } = await import("../../server/goals/memory/model-transport.js");
	const { memoryConnection, resolveMemoryModels } = await import("../../server/goals/memory/model-settings.js");
	const received: Array<{ path: string; model: unknown; key: unknown; auth: unknown; version: unknown }> = [];
	const upstream = createServer(async (req, res) => {
		let text = "";
		for await (const chunk of req) text += chunk;
		received.push({ path: req.url!, model: JSON.parse(text).model, key: req.headers["x-api-key"], auth: req.headers.authorization, version: req.headers["anthropic-version"] });
		res.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}');
	});
	await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
	const address = upstream.address(); assert.ok(address && typeof address === "object");
	const base = `http://127.0.0.1:${address.port}`;
	mkdirSync(root, { recursive: true });
	writeFileSync(join(root, "models.json"), JSON.stringify({ providers: {
		claude: { api: "anthropic-messages", baseUrl: base, models: [{ id: "claude-native" }] },
		resp: { api: "openai-responses", baseUrl: `${base}/v1`, models: [{ id: "resp-native" }] },
		gem: { api: "google-generative-ai", baseUrl: base, models: [{ id: "gem-native" }] },
		sub: { api: "anthropic-messages", baseUrl: base, models: [{ id: "claude-sub" }] },
	} }));
	for (const [id, key] of [["claude", "claude-key"], ["resp", "resp-key"], ["gem", "gem-key"], ["sub", "sk-ant-oat01-subscription"]]) {
		writeStoredCredential(join(root, "auth.json"), id, { type: "api_key", key });
	}
	saveSettings({ defaultProvider: "claude", defaultModel: "claude-native", memoryModels: { llm: {}, retain: { model: "resp/resp-native" }, reflect: {}, consolidation: {} } });
	const transport = new MemoryModelTransport();
	try {
		const { env } = await transport.register(resolveMemoryModels(loadSettings()));
		assert.equal(env.HINDSIGHT_API_LLM_PROVIDER, "anthropic");
		assert.equal(env.HINDSIGHT_API_RETAIN_LLM_PROVIDER, "openai-responses");
		const post = (url: string, headers: Record<string, string>) => fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: '{"model":"client-name"}' });
		const statuses = [
			(await post(`${env.HINDSIGHT_API_LLM_BASE_URL}/v1/messages`, { "x-api-key": env.HINDSIGHT_API_LLM_API_KEY!, "anthropic-version": "2023-06-01" })).status,
			(await post(`${env.HINDSIGHT_API_RETAIN_LLM_BASE_URL}/responses`, { authorization: `Bearer ${env.HINDSIGHT_API_RETAIN_LLM_API_KEY}` })).status,
			(await post(`${env.HINDSIGHT_API_LLM_BASE_URL}/chat/completions`, { authorization: `Bearer ${env.HINDSIGHT_API_LLM_API_KEY}` })).status,
			(await post(`${env.HINDSIGHT_API_LLM_BASE_URL}/v1/messages`, { "x-api-key": "wrong" })).status,
		];
		assert.deepEqual(statuses, [200, 200, 409, 401], "a path that does not match the model's API is not forwarded");
		assert.deepEqual(received, [
			{ path: "/v1/messages", model: "claude-native", key: "claude-key", auth: undefined, version: "2023-06-01" },
			{ path: "/v1/responses", model: "resp-native", key: undefined, auth: "Bearer resp-key", version: undefined },
		]);
		await assert.rejects(memoryConnection("gem/gem-native"), /'google-generative-ai' is unsupported/);
		await assert.rejects(memoryConnection("sub/claude-sub"), /subscription login/);
		await assert.rejects(memoryConnection("claude/claude-native", ["openai-completions"]), /'anthropic-messages' is unsupported/, "a restricted API list rejects other clients");
	} finally {
		await transport.close();
		await new Promise<void>((resolve) => upstream.close(() => resolve()));
		rmSync(root, { recursive: true, force: true });
	}
});

test("the memory tool reports a restarting service instead of failing the turn", async () => {
	const { isMemoryUnavailable, MEMORY_UNAVAILABLE_TEXT } = await import("pi-user-memory");
	assert.equal(isMemoryUnavailable(new Error('Hindsight /banks/x/recall failed: HTTP 503 {"error":"User Memory configuration is applying; retry shortly"}')), true);
	assert.equal(isMemoryUnavailable(new TypeError("fetch failed")), true);
	assert.equal(isMemoryUnavailable(new Error('Hindsight /banks/x/memories/list failed: HTTP 500 {"detail":"[Errno 61] Connection refused"}')), true);
	assert.equal(isMemoryUnavailable(new Error("Hindsight /banks/x/recall failed: HTTP 500 boom")), false);
	assert.match(MEMORY_UNAVAILABLE_TEXT, /temporarily unavailable/);
});

test("a reranker selection saved by an earlier version is dropped and no reranker environment is published", async () => {
	const { parseMemoryModels, resolveMemoryModels } = await import("../../server/goals/memory/model-settings.js");
	const { MemoryModelTransport } = await import("../../server/goals/memory/model-transport.js");
	const roles = { llm: {}, retain: {}, reflect: {}, consolidation: {} };
	assert.deepEqual(parseMemoryModels({ ...roles, reranker: { provider: "flashrank", model: "ms-marco-MiniLM-L-12-v2" } }), roles);
	const transport = new MemoryModelTransport();
	try {
		const { env } = await transport.register(resolveMemoryModels({ defaultProvider: "local", defaultModel: "first", memoryModels: roles }));
		assert.ok(!Object.keys(env).some((key) => key.includes("RERANKER")), "Hindsight keeps its own reranker default");
	} finally {
		await transport.close();
	}
});
