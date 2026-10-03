import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
	CURRENT_FORMAT_VERSION,
	DATA_FORMAT_FILE,
	DataDirectoryError,
	prepareDataDirectory,
	readDataFormat,
	type DataMigration,
} from "../../server/config/data-format.js";

const quiet = () => undefined;

function scratch(context: { after(fn: () => void): void }): string {
	const root = mkdtempSync(join(tmpdir(), "telomi-data-format-"));
	context.after(() => rmSync(root, { recursive: true, force: true }));
	return root;
}

test("a missing configured directory is refused without creating anything", async (context) => {
	const root = scratch(context);
	const dataDir = join(root, "unmounted-volume", "telomi-data");
	await assert.rejects(
		prepareDataDirectory(dataDir, { defaultDir: join(root, "default"), log: quiet }),
		(error) => error instanceof DataDirectoryError && /does not exist/u.test(error.message),
	);
	assert.deepEqual(readdirSync(root), []);
});

test("the checkout's default directory is created on first start", async (context) => {
	const dataDir = join(scratch(context), "data");
	const format = await prepareDataDirectory(dataDir, { defaultDir: dataDir, log: quiet });
	assert.equal(format.formatVersion, CURRENT_FORMAT_VERSION);
	assert.deepEqual(readDataFormat(dataDir), format);
});

test("an existing empty directory is a new installation in the current layout", async (context) => {
	const dataDir = scratch(context);
	const ran: string[] = [];
	const migrations: DataMigration[] = [{ name: "never", run: () => void ran.push("never") }];
	const format = await prepareDataDirectory(dataDir, { defaultDir: join(dataDir, "other"), migrations, log: quiet });
	assert.equal(format.formatVersion, 2);
	assert.deepEqual(ran, [], "nothing to migrate in a new directory");
	assert.match(format.installationId, /^[0-9a-f-]{36}$/u);
	assert.deepEqual(readdirSync(dataDir), [DATA_FORMAT_FILE]);
});

test("an unmarked existing installation is adopted as version 1 without touching its files", async (context) => {
	const dataDir = scratch(context);
	mkdirSync(join(dataDir, "goal_x"));
	writeFileSync(join(dataDir, "goals.json"), "[]\n");
	const messages: string[] = [];
	const format = await prepareDataDirectory(dataDir, { migrations: [], log: (message) => messages.push(message) });
	assert.equal(format.formatVersion, 1);
	assert.equal(readFileSync(join(dataDir, "goals.json"), "utf8"), "[]\n");
	assert.match(messages.join("\n"), /adopted as format version 1/u);
	// Identity is stable across restarts.
	assert.deepEqual(await prepareDataDirectory(dataDir, { migrations: [], log: quiet }), format);
});

test("data newer than the code is refused before any migration runs", async (context) => {
	const dataDir = scratch(context);
	const marker = { formatVersion: CURRENT_FORMAT_VERSION + 1, installationId: "future" };
	writeFileSync(join(dataDir, DATA_FORMAT_FILE), JSON.stringify(marker));
	await assert.rejects(
		prepareDataDirectory(dataDir, { log: quiet }),
		(error) => error instanceof DataDirectoryError && /written by a newer Telomi/u.test(error.message),
	);
	assert.deepEqual(JSON.parse(readFileSync(join(dataDir, DATA_FORMAT_FILE), "utf8")), marker);
});

test("an unreadable marker is refused rather than replaced", async (context) => {
	const dataDir = scratch(context);
	writeFileSync(join(dataDir, DATA_FORMAT_FILE), "{");
	await assert.rejects(prepareDataDirectory(dataDir, { log: quiet }), DataDirectoryError);
	writeFileSync(join(dataDir, DATA_FORMAT_FILE), JSON.stringify({ formatVersion: 0, installationId: "x" }));
	await assert.rejects(prepareDataDirectory(dataDir, { log: quiet }), DataDirectoryError);
});

test("migrations run in order and the version advances only after each succeeds", async (context) => {
	const dataDir = scratch(context);
	writeFileSync(join(dataDir, "goals.json"), "[]\n");
	await prepareDataDirectory(dataDir, { migrations: [], log: quiet });
	const ran: string[] = [];
	let failSecond = true;
	const migrations: DataMigration[] = [
		{ name: "first", run: () => void ran.push("first") },
		{ name: "second", run: () => {
			if (failSecond) throw new Error("disk full");
			ran.push("second");
		} },
	];
	await assert.rejects(prepareDataDirectory(dataDir, { migrations, log: quiet }), /disk full/u);
	assert.equal(readDataFormat(dataDir)?.formatVersion, 2);

	failSecond = false;
	const format = await prepareDataDirectory(dataDir, { migrations, log: quiet });
	assert.equal(format.formatVersion, 3);
	assert.deepEqual(ran, ["first", "second"]);
});

test("the server entrypoint refuses a missing data directory before loading the app", (context) => {
	const root = scratch(context);
	const dataDir = join(root, "NotMounted", "telomi-data");
	const result = spawnSync(process.execPath, ["--import", "tsx", "server/index.ts"], {
		cwd: new URL("../..", import.meta.url),
		env: { ...process.env, TELOMI_DATA_DIR: dataDir },
		encoding: "utf8",
		timeout: 60_000,
	});
	assert.equal(result.status, 1, result.stderr);
	assert.match(result.stderr, /Data directory .* does not exist/u);
	assert.equal(existsSync(join(root, "NotMounted")), false);
});

test("format 4 model preferences migrate atomically to canonical names without changing evidence", async (context) => {
	const dataDir = scratch(context);
	const agentDir = join(dataDir, ".pi", "agent");
	mkdirSync(agentDir, { recursive: true });
	const marker = { formatVersion: 4, installationId: "canonical-settings" };
	writeFileSync(join(dataDir, DATA_FORMAT_FILE), JSON.stringify(marker));
	const settingsPath = join(agentDir, "settings.json");
	const unrelated = { defaultModel: "provider/default", taskModels: { primeRoot: "provider/root" }, speech: { voice: "kept" } };
	writeFileSync(settingsPath, JSON.stringify({ ...unrelated,
		taskModels: { ...unrelated.taskModels, cornellNote: "provider/note", wikiMaintainer: "provider/wiki" },
		stageThinkingLevels: { "cornellNote.evidenceNote": { level: "medium" }, "wikiMaintainer.maintenance": { level: "high" }, "primeRoot.reportWriter": { level: "low" } },
	}));
	const evidencePath = join(dataDir, "case-artifact.json");
	writeFileSync(evidencePath, '{"actor":"cornell_note","ref":"deep-search:original:cue-1"}\n');
	const digest = () => createHash("sha256").update(readFileSync(evidencePath)).digest("hex");
	const hash = digest();
	assert.deepEqual(await prepareDataDirectory(dataDir, { log: quiet }), { ...marker, formatVersion: 5 });
	assert.deepEqual(JSON.parse(readFileSync(settingsPath, "utf8")), { ...unrelated,
		taskModels: { ...unrelated.taskModels, noteAgent: "provider/note", wikiCurator: "provider/wiki" },
		stageThinkingLevels: { "noteAgent.evidenceNote": { level: "medium" }, "wikiCurator.maintenance": { level: "high" }, "primeRoot.reportWriter": { level: "low" } },
	});
	assert.equal(digest(), hash);
	const migrated = readFileSync(settingsPath, "utf8");
	// The settings rename succeeded but the process crashed before the format marker advanced.
	writeFileSync(join(dataDir, DATA_FORMAT_FILE), JSON.stringify(marker));
	await prepareDataDirectory(dataDir, { log: quiet });
	assert.equal(readFileSync(settingsPath, "utf8"), migrated);
	assert.equal(digest(), hash);
	assert.deepEqual(readdirSync(agentDir), ["settings.json"]);
});

test("conflicting canonical model preferences block migration without writing either file", async (context) => {
	for (const preferences of [
		{ taskModels: { cornellNote: "provider/old", noteAgent: "provider/new" } },
		{ stageThinkingLevels: { "wikiMaintainer.maintenance": { level: "medium" }, "wikiCurator.maintenance": { level: "high" } } },
	]) {
		const dataDir = scratch(context);
		const agentDir = join(dataDir, ".pi", "agent");
		mkdirSync(agentDir, { recursive: true });
		const marker = JSON.stringify({ formatVersion: 4, installationId: "conflict" });
		writeFileSync(join(dataDir, DATA_FORMAT_FILE), marker);
		const raw = JSON.stringify(preferences);
		const path = join(agentDir, "settings.json");
		writeFileSync(path, raw);
		await assert.rejects(prepareDataDirectory(dataDir, { log: quiet }), /conflicts with/u);
		assert.equal(readFileSync(path, "utf8"), raw);
		assert.equal(readFileSync(join(dataDir, DATA_FORMAT_FILE), "utf8"), marker);
		assert.deepEqual(readdirSync(agentDir), ["settings.json"]);
	}
});

test("equal canonical preferences merge without losing unrelated settings", async (context) => {
	const dataDir = scratch(context);
	const agentDir = join(dataDir, ".pi", "agent");
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(join(dataDir, DATA_FORMAT_FILE), JSON.stringify({ formatVersion: 4, installationId: "same" }));
	const path = join(agentDir, "settings.json");
	writeFileSync(path, JSON.stringify({ taskModels: { cornellNote: "provider/note", noteAgent: "provider/note" }, custom: 42 }));
	await prepareDataDirectory(dataDir, { log: quiet });
	assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { taskModels: { noteAgent: "provider/note" }, custom: 42 });
});

test("format 5 canonicalizes mutable Wiki control jobs across Goals without rewriting captured evidence", async (context) => {
	const dataDir = scratch(context);
	const marker = { formatVersion: 4, installationId: "wiki-jobs" };
	writeFileSync(join(dataDir, DATA_FORMAT_FILE), JSON.stringify(marker));
	const save = (path: string, value: unknown) => {
		mkdirSync(join(path, ".."), { recursive: true });
		writeFileSync(path, JSON.stringify(value));
	};
	const base = { schema_version: 1, goal_id: "goal_a", run_id: "run_a", attempts: 2,
		cornell_notes: { relative_path: "artifacts/input/cornell-notes.json", sha256: "a".repeat(64), byte_length: 12 },
		started_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:01:00Z" };
	const paths = [
		join(dataDir, ".pi/runtime/harness/goal_a/runs/run_a/wiki-update-job.json"),
		join(dataDir, ".pi/runtime/harness/goal_b/wiki-updates/update_b/wiki-update-job.json"),
	];
	const jobs = [{ ...base, compiler: "legacy", status: "interrupted" },
		{ ...base, goal_id: "goal_b", compiler: "note-first", status: "succeeded", finished_at: "2026-01-01T00:02:00Z" }];
	paths.forEach((path, index) => save(path, jobs[index]));
	const frozenPaths = [
		join(dataDir, ".pi/runtime/harness/goal_a/runs/run_a/artifacts/wiki-update-job.json"),
		join(dataDir, ".pi/runtime/harness/goal_a/evaluation/imported-cases/case/wiki-update-job.json"),
		join(dataDir, "goal_a/wiki/editions/edition/wiki-update-job.json"),
	];
	frozenPaths.forEach((path) => save(path, jobs[0]));
	const hashes = frozenPaths.map((path) => createHash("sha256").update(readFileSync(path)).digest("hex"));
	await prepareDataDirectory(dataDir, { log: quiet });
	paths.forEach((path, index) => assert.deepEqual(JSON.parse(readFileSync(path, "utf8")),
		{ ...jobs[index], compiler: index ? "wiki-compilation" : "shards" }));
	// A crash may leave only the first replacement finished while the format marker remains at 4.
	save(paths[1]!, jobs[1]);
	writeFileSync(join(dataDir, DATA_FORMAT_FILE), JSON.stringify(marker));
	await prepareDataDirectory(dataDir, { log: quiet });
	assert.equal(JSON.parse(readFileSync(paths[1]!, "utf8")).compiler, "wiki-compilation");
	frozenPaths.forEach((path, index) => assert.equal(createHash("sha256").update(readFileSync(path)).digest("hex"), hashes[index]));
});
