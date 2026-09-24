import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import express from "express";

const root = mkdtempSync(join(tmpdir(), "connections-api-"));
process.env.PI_CODING_AGENT_DIR = root;
mkdirSync(root, { recursive: true });
writeFileSync(join(root, "models.json"), JSON.stringify({ providers: {
	"local-llm": { api: "openai-completions", baseUrl: "http://127.0.0.1:9/v1", models: [{ id: "m1" }, { id: "bge-reranker-v2-m3" }] },
	"local-stt": { api: "openai-completions", baseUrl: "http://127.0.0.1:9/v1", capability: "audio-recognition", apiKey: "sk-localstt-1234", models: [{ id: "whisper" }] },
	// The managed runtime's saved entry may carry a pin from an older version; it still serves both audio capabilities.
	"telomi-audio": { api: "openai-completions", baseUrl: "http://127.0.0.1:9595/v1", capability: "audio-generation", apiKey: "local", models: [{ id: "Qwen3-TTS-12Hz-0.6B" }, { id: "Qwen3-ASR-0.6B-MLX-4bit" }, { id: "Qwen3-ForcedAligner-0.6B", capabilities: ["chat"] }] },
	// Pinned from the Embedding page: discovery classified the listing, and the pin keeps only its own share.
	"gateway-embed": { api: "openai-completions", baseUrl: "http://127.0.0.1:9/v1", capability: "embedding", apiKey: "sk-embed-5678", models: [
		{ id: "text-embedding-3-small", capabilities: ["embedding"] }, { id: "gpt-4o-mini", capabilities: ["chat"] }, { id: "hand-added" },
	] },
} }));
writeFileSync(join(root, "auth.json"), JSON.stringify({ openrouter: { type: "api_key", key: "sk-or-abcdefgh" }, anthropic: { type: "oauth", access: "tok", refresh: "r", expires: 0 } }));
writeFileSync(join(root, "auth-pending.json"), JSON.stringify({ openai: { type: "api_key", key: "sk-openai-pending" } }));
// Built-in discovery reads OpenRouter's speech, transcription and embedding catalogs; they answer here instead of the network.
const realFetch = globalThis.fetch;
const openrouterListings: Record<string, unknown[]> = {
	"models?output_modalities=speech": [{ id: "vendor/tts-1", architecture: { output_modalities: ["speech"] }, supported_voices: ["alloy"] }],
	"models?output_modalities=transcription": [{ id: "vendor/stt-1", architecture: { input_modalities: ["audio"], output_modalities: ["transcription"] } }],
	"embeddings/models": [{ id: "vendor/embed-1", architecture: { output_modalities: ["embeddings"] } }],
};
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
	const url = input instanceof Request ? input.url : String(input);
	if (!url.startsWith("https://openrouter.ai/api/v1/")) return realFetch(input, init);
	return Response.json({ data: openrouterListings[url.slice("https://openrouter.ai/api/v1/".length)] ?? [] });
}) as typeof fetch;
const { saveSettings } = await import("../../server/config/settings.js");
const { mountConnectionsApi } = await import("../../server/providers/connections-api.js");

test("connections aggregate credentials, capabilities and the reverse index of selections", async () => {
	saveSettings({ defaultProvider: "openrouter", defaultModel: "qwen/qwen3", taskModels: { cornellNote: "local-llm/m1" },
		embedding: { default: { connection: "openrouter", model: "qwen/qwen3-embedding-4b" } },
		// Speech models are the user's choice too; nothing is listed as used until one is chosen.
		audioGeneration: { default: { connection: "telomi-audio", model: "Qwen3-TTS-12Hz-0.6B", voice: "", rate: 1 } },
		speechRecognition: { default: { connection: "telomi-audio", model: "Qwen3-ASR-0.6B-MLX-4bit" }, cleanupEnabled: false, cleanupInstructions: "" } });
	const app = express();
	mountConnectionsApi(app);
	const server = app.listen(0, "127.0.0.1");
	await new Promise<void>((resolve) => server.once("listening", resolve));
	const address = server.address();
	assert.ok(address && typeof address === "object");
	try {
		const body = await fetch(`http://127.0.0.1:${address.port}/api/connections`).then((r) => r.json());
		const byId = new Map(body.connections.map((item: { id: string }) => [item.id, item]));
		const openrouter = byId.get("openrouter");
		assert.equal(openrouter.status, "connected");
		assert.equal(openrouter.auth, "api_key");
		assert.equal(openrouter.keyHint, "sk-o…efgh");
		assert.deepEqual(openrouter.capabilities, ["chat", "embedding", "tts", "stt"], "one built-in key serves every capability page");
		assert.deepEqual(openrouter.models.embedding.map((m: { id: string }) => m.id), ["vendor/embed-1"]);
		assert.deepEqual(openrouter.models.tts, [{ id: "vendor/tts-1", supportedVoices: ["alloy"] }]);
		assert.deepEqual(openrouter.models.stt.map((m: { id: string }) => m.id), ["vendor/stt-1"]);
		assert.deepEqual(openrouter.usedBy.map((u: { capability: string; consumer: string }) => `${u.capability}:${u.consumer}`), ["chat:default", "embedding:wiki", "embedding:memory"], "memory inherits the default embedding selection");
		assert.equal(byId.get("anthropic").auth, "oauth");
		assert.deepEqual(byId.get("anthropic").capabilities, ["chat"], "a chat-only Provider serves no other capability, whatever its credential");
		assert.equal(byId.get("openai").status, "pending");
		const local = byId.get("local-llm");
		assert.equal(local.kind, "custom");
		assert.equal(local.auth, "anonymous");
		assert.deepEqual(local.usedBy.map((u: { consumer: string }) => u.consumer), ["cornellNote"]);
		assert.deepEqual(byId.get("local-stt").capabilities, ["stt"]);
		assert.deepEqual(byId.get("local-stt").models.stt.map((m: { id: string }) => m.id), ["whisper"], "a hand-added id counts as the pinned capability");
		assert.deepEqual(byId.get("telomi-audio").capabilities, ["tts", "stt"]);
		assert.deepEqual(byId.get("telomi-audio").models.stt.map((m: { id: string }) => m.id), ["Qwen3-ASR-0.6B-MLX-4bit"], "the managed runtime lists its recognition models despite a generation pin");
		assert.deepEqual(byId.get("telomi-audio").models.tts.map((m: { id: string }) => m.id), ["Qwen3-TTS-12Hz-0.6B"]);
		assert.deepEqual(byId.get("telomi-audio").models.chat, [], "a stale aligner id on the managed runtime is never offered as an LLM");
		const embed = byId.get("gateway-embed");
		assert.deepEqual(embed.capabilities, ["embedding"], "a pinned connection serves only its capability");
		assert.deepEqual(embed.models.embedding.map((m: { id: string }) => m.id), ["text-embedding-3-small", "hand-added"], "the pin drops models discovery classified for other capabilities");
		assert.deepEqual(embed.models.chat, [], "a pinned connection never offers chat models");
		assert.deepEqual(byId.get("local-llm").models.chat.map((m: { id: string }) => m.id), ["m1"]);
		assert.deepEqual(byId.get("local-llm").capabilities, ["chat"], "capabilities follow what discovery classified");
		assert.ok(openrouter.models.chat.length > 0, "cloud connections list their registry chat models");
		assert.deepEqual(byId.get("hindsight-local").models.embedding.map((m: { id: string }) => m.id), ["sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2"]);
		assert.equal(byId.get("local-stt").keyHint, "sk-l…1234");
		assert.deepEqual(byId.get("hindsight-local").capabilities, ["embedding"]);
		assert.ok(body.selections.some((s: { capability: string; consumer: string }) => s.capability === "stt" && s.consumer === "recognition"));
		assert.ok(body.selections.some((s: { capability: string; consumer: string }) => s.capability === "tts" && s.consumer === "playback"));
	} finally {
		await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
		globalThis.fetch = realFetch;
		rmSync(root, { recursive: true, force: true });
	}
});
