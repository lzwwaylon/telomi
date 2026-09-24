import assert from "node:assert/strict";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { copyTree, moveInstallationStateIntoDataDirectory, moveTree, pg0InstanceName } from "../../server/config/data-layout.js";
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

test("format version 2 moves memory and caches of the configured installation, and is safe to re-run", async (context) => {
	const root = scratch(context);
	const dataDir = join(root, "data");
	const cacheDir = join(root, "cache");
	const home = join(root, "home");
	const python = join(root, "bin/python");
	mkdirSync(join(root, "bin"), { recursive: true });
	writeFileSync(python, "#!/bin/sh\nexit 0\n");
	chmodSync(python, 0o755);
	const saved = { ...process.env };
	context.after(() => { process.env = saved; });
	Object.assign(process.env, {
		TELOMI_DATA_DIR: dataDir, TELOMI_CACHE_DIR: cacheDir, HOME: home, TELOMI_HINDSIGHT_EXECUTABLE: python,
		// Keeps the checkout's own managed browser out of this scratch installation.
		TELOMI_EVAL_INSTANCE: "1",
	});
	for (const name of ["HINDSIGHT_API_DATABASE_URL", "SOURCE_SERVICE_HF_HOME", "SOURCE_SERVICE_MATERIAL_CACHE_ROOT"]) delete process.env[name];

	const instance = join(home, ".pg0/instances", pg0InstanceName(memoryDatabaseUrl())!);
	mkdirSync(join(instance, "data"), { recursive: true });
	writeFileSync(join(instance, "data/PG_VERSION"), "18\n");
	const legacyCaches = join(dataDir, ".pi/runtime/research-source-service");
	mkdirSync(join(legacyCaches, "huggingface/hub"), { recursive: true });
	writeFileSync(join(legacyCaches, "huggingface/hub/model"), "weights");
	mkdirSync(join(legacyCaches, "material-cache"), { recursive: true });
	writeFileSync(join(legacyCaches, "material-cache/entry"), "material");
	writeFileSync(join(dataDir, "goals.json"), "[]\n");

	await moveInstallationStateIntoDataDirectory.run(dataDir);
	assert.equal(readFileSync(join(memoryDatabaseDir(dataDir), "PG_VERSION"), "utf8"), "18\n");
	assert.equal(readFileSync(join(cacheDir, "huggingface/hub/model"), "utf8"), "weights");
	assert.equal(readFileSync(join(cacheDir, "material-cache/entry"), "utf8"), "material");
	assert.equal(readFileSync(join(dataDir, "goals.json"), "utf8"), "[]\n");

	// A crash before the version is recorded runs the step again; everything is already in place.
	await moveInstallationStateIntoDataDirectory.run(dataDir);
	assert.equal(readFileSync(join(memoryDatabaseDir(dataDir), "PG_VERSION"), "utf8"), "18\n");
});

test("format version 2 leaves any directory other than the configured one untouched", async (context) => {
	const root = scratch(context);
	const saved = { ...process.env };
	context.after(() => { process.env = saved; });
	process.env.TELOMI_DATA_DIR = join(root, "configured");
	const other = join(root, "other");
	mkdirSync(join(other, ".pi/runtime/research-source-service/material-cache"), { recursive: true });
	await moveInstallationStateIntoDataDirectory.run(other);
	assert.equal(existsSync(join(other, ".pi/runtime/research-source-service/material-cache")), true);
});
