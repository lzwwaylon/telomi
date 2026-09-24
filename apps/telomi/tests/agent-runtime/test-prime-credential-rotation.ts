/** Configuration APIs through the native Prime SDK, with a controlled local upstream only. */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import * as prime from "prime-agent";


const root = mkdtempSync(join(tmpdir(), "telomi-prime-credentials-"));
const canonical = join(root, "canonical");
mkdirSync(canonical);
process.env.PI_CODING_AGENT_DIR = canonical;
const {
	PRIME_CREDENTIAL_SOURCE_ENV, PRIME_MODEL_DEFINITIONS_ENV,
	createPrimeModelRegistry, createPrimeSettingsManager, stagePrimeAgentDirectory,
} = await import("../../server/agent-runtime/prime-agent-paths.js");
const { freezeModelDefinitions } = await import("../../server/agent-runtime/model-policy.js");
const savedAmbient = process.env.DEEPSEEK_API_KEY;
const headersSeen: unknown[] = [];
const seen: Array<{ path: string; key: string; model: string }> = [];
let holdNext = false;
let releaseRequest: (() => void) | undefined;
let requestStarted: (() => void) | undefined;
const upstream = createServer((req, res) => {
	let body = "";
	req.on("data", (data) => { body += String(data); });
	req.on("end", () => {
		// Without a model chosen for the probe, Connection Apply checks the endpoint's listing instead.
		if (!body) { res.writeHead(200, { "content-type": "application/json" }).end('{"data":[{"id":"small-1"}]}'); return; }
		headersSeen.push([req.headers["x-required"], req.headers["x-model"]]);
		seen.push({ path: req.url!, key: req.headers.authorization ?? "", model: String(JSON.parse(body).model) });
		const finish = () => {
			const chunk = (delta: unknown, reason: string | null) => `data: ${JSON.stringify({
				id: "local", object: "chat.completion.chunk", created: 1, model: "small-1",
				choices: [{ index: 0, delta, finish_reason: reason }],
			})}\n\n`;
			res.writeHead(200, { "content-type": "text/event-stream" });
			res.end(chunk({ role: "assistant", content: "OK" }, null) + chunk({}, "stop") + "data: [DONE]\n\n");
		};
		if (holdNext) { holdNext = false; releaseRequest = finish; requestStarted?.(); }
		else finish();
	});
});
await new Promise<void>((done) => upstream.listen(0, "127.0.0.1", done));
const url = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
const definition = (apiKey: string, baseUrl = `${url}/old`) => ({
	apiKey, baseUrl, api: "openai-completions", models: [{ id: "small-1", name: "Small", reasoning: false }],
});
writeFileSync(join(canonical, "auth.json"), "{}");
writeFileSync(join(canonical, "models.json"), JSON.stringify({ providers: {
	anthropic: { ...definition("MODEL_LITERAL"), headers: { Host: "old.host", "x-required": "!printf sdk-header" },
		models: [{ id: "small-1", headers: { "x-model": "model-header" } }] },
	headers: { ...definition("schema-secret-key"), models: [{ id: "apiKey", headers: { "x-secret": "schema-secret-model" } }],
		modelOverrides: { apiKey: { headers: { "x-secret": "schema-secret-override" } } } },
	"telomi-custom": definition("UPPERCASE_LITERAL"),
} }));
const { mountAuthApi } = await import("../../server/accounts/auth-api.js");
const { mountCustomProvidersApi } = await import("../../server/providers/api.js");
const app = express();
app.use(express.json());
mountAuthApi(app);
mountCustomProvidersApi(app);
const server = app.listen(0, "127.0.0.1");
await new Promise<void>((done) => server.once("listening", done));
const api = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
async function call(method: string, path: string, body?: unknown) {
	const result = await fetch(`${api}${path}`, { method, headers: { "content-type": "application/json" },
		...(body === undefined ? {} : { body: JSON.stringify(body) }) });
	assert.equal(result.status, 200, await result.text());
}
const apply = (key: string) => call("PUT", "/api/auth/anthropic", { key, modelId: "small-1" });
const env = freezeModelDefinitions({ PRIME_AGENT_CODING_AGENT_DIR: canonical }, join(root, "control"));
function registry(name: string, runEnv = env) {
	const dir = stagePrimeAgentDirectory(join(root, name), runEnv);
	return { dir, ...createPrimeModelRegistry(prime, dir, { [PRIME_CREDENTIAL_SOURCE_ENV]: canonical }) };
}
const sessions: prime.AgentSession[] = [];
async function session(name: string, runEnv = env) {
	const runtime = registry(name, runEnv);
	assert.equal(runtime.modelRegistry.getError(), undefined);
	const model = runtime.modelRegistry.find("anthropic", "small-1");
	assert.ok(model);
	const settingsManager = createPrimeSettingsManager(prime.SettingsManager, root, runtime.dir);
	const loader = new prime.DefaultResourceLoader({ cwd: root, agentDir: runtime.dir, settingsManager,
		noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true });
	await loader.reload();
	const created = await prime.createAgentSession({ cwd: root, agentDir: runtime.dir, ...runtime,
		model, settingsManager, resourceLoader: loader, sessionManager: prime.SessionManager.inMemory(root),
		thinkingLevel: "off", noTools: "all", includeGoals: false, includeCompactSkill: false,
		prewarmIpythonKernel: false, telemetryDisabled: true,
	});
	sessions.push(created.session);
	return { ...runtime, session: created.session, model };
}
try {
	const first = await session("stage-one");
	await first.session.prompt("Return OK with the custom literal");
	assert.equal(seen.at(-1)?.key, "Bearer MODEL_LITERAL");
	assert.deepEqual(headersSeen.at(-1), ["sdk-header", "model-header"], "native resolution preserves required headers");
	assert.ok(first.modelRegistry.find("headers", "apiKey"), "field names remain valid provider/model IDs");
	const frozen = JSON.parse(readFileSync(env[PRIME_MODEL_DEFINITIONS_ENV]!, "utf8"));
	assert.ok(frozen.providers.headers.modelOverrides.apiKey);
	assert.doesNotMatch(JSON.stringify(frozen), /schema-secret/u);
	await apply("stored-first");
	await first.session.prompt("Return OK");
	assert.deepEqual(seen.at(-1), { path: "/old/chat/completions", key: "Bearer stored-first", model: "small-1" });
	// A request already sent keeps its credential, while the next request in this SAME session rotates.
	holdNext = true;
	const started = new Promise<void>((done) => { requestStarted = done; });
	const inflight = first.session.prompt("Return OK again");
	await started;
	assert.equal(seen.at(-1)?.key, "Bearer stored-first");
	await apply("stored-second");
	releaseRequest!();
	await inflight;
	await first.session.prompt("Return OK after rotation");
	assert.equal(seen.at(-1)?.key, "Bearer stored-second");
	// Same provider/model id, edited endpoint: a later Stage of the Run retains its old definition.
	await call("PUT", "/api/custom-providers/anthropic", definition("different-literal", `${url}/new`));
	const sentAfterApply = seen.length;
	await assert.rejects(first.session.prompt("Return OK on the old Run"), /connection.*changed/iu);
	await assert.rejects(async () => {
		const later = await session("stage-two");
		await later.session.prompt("Return OK on a later Stage of the old Run");
	}, /connection.*changed/iu);
	assert.equal(seen.length, sentAfterApply, "old Run must reject before transport");
	assert.equal(seen.some((request) => request.path.startsWith("/old/") && request.key === "Bearer different-literal"), false);
	const nextRun = await session("next-run", freezeModelDefinitions(
		{ PRIME_AGENT_CODING_AGENT_DIR: canonical }, join(root, "next-control")));
	await nextRun.session.prompt("Return OK");
	assert.deepEqual(seen.at(-1), { path: "/new/chat/completions", key: "Bearer different-literal", model: "small-1" });
	const activeDefinitions = readFileSync(join(canonical, "models.json"), "utf8");
	const changedHeaders = JSON.parse(activeDefinitions);
	changedHeaders.providers.anthropic.headers.Host = "new.host";
	writeFileSync(join(canonical, "models.json"), JSON.stringify(changedHeaders));
	const sentBeforeHeaderChange = seen.length;
	await assert.rejects(nextRun.session.prompt("Return OK after Host change"), /connection.*changed/iu);
	assert.equal(seen.length, sentBeforeHeaderChange);
	changedHeaders.providers.anthropic.headers.Host = "old.host";
	changedHeaders.providers.anthropic.authHeader = true;
	writeFileSync(join(canonical, "models.json"), JSON.stringify(changedHeaders));
	await assert.rejects(nextRun.session.prompt("Return OK after auth shape change"), /connection.*changed/iu);
	assert.equal(seen.at(-1)?.key, "Bearer different-literal");
	writeFileSync(join(canonical, "models.json"), activeDefinitions);
	// Native opaque literals, environment references, and commands retain SDK semantics.
	const custom = first.modelRegistry.find("telomi-custom", "small-1");
	assert.ok(custom, "native registry must load custom models from frozen definitions");
	assert.equal(await first.modelRegistry.getApiKeyForProvider(custom.provider), "UPPERCASE_LITERAL");
	await call("PUT", "/api/custom-providers/telomi-custom", definition("ROTATED_UPPERCASE"));
	assert.equal(await first.modelRegistry.getApiKeyForProvider(custom.provider), "ROTATED_UPPERCASE");
	process.env.telomi_lowercase_key = "env-value";
	await call("PUT", "/api/custom-providers/telomi-custom", definition("telomi_lowercase_key"));
	assert.equal(await first.modelRegistry.getApiKeyForProvider(custom.provider), "env-value");
	await call("PUT", "/api/custom-providers/telomi-custom", definition("!printf command-value"));
	assert.equal(await first.modelRegistry.getApiKeyForProvider(custom.provider), "command-value");
	await call("DELETE", "/api/custom-providers/telomi-custom");
	assert.equal(await first.modelRegistry.getApiKeyForProvider(custom.provider), undefined);
	// Native SDK persistence shares refreshed OAuth state; an unrelated edit cannot replace it.
	first.modelRegistry.registerProvider("oauth-test", { oauth: {
		name: "Local OAuth contract",
		login: async () => { throw new Error("No login in deterministic test"); },
		refreshToken: async () => ({ access: "fresh-access", refresh: "fresh-refresh", expires: Date.now() + 60_000 }),
		getApiKey: (credential) => credential.access,
	} });
	first.authStorage.set("oauth-test", { type: "oauth", access: "expired-access", refresh: "expired-refresh", expires: 1 });
	assert.equal(await first.authStorage.getApiKey("oauth-test"), "fresh-access");
	await apply("stored-third");
	await nextRun.modelRegistry.getApiKeyForProvider("anthropic");
	assert.equal(nextRun.authStorage.get("oauth-test")?.type, "oauth");
	assert.equal((nextRun.authStorage.get("oauth-test") as { refresh: string }).refresh, "fresh-refresh");
	// A connection changed during asynchronous OAuth resolution must also reject before transport.
	const beforeRefresh = readFileSync(join(canonical, "models.json"), "utf8");
	first.modelRegistry.registerProvider("oauth-test", { oauth: {
		name: "Local OAuth affinity contract",
		login: async () => { throw new Error("No login in deterministic test"); },
		refreshToken: async () => {
			const changed = JSON.parse(beforeRefresh);
			changed.providers["oauth-test"] = definition("new-connection-key", `${url}/oauth-new`);
			writeFileSync(join(canonical, "models.json"), JSON.stringify(changed));
			return { access: "new-access", refresh: "new-refresh", expires: Date.now() + 60_000 };
		},
		getApiKey: (credential) => credential.access,
	} });
	first.authStorage.set("oauth-test", { type: "oauth", access: "expired", refresh: "expired", expires: 1 });
	await assert.rejects(first.modelRegistry.getApiKeyForProvider("oauth-test"), /connection.*changed/iu);
	writeFileSync(join(canonical, "models.json"), beforeRefresh);
	// Env-only deletion changes no auth/models content. It also wins before a first lookup.
	process.env.DEEPSEEK_API_KEY = "ambient-old";
	const beforeDeletion = registry("before-delete");
	assert.equal(await first.modelRegistry.getApiKeyForProvider("deepseek"), "ambient-old");
	// Normalize fixture formatting to the API writer before asserting byte-for-byte stability.
	writeFileSync(join(canonical, "auth.json"), `${readFileSync(join(canonical, "auth.json"), "utf8").trimEnd()}\n`);
	const authBefore = readFileSync(join(canonical, "auth.json"), "utf8");
	await call("DELETE", "/api/auth/deepseek");
	process.env.DEEPSEEK_API_KEY = "child-inherited-old";
	assert.equal(readFileSync(join(canonical, "auth.json"), "utf8"), authBefore);
	assert.equal(await first.modelRegistry.getApiKeyForProvider("deepseek"), undefined);
	assert.equal(await beforeDeletion.modelRegistry.getApiKeyForProvider("deepseek"), undefined);
	await call("DELETE", "/api/auth/anthropic");
	assert.equal((await first.modelRegistry.getApiKeyAndHeaders(first.model)).ok, false);
	// Secret headers at every supported level must never enter Run artifacts.
	writeFileSync(join(canonical, "models.json"), JSON.stringify({ providers: { anthropic: {
		...definition("secret-key"), headers: { Authorization: "secret-provider-header" },
		models: [{ id: "small-1", headers: { Authorization: "secret-model-header" } }],
		modelOverrides: { "small-1": { headers: { "x-api-key": "secret-override-header" } } },
	} } }));
	const sanitized = freezeModelDefinitions({ PRIME_AGENT_CODING_AGENT_DIR: canonical }, join(root, "safe-control"));
	assert.doesNotMatch(readFileSync(sanitized[PRIME_MODEL_DEFINITIONS_ENV]!, "utf8"), /secret-/u);
	const dynamicHost = JSON.parse(readFileSync(join(canonical, "models.json"), "utf8"));
	dynamicHost.providers["dynamic-host"] = { ...definition("local-key"), headers: { Host: "!printf dynamic-host" } };
	writeFileSync(join(canonical, "models.json"), JSON.stringify(dynamicHost));
	const dynamicEnv = freezeModelDefinitions({ PRIME_AGENT_CODING_AGENT_DIR: canonical }, join(root, "dynamic-control"));
	const dynamicRegistry = registry("dynamic-worker", dynamicEnv).modelRegistry;
	await assert.rejects(dynamicRegistry.getApiKeyAndHeaders(dynamicRegistry.find("dynamic-host", "small-1")!), /Host.*literal/u);
	delete dynamicHost.providers["dynamic-host"];
	writeFileSync(join(canonical, "models.json"), JSON.stringify(dynamicHost));
	// Broken storage must fail, never masquerade as deletion or retain cached credentials.
	writeFileSync(join(canonical, "auth.json"), "broken JSON");
	await assert.rejects(first.modelRegistry.getApiKeyForProvider("openai"), /credential storage/u);
	writeFileSync(join(canonical, "auth.json"), "{}");
	assert.equal(await first.modelRegistry.getApiKeyForProvider("deepseek"), undefined);
	assert.throws(() => stagePrimeAgentDirectory(join(root, "missing-snapshot"), {
		PRIME_AGENT_CODING_AGENT_DIR: canonical, [PRIME_MODEL_DEFINITIONS_ENV]: join(root, "missing.json"),
	}), /Frozen Run model definitions are missing/u);
	console.log("native Prime credential and connection boundaries: ok");
} finally {
	for (const value of sessions) value.dispose();
	server.close(); upstream.close();
	if (savedAmbient === undefined) delete process.env.DEEPSEEK_API_KEY;
	else process.env.DEEPSEEK_API_KEY = savedAmbient;
	delete process.env.telomi_lowercase_key;
	rmSync(root, { recursive: true, force: true });
}
