import assert from "node:assert/strict";
import { test } from "node:test";
import express from "express";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { listOllamaModels, looksLikeOllama, mountOllamaApi, ollamaLibrary, ollamaRoot, parseOllamaLibrary, pullJob, pullJobKey, startOllamaPull } from "../../server/providers/ollama-api.js";

/** A fake Ollama: installed models with native capabilities, and a streaming pull. */
function fakeOllama() {
	const installed = new Set(["embeddinggemma:latest", "qwen3:4b"]);
	const capabilities: Record<string, string[]> = { "embeddinggemma:latest": ["embedding"], "qwen3:4b": ["completion", "tools"], "nomic-embed-text:latest": ["embedding"] };
	const server = createServer(async (request, response) => {
		let text = "";
		for await (const chunk of request) text += chunk;
		const body = text ? JSON.parse(text) as { model?: string } : {};
		response.setHeader("content-type", "application/json");
		if (request.url === "/api/tags") {
			response.end(JSON.stringify({ models: [...installed].map((name) => ({ name, size: 100, details: { family: name.split(":")[0] } })) }));
		} else if (request.url === "/api/show") {
			if (!installed.has(body.model ?? "")) { response.statusCode = 404; response.end("{}"); return; }
			response.end(JSON.stringify({ capabilities: capabilities[body.model!] }));
		} else if (request.url === "/api/pull") {
			if (body.model === "missing:latest") { response.end(JSON.stringify({ error: "pull model manifest: file does not exist" }) + "\n"); return; }
			response.write(JSON.stringify({ status: "pulling manifest" }) + "\n");
			response.write(JSON.stringify({ status: "pulling sha256", total: 200, completed: 50 }) + "\n");
			installed.add(body.model!);
			response.end(JSON.stringify({ status: "pulling sha256", total: 200, completed: 200 }) + "\n" + JSON.stringify({ status: "success" }) + "\n");
		} else { response.statusCode = 404; response.end("{}"); }
	});
	return server;
}

test("Ollama discovery reads native capabilities and the address helpers accept the OpenAI suffix", async () => {
	const ollama = fakeOllama();
	await new Promise<void>((resolve) => ollama.listen(0, "127.0.0.1", resolve));
	const port = (ollama.address() as AddressInfo).port;
	try {
		assert.equal(ollamaRoot(`http://127.0.0.1:${port}/v1/`), `http://127.0.0.1:${port}`);
		assert.equal(looksLikeOllama("http://127.0.0.1:11434/v1"), true);
		assert.equal(looksLikeOllama("https://openrouter.ai/api/v1"), false);
		const models = await listOllamaModels(`http://127.0.0.1:${port}/v1`);
		assert.deepEqual(models.map((m) => [m.id, m.capabilities]), [["embeddinggemma:latest", ["embedding"]], ["qwen3:4b", ["chat"]]]);
	} finally {
		await new Promise<void>((resolve) => ollama.close(() => resolve()));
	}
});

test("an Ollama pull is watched as a job until the model is installed, and a bad name fails the job", async () => {
	const ollama = fakeOllama();
	await new Promise<void>((resolve) => ollama.listen(0, "127.0.0.1", resolve));
	const port = (ollama.address() as AddressInfo).port;
	const baseUrl = `http://127.0.0.1:${port}/v1`;
	const app = express();
	app.use(express.json());
	mountOllamaApi(app);
	const api = app.listen(0, "127.0.0.1");
	await new Promise<void>((resolve) => api.once("listening", resolve));
	const apiPort = (api.address() as AddressInfo).port;
	const call = async (method: string, path: string, body?: unknown) => {
		const response = await fetch(`http://127.0.0.1:${apiPort}${path}`, { method, headers: { "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
		return { status: response.status, json: await response.json() as Record<string, unknown> };
	};
	const settled = async (job: string) => {
		for (;;) {
			const state = pullJob(job);
			if (state && state.status !== "pulling") return state;
			await new Promise((resolve) => setTimeout(resolve, 5));
		}
	};
	try {
		const started = await call("POST", "/api/ollama/pull", { baseUrl, model: "nomic-embed-text:latest" });
		assert.equal(started.status, 200);
		assert.equal(started.json.job, pullJobKey(baseUrl, "nomic-embed-text:latest"));
		const done = await settled(started.json.job as string);
		assert.deepEqual([done.status, done.completed, done.total, done.detail], ["done", 200, 200, "success"]);
		const polled = await call("GET", `/api/ollama/pull?job=${encodeURIComponent(started.json.job as string)}`);
		assert.equal(polled.json.status, "done");
		// The freshly pulled model is now discovered with its capability.
		const listed = await call("POST", "/api/ollama/models", { baseUrl });
		assert.ok((listed.json.models as Array<{ id: string; capabilities: string[] }>).some((m) => m.id === "nomic-embed-text:latest" && m.capabilities[0] === "embedding"));

		const failed = await settled(startOllamaPull(baseUrl, "missing:latest"));
		assert.equal(failed.status, "failed");
		assert.match(failed.error ?? "", /does not exist/);
		assert.equal((await call("POST", "/api/ollama/pull", { baseUrl, model: "../etc" })).status, 400);
		assert.equal((await call("GET", "/api/ollama/pull?job=nope")).status, 404);
	} finally {
		await new Promise<void>((resolve) => api.close(() => resolve()));
		await new Promise<void>((resolve) => ollama.close(() => resolve()));
	}
});

const LIBRARY_HTML = `
<li class="flex"><a href="/library/embeddinggemma"><div><h2><span>embeddinggemma</span></h2>
<p class="max-w-lg break-words text-neutral-800 text-md">EmbeddingGemma is a 300M parameter embedding model from Google.</p></div>
<span  class="inline-flex my-1 items-center rounded-md px-2 text-xs font-medium text-indigo-600">embedding</span>
<span  class="inline-flex my-1 items-center rounded-md px-2 text-xs font-medium text-blue-600">300m</span></a></li>
<li class="flex"><a href="/library/qwen3-embedding"><div><p class="max-w-lg break-words text-neutral-800 text-md">Qwen3 embeddings.</p></div>
<span  class="inline-flex text-xs font-medium">embedding</span><span  class="inline-flex text-xs font-medium">0.6b</span><span  class="inline-flex text-xs font-medium">4b</span><span  class="inline-flex text-xs font-medium">8b</span></a></li>
<li class="flex"><a href="/library/qwen3"><div><p class="max-w-lg break-words text-neutral-800 text-md">Qwen3 chat.</p></div>
<span  class="inline-flex text-xs font-medium">tools</span><span  class="inline-flex text-xs font-medium">4b</span></a></li>`;

test("the Ollama library page is parsed per capability, with pullable size tags, and a dead site falls back to built-in names", async () => {
	assert.deepEqual(parseOllamaLibrary(LIBRARY_HTML, "embedding"), [
		{ name: "embeddinggemma", description: "EmbeddingGemma is a 300M parameter embedding model from Google.", sizes: ["300m"] },
		{ name: "qwen3-embedding", description: "Qwen3 embeddings.", sizes: ["0.6b", "4b", "8b"] },
	]);
	assert.deepEqual(parseOllamaLibrary(LIBRARY_HTML, "chat").map((m) => m.name), ["qwen3"]);
	const offline = await ollamaLibrary("embedding", async () => { throw new Error("offline"); });
	assert.ok(offline.some((m) => m.name === "nomic-embed-text"), "offline, the built-in suggestions still serve");
	const online = await ollamaLibrary("chat", async () => new Response(LIBRARY_HTML));
	assert.deepEqual(online.map((m) => m.name), ["qwen3"]);
});
