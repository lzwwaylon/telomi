import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

import { memoryEmbeddingEnv } from "../../server/embedding/memory-env.js";
import type { ManagedHindsightChildProcess } from "../../server/goals/memory/hindsight-runtime.js";

const configurationRoot = mkdtempSync(join(tmpdir(), "telomi-hindsight-config-"));
process.env.PI_CODING_AGENT_DIR = configurationRoot;
const { HindsightRuntimeManager, healthUrl } = await import("../../server/goals/memory/hindsight-runtime.js");
const { saveSettings } = await import("../../server/config/settings.js");
const { writeStoredCredential } = await import("../../server/accounts/stored-credentials.js");
// Memory roles inherit the global LLM default; the legacy service environment never selects a model.
// The embedding model is the user's choice too; these tests choose the local one the service runs itself.
saveSettings({ defaultProvider: "deepseek", defaultModel: "deepseek-v4-flash",
	embedding: { memory: { connection: "hindsight-local", model: "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2" } } });
writeStoredCredential(join(configurationRoot, "auth.json"), "deepseek", { type: "api_key", key: "settings-key" });
test.after(() => rmSync(configurationRoot, { recursive: true, force: true }));

function fakeChild(pid = 4321): ManagedHindsightChildProcess {
	const child = new EventEmitter() as ManagedHindsightChildProcess;
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

test("Hindsight runtime reuses a healthy local service", async () => {
	let spawns = 0;
	const manager = new HindsightRuntimeManager({
		fetcher: async (input) => {
			assert.equal(String(input), "http://127.0.0.1:18888/health");
			return new Response(JSON.stringify({ status: "healthy" }), { status: 200 });
		},
		spawnProcess: () => {
			spawns += 1;
			return fakeChild();
		},
	});

	assert.deepEqual(await manager.ensureReady(), {
		baseUrl: "http://127.0.0.1:18888/v1/default",
		owned: false,
	});
	assert.equal(spawns, 0);
	await manager.close();
});

test("Hindsight starts once even when legacy automatic-startup settings are disabled", async () => {
	const root = mkdtempSync(join(tmpdir(), "telomi-hindsight-test-"));
	const executable = join(root, ".venv", "bin", "python");
	mkdirSync(join(root, ".venv", "bin"), { recursive: true });
	writeFileSync(executable, "");
	let healthy = false;
	let spawns = 0;
	const child = fakeChild();
	const manager = new HindsightRuntimeManager({
		env: {
			TELOMI_HINDSIGHT_AUTOSTART: "0",
			TELOMI_HINDSIGHT_EXECUTABLE: join(root, ".venv", "bin", "hindsight-api"),
			HINDSIGHT_API_LLM_PROVIDER: "deepseek",
			DEEPSEEK_API_KEY: "secret",
			HINDSIGHT_API_EMBEDDINGS_OPENAI_BASE_URL: "http://127.0.0.1:11434/v1",
			HINDSIGHT_API_EMBEDDINGS_OPENAI_MODEL: "embeddinggemma:latest",
		},
		serviceRoot: root,
		fetcher: async () => new Response(null, { status: healthy ? 200 : 503 }),
		spawnProcess: (command, args, options) => {
			spawns += 1;
			healthy = true;
			assert.equal(command, executable);
			assert.match(args[0], /telomi_configuration\.py$/u);
			assert.deepEqual(args.slice(1), ["--host", "127.0.0.1", "--port", "18888"]);
			assert.match(options.env?.HINDSIGHT_API_DATABASE_URL ?? "", /^pg0:\/\/telomi-[0-9a-f]{12}$/u, "each installation gets its own pg0 instance");
			assert.equal(options.env?.HINDSIGHT_API_LLM_MODEL, "deepseek-v4-flash", "the global LLM default serves; legacy service variables are ignored");
			assert.ok(options.env?.HINDSIGHT_API_LLM_API_KEY);
			assert.notEqual(options.env?.HINDSIGHT_API_LLM_API_KEY, "secret", "the child receives a local transport token, not the upstream credential");
			assert.equal(options.env?.HINDSIGHT_API_EMBEDDINGS_PROVIDER, "local", "the managed embedding selection replaces legacy embedding values");
			assert.equal(options.env?.HINDSIGHT_API_EMBEDDINGS_LOCAL_MODEL, "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2");
			assert.equal(options.env?.HINDSIGHT_API_EMBEDDINGS_OPENAI_BASE_URL, undefined);
			assert.equal(options.env?.HINDSIGHT_API_RERANKER_PROVIDER, "local");
			assert.equal(options.env?.HINDSIGHT_API_RERANKER_LOCAL_MODEL, "cross-encoder/mmarco-mMiniLMv2-L12-H384-v1", "the managed service reranks with a multilingual cross-encoder");
			return child;
		},
		wait: async () => undefined,
	});

	try {
		const [first, second] = await Promise.all([manager.ensureReady(), manager.ensureReady()]);
		assert.equal(spawns, 1);
		assert.equal(first.owned, true);
		assert.deepEqual(second, first);
	} finally {
		await manager.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("Hindsight runtime does not manage an unavailable external endpoint", async () => {
	let spawns = 0;
	const manager = new HindsightRuntimeManager({
		env: { HINDSIGHT_URL: "https://memory.example.com/v1/default" },
		fetcher: async () => { throw new Error("unavailable"); },
		spawnProcess: () => {
			spawns += 1;
			return fakeChild();
		},
	});

	await assert.rejects(manager.ensureReady(), /external and cannot be started/);
	assert.equal(spawns, 0);
	await manager.close();
});

test("a checkout without a Hindsight Python environment reports how to install it", async () => {
	const root = mkdtempSync(join(tmpdir(), "telomi-hindsight-missing-"));
	let spawns = 0;
	const manager = new HindsightRuntimeManager({
		env: { TELOMI_HINDSIGHT_AUTOSTART: "0" },
		serviceRoot: root,
		fetcher: async () => new Response(null, { status: 503 }),
		spawnProcess: () => { spawns++; return fakeChild(); },
	});
	try {
		await assert.rejects(manager.ensureReady(), (error: Error) => {
			assert.ok(error.message.includes(join(root, ".venv", "bin", "python")));
			assert.match(error.message, /Run npm run memory:install/);
			return true;
		});
		assert.equal(spawns, 0);
	} finally {
		await manager.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("Hindsight health URL preserves an optional reverse-proxy prefix", () => {
	assert.equal(
		healthUrl("http://127.0.0.1:18888/hindsight/v1/default"),
		"http://127.0.0.1:18888/hindsight/health",
	);
});

test("close cancels an in-flight initial probe without spawning and permits a later start", async () => {
	let spawns = 0;
	let probing!: () => void;
	const entered = new Promise<void>((resolve) => { probing = resolve; });
	let healthy = false;
	const manager = new HindsightRuntimeManager({
		fetcher: async (_input, init) => {
			if (healthy) return new Response(null, { status: 200 });
			probing();
			return new Promise<Response>((_resolve, reject) => {
				init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
			});
		},
		spawnProcess: () => { spawns++; return fakeChild(); },
	});
	const starting = assert.rejects(manager.ensureReady(), /cancelled/);
	await entered;
	const closing = manager.close();
	assert.equal(manager.close(), closing);
	await assert.rejects(manager.ensureReady(), /shutting down/);
	await Promise.all([starting, closing]);
	assert.equal(spawns, 0);
	healthy = true;
	assert.equal((await manager.ensureReady()).owned, false);
	await manager.close();
});

test("close cancels a hung readiness request and waits for signal termination", async () => {
	const root = mkdtempSync(join(tmpdir(), "telomi-hindsight-cancel-"));
	const executable = join(root, "hindsight-api");
	writeFileSync(executable, "");
	const child = fakeChild();
	const signals: Array<NodeJS.Signals | number | undefined> = [];
	child.kill = (signal) => {
		signals.push(signal);
		if (signal === "SIGTERM") setImmediate(() => {
			child.signalCode = "SIGTERM";
			child.emit("exit", null, "SIGTERM");
		});
		return true;
	};
	let probing!: () => void;
	const entered = new Promise<void>((resolve) => { probing = resolve; });
	let probes = 0;
	const manager = new HindsightRuntimeManager({
		env: { TELOMI_HINDSIGHT_EXECUTABLE: executable },
		serviceRoot: root,
		spawnProcess: () => child,
		fetcher: async (_input, init) => {
			if (++probes === 1) return new Response(null, { status: 503 });
			probing();
			return new Promise<Response>((_resolve, reject) => {
				init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
			});
		},
	});
	try {
		const starting = assert.rejects(manager.ensureReady(), /failed to start/);
		await entered;
		await manager.close();
		await starting;
		assert.equal(child.signalCode, "SIGTERM");
		assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
	} finally {
		await manager.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("a service that exits during startup reports its native error without the database URL", async () => {
	const root = mkdtempSync(join(tmpdir(), "telomi-hindsight-stderr-"));
	const executable = join(root, "hindsight-api");
	writeFileSync(executable, "");
	const child = fakeChild();
	const manager = new HindsightRuntimeManager({
		env: { TELOMI_HINDSIGHT_EXECUTABLE: executable },
		serviceRoot: root,
		fetcher: async () => new Response(null, { status: 503 }),
		spawnProcess: () => {
			setImmediate(() => {
				child.stderr!.write("Traceback (most recent call last):\n  File \"x.py\"\nValueError: embedding dimension mismatch at postgresql://memory:secret-pass@127.0.0.1:5432/memory\n");
				child.exitCode = 1;
				child.emit("exit", 1, null);
			});
			return child;
		},
	});
	try {
		await assert.rejects(manager.ensureReady(), (error: Error) => {
			assert.match(error.message, /failed to start \(process \d+\): ValueError: embedding dimension mismatch at <database>$/);
			assert.ok(!error.message.includes("secret-pass"));
			return true;
		});
	} finally {
		await manager.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("a native spawn error rejects startup and releases its process exit hook", async () => {
	const root = mkdtempSync(join(tmpdir(), "telomi-hindsight-spawn-error-"));
	const executable = join(root, "not-executable");
	writeFileSync(executable, "", { mode: 0o600 });
	const listeners = process.listenerCount("exit");
	const manager = new HindsightRuntimeManager({
		env: { TELOMI_HINDSIGHT_EXECUTABLE: executable },
		serviceRoot: root,
		fetcher: async () => new Response(null, { status: 503 }),
	});
	try {
		await assert.rejects(manager.ensureReady(), /failed to start/);
		assert.equal(process.listenerCount("exit"), listeners);
	} finally {
		await manager.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("Memory embedding rejects unknown connections instead of inheriting the environment", () => {
	for (const connection of ["hindsight-environment", "unknown-connection"]) {
		assert.throws(() => memoryEmbeddingEnv({ connection, model: "old-model", baseUrl: "" }, "stored-key"), /is unknown/u);
	}
});

test("User Memory reports executing operations without starting the service", async () => {
	const root = mkdtempSync(join(tmpdir(), "telomi-hindsight-activity-"));
	mkdirSync(join(root, ".venv", "bin"), { recursive: true });
	writeFileSync(join(root, ".venv", "bin", "python"), "");
	let healthy = false;
	let spawns = 0;
	let activeOperations = 3;
	let boundaryAnswers = true;
	let becomeHealthy: (() => void) | undefined;
	const manager = new HindsightRuntimeManager({
		env: { TELOMI_HINDSIGHT_EXECUTABLE: join(root, ".venv", "bin", "hindsight-api") },
		serviceRoot: root,
		fetcher: async (input) => {
			if (new URL(String(input)).pathname === "/ext/telomi-configuration/status") {
				return boundaryAnswers
					? Response.json({ draining: false, activeOperations })
					: new Response(null, { status: 502 });
			}
			return new Response(null, { status: healthy ? 200 : 503 });
		},
		spawnProcess: () => {
			spawns += 1;
			return fakeChild();
		},
		wait: () => new Promise((resolveWait) => {
			becomeHealthy = () => {
				healthy = true;
				resolveWait();
			};
		}),
	});
	try {
		assert.equal(await manager.activeOperations(), 0, "a service that was never started runs nothing");
		assert.equal(spawns, 0, "reading the count never starts the service");
		const ready = manager.ensureReady();
		while (!becomeHealthy) await new Promise((resolveTick) => setImmediate(resolveTick));
		assert.equal(await manager.activeOperations(), null, "a starting service cannot say what it runs");
		becomeHealthy();
		assert.equal((await ready).owned, true);
		assert.equal(await manager.activeOperations(), 3);
		activeOperations = 0;
		assert.equal(await manager.activeOperations(), 0);
		boundaryAnswers = false;
		assert.equal(await manager.activeOperations(), null, "an unanswered boundary is not reported as idle");
	} finally {
		await manager.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("an external User Memory service is not interrupted by stopping Telomi", async () => {
	const manager = new HindsightRuntimeManager({
		fetcher: async () => new Response(JSON.stringify({ status: "healthy" }), { status: 200 }),
		spawnProcess: () => fakeChild(),
	});
	try {
		assert.equal((await manager.ensureReady()).owned, false);
		assert.equal(await manager.activeOperations(), 0);
	} finally {
		await manager.close();
	}
});

test("the managed Memory database stops with the service on SIGTERM, even when it was already running", async () => {
	const { execFile } = await import("node:child_process");
	const { promisify } = await import("node:util");
	const { fileURLToPath } = await import("node:url");
	const result = await promisify(execFile)(
		fileURLToPath(new URL("../../services/hindsight/.venv/bin/python", import.meta.url)),
		["-B", fileURLToPath(new URL("./memory-database-lifecycle-check.py", import.meta.url))],
		{ timeout: 60_000 },
	);
	assert.equal(result.stdout.trim(), "ok");
});
