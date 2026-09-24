import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

const root = mkdtempSync(join(tmpdir(), "builtin-connections-"));
process.env.PI_CODING_AGENT_DIR = root;
delete process.env.OPENROUTER_API_KEY;
delete process.env.OPENAI_API_KEY;
// What pi's OpenRouter OAuth login stores: the permanent API key it exchanged the code for, as `access`.
const OAUTH_KEY = "sk-or-v1-oauth-issued";
const writeAuth = (auth: Record<string, unknown>) => writeFileSync(join(root, "auth.json"), JSON.stringify(auth));
writeAuth({ openrouter: { type: "oauth", access: OAUTH_KEY, refresh: "", expires: Number.MAX_SAFE_INTEGER }, anthropic: { type: "oauth", access: "session", refresh: "r", expires: 0 } });

const realFetch = globalThis.fetch;
const requests: Array<{ url: string; authorization: string | null }> = [];
const listings: Record<string, unknown[]> = {
	models: [{ id: "openai/gpt-5", architecture: { output_modalities: ["text"] } }],
	"models?output_modalities=speech": [{ id: "vendor/tts-1", architecture: { output_modalities: ["speech"] } }],
	"models?output_modalities=transcription": [{ id: "vendor/stt-1", architecture: { input_modalities: ["audio"], output_modalities: ["transcription"] } }],
	"embeddings/models": [{ id: "vendor/embed-1", architecture: { output_modalities: ["embeddings"] } }],
};
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
	const url = input instanceof Request ? input.url : String(input);
	if (!url.startsWith("https://openrouter.ai/api/v1/")) return realFetch(input, init);
	requests.push({ url, authorization: new Headers(init?.headers).get("authorization") });
	const listed = listings[url.slice("https://openrouter.ai/api/v1/".length)];
	return listed ? Response.json({ data: listed }) : new Response("not found", { status: 404 });
}) as typeof fetch;
after(() => { globalThis.fetch = realFetch; rmSync(root, { recursive: true, force: true }); });

const { connectionApiKey, builtinConnectionEntry } = await import("../../server/providers/builtin-connections.js");
const { listConnections } = await import("../../server/providers/connections-api.js");
const { connectionEntry, audioGenerationKey } = await import("../../server/audio/configuration.js");
const { speechConnectionKey, validateSpeechConnection } = await import("../../server/voice/configuration.js");
const { embeddingApiKey, embeddingEndpointFor } = await import("../../server/embedding/configuration.js");
const { readStoredCredentials } = await import("../../server/accounts/stored-credentials.js");
const { markProviderCredentialDeleted } = await import("../../server/config/credential-tombstones.js");

test("an OpenRouter OAuth login serves every capability page with the key it issued", async () => {
	const credentials = readStoredCredentials(join(root, "auth.json"));
	assert.equal(connectionApiKey("openrouter", credentials), OAUTH_KEY);
	assert.equal(connectionApiKey("anthropic", credentials), undefined, "a chat session token is not an API key");

	const { connections } = await listConnections();
	const openrouter = connections.find((item) => item.id === "openrouter")!;
	assert.equal(openrouter.auth, "oauth");
	assert.deepEqual(openrouter.capabilities, ["chat", "embedding", "tts", "stt"]);
	assert.deepEqual([openrouter.models.embedding, openrouter.models.tts, openrouter.models.stt].map((models) => models.map((model) => model.id)), [["vendor/embed-1"], ["vendor/tts-1"], ["vendor/stt-1"]]);
	assert.ok(requests.length > 0 && requests.every((request) => request.authorization === `Bearer ${OAUTH_KEY}`), "discovery authenticates with the issued key");
	assert.deepEqual(connections.find((item) => item.id === "anthropic")!.capabilities, ["chat"]);

	const baseUrl = "https://openrouter.ai/api/v1";
	assert.equal(connectionEntry("openrouter")?.baseUrl, baseUrl);
	assert.equal(embeddingEndpointFor("openrouter"), baseUrl);
	assert.equal(await embeddingApiKey("openrouter"), OAUTH_KEY);
	assert.equal(audioGenerationKey({ connection: "openrouter", model: "vendor/tts-1", voice: "", rate: 1, baseUrl }), OAUTH_KEY);
	assert.equal(speechConnectionKey("openrouter", baseUrl), OAUTH_KEY);
	await assert.rejects(embeddingApiKey("anthropic"), /API key authentication/);
});

test("recognition accepts a model the gateway lists only among its transcription models", async () => {
	const baseUrl = "https://openrouter.ai/api/v1";
	await validateSpeechConnection(baseUrl, OAUTH_KEY, ["vendor/stt-1"]);
	await assert.rejects(validateSpeechConnection(baseUrl, OAUTH_KEY, ["vendor/missing"]), /Model unavailable/);
});

test("a connection definition of the same id replaces the built-in, and a deleted credential serves nothing", () => {
	writeFileSync(join(root, "models.json"), JSON.stringify({ providers: { openrouter: { api: "openai-completions", baseUrl: "https://gateway.example/v1", models: [] } } }));
	assert.equal(builtinConnectionEntry("openrouter"), undefined);
	assert.equal(connectionEntry("openrouter")?.baseUrl, "https://gateway.example/v1");
	rmSync(join(root, "models.json"));

	markProviderCredentialDeleted("openrouter", {});
	assert.equal(connectionApiKey("openrouter", readStoredCredentials(join(root, "auth.json"))), undefined);
	assert.throws(() => audioGenerationKey({ connection: "openrouter", model: "vendor/tts-1", voice: "", rate: 1, baseUrl: "https://openrouter.ai/api/v1" }), /credential was deleted/);
});
