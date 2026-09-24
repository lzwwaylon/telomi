import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test, { after } from "node:test";
import type { ManagedAudioChildProcess } from "../../server/audio/local-runtime.js";

const data = mkdtempSync(join(tmpdir(), "telomi-managed-audio-"));
const previousDataDir = process.env.TELOMI_DATA_DIR;
process.env.TELOMI_DATA_DIR = data;
after(() => {
	if (previousDataDir === undefined) delete process.env.TELOMI_DATA_DIR;
	else process.env.TELOMI_DATA_DIR = previousDataDir;
	rmSync(data, { recursive: true, force: true });
});

const { AudioLocalRuntimeManager } = await import("../../server/audio/local-runtime.js");
const { saveCustomProviders } = await import("../../server/providers/custom-models.js");
const { MANAGED_AUDIO_CONNECTION_ID } = await import("../../shared/connections.js");

/** A runtime at the bundled address whose service is down until the runtime spawns it. */
function bundledRuntime() {
	let spawns = 0;
	const manager = new AudioLocalRuntimeManager({
		env: {},
		fetcher: async () => spawns
			? new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } })
			: new Response(null, { status: 503 }),
		spawnProcess: () => {
			spawns += 1;
			const child = new EventEmitter() as ManagedAudioChildProcess;
			child.pid = 4321;
			child.exitCode = null;
			child.stdout = new PassThrough();
			child.stderr = new PassThrough();
			child.kill = () => {
				child.exitCode = 0;
				queueMicrotask(() => child.emit("exit", 0, null));
				return true;
			};
			return child;
		},
		sleep: async () => undefined,
	});
	return { manager, spawns: () => spawns };
}

test("selecting the managed connection from a fresh data dir starts the bundled service and waits for health", async () => {
	const { manager, spawns } = bundledRuntime();
	try {
		await manager.prepare(MANAGED_AUDIO_CONNECTION_ID);
		assert.equal(spawns(), 1);
		assert.equal(manager.status().stage, "ready");
	} finally {
		await manager.close();
	}
});

test("an external URL for the same service never starts a process", async () => {
	const { manager, spawns } = bundledRuntime();
	const endpoint = (baseUrl: string) => ({ baseUrl, api: "openai-completions" as const, models: [] });
	try {
		saveCustomProviders({ providers: {
			// The managed id pointed at another machine is that machine's service.
			[MANAGED_AUDIO_CONNECTION_ID]: endpoint("http://192.168.1.20:9595/v1"),
			// Any other connection is an endpoint the user runs, even at the bundled address.
			"gpu-box": endpoint("http://127.0.0.1:9595/v1"),
		} });
		await manager.prepare(MANAGED_AUDIO_CONNECTION_ID);
		await manager.prepare("gpu-box");
		assert.equal(spawns(), 0);
		assert.equal(manager.status().stage, "stopped");

		saveCustomProviders({ providers: { [MANAGED_AUDIO_CONNECTION_ID]: endpoint("HTTP://127.0.0.1:9595/v1/") } });
		await manager.prepare(MANAGED_AUDIO_CONNECTION_ID);
		assert.equal(spawns(), 1, "the managed connection declared at the bundled address is still the bundled service");
	} finally {
		await manager.close();
	}
});

test("a local runtime that turns healthy lists itself as the managed connection, with its models and voices", async () => {
	const { createServer } = await import("node:http");
	const { once } = await import("node:events");
	const { loadCustomProviders, writeCustomProvider } = await import("../../server/providers/custom-models.js");
	const { listManagedAudioConnection } = await import("../../server/audio/managed-connection.js");
	const { listConnections } = await import("../../server/providers/connections-api.js");
	const { markProviderCredentialDeleted, clearProviderCredentialTombstone } = await import("../../server/config/credential-tombstones.js");
	const voices = ["vivian", "serena", "ryan"];
	// The listing shape of apps/telomi-audio-local's /v1/models.
	const service = createServer((req, res) => {
		res.setHeader("Content-Type", "application/json");
		if (req.url === "/health") res.end(JSON.stringify({ ok: true }));
		else if (req.url === "/v1/models") res.end(JSON.stringify({ object: "list", data: [
			{ id: "Qwen3-TTS-12Hz-0.6B-CustomVoice-8bit", object: "model", modality: "tts", default_voice: "vivian", supported_voices: voices },
			{ id: "Qwen3-ASR-0.6B-MLX-4bit", object: "model", modality: "stt" },
		] }));
		else if (req.url === "/v1/audio/voices") res.end(JSON.stringify({ voices: voices.map((id) => ({ id, name: id })) }));
		else { res.statusCode = 404; res.end("{}"); }
	}).listen(0, "127.0.0.1");
	await once(service, "listening");
	const baseUrl = `http://127.0.0.1:${(service.address() as { port: number }).port}/v1`;
	const listings: string[] = [];
	const manager = new AudioLocalRuntimeManager({ env: { TELOMI_AUDIO_STT_BASE_URL: baseUrl } });
	manager.onReady(async (url) => { listings.push(url); await listManagedAudioConnection(url); });
	try {
		saveCustomProviders({ providers: {} });
		// A fresh install has no entry: settings had no connection to offer, test or preview.
		assert.equal((await manager.refresh()).stage, "ready");
		const managed = (await listConnections()).connections.find((item) => item.id === MANAGED_AUDIO_CONNECTION_ID);
		assert.equal(managed?.status, "connected");
		assert.deepEqual(managed?.capabilities, ["tts", "stt"]);
		assert.deepEqual(managed?.models.tts, [{ id: "Qwen3-TTS-12Hz-0.6B-CustomVoice-8bit", supportedVoices: voices }]);
		assert.deepEqual(managed?.models.stt.map((model) => model.id), ["Qwen3-ASR-0.6B-MLX-4bit"]);

		await manager.refresh();
		assert.deepEqual(listings, [baseUrl], "staying healthy lists nothing again");

		// The user's own choices stand: a managed connection pointed elsewhere, or deleted, is left alone.
		const elsewhere = { baseUrl: "http://192.168.1.20:9595/v1", api: "openai-completions" as const, models: [] };
		saveCustomProviders({ providers: { [MANAGED_AUDIO_CONNECTION_ID]: elsewhere } });
		await listManagedAudioConnection(baseUrl);
		assert.deepEqual(loadCustomProviders().providers?.[MANAGED_AUDIO_CONNECTION_ID], elsewhere);
		writeCustomProvider(MANAGED_AUDIO_CONNECTION_ID, null);
		markProviderCredentialDeleted(MANAGED_AUDIO_CONNECTION_ID);
		await listManagedAudioConnection(baseUrl);
		assert.equal(loadCustomProviders().providers?.[MANAGED_AUDIO_CONNECTION_ID], undefined);
		clearProviderCredentialTombstone(MANAGED_AUDIO_CONNECTION_ID);
	} finally {
		await manager.close();
		service.close();
	}
});
