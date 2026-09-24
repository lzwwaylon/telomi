import assert from "node:assert/strict";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { copyTree, moveInstallationState, moveTree, pg0InstanceName } from "../../server/config/data-layout.js";
import { memoryDatabaseDir, memoryDatabaseUrl } from "../../server/goals/memory/hindsight-runtime.js";

function scratch(context: { after(fn: () => void): void }): string {
	const root = mkdtempSync(join(tmpdir(), "telomi-data-layout-"));
	context.after(() => rmSync(root, { recursive: true, force: true }));
	return root;
}

test("pg0 instance names are read the way Hindsight parses them", () => {
	assert.equal(pg0InstanceName("pg0"), "hindsight");
	assert.equal(pg0InstanceName("pg0://telomi-0123456789ab"), "telomi-0123456789ab");
	assert.equal(pg0InstanceName("pg0://telomi-worktree-x:5433"), "telomi-worktree-x");
	assert.equal(pg0InstanceName("pg0://user:secret@memory:5433"), "memory");
	assert.equal(pg0InstanceName("postgresql://user@host/db"), undefined);
});

test("a move never overwrites an existing target, and replaces only an empty one", (context) => {
	const root = scratch(context);
	mkdirSync(join(root, "source/nested"), { recursive: true });
	writeFileSync(join(root, "source/nested/file"), "state");
	mkdirSync(join(root, "occupied"));
	writeFileSync(join(root, "occupied/other"), "other");
	moveTree(join(root, "source"), join(root, "occupied"), "copy");
	assert.equal(readFileSync(join(root, "source/nested/file"), "utf8"), "state", "source kept when the target holds files");

	mkdirSync(join(root, "empty/hub"), { recursive: true });
	moveTree(join(root, "source"), join(root, "empty"), "copy");
	assert.equal(readFileSync(join(root, "empty/nested/file"), "utf8"), "state");
	assert.equal(existsSync(join(root, "source")), false);

	mkdirSync(join(root, "linked"));
	symlinkSync(join(root, "empty"), join(root, "linked/hub"));
	mkdirSync(join(root, "again"));
	moveTree(join(root, "again"), join(root, "linked"), "copy");
	assert.equal(existsSync(join(root, "again")), true, "a symbolic link counts as content");
});

test("a copy across file systems keeps permissions and links, and replaces an unfinished one", (context) => {
	const root = scratch(context);
	const source = join(root, "postgres");
	mkdirSync(join(source, "base"), { recursive: true, mode: 0o700 });
	chmodSync(source, 0o700);
	writeFileSync(join(source, "base/1"), "page");
	symlinkSync("base", join(source, "link"));
	mkdirSync(join(root, "copy.partial"));
	writeFileSync(join(root, "copy.partial/stale"), "crashed copy");
	copyTree(source, join(root, "copy"));
	assert.equal(statSync(join(root, "copy")).mode & 0o777, 0o700, "PostgreSQL refuses a data directory others can read");
	assert.equal(readFileSync(join(root, "copy/base/1"), "utf8"), "page");
	assert.equal(lstatSync(join(root, "copy/link")).isSymbolicLink() && readlinkSync(join(root, "copy/link")), "base");
	assert.equal(existsSync(join(root, "copy/stale")), false);
	assert.equal(existsSync(join(root, "copy.partial")), false);
	assert.equal(readFileSync(join(source, "base/1"), "utf8"), "page", "the original is kept");
});

function installation(context: { after(fn: () => void): void }) {
	const root = scratch(context);
	const dataDir = join(root, "data");
	const python = join(root, "bin/python");
	const stops = join(root, "stops");
	mkdirSync(join(root, "bin"), { recursive: true });
	// Records each pg0 stop; exit 0 means the instance is stopped.
	writeFileSync(python, `#!/bin/sh\necho "$3" >> ${stops}\nexit 0\n`);
	chmodSync(python, 0o755);
	const env: NodeJS.ProcessEnv = {
		TELOMI_DATA_DIR: dataDir, TELOMI_CACHE_DIR: join(root, "cache"), HOME: join(root, "home"), TELOMI_HINDSIGHT_EXECUTABLE: python,
	};
	const legacyBrowser = { profileDir: join(root, "checkout/.chrome-debug-profile"), stateDir: join(root, "checkout/.chrome-debug") };
	const pg0 = (url?: string) => join(env.HOME!, ".pg0/instances", pg0InstanceName(memoryDatabaseUrl({ ...env, HINDSIGHT_API_DATABASE_URL: url }))!);
	const stopped = () => existsSync(stops) ? readFileSync(stops, "utf8").trim().split("\n") : [];
	mkdirSync(dataDir, { recursive: true });
	writeFileSync(join(dataDir, "goals.json"), "[]\n");
	return { root, dataDir, env, legacyBrowser, pg0, stopped };
}

test("format version 2 moves the checkout's memory, browser and caches into place, and is safe to re-run", async (context) => {
	const { root, dataDir, env, legacyBrowser, pg0, stopped } = installation(context);
	mkdirSync(join(pg0(), "data"), { recursive: true });
	writeFileSync(join(pg0(), "data/PG_VERSION"), "18\n");
	mkdirSync(join(legacyBrowser.profileDir, "Default"), { recursive: true });
	writeFileSync(join(legacyBrowser.profileDir, "Default/Cookies"), "logins");
	const legacyCaches = join(dataDir, ".pi/runtime/research-source-service");
	mkdirSync(join(legacyCaches, "huggingface/hub"), { recursive: true });
	writeFileSync(join(legacyCaches, "huggingface/hub/model"), "weights");
	mkdirSync(join(legacyCaches, "material-cache"), { recursive: true });
	writeFileSync(join(legacyCaches, "material-cache/entry"), "material");

	const checkout = { TELOMI_DATA_DIR: dataDir };
	await moveInstallationState(dataDir, env, checkout, legacyBrowser);
	assert.equal(readFileSync(join(memoryDatabaseDir(dataDir), "PG_VERSION"), "utf8"), "18\n");
	assert.deepEqual(stopped(), [pg0InstanceName(memoryDatabaseUrl(env))], "the cluster is stopped before its files move");
	assert.equal(readFileSync(join(dataDir, "browser-profile/Default/Cookies"), "utf8"), "logins");
	assert.equal(readFileSync(join(root, "cache/huggingface/hub/model"), "utf8"), "weights");
	assert.equal(readFileSync(join(root, "cache/material-cache/entry"), "utf8"), "material");
	assert.equal(readFileSync(join(dataDir, "goals.json"), "utf8"), "[]\n");

	// A crash before the version is recorded runs the step again; everything is already in place.
	await moveInstallationState(dataDir, env, checkout, legacyBrowser);
	assert.equal(readFileSync(join(memoryDatabaseDir(dataDir), "PG_VERSION"), "utf8"), "18\n");
	assert.equal(stopped().length, 1);
});

test("a process pointed at another data directory never takes the checkout's state", async (context) => {
	const { dataDir, env, legacyBrowser, pg0, stopped } = installation(context);
	// The checkout's own configuration names its data directory and its memory instance.
	const url = "pg0://telomi-worktree-other:5433";
	mkdirSync(join(pg0(url), "data"), { recursive: true });
	mkdirSync(legacyBrowser.profileDir, { recursive: true });
	await moveInstallationState(dataDir, { ...env, HINDSIGHT_API_DATABASE_URL: url }, { TELOMI_DATA_DIR: "/checkout/data" }, legacyBrowser);
	assert.deepEqual(stopped(), [], "another installation's database is not even stopped");
	assert.equal(existsSync(memoryDatabaseDir(dataDir)), false);
	assert.equal(existsSync(legacyBrowser.profileDir), true);
});

test("memory already recorded elsewhere belongs to that installation", async (context) => {
	const { dataDir, env, pg0, stopped } = installation(context);
	mkdirSync(join(pg0(), "data"), { recursive: true });
	writeFileSync(join(pg0(), "instance.json"), JSON.stringify({ data_dir: "/elsewhere/user-memory/postgres" }));
	await moveInstallationState(dataDir, env, { TELOMI_DATA_DIR: dataDir });
	assert.deepEqual(stopped(), []);
	assert.equal(existsSync(memoryDatabaseDir(dataDir)), false);
});

test("format version 2 leaves any directory other than the configured one untouched", async (context) => {
	const { root, env } = installation(context);
	const other = join(root, "other");
	mkdirSync(join(other, ".pi/runtime/research-source-service/material-cache"), { recursive: true });
	await moveInstallationState(other, env, { TELOMI_DATA_DIR: other });
	assert.equal(existsSync(join(other, ".pi/runtime/research-source-service/material-cache")), true);
});
