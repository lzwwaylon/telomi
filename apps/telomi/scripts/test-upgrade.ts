import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { resolveBackupDir, upgradeInProgress, upgradeMarkerPath } from "../server/config/data-dir.js";
import {
	assertClean,
	dataFormatChanged,
	listSnapshots,
	parseOptions,
	pruneSnapshots,
	resolveTarget,
	restoreSnapshot,
	SNAPSHOT_LIMITS,
	takeSnapshot,
	trackBusy,
	UpgradeError,
	type Installation,
} from "./upgrade.js";

function scratch(context: { after(fn: () => void): void }): string {
	const root = mkdtempSync(join(tmpdir(), "telomi-upgrade-"));
	context.after(() => rmSync(root, { recursive: true, force: true }));
	return root;
}

function install(root: string, formatVersion = 2): Installation {
	const dataDir = join(root, "data");
	mkdirSync(join(dataDir, "user-memory", "postgres"), { recursive: true, mode: 0o700 });
	writeFileSync(join(dataDir, "format.json"), JSON.stringify({ formatVersion, installationId: "id" }));
	writeFileSync(join(dataDir, "goals.json"), "[\"before\"]\n");
	return { repoRoot: root, dataDir, backupDir: join(root, "backups"), marker: join(root, "backups", ".upgrade-in-progress"), baseUrl: "http://127.0.0.1:1", env: {} };
}

function gitRepo(root: string): (...args: string[]) => string {
	const git = (...args: string[]) => {
		const result = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: root, encoding: "utf8" });
		assert.equal(result.status, 0, result.stderr);
		return result.stdout.trim();
	};
	git("init", "--quiet", "-b", "dev");
	writeFileSync(join(root, "tracked.txt"), "1\n");
	git("add", ".");
	git("commit", "--quiet", "-m", "one");
	return git;
}

test("options reject combinations that would do something other than asked", () => {
	assert.deepEqual(parseOptions(["--ref", "dev", "--if-idle"]), { ref: "dev", ifIdle: true, snapshotOnly: false, rollback: false });
	assert.equal(parseOptions(["--ref=v1.2.3"]).ref, "v1.2.3");
	assert.throws(() => parseOptions(["--rollback", "--ref", "dev"]), UpgradeError);
	assert.throws(() => parseOptions(["--snapshot-only", "--ref", "dev"]), UpgradeError);
	assert.throws(() => parseOptions(["--ref="]), UpgradeError);
	assert.throws(() => parseOptions(["--force"]), UpgradeError);
});

test("the default target is the highest published Release tag, not a prerelease", (context) => {
	const root = scratch(context);
	const git = gitRepo(root);
	for (const tag of ["v0.0.2", "v0.0.10", "v0.1.0-rc.1", "not-a-release"]) git("tag", tag);
	assert.deepEqual(resolveTarget(root), { commit: git("rev-parse", "HEAD"), label: "v0.0.10" });
	assert.equal(resolveTarget(root, "dev").commit, git("rev-parse", "HEAD"));
	assert.throws(() => resolveTarget(root, "missing"), /Unknown ref missing/u);
	rmSync(join(root, ".git"), { recursive: true });
	gitRepo(root);
	assert.throws(() => resolveTarget(root), /No published Release/u);
});

test("local changes to tracked files stop an upgrade; untracked files do not", (context) => {
	const root = scratch(context);
	gitRepo(root);
	writeFileSync(join(root, "untracked.txt"), "x");
	assertClean(root);
	writeFileSync(join(root, "tracked.txt"), "2\n");
	assert.throws(() => assertClean(root), /local changes/u);
});

test("a snapshot is a complete, private copy that records its code and data format", (context) => {
	const target = install(scratch(context));
	const snapshot = takeSnapshot(target, "upgrade", "abcdef0123456789", new Date("2026-09-24T01:02:03.456Z"));
	assert.equal(snapshot.path, join(target.backupDir, "upgrade-20260924T010203Z-abcdef012345"));
	assert.equal(readFileSync(join(snapshot.path, "data", "goals.json"), "utf8"), "[\"before\"]\n");
	assert.equal(statSync(join(snapshot.path, "data", "user-memory", "postgres")).mode & 0o777, 0o700);
	assert.deepEqual(listSnapshots(target.backupDir), [{ ...snapshot }]);
	assert.equal(snapshot.formatVersion, 2);
});

test("pruning keeps the newest snapshots of each kind and removes unfinished copies", (context) => {
	const target = install(scratch(context));
	const at = (minute: number) => new Date(Date.UTC(2026, 8, 24, 0, minute));
	for (let minute = 0; minute < SNAPSHOT_LIMITS.upgrade + 2; minute++) takeSnapshot(target, "upgrade", `u${String(minute).padStart(2, "0")}`, at(minute));
	for (let minute = 0; minute < SNAPSHOT_LIMITS.daily + 2; minute++) takeSnapshot(target, "daily", `d${String(minute).padStart(2, "0")}`, at(30 + minute));
	mkdirSync(join(target.backupDir, "upgrade-crashed.partial"));
	writeFileSync(join(target.backupDir, "upgrade-crashed.partial", "snapshot.json"), "{}");

	assert.equal(pruneSnapshots(target.backupDir).length, 5);
	const left = listSnapshots(target.backupDir);
	assert.equal(left.filter((snapshot) => snapshot.kind === "upgrade").length, SNAPSHOT_LIMITS.upgrade);
	assert.equal(left.filter((snapshot) => snapshot.kind === "daily").length, SNAPSHOT_LIMITS.daily);
	assert.ok(left.every((snapshot) => !["u00", "u01", "d00", "d01"].includes(snapshot.commit)));
	assert.ok(!readdirSync(target.backupDir).some((name) => name.endsWith(".partial")));
});

test("restoring a snapshot moves the replaced data aside instead of overwriting it", (context) => {
	const target = install(scratch(context), 2);
	const snapshot = takeSnapshot(target, "upgrade", "abcdef0123456789");
	assert.equal(dataFormatChanged(target, snapshot), false);

	writeFileSync(join(target.dataDir, "format.json"), JSON.stringify({ formatVersion: 3, installationId: "id" }));
	writeFileSync(join(target.dataDir, "goals.json"), "[\"after\"]\n");
	assert.equal(dataFormatChanged(target, snapshot), true);

	const aside = restoreSnapshot(target, snapshot, new Date("2026-09-24T05:00:00Z"));
	assert.equal(aside, `${target.dataDir}.replaced-20260924T050000Z`);
	assert.equal(readFileSync(join(aside, "goals.json"), "utf8"), "[\"after\"]\n");
	assert.equal(readFileSync(join(target.dataDir, "goals.json"), "utf8"), "[\"before\"]\n");
	assert.ok(existsSync(join(snapshot.path, "data", "goals.json")));
});

test("an unreadable format marker counts as changed data", (context) => {
	const target = install(scratch(context));
	const snapshot = takeSnapshot(target, "upgrade", "abcdef0123456789");
	writeFileSync(join(target.dataDir, "format.json"), "{");
	assert.equal(dataFormatChanged(target, snapshot), true);
});

test("a busy streak is measured from its first skipped run and cleared when idle", (context) => {
	const state = join(scratch(context), "upgrade-state.json");
	const start = Date.UTC(2026, 8, 24);
	assert.equal(trackBusy(state, true, start), 0);
	assert.equal(trackBusy(state, true, start + 25 * 3_600_000), 25 * 3_600_000);
	assert.equal(trackBusy(state, false, start + 26 * 3_600_000), 0);
	assert.equal(existsSync(state), false);
	assert.equal(trackBusy(state, true, start + 27 * 3_600_000), 0);
});

test("the server sees an upgrade in progress only while that upgrade is alive", (context) => {
	const root = scratch(context);
	const env = { TELOMI_DATA_DIR: join(root, "data") };
	assert.equal(resolveBackupDir(env), join(root, "backups"));
	assert.equal(upgradeInProgress(env), undefined);
	mkdirSync(join(root, "backups"));
	writeFileSync(upgradeMarkerPath(env), String(process.pid));
	assert.equal(upgradeInProgress(env), process.pid);
	const exited = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" });
	writeFileSync(upgradeMarkerPath(env), exited.stdout);
	assert.equal(upgradeInProgress(env), undefined);
	assert.equal(resolveBackupDir({ ...env, TELOMI_BACKUP_DIR: join(root, "elsewhere") }), join(root, "elsewhere"));
});
