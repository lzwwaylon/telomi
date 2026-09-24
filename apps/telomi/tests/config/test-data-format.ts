import assert from "node:assert/strict";
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
