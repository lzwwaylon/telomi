import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import type { ManagedHindsightChildProcess } from "../../server/goals/memory/hindsight-runtime.js";

const root = mkdtempSync(join(tmpdir(), "telomi-memory-embedding-"));
process.env.PI_CODING_AGENT_DIR = root;
const { HindsightRuntimeManager } = await import("../../server/goals/memory/hindsight-runtime.js");
const { hindsightEmbeddingMigrator } = await import("../../server/embedding/memory-migration.js");
const { loadSettings, saveSettings } = await import("../../server/config/settings.js");
const { writeStoredCredential } = await import("../../server/accounts/stored-credentials.js");
test.after(() => rmSync(root, { recursive: true, force: true }));

test("the migration keeps Memory Units, links and entities on real Hindsight storage across dimension changes", async () => {
	const python = fileURLToPath(new URL("../../services/hindsight/.venv/bin/python", import.meta.url));
	const result = await promisify(execFile)(python, ["-B", fileURLToPath(new URL("./memory-embedding-migration-check.py", import.meta.url))], { maxBuffer: 16 * 1024 * 1024 });
	assert.match(result.stdout, /memory embedding migration storage check passed/u);
});

test("the managed service and its migration receive the selected embedding environment and cut over drained", async () => {
	mkdirSync(root, { recursive: true });
	writeFileSync(join(root, "models.json"), JSON.stringify({ providers: { local: { api: "openai-completions", baseUrl: "http://127.0.0.1:9/v1", models: [{ id: "chat" }] }, vec: { api: "openai-completions", baseUrl: "http://127.0.0.1:9/v2", models: [] } } }));
	writeStoredCredential(join(root, "auth.json"), "local", { type: "api_key", key: "chat-key" });
	writeStoredCredential(join(root, "auth.json"), "vec", { type: "api_key", key: "vec-key" });
	saveSettings({ defaultProvider: "local", defaultModel: "chat", memoryModels: { llm: {}, retain: {}, reflect: {}, consolidation: {} },
		embedding: { default: { connection: "vec", model: "wiki-model" }, memory: { connection: "hindsight-local", model: "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2" } } });
	const executable = join(root, "hindsight-api");
	writeFileSync(executable, "");
	const spawned: Array<{ args: readonly string[]; env: NodeJS.ProcessEnv; child: ManagedHindsightChildProcess }> = [];
	let alive = false;
	let drained = false;
	let scriptExit = 0;
	let scriptOutput: string[] = [];
	const manager = new HindsightRuntimeManager({
		env: { TELOMI_HINDSIGHT_EXECUTABLE: executable, HINDSIGHT_API_EMBEDDINGS_OPENAI_MODEL: "stale-ambient", HINDSIGHT_API_DATABASE_URL: "pg0://check" },
		fetcher: async (url) => {
			if (String(url).includes("telomi-configuration")) { if (String(url).endsWith("/drain")) drained = true; return new Response(JSON.stringify({ activeOperations: 0 })); }
			return new Response(null, { status: alive ? 200 : 503 });
		},
		wait: async () => undefined,
		spawnProcess: (_command, args, options) => {
			const child = new EventEmitter() as ManagedHindsightChildProcess;
			child.exitCode = null; child.stdout = new PassThrough(); child.stderr = new PassThrough();
			spawned.push({ args, env: options.env!, child });
			if (args.some((arg) => arg.endsWith("telomi_embedding_migration.py"))) {
				assert.equal(alive || args.includes("cutover") || args.includes("estimate") || args.includes("prepare") || args.includes("abort"), true);
				child.kill = () => true;
				queueMicrotask(() => {
					for (const line of scriptOutput) child.stdout!.write(`${line}\n`);
					if (scriptExit) child.stderr!.write("Traceback (most recent call last):\n  ...\nRuntimeError: model weights missing\n");
					child.exitCode = scriptExit;
					setTimeout(() => child.emit("exit", scriptExit, null), 5);
				});
			} else {
				alive = true;
				child.kill = () => { alive = false; child.exitCode = 0; queueMicrotask(() => child.emit("exit", 0, null)); return true; };
			}
			return child;
		},
	});
	try {
		await manager.ensureReady();
		const service = spawned[0]!.env;
		assert.equal(service.HINDSIGHT_API_EMBEDDINGS_PROVIDER, "local");
		assert.equal(service.HINDSIGHT_API_EMBEDDINGS_LOCAL_MODEL, "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2");
		assert.equal(service.HINDSIGHT_API_EMBEDDINGS_OPENAI_MODEL, undefined, "legacy embedding values no longer reach the service");

		const migrator = hindsightEmbeddingMigrator(manager);
		const target = { connection: "vec", model: "new-model", dimensions: 8, baseUrl: "http://127.0.0.1:9/v2", source: "override" as const };
		scriptOutput = ['{"event": "estimate", "units": 12, "characters": 480, "dimension": 384}', '{"event": "done"}'];
		assert.deepEqual(await migrator.estimate(target), { units: 12, characters: 480 });
		const estimate = spawned.at(-1)!;
		assert.deepEqual(estimate.args.slice(-4), ["--database-url", "pg0://check", "--phase", "estimate"]);
		assert.equal(estimate.env.HINDSIGHT_API_EMBEDDINGS_PROVIDER, "openai");
		assert.equal(estimate.env.HINDSIGHT_API_EMBEDDINGS_OPENAI_MODEL, "new-model");
		assert.equal(estimate.env.HINDSIGHT_API_EMBEDDINGS_OPENAI_BASE_URL, "http://127.0.0.1:9/v2");
		assert.equal(estimate.env.HINDSIGHT_API_EMBEDDINGS_OPENAI_API_KEY, "vec-key");
		assert.equal(estimate.env.HINDSIGHT_API_EMBEDDINGS_OPENAI_DIMENSIONS, "8");
		assert.equal(estimate.env.HINDSIGHT_API_DATABASE_URL, "pg0://check");

		// The selection still serving may point at a connection the user deleted; moving off it must still work.
		const { markProviderCredentialDeleted } = await import("../../server/config/credential-tombstones.js");
		const serving = loadSettings();
		saveSettings({ ...serving, embedding: { default: { connection: "vec", model: "wiki-model" }, memory: { connection: "gone", model: "old-model" } } });
		markProviderCredentialDeleted("gone");
		scriptOutput = ['{"event": "estimate", "units": 1, "characters": 10, "dimension": 384}', '{"event": "done"}'];
		assert.deepEqual(await migrator.estimate(target), { units: 1, characters: 10 });
		assert.equal(spawned.at(-1)!.env.HINDSIGHT_API_EMBEDDINGS_OPENAI_MODEL, "new-model", "the migration speaks only the target");
		saveSettings({ ...loadSettings(), embedding: serving.embedding });

		const progress: Array<{ done: number; total: number }> = [];
		scriptOutput = ['INFO native log line', '{"event": "progress", "done": 4, "total": 12}', '{"event": "progress", "done": 12, "total": 12}', '{"event": "done"}'];
		await migrator.prepare(target, (item) => progress.push(item), new AbortController().signal);
		assert.deepEqual(progress, [{ done: 4, total: 12 }, { done: 12, total: 12 }]);
		assert.equal(alive, true, "prepare runs beside the serving service");

		scriptExit = 1; scriptOutput = [];
		await assert.rejects(migrator.prepare(target, () => undefined, new AbortController().signal), /model weights missing/u);
		scriptExit = 0;

		let committed: unknown;
		const serviceSpawnsBefore = spawned.filter((entry) => !entry.args.some((arg) => arg.endsWith("telomi_embedding_migration.py"))).length;
		await migrator.cutover(target, () => {
			assert.equal(alive, false, "the cutover runs while the service is stopped");
			assert.equal(drained, true);
			saveSettings({ ...loadSettings(), embedding: { default: { connection: "vec", model: "wiki-model" }, memory: { connection: "vec", model: "new-model", dimensions: 8 } } });
			committed = spawned.at(-1)!.args.at(-1);
		});
		assert.equal(committed, "cutover", "settings commit after the storage swap");
		const restarted = spawned.filter((entry) => !entry.args.some((arg) => arg.endsWith("telomi_embedding_migration.py")));
		assert.equal(restarted.length, serviceSpawnsBefore + 1);
		assert.equal(restarted.at(-1)!.env.HINDSIGHT_API_EMBEDDINGS_OPENAI_MODEL, "new-model", "the restarted service uses the committed selection");
		assert.equal(restarted.at(-1)!.env.HINDSIGHT_API_EMBEDDINGS_PROVIDER, "openai");
		assert.equal(manager.describeConfiguration().status, "active");

		scriptExit = 1;
		await assert.rejects(migrator.cutover(target, () => { throw new Error("commit must not run after a failed cutover"); }), /model weights missing/u);
		assert.equal(alive, true, "a failed cutover restarts the previous service");
	} finally {
		await manager.close();
	}
});

test("a cutover while the service is not running commits, then starts it with the new selection", async () => {
	const spawned: Array<{ args: readonly string[]; env: NodeJS.ProcessEnv }> = [];
	let alive = false;
	mkdirSync(root, { recursive: true });
	writeFileSync(join(root, "hindsight-api"), "");
	writeFileSync(join(root, "models.json"), JSON.stringify({ providers: { local: { api: "openai-completions", baseUrl: "http://127.0.0.1:9/v1", models: [{ id: "chat" }] } } }));
	writeStoredCredential(join(root, "auth.json"), "local", { type: "api_key", key: "chat-key" });
	// No embedding model chosen yet: the service could not start before this first selection.
	saveSettings({ defaultProvider: "local", defaultModel: "chat", memoryModels: { llm: {}, retain: {}, reflect: {}, consolidation: {} } });
	const selection = { connection: "hindsight-local", model: "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2" };
	const manager = new HindsightRuntimeManager({
		env: { TELOMI_HINDSIGHT_EXECUTABLE: join(root, "hindsight-api"), HINDSIGHT_API_DATABASE_URL: "pg0://check" },
		fetcher: async (url) => String(url).includes("telomi-configuration") ? new Response(JSON.stringify({ activeOperations: 0 })) : new Response(null, { status: alive ? 200 : 503 }),
		wait: async () => undefined,
		spawnProcess: (_command, args, options) => {
			spawned.push({ args, env: options.env! });
			const child = new EventEmitter() as ManagedHindsightChildProcess;
			child.exitCode = null; child.stdout = new PassThrough(); child.stderr = new PassThrough();
			if (args.some((arg) => arg.endsWith("telomi_embedding_migration.py"))) {
				child.kill = () => true;
				queueMicrotask(() => { child.stdout!.write('{"event": "done"}\n'); child.exitCode = 0; setTimeout(() => child.emit("exit", 0, null), 5); });
			} else {
				alive = true;
				child.kill = () => { alive = false; child.exitCode = 0; queueMicrotask(() => child.emit("exit", 0, null)); return true; };
			}
			return child;
		},
	});
	try {
		await assert.rejects(manager.ensureReady(), /Choose an embedding model for User Memory/u);
		assert.equal(manager.describeConfiguration().embeddingSelected, false);
		assert.equal(spawned.length, 0, "nothing starts without an embedding model");
		await hindsightEmbeddingMigrator(manager).cutover({ ...selection, baseUrl: "", source: "override" }, () => { saveSettings({ ...loadSettings(), embedding: { memory: selection } }); });
		// The page reads the configuration while the service is still starting; the missing selection it just resolved is no failure.
		assert.notEqual(manager.describeConfiguration().status, "failed", "a committed selection does not keep reporting the failure it resolved");
		assert.equal(manager.describeConfiguration().error, null);
		await manager.ensureReady();
		assert.deepEqual(spawned.map((entry) => entry.args.at(-1)), ["cutover", spawned[1]?.args.at(-1)]);
		assert.equal(spawned[1]!.env.HINDSIGHT_API_EMBEDDINGS_LOCAL_MODEL, selection.model, "the service starts with the committed selection");
		assert.equal(manager.describeConfiguration().embeddingSelected, true);
		assert.deepEqual([manager.describeConfiguration().status, manager.describeConfiguration().error], ["active", null], "the earlier startup failure is no longer reported");
	} finally {
		await manager.close();
	}
});
