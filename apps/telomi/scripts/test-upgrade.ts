import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { resolveBackupDir } from "../server/config/data-dir.js";
import { installationBackupDir, upgradeInProgress, upgradeMarkerPath } from "../server/config/data-format.js";
import {
	assertClean,
	checkout,
	checksVerdict,
	githubRepository,
	installation,
	launchAgentPath,
	launchdHooks,
	reportFlatSnapshots,
	serviceLabel,
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
	assert.deepEqual(parseOptions(["--ref", "dev", "--if-idle", "--require-checks"]), { ref: "dev", ifIdle: true, snapshotOnly: false, rollback: false, requireChecks: true });
	assert.equal(parseOptions(["--ref=v1.2.3"]).ref, "v1.2.3");
	assert.throws(() => parseOptions(["--rollback", "--ref", "dev"]), UpgradeError);
	assert.throws(() => parseOptions(["--snapshot-only", "--ref", "dev"]), UpgradeError);
	assert.throws(() => parseOptions(["--ref="]), UpgradeError);
	assert.throws(() => parseOptions(["--force"]), UpgradeError);
	assert.throws(() => parseOptions(["--snapshot-only", "--require-checks"]), UpgradeError);
	assert.throws(() => parseOptions(["--rollback", "--require-checks"]), UpgradeError);
});

test("a commit is ready only when all of its checks finished without failing", () => {
	const run = (name: string, status: string, conclusion: string | null) => ({ name, status, conclusion });
	assert.equal(checksVerdict([]).passed, false);
	assert.equal(checksVerdict([run("tests", "completed", "success"), run("build", "in_progress", null)]).passed, false);
	assert.match(checksVerdict([run("tests", "completed", "failure")]).reason, /failed: tests \(failure\)/u);
	assert.equal(checksVerdict([run("tests", "completed", "success"), run("lint", "completed", "skipped")]).passed, true);
	assert.equal(githubRepository("git@github.com:owner/repo.git"), "owner/repo");
	assert.equal(githubRepository("https://github.com/owner/repo"), "owner/repo");
	assert.equal(githubRepository("https://gitlab.com/owner/repo.git"), undefined);
});

test("an installed service becomes the supervisor unless stop and start are configured", (context) => {
	const root = scratch(context);
	const appRoot = join(root, "apps", "telomi");
	mkdirSync(appRoot, { recursive: true });
	const home = join(root, "home");
	const hooks = launchdHooks(root, 501, home);
	assert.match(hooks.stop, /^launchctl bootout gui\/501\/com\.telomi\.[0-9a-f]{12}\.server$/u);
	assert.match(hooks.start, /^launchctl enable .+ && launchctl bootstrap gui\/501 '.+\.server\.plist'$/u);
	assert.notEqual(serviceLabel(root), serviceLabel(appRoot));
	assert.equal(checkout(appRoot, { HOME: home }).env.TELOMI_SERVICE_STOP, undefined);
	const plist = launchAgentPath(`${serviceLabel(root)}.server`, home);
	mkdirSync(dirname(plist), { recursive: true });
	writeFileSync(plist, "");
	assert.equal(checkout(appRoot, { HOME: home }).env.TELOMI_SERVICE_STOP?.startsWith("launchctl bootout"), true);
	assert.equal(checkout(appRoot, { HOME: home, TELOMI_SERVICE_STOP: "custom" }).env.TELOMI_SERVICE_STOP, "custom");
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

test("pruning keeps the newest snapshots of each kind and replaced data directory, and removes unfinished copies", (context) => {
	const target = install(scratch(context));
	const at = (minute: number) => new Date(Date.UTC(2026, 8, 24, 0, minute));
	for (let minute = 0; minute < SNAPSHOT_LIMITS.upgrade + 2; minute++) takeSnapshot(target, "upgrade", `u${String(minute).padStart(2, "0")}`, at(minute));
	for (let minute = 0; minute < SNAPSHOT_LIMITS.daily + 2; minute++) takeSnapshot(target, "daily", `d${String(minute).padStart(2, "0")}`, at(30 + minute));
	mkdirSync(join(target.backupDir, "upgrade-crashed.partial"));
	writeFileSync(join(target.backupDir, "upgrade-crashed.partial", "snapshot.json"), "{}");
	for (const time of ["20260901T000000Z", "20260910T000000Z", "20260920T000000Z"]) mkdirSync(`${target.dataDir}.replaced-${time}`);

	const removed = pruneSnapshots(target);
	assert.equal(removed.length, 7);
	assert.ok(removed.includes(`${target.dataDir}.replaced-20260901T000000Z`) && removed.includes(`${target.dataDir}.replaced-20260910T000000Z`));
	assert.ok(existsSync(`${target.dataDir}.replaced-20260920T000000Z`), "the newest replaced data directory is kept as evidence");
	assert.ok(existsSync(target.dataDir));
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

function marked(dataDir: string, installationId: string): void {
	mkdirSync(dataDir, { recursive: true });
	writeFileSync(join(dataDir, "format.json"), JSON.stringify({ formatVersion: 2, installationId }));
}

test("the server sees an upgrade in progress only while that upgrade of its own installation is alive", (context) => {
	const root = scratch(context);
	const env = { TELOMI_DATA_DIR: join(root, "data") };
	const other = { TELOMI_DATA_DIR: join(root, "other") };
	assert.equal(resolveBackupDir(env), join(root, "backups"));
	// An unmarked data directory has no installation directory, so nothing can be upgrading it.
	assert.equal(installationBackupDir(env), undefined);
	assert.equal(upgradeInProgress(env), undefined);
	marked(env.TELOMI_DATA_DIR, "first");
	marked(other.TELOMI_DATA_DIR, "second");
	const backupDir = installationBackupDir(env)!;
	assert.equal(backupDir, join(root, "backups", "first"));
	mkdirSync(backupDir, { recursive: true });
	writeFileSync(upgradeMarkerPath(backupDir), String(process.pid));
	assert.equal(upgradeInProgress(env), process.pid);
	assert.equal(upgradeInProgress(other), undefined, "another installation sharing the root still starts");
	const exited = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" });
	writeFileSync(upgradeMarkerPath(backupDir), exited.stdout);
	assert.equal(upgradeInProgress(env), undefined);
	assert.equal(installationBackupDir({ ...env, TELOMI_BACKUP_DIR: join(root, "elsewhere") }), join(root, "elsewhere", "first"));
});

test("installations sharing a backup root never see or prune each other's snapshots", (context) => {
	const root = scratch(context);
	const [a, b] = ["a", "b"].map((name) => {
		const dataDir = join(root, name);
		marked(dataDir, `id-${name}`);
		const backupDir = installationBackupDir({ TELOMI_DATA_DIR: dataDir })!;
		return { repoRoot: root, dataDir, backupDir, marker: upgradeMarkerPath(backupDir), baseUrl: "http://127.0.0.1:1", env: {} } satisfies Installation;
	});
	assert.equal(dirname(a!.backupDir), dirname(b!.backupDir));
	const kept = takeSnapshot(b!, "daily", "b".repeat(40), new Date("2026-09-01T00:00:00Z"));
	for (let day = 1; day <= SNAPSHOT_LIMITS.daily + 2; day++) takeSnapshot(a!, "daily", "a".repeat(40), new Date(Date.UTC(2026, 8, 10 + day)));
	assert.equal(listSnapshots(a!.backupDir).length, SNAPSHOT_LIMITS.daily + 2);
	assert.deepEqual(listSnapshots(b!.backupDir).map((snapshot) => snapshot.path), [kept.path]);
	pruneSnapshots(a!);
	assert.equal(listSnapshots(a!.backupDir).length, SNAPSHOT_LIMITS.daily);
	assert.deepEqual(listSnapshots(b!.backupDir).map((snapshot) => snapshot.path), [kept.path], "the other installation's oldest snapshot survives");
});

test("snapshots from before per-installation backups are reported once and never touched", (context) => {
	const root = scratch(context);
	const dataDir = join(root, "data");
	marked(dataDir, "only");
	const flat = join(root, "backups", "daily-20260901T000000Z-aaaaaaaaaaaa");
	mkdirSync(join(flat, "data"), { recursive: true });
	writeFileSync(join(flat, "snapshot.json"), JSON.stringify({ kind: "daily", createdAt: "2026-09-01T00:00:00.000Z", commit: "a".repeat(40), formatVersion: 2 }));
	const backupDir = installationBackupDir({ TELOMI_DATA_DIR: dataDir })!;
	mkdirSync(backupDir);
	const target = { dataDir, backupDir };
	assert.deepEqual(reportFlatSnapshots(target), [flat]);
	assert.deepEqual(reportFlatSnapshots(target), [], "reported once");
	assert.deepEqual(listSnapshots(backupDir), []);
	pruneSnapshots(target);
	assert.equal(existsSync(join(flat, "snapshot.json")), true);
});

test("an upgrade needs a data directory Telomi has marked", (context) => {
	const root = scratch(context);
	const appRoot = join(root, "apps", "telomi");
	mkdirSync(join(root, "data"), { recursive: true });
	mkdirSync(appRoot, { recursive: true });
	assert.throws(() => installation(appRoot, { TELOMI_DATA_DIR: join(root, "data") }), /has no format\.json yet/u);
	marked(join(root, "data"), "marked");
	assert.equal(installation(appRoot, { TELOMI_DATA_DIR: join(root, "data") }).backupDir, join(root, "backups", "marked"));
});

test("an uncaught exception after Telomi was stopped starts it again and clears the marker and lock", (context) => {
	const root = scratch(context);
	gitRepo(root);
	const target = install(root);
	const env = {
		// Recorded by the hooks; no real server answers on the base URL, so the health wait lasts until the crash.
		TELOMI_SERVICE_STOP: "echo stop >> hooks.log",
		TELOMI_SERVICE_START: "echo start >> hooks.log",
		HINDSIGHT_API_DATABASE_URL: "postgresql://unused",
	};
	// Like undici's EINVAL: thrown from an I/O callback while the upgrade awaits, so no try/catch sees it.
	const script = `
		import { main } from ${JSON.stringify(new URL("./upgrade.ts", import.meta.url).href)};
		const install = ${JSON.stringify({ ...target, env })};
		setTimeout(() => { throw new Error("injected crash"); }, 3_000);
		process.exitCode = await main(["--snapshot-only"], install);
	`;
	const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { cwd: new URL("..", import.meta.url), encoding: "utf8", timeout: 60_000 });
	assert.equal(result.status, 1, result.stderr);
	assert.match(result.stderr, /crashed after stopping Telomi: Error: injected crash/u);
	assert.deepEqual(readFileSync(join(root, "hooks.log"), "utf8").trim().split("\n"), ["stop", "start", "start"]);
	assert.equal(existsSync(target.marker), false);
	assert.equal(existsSync(join(target.backupDir, ".upgrade.lock")), false);
	assert.equal(listSnapshots(target.backupDir).length, 1);
});
