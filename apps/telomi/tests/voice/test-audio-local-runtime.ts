import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import express from "express";
import { mountAudioConfigApi } from "../../server/voice/config-api.js";
import {
	AudioLocalRuntimeManager,
	type ManagedAudioChildProcess,
} from "../../server/audio/local-runtime.js";

function fakeChild(pid = 4321): ManagedAudioChildProcess {
	const child = new EventEmitter() as ManagedAudioChildProcess;
	child.pid = pid;
	child.exitCode = null;
	child.stdout = new PassThrough();
	child.stderr = new PassThrough();
	child.kill = () => {
		child.exitCode = 0;
		queueMicrotask(() => child.emit("exit", 0, null));
		return true;
	};
	return child;
}

test("local audio runtime reuses an already healthy sidecar", async () => {
	let probes = 0;
	const manager = new AudioLocalRuntimeManager({
		env: {},
		fetcher: async (input) => {
			probes += 1;
			assert.equal(String(input), "http://127.0.0.1:9595/health");
			return new Response(JSON.stringify({ ok: true }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		},
	});

	const status = await manager.ensureReady();

	assert.equal(status.stage, "ready");
	assert.equal(status.baseUrl, "http://127.0.0.1:9595/v1");
	assert.equal(status.owned, false);
	assert.equal(probes, 1);
	await manager.close();
});

test("the VAD status a health document reports rides on the runtime status", async () => {
	const manager = new AudioLocalRuntimeManager({
		env: {},
		fetcher: async () => new Response(JSON.stringify({
			ok: true,
			vad: { provider: "silero-vad", version: "v5.1.2", default_enabled: false, model_exists: true, model_loaded: false, expected_sha256: "abc" },
		}), { status: 200, headers: { "Content-Type": "application/json" } }),
	});
	assert.equal(manager.status().vad, null, "nothing is known before the service answers");
	const status = await manager.refresh();
	assert.equal(status.stage, "ready");
	assert.deepEqual(status.vad, { provider: "silero-vad", version: "v5.1.2", defaultEnabled: false, modelExists: true, modelLoaded: false, expectedSha256: "abc" });
	await manager.close();
});

test("unavailable remote endpoints fail without spawning a local process", async () => {
	let spawns = 0;
	const manager = new AudioLocalRuntimeManager({
		env: {
			TELOMI_AUDIO_STT_BASE_URL: "https://voice.example.com/v1",
		},
		fetcher: async () => {
			throw new Error("connection refused");
		},
		spawnProcess: () => {
			spawns += 1;
			return fakeChild();
		},
	});

	await assert.rejects(
		manager.ensureReady(),
		/unavailable and cannot be managed locally/,
	);
	assert.equal(spawns, 0);
	assert.equal(manager.status().stage, "failed");
	assert.equal(manager.status().managed, false);
	await manager.close();
});

test("healthy remote endpoints may expose a status-only health response", async () => {
	let spawns = 0;
	const manager = new AudioLocalRuntimeManager({
		env: {
			TELOMI_AUDIO_STT_BASE_URL: "https://voice.example.com/v1",
		},
		fetcher: async (input) => {
			assert.equal(String(input), "https://voice.example.com/health");
			return new Response(null, { status: 200 });
		},
		spawnProcess: () => {
			spawns += 1;
			return fakeChild();
		},
	});

	const status = await manager.ensureReady();

	assert.equal(status.stage, "ready");
	assert.equal(status.managed, false);
	assert.equal(status.owned, false);
	assert.equal(spawns, 0);
	await manager.close();
});

test("legacy automatic-startup settings cannot disable local audio", async () => {
	let started = false;
	let spawns = 0;
	const manager = new AudioLocalRuntimeManager({
		env: { TELOMI_AUDIO_LOCAL_AUTOSTART: "0" },
		fetcher: async () => new Response(
			started ? JSON.stringify({ ok: true }) : null,
			{
				status: started ? 200 : 503,
				headers: { "Content-Type": "application/json" },
			},
		),
		spawnProcess: () => {
			spawns += 1;
			started = true;
			return fakeChild();
		},
		sleep: async () => undefined,
	});

	assert.equal((await manager.ensureReady()).stage, "ready");
	assert.equal((await manager.startExplicitly()).stage, "ready");
	assert.equal(spawns, 1);
	await manager.close();
});

test("audio config runtime endpoints expose health and explicit readiness", async () => {
	let probes = 0;
	const manager = new AudioLocalRuntimeManager({
		fetcher: async () => {
			probes += 1;
			return new Response(JSON.stringify({ ok: true }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		},
	});
	const app = express();
	app.use(express.json());
	mountAudioConfigApi(app, manager);
	const server = createServer(app);
	await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
	const address = server.address();
	assert.ok(address && typeof address === "object");
	const origin = `http://127.0.0.1:${address.port}`;

	try {
		const healthResponse = await fetch(`${origin}/api/audio-config/local-runtime`);
		assert.equal(healthResponse.status, 200);
		const health = await healthResponse.json() as { stage: string; owned: boolean };
		assert.equal(health.stage, "ready");
		assert.equal(health.owned, false);

		const startResponse = await fetch(`${origin}/api/audio-config/local-runtime/start`, {
			method: "POST",
		});
		assert.equal(startResponse.status, 200);
		const started = await startResponse.json() as { stage: string; owned: boolean };
		assert.equal(started.stage, "ready");
		assert.equal(started.owned, false);
		assert.equal(probes, 2);
	} finally {
		await manager.close();
		await new Promise<void>((resolveClose, rejectClose) => {
			server.close((error) => error ? rejectClose(error) : resolveClose());
		});
	}
});

test("concurrent readiness starts one managed sidecar and exposes the model install in progress", async () => {
	const root = mkdtempSync(join(tmpdir(), "telomi-audio-sidecar-test-"));
	const asrStatusPath = join(root, "asr-install.json");
	const ttsStatusPath = join(root, "tts-install.json");
	const writeStatus = (path: string, status: Record<string, unknown>) =>
		writeFileSync(path, JSON.stringify({ schema_version: 1, updated_at_unix_ms: Date.now(), ...status }));
	// Left behind by an earlier startup; it must not read as this startup failing.
	writeStatus(ttsStatusPath, {
		model_id: "Qwen3-TTS-12Hz-0.6B-CustomVoice-8bit",
		stage: "failed",
		detail: "local TTS model installation failed validation or download",
		completed_files: 0,
		total_files: 12,
		updated_at_unix_ms: 123,
	});
	let probes = 0;
	let spawns = 0;
	let markSpawned!: () => void;
	const spawned = new Promise<void>((resolveSpawned) => { markSpawned = resolveSpawned; });
	const child = fakeChild();
	const manager = new AudioLocalRuntimeManager({
		env: {
			TELOMI_AUDIO_ASR_INSTALL_STATUS: asrStatusPath,
			TELOMI_AUDIO_TTS_INSTALL_STATUS: ttsStatusPath,
		},
		serviceRoot: root,
		fetcher: async () => {
			probes += 1;
			if (probes < 3) throw new Error("connection refused");
			return new Response(JSON.stringify({ ok: true }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		},
		spawnProcess: (command, args, options) => {
			spawns += 1;
			assert.equal(command, join(root, "run.sh"));
			assert.deepEqual(args, []);
			assert.equal(options.env.TELOMI_AUDIO_PORT, "9595");
			assert.equal(options.env.TELOMI_AUDIO_PARENT_PID, String(process.pid));
			// run.sh verifies the ASR model, then fetches the TTS model.
			writeStatus(asrStatusPath, {
				model_id: "Qwen3-ASR-0.6B-MLX-4bit",
				stage: "ready",
				detail: "local ASR model is installed and verified",
				completed_files: 8,
				total_files: 8,
			});
			writeStatus(ttsStatusPath, {
				model_id: "Qwen3-TTS-12Hz-0.6B-CustomVoice-8bit",
				stage: "downloading",
				detail: "fetching pinned local TTS model asset 4/12",
				completed_files: 3,
				total_files: 12,
			});
			markSpawned();
			return child;
		},
		sleep: async () => undefined,
	});

	try {
		const first = manager.ensureReady();
		const second = manager.ensureReady();
		await spawned;
		const installing = manager.status();
		assert.equal(installing.stage, "installing");
		assert.equal(installing.installStage, "downloading");
		assert.equal(installing.detail, "fetching pinned local TTS model asset 4/12");
		assert.equal(installing.completedFiles, 3);
		assert.equal(installing.totalFiles, 12);

		const [firstStatus, secondStatus] = await Promise.all([first, second]);
		assert.equal(spawns, 1);
		assert.equal(firstStatus.stage, "ready");
		assert.equal(secondStatus.stage, "ready");
		assert.equal(firstStatus.owned, true);
		assert.equal(firstStatus.pid, 4321);
	} finally {
		await manager.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("install status left by an earlier startup is not reported before this one writes its own", async () => {
	const root = mkdtempSync(join(tmpdir(), "telomi-audio-sidecar-test-"));
	const asrStatusPath = join(root, "asr-install.json");
	writeFileSync(asrStatusPath, JSON.stringify({
		schema_version: 1,
		model_id: "Qwen3-ASR-0.6B-MLX-4bit",
		stage: "failed",
		detail: "local ASR model installation failed validation or download",
		completed_files: 2,
		total_files: 8,
		updated_at_unix_ms: 123,
	}));
	let healthy = false;
	let markSpawned!: () => void;
	const spawned = new Promise<void>((resolveSpawned) => { markSpawned = resolveSpawned; });
	const manager = new AudioLocalRuntimeManager({
		env: {
			TELOMI_AUDIO_ASR_INSTALL_STATUS: asrStatusPath,
			TELOMI_AUDIO_TTS_INSTALL_STATUS: join(root, "tts-install.json"),
		},
		serviceRoot: root,
		fetcher: async () => {
			if (!healthy) throw new Error("connection refused");
			return new Response(JSON.stringify({ ok: true }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		},
		spawnProcess: () => {
			markSpawned();
			return fakeChild();
		},
		sleep: async () => undefined,
	});

	try {
		const ready = manager.ensureReady();
		await spawned;
		const starting = manager.status();
		assert.equal(starting.stage, "starting");
		assert.equal(starting.installStage, null);
		healthy = true;
		assert.equal((await ready).stage, "ready");
	} finally {
		await manager.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("an owned sidecar that stays silent past the grace period is stopped before its replacement starts", async () => {
	let healthy = false;
	let spawns = 0;
	let clock = 0;
	const firstChild = fakeChild(1111);
	const secondChild = fakeChild(2222);
	const manager = new AudioLocalRuntimeManager({
		serviceRoot: tmpdir(),
		fetcher: async () => {
			if (!healthy) throw new Error("connection refused");
			return new Response(JSON.stringify({ ok: true }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		},
		spawnProcess: () => {
			spawns += 1;
			healthy = true;
			return spawns === 1 ? firstChild : secondChild;
		},
		sleep: async (durationMs) => { clock += durationMs; },
		now: () => clock,
	});

	try {
		const first = await manager.ensureReady();
		assert.equal(first.pid, 1111);
		healthy = false;
		const failed = await manager.refresh();
		assert.equal(failed.stage, "failed");
		assert.equal(failed.owned, true);

		const replacement = await manager.ensureReady();
		assert.ok(clock >= 60_000);
		assert.equal(spawns, 2);
		assert.equal(firstChild.exitCode, 0);
		assert.equal(replacement.stage, "ready");
		assert.equal(replacement.pid, 2222);
	} finally {
		await manager.close();
	}
});

test("a busy owned sidecar that leaves health unanswered for most of a minute is not replaced", async () => {
	let spawns = 0;
	let healthy = false;
	let clock = 0;
	let busyUntil = 0;
	const child = fakeChild(3333);
	const manager = new AudioLocalRuntimeManager({
		serviceRoot: tmpdir(),
		fetcher: async () => {
			if (!healthy || clock < busyUntil) throw new Error("health timeout");
			return new Response(JSON.stringify({ ok: true }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		},
		spawnProcess: () => {
			spawns += 1;
			healthy = true;
			return child;
		},
		sleep: async (durationMs) => { clock += durationMs; },
		now: () => clock,
	});

	try {
		assert.equal((await manager.ensureReady()).pid, 3333);
		busyUntil = clock + 59_000;
		const recovered = await manager.ensureReady();
		assert.equal(spawns, 1);
		assert.equal(child.exitCode, null);
		assert.equal(recovered.stage, "ready");
		assert.equal(recovered.pid, 3333);
		assert.match(recovered.detail, /transient health failure/);
	} finally {
		await manager.close();
	}
});
