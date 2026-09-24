import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import express from "express";

const root = mkdtempSync(join(tmpdir(), "connection-probe-"));
process.env.PI_CODING_AGENT_DIR = root;
process.env.TELOMI_DATA_DIR = join(root, "data");
mkdirSync(process.env.TELOMI_DATA_DIR, { recursive: true });

// One OpenAI-compatible service that embeds, speaks and transcribes; every probe must hit the right path.
const seen: Array<{ url: string; authorization?: string; body: string }> = [];
const upstream = createServer((req, res) => {
	let body = "";
	req.on("data", (chunk) => { body += chunk; });
	req.on("end", () => {
		seen.push({ url: req.url ?? "", authorization: req.headers.authorization, body });
		if (req.url === "/v1/embeddings") { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ data: [{ index: 0, embedding: [0.1, 0.2, 0.3] }] })); return; }
		if (req.url === "/v1/audio/speech") { res.setHeader("Content-Type", "audio/mpeg"); res.end(Buffer.alloc(2048, 1)); return; }
		if (req.url === "/v1/audio/transcriptions") { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ text: req.headers.authorization === "Bearer sk-unit-1234" ? "This is a speech recognition check." : "" })); return; }
		res.statusCode = 404; res.end("{}");
	});
});
await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
const port = (upstream.address() as { port: number }).port;
const baseUrl = `http://127.0.0.1:${port}/v1`;
writeFileSync(join(root, "models.json"), JSON.stringify({ providers: {
	"unit-cloud": { api: "openai-completions", baseUrl, models: [{ id: "embed-1", capabilities: ["embedding"] }, { id: "speech-1", capabilities: ["tts"], supportedVoices: ["nova"] }, { id: "whisper-1", capabilities: ["stt"] }] },
	// A server that lists nothing: everything it serves is typed by hand.
	"unlisted-cloud": { api: "openai-completions", baseUrl, models: [] },
} }));
writeFileSync(join(root, "auth.json"), JSON.stringify({ "unit-cloud": { type: "api_key", key: "sk-unit-1234" }, "unlisted-cloud": { type: "api_key", key: "sk-unit-1234" } }));

const { mountConnectionsApi } = await import("../../server/providers/connections-api.js");

test("each capability probe runs the consumer's own request against the connection", async () => {
	const app = express();
	app.use(express.json());
	mountConnectionsApi(app);
	const server = app.listen(0, "127.0.0.1");
	await new Promise<void>((resolve) => server.once("listening", resolve));
	const api = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
	const probe = async (connection: string, body: unknown) => {
		const response = await fetch(`${api}/api/connections/${connection}/test`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
		return { status: response.status, body: await response.json() as { ok: boolean; detail?: string; error?: string } };
	};
	try {
		const embedding = await probe("unit-cloud", { capability: "embedding", model: "embed-1" });
		assert.equal(embedding.status, 200);
		assert.equal(embedding.body.detail, "3 dimensions");
		assert.equal(seen.at(-1)?.url, "/v1/embeddings");
		assert.equal(JSON.parse(seen.at(-1)!.body).model, "embed-1");

		const tts = await probe("unit-cloud", { capability: "tts", model: "speech-1" });
		assert.equal(tts.status, 200, JSON.stringify(tts.body));
		assert.equal(tts.body.detail, "nova · 2 KB mp3", "the listed voice serves when the selection names none");
		assert.equal(JSON.parse(seen.at(-1)!.body).response_format, "mp3", "the probe asks for what playback asks for");

		const stt = await probe("unit-cloud", { capability: "stt", model: "whisper-1" });
		assert.equal(stt.status, 200, JSON.stringify(stt.body));
		assert.equal(stt.body.detail, "This is a speech recognition check.");
		assert.equal(seen.at(-1)?.url, "/v1/audio/transcriptions");
		assert.match(seen.at(-1)!.body, /name="file"; filename="stt-probe.wav"/);

		const typed = await probe("unlisted-cloud", { capability: "tts", model: "typed-model", voice: "zephyr" });
		assert.equal(typed.status, 200, JSON.stringify(typed.body));
		assert.equal(typed.body.detail, "zephyr · 2 KB mp3", "a model and voice the listing never offered are probed as typed");
		assert.equal(JSON.parse(seen.at(-1)!.body).model, "typed-model");
		assert.equal(JSON.parse(seen.at(-1)!.body).voice, "zephyr");

		const unknown = await probe("nowhere", { capability: "embedding", model: "embed-1" });
		assert.equal(unknown.status, 502);
		assert.match(unknown.body.error!, /unknown/);

		const invalid = await probe("unit-cloud", { capability: "video", model: "x" });
		assert.equal(invalid.status, 400);

		const local = await probe("hindsight-local", { capability: "embedding", model: "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2" });
		assert.equal(local.status, 502);
		assert.match(local.body.error!, /Hindsight/);
	} finally {
		await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
		await new Promise<void>((resolve) => upstream.close(() => resolve()));
		rmSync(root, { recursive: true, force: true });
	}
});
