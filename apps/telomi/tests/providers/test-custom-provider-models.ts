import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mock } from "node:test";
import { startCustomProvidersSync } from "../../server/providers/sync.js";

import {
	discoverCustomProviderModels,
	mergeCustomProvider,
	mergeDiscoveredModels,
} from "../../server/providers/custom-models.js";

const requests: Array<{ url: string; authorization?: string }> = [];
// One endpoint that lists like OpenRouter: the plain catalog, plus speech, transcription and embedding catalogs.
const listings: Record<string, unknown> = {
	"/v1/models": { data: [{ id: "gpt-local", name: "Local GPT" }, {}] },
	"/v1/models?output_modalities=speech": { data: [{ id: "x-ai/grok-voice-tts-1.0", architecture: { output_modalities: ["speech"] }, supported_voices: ["eve"] }, { id: "aurora-1", architecture: { output_modalities: ["speech"] } }] },
	"/v1/models?output_modalities=transcription": { data: [{ id: "deepgram/nova-3", architecture: { input_modalities: ["audio"], output_modalities: ["transcription"] } }] },
	// The Open WebUI convention: one voice listing for the endpoint, not per model.
	"/v1/audio/voices": { voices: [{ id: "vivian", name: "Vivian" }, { id: "ryan" }] },
};
const server = createServer((request, response) => {
	requests.push({
		url: request.url ?? "",
		authorization: request.headers.authorization,
	});
	const body = listings[request.url ?? ""];
	if (!body) { response.statusCode = 404; response.end("{}"); return; }
	response.setHeader("Content-Type", "application/json");
	response.end(JSON.stringify(body));
});

await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
try {
	const address = server.address();
	assert.ok(address && typeof address === "object");
	const baseUrl = `http://127.0.0.1:${address.port}/v1`;
	assert.deepEqual(
		await discoverCustomProviderModels({ baseUrl, apiKey: "secret" }),
		[
			{ id: "gpt-local", name: "Local GPT", capabilities: ["chat"] },
			{ id: "x-ai/grok-voice-tts-1.0", capabilities: ["tts"], supportedVoices: ["eve"] },
			// No regex matches this id: the declared speech modality classifies it, and the
			// endpoint's own voice listing fills the voices its model entry does not carry.
			{ id: "aurora-1", capabilities: ["tts"], supportedVoices: ["vivian", "ryan"] },
			{ id: "deepgram/nova-3", capabilities: ["stt"] },
		],
		"every listing the endpoint serves contributes; a missing catalog is skipped",
	);
	assert.deepEqual(new Set(requests.map((r) => r.url)), new Set(["/v1/models/user", "/v1/models", "/v1/models?output_modalities=speech", "/v1/models?output_modalities=transcription", "/v1/embeddings/models", "/v1/audio/voices"]), "the account-scoped listing is tried first and the plain catalog answers when it is missing");
	assert.ok(requests.every((r) => r.authorization === "Bearer secret"));
	requests.length = 0;
	listings["/v1/models/user"] = { data: [{ id: "routable-only" }] };
	assert.deepEqual(
		(await discoverCustomProviderModels({ baseUrl, apiKey: "secret" })).map((m) => m.id),
		["routable-only", "x-ai/grok-voice-tts-1.0", "aurora-1", "deepgram/nova-3"],
		"when the endpoint scopes the catalog to the key, that listing replaces the plain one",
	);
	assert.ok(!requests.some((r) => r.url === "/v1/models"), "the plain catalog is not fetched once the scoped one answers");
	requests.length = 0;
	await discoverCustomProviderModels({ baseUrl });
	assert.ok(!requests.some((r) => r.url === "/v1/models/user"), "without a key there is no account to scope to");
	assert.deepEqual(
		(await discoverCustomProviderModels({ baseUrl, apiKey: "secret", capability: "audio-recognition" })).map((m) => m.id),
		["deepgram/nova-3"],
		"a pinned connection keeps only the models its capability can use",
	);
	delete listings["/v1/models/user"];
	assert.deepEqual(
		mergeDiscoveredModels(
			[{ id: "gpt-local", capabilities: ["chat"], contextWindow: 8_192 }, { id: "hand-added" }],
			[{ id: "gpt-local", name: "Local GPT", capabilities: ["chat", "stt"] }, { id: "new-model", capabilities: ["embedding"] }],
		),
		[{ id: "gpt-local", name: "Local GPT", capabilities: ["chat", "stt"], contextWindow: 8_192 }, { id: "hand-added" }, { id: "new-model", capabilities: ["embedding"] }],
		"a rediscovered model takes the listing's classification in place; hand-added ids survive",
	);
	assert.deepEqual(
		mergeCustomProvider(
			{
				baseUrl: "http://old.example/v1",
				api: "openai-completions",
				apiKey: "kept-secret",
				headers: { "x-runtime": "external" },
				models: [{ id: "gpt-local", contextWindow: 8_192, maxTokens: 512 }],
			},
			{
				baseUrl,
				api: "openai-completions",
				models: [{ id: "gpt-local", name: "Local GPT", capabilities: ["chat"] }],
			},
		),
		{
			baseUrl,
			api: "openai-completions",
			apiKey: "kept-secret",
			headers: { "x-runtime": "external" },
			models: [{ id: "gpt-local", name: "Local GPT", capabilities: ["chat"], contextWindow: 8_192, maxTokens: 512 }],
		},
	);
} finally {
	await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

// An endpoint that publishes no catalog: discovery is empty rather than failed, so the connection
// still works with a model and voice the user types. A side listing that breaks changes nothing.
const silent = createServer((request, response) => { response.statusCode = (request.url ?? "").startsWith("/v1/models") ? 404 : 500; response.end("not found"); });
await new Promise<void>((resolve) => silent.listen(0, "127.0.0.1", resolve));
try {
	const { port } = silent.address() as { port: number };
	assert.deepEqual(await discoverCustomProviderModels({ baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: "secret" }), []);
} finally {
	await new Promise<void>((resolve, reject) => silent.close((error) => error ? reject(error) : resolve()));
}
// Some servers answer the voice listing as a bare array of names.
const bare = createServer((request, response) => {
	response.setHeader("Content-Type", "application/json");
	if (request.url === "/v1/models") { response.end(JSON.stringify({ data: [{ id: "kokoro", architecture: { output_modalities: ["speech"] } }] })); return; }
	if (request.url === "/v1/audio/voices") { response.end(JSON.stringify(["alloy", "nova"])); return; }
	response.statusCode = 404; response.end("{}");
});
await new Promise<void>((resolve) => bare.listen(0, "127.0.0.1", resolve));
try {
	const { port } = bare.address() as { port: number };
	assert.deepEqual(
		await discoverCustomProviderModels({ baseUrl: `http://127.0.0.1:${port}/v1` }),
		[{ id: "kokoro", capabilities: ["tts"], supportedVoices: ["alloy", "nova"] }],
	);
} finally {
	await new Promise<void>((resolve, reject) => bare.close((error) => error ? reject(error) : resolve()));
}

// A rejected credential and a failing catalog are not missing listings: the status reaches the user.
const guarded = createServer((request, response) => { response.statusCode = request.url === "/v1/models" ? 401 : 404; response.end("{}"); });
const broken = createServer((request, response) => { response.statusCode = request.url === "/v1/models" ? 503 : 404; response.end("{}"); });
await new Promise<void>((resolve) => guarded.listen(0, "127.0.0.1", resolve));
await new Promise<void>((resolve) => broken.listen(0, "127.0.0.1", resolve));
try {
	const { port } = guarded.address() as { port: number };
	await assert.rejects(discoverCustomProviderModels({ baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: "wrong" }), /401/);
	await assert.rejects(discoverCustomProviderModels({ baseUrl: `http://127.0.0.1:${(broken.address() as { port: number }).port}/v1` }), /503/);
} finally {
	await new Promise<void>((resolve, reject) => broken.close((error) => error ? reject(error) : resolve()));
	await new Promise<void>((resolve, reject) => guarded.close((error) => error ? reject(error) : resolve()));
}
// An address nothing answers is a wrong base URL, not a server without listings, and still fails.
await assert.rejects(discoverCustomProviderModels({ baseUrl: "http://127.0.0.1:1/v1" }));

const priorSyncEnabled = process.env.TELOMI_CUSTOM_PROVIDERS_SYNC_ENABLED;
const timer = setTimeout(() => assert.fail("the stopped sync timer must not run"), 60_000);
const scheduledDelays: Array<number | undefined> = [];
const scheduling = mock.method(globalThis, "setTimeout", (_callback, delay) => {
	scheduledDelays.push(delay);
	return timer;
});
try {
	process.env.TELOMI_CUSTOM_PROVIDERS_SYNC_ENABLED = "false";
	const sync = startCustomProvidersSync({ initialDelayMs: 123, intervalMs: 456 });
	try {
		assert.deepEqual(sync.config, { enabled: true, initialDelayMs: 123, intervalMs: 456 });
		assert.deepEqual(scheduledDelays, [123], "legacy settings must not prevent scheduling Provider model discovery");
	} finally {
		sync.stop();
	}
} finally {
	scheduling.mock.restore();
	clearTimeout(timer);
	if (priorSyncEnabled === undefined) delete process.env.TELOMI_CUSTOM_PROVIDERS_SYNC_ENABLED;
	else process.env.TELOMI_CUSTOM_PROVIDERS_SYNC_ENABLED = priorSyncEnabled;
}

console.log("custom provider model discovery tests passed");
