// `npm run upgrade`: move this installation to another version without risking its data.
//
// Every run that changes code first stops Telomi and snapshots the stopped data directory. When a
// later step fails, the installation returns to the previous code, and also to the snapshot when the
// failed version already migrated the data (`format.json` changed). See docs/upgrading.md.

import { spawn, spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { applicationRoot, resolveBackupDir, resolveDataDir, upgradeMarkerPath } from "../server/config/data-dir.js";
import { readDataFormat } from "../server/config/data-format.js";
import { stopManagedBrowser, stopMemoryDatabase } from "../server/config/data-layout.js";
import { loadProjectEnvironment } from "../server/config/environment.js";
import { runtimeControlRoot } from "../server/workspaces/server-runtime-paths.js";
import { managedBrowserPaths } from "./chrome-debug.js";

/** Snapshots kept per kind: one before every upgrade, and `--snapshot-only` ones (typically daily). */
export const SNAPSHOT_LIMITS = { upgrade: 10, daily: 7 } as const;
/** `--if-idle` keeps skipping a busy instance; past this it reports a warning instead of staying silent. */
export const BUSY_WARNING_MS = 24 * 60 * 60_000;
/** Startup includes managed services and any data migration, which can copy a whole database. */
const HEALTH_TIMEOUT_MS = 10 * 60_000;
const STOP_TIMEOUT_MS = 60_000;

export type SnapshotKind = keyof typeof SNAPSHOT_LIMITS;

export interface Snapshot {
	path: string;
	kind: SnapshotKind;
	createdAt: string;
	/** The code the snapshot belongs to. */
	commit: string;
	formatVersion: number;
}

export interface Installation {
	repoRoot: string;
	dataDir: string;
	backupDir: string;
	/** Tells the server not to start while this upgrade changes the installation. */
	marker: string;
	baseUrl: string;
	/** The checkout's settings, read the way the server reads them. Never passed to child processes. */
	env: NodeJS.ProcessEnv;
}

export class UpgradeError extends Error {}

const log = (message: string) => console.log(`[upgrade] ${message}`);

export function installation(appRoot = applicationRoot, parentEnv: NodeJS.ProcessEnv = process.env): Installation {
	const env = { ...parentEnv };
	loadProjectEnvironment(appRoot, env);
	return {
		repoRoot: resolve(appRoot, "../.."),
		dataDir: resolve(appRoot, resolveDataDir(env, appRoot)),
		backupDir: resolveBackupDir(env, appRoot),
		marker: upgradeMarkerPath(env, appRoot),
		baseUrl: `http://127.0.0.1:${env.PORT?.trim() || "8787"}`,
		env,
	};
}

function git(repo: string, ...args: string[]): string {
	const result = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
	if (result.status !== 0) throw new UpgradeError(`git ${args.join(" ")} failed: ${result.stderr.trim()}`);
	return result.stdout.trim();
}

function run(command: string, args: string[], cwd: string): void {
	const started = Date.now();
	const result = spawnSync(command, args, { cwd, stdio: "inherit" });
	if (result.status !== 0) throw new UpgradeError(`${command} ${args.join(" ")} failed (exit ${result.status ?? result.signal})`);
	log(`${command} ${args.join(" ")} finished in ${seconds(started)}`);
}

function seconds(since: number): string {
	return `${Math.round((Date.now() - since) / 1000)} s`;
}

/** The latest published Release (`vX.Y.Z` tag) by default; otherwise `ref`, preferring the remote branch of that name. */
export function resolveTarget(repo: string, ref?: string): { commit: string; label: string } {
	if (git(repo, "remote").split("\n").includes("origin")) git(repo, "fetch", "--quiet", "--tags", "--prune", "origin");
	if (!ref) {
		const tag = git(repo, "tag", "--list", "v*", "--sort=-v:refname").split("\n").find((name) => /^v\d+\.\d+\.\d+$/u.test(name));
		if (!tag) throw new UpgradeError("No published Release (vX.Y.Z tag) found; pass --ref to choose a version");
		return { commit: git(repo, "rev-parse", `${tag}^{commit}`), label: tag };
	}
	for (const candidate of [`refs/remotes/origin/${ref}`, ref]) {
		const found = spawnSync("git", ["rev-parse", "--verify", "--quiet", "--end-of-options", `${candidate}^{commit}`], { cwd: repo, encoding: "utf8" });
		if (found.status === 0) return { commit: found.stdout.trim(), label: ref };
	}
	throw new UpgradeError(`Unknown ref ${ref}`);
}

export function assertClean(repo: string): void {
	if (git(repo, "status", "--porcelain", "--untracked-files=no")) {
		throw new UpgradeError("The checkout has local changes; commit or remove them first (upgrade never discards them)");
	}
}

function stamp(date: Date): string {
	return date.toISOString().replace(/[-:]/gu, "").replace(/\.\d+Z$/u, "Z");
}

/** Copy-on-write clone where the file system supports it (APFS), a full copy otherwise. Keeps permissions. */
export function cloneTree(source: string, target: string): void {
	if (process.platform === "darwin" && spawnSync("cp", ["-cpR", source, target]).status === 0) return;
	rmSync(target, { recursive: true, force: true });
	const copied = spawnSync("cp", ["-pR", source, target], { encoding: "utf8" });
	if (copied.status !== 0) throw new UpgradeError(`Could not copy ${source} to ${target}: ${copied.stderr.trim()}`);
}

/** Copies the data directory, which must not be in use, into `<backupDir>/<kind>-<time>-<commit>`. */
export function takeSnapshot(install: Installation, kind: SnapshotKind, commit: string, now = new Date()): Snapshot {
	const path = join(install.backupDir, `${kind}-${stamp(now)}-${commit.slice(0, 12)}`);
	const partial = `${path}.partial`;
	rmSync(partial, { recursive: true, force: true });
	mkdirSync(partial, { recursive: true, mode: 0o700 });
	cloneTree(install.dataDir, join(partial, "data"));
	const record = { kind, createdAt: now.toISOString(), commit, formatVersion: readDataFormat(install.dataDir)?.formatVersion ?? 1 };
	writeFileSync(join(partial, "snapshot.json"), `${JSON.stringify(record, null, "\t")}\n`);
	renameSync(partial, path);
	return { path, ...record };
}

/** Complete snapshots, newest first. */
export function listSnapshots(backupDir: string): Snapshot[] {
	if (!existsSync(backupDir)) return [];
	return readdirSync(backupDir)
		.filter((name) => !name.endsWith(".partial") && existsSync(join(backupDir, name, "snapshot.json")))
		.map((name) => ({ path: join(backupDir, name), ...JSON.parse(readFileSync(join(backupDir, name, "snapshot.json"), "utf8")) as Omit<Snapshot, "path"> }))
		.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/**
 * Keeps SNAPSHOT_LIMITS per kind, drops copies a crash left unfinished, and keeps only the newest
 * data directory a rollback replaced (the evidence of the latest failed migration). Returns what was removed.
 */
export function pruneSnapshots(install: Pick<Installation, "backupDir" | "dataDir">): string[] {
	const { backupDir, dataDir } = install;
	const snapshots = listSnapshots(backupDir);
	const replacedPrefix = `${basename(dataDir)}.replaced-`;
	const removed = [
		...readdirSync(backupDir).filter((name) => name.endsWith(".partial")).map((name) => join(backupDir, name)),
		...(Object.keys(SNAPSHOT_LIMITS) as SnapshotKind[])
			.flatMap((kind) => snapshots.filter((snapshot) => snapshot.kind === kind).slice(SNAPSHOT_LIMITS[kind]).map((snapshot) => snapshot.path)),
		// The timestamp suffix sorts chronologically.
		...readdirSync(dirname(dataDir)).filter((name) => name.startsWith(replacedPrefix)).sort().reverse().slice(1)
			.map((name) => join(dirname(dataDir), name)),
	];
	for (const path of removed) rmSync(path, { recursive: true, force: true });
	return removed;
}

/**
 * Puts the snapshot's data back into an empty data directory path. The current data is moved aside,
 * never overwritten or deleted, and its location returned.
 */
export function restoreSnapshot(install: Installation, snapshot: Snapshot, now = new Date()): string {
	const aside = `${install.dataDir}.replaced-${stamp(now)}`;
	renameSync(install.dataDir, aside);
	cloneTree(join(snapshot.path, "data"), install.dataDir);
	return aside;
}

/** Whether the data needs the snapshot back: the failed version changed its format, or left it unreadable. */
export function dataFormatChanged(install: Installation, snapshot: Snapshot): boolean {
	try {
		return (readDataFormat(install.dataDir)?.formatVersion ?? 1) !== snapshot.formatVersion;
	} catch {
		return true;
	}
}

/** How long the instance has been busy, remembered across `--if-idle` runs; 0 once it is idle. */
export function trackBusy(statePath: string, busy: boolean, now = Date.now()): number {
	if (!busy) {
		rmSync(statePath, { force: true });
		return 0;
	}
	const since = existsSync(statePath) ? (JSON.parse(readFileSync(statePath, "utf8")) as { busySince?: string }).busySince : undefined;
	if (!since) writeFileSync(statePath, `${JSON.stringify({ busySince: new Date(now).toISOString() })}\n`);
	return since ? now - Date.parse(since) : 0;
}

async function getJson(url: string): Promise<unknown> {
	try {
		const response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
		return response.ok ? await response.json() : undefined;
	} catch {
		return undefined;
	}
}

async function responding(install: Installation): Promise<boolean> {
	try {
		await fetch(`${install.baseUrl}/api/health`, { signal: AbortSignal.timeout(5_000) });
		return true;
	} catch {
		return false;
	}
}

/** The server answers for this data directory and can list its Goals. */
async function healthy(install: Installation): Promise<boolean> {
	const health = await getJson(`${install.baseUrl}/api/health`) as { workspaceDir?: string } | undefined;
	if (!health?.workspaceDir || resolve(health.workspaceDir) !== install.dataDir) return false;
	const goals = await getJson(`${install.baseUrl}/api/goals`) as { goals?: unknown } | undefined;
	return Array.isArray(goals?.goals);
}

async function waitFor(condition: () => Promise<boolean>, timeoutMs: number, abandoned = () => false): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline && !abandoned()) {
		if (await condition()) return true;
		await new Promise((done) => setTimeout(done, 1_000));
	}
	return condition();
}

/**
 * Stops the server through TELOMI_SERVICE_STOP when a supervisor owns it, otherwise through the
 * checkout's own process ownership (`npm start`/`npm run dev`), then the managed browser and the
 * embedded memory database, which can outlive the server. Afterwards nothing is using the data directory.
 */
async function stopService(install: Installation): Promise<void> {
	try {
		await stopAll(install);
	} catch (error) {
		// Never leave the installation down because something besides the server would not stop.
		if (!(await responding(install))) await startService(install).catch(() => undefined);
		throw error;
	}
}

async function stopAll(install: Installation): Promise<void> {
	// Set first: a supervisor that restarts the old server after the stop must find it refusing to start.
	writeFileSync(install.marker, String(process.pid));
	const hook = install.env.TELOMI_SERVICE_STOP?.trim();
	// A stop hook fails for a service that is not loaded; whether the server still answers is what counts.
	spawnSync(hook ? "/bin/sh" : "python3", hook ? ["-c", hook] : ["apps/telomi/scripts/worktree.py", "stop"], { cwd: install.repoRoot, stdio: "inherit" });
	if (!(await waitFor(async () => !(await responding(install)), STOP_TIMEOUT_MS))) {
		throw new UpgradeError(`Telomi still answers on ${install.baseUrl}. It was started some other way, or a supervisor restarted it: `
			+ "set TELOMI_SERVICE_STOP and TELOMI_SERVICE_START (see docs/upgrading.md)");
	}
	await stopManagedBrowser(managedBrowserPaths(install.dataDir));
	stopMemoryDatabase(install.env);
}

async function startService(install: Installation): Promise<void> {
	rmSync(install.marker, { force: true });
	const hook = install.env.TELOMI_SERVICE_START?.trim();
	let exited = false;
	let logPath = "the supervisor's log";
	if (hook) {
		run("/bin/sh", ["-c", hook], install.repoRoot);
	} else {
		logPath = join(runtimeControlRoot(install.dataDir), "logs", "server.log");
		mkdirSync(dirname(logPath), { recursive: true });
		const output = openSync(logPath, "a");
		const child = spawn("npm", ["start"], { cwd: install.repoRoot, detached: true, stdio: ["ignore", output, output] });
		closeSync(output);
		child.once("exit", () => { exited = true; });
		child.unref();
	}
	const started = Date.now();
	if (!(await waitFor(() => healthy(install), HEALTH_TIMEOUT_MS, () => exited))) {
		throw new UpgradeError(`Telomi did not become healthy on ${install.baseUrl} (waited ${seconds(started)}); see ${logPath}`);
	}
	log(`Telomi is healthy after ${seconds(started)}`);
}

function installCode(install: Installation, commit: string): void {
	git(install.repoRoot, "switch", "--detach", "--quiet", commit);
	for (const args of [["ci"], ["run", "setup"], ["run", "build"]]) run("npm", args, install.repoRoot);
}

async function rollBack(install: Installation, snapshot: Snapshot, reason: string): Promise<void> {
	log(`rolling back to ${snapshot.commit.slice(0, 12)}: ${reason}`);
	// Also when the failed version is not answering: a supervisor may be restarting it right now.
	await stopService(install);
	if (dataFormatChanged(install, snapshot)) {
		const aside = restoreSnapshot(install, snapshot);
		log(`restored the data directory from the snapshot taken ${snapshot.createdAt}; anything written after that time is not in it`);
		log(`the replaced data directory is kept at ${aside}`);
		if (!install.env.TELOMI_SERVICE_START?.trim()) log(`the failed version's server log is ${join(runtimeControlRoot(aside), "logs", "server.log")}`);
	} else {
		log("the data format did not change, so the data directory is kept as it is");
	}
	installCode(install, snapshot.commit);
	await startService(install);
	log(`running ${snapshot.commit.slice(0, 12)} again`);
}

/** Reports why a busy instance was left alone; returns the exit code. */
function busyStatePath(install: Installation): string {
	return join(install.backupDir, "upgrade-state.json");
}

async function busy(install: Installation): Promise<number | undefined> {
	const statePath = busyStatePath(install);
	const verdict = await getJson(`${install.baseUrl}/api/runtime/idle`) as { idle?: boolean; reasons?: unknown[] } | undefined;
	// A stopped server is idle; one that answers without a verdict cannot promise it is.
	const isBusy = verdict ? verdict.idle !== true : await responding(install);
	const duration = trackBusy(statePath, isBusy);
	if (!isBusy) return undefined;
	log(`Telomi is busy; nothing was stopped. Reasons: ${JSON.stringify(verdict?.reasons ?? ["idle verdict unavailable"])}`);
	if (duration < BUSY_WARNING_MS) return 0;
	console.error(`[upgrade] WARNING: Telomi has been busy for ${Math.round(duration / 3_600_000)} hours; check the reasons above`);
	return 3;
}

export interface Options {
	ref?: string;
	ifIdle: boolean;
	snapshotOnly: boolean;
	rollback: boolean;
}

export function parseOptions(argv: string[]): Options {
	const options: Options = { ifIdle: false, snapshotOnly: false, rollback: false };
	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index]!;
		if (arg === "--if-idle") options.ifIdle = true;
		else if (arg === "--snapshot-only") options.snapshotOnly = true;
		else if (arg === "--rollback") options.rollback = true;
		else if (arg === "--ref") options.ref = argv[++index];
		else if (arg.startsWith("--ref=")) options.ref = arg.slice("--ref=".length);
		else throw new UpgradeError(`Unknown argument ${arg}. Usage: npm run upgrade -- [--ref <ref>] [--if-idle] | --snapshot-only [--if-idle] | --rollback`);
	}
	if (options.ref === "") throw new UpgradeError("--ref needs a value");
	if (options.rollback && (options.ref || options.ifIdle || options.snapshotOnly)) throw new UpgradeError("--rollback takes no other options");
	if (options.snapshotOnly && options.ref) throw new UpgradeError("--snapshot-only keeps the current code; drop --ref");
	return options;
}

function acquireLock(backupDir: string): () => void {
	mkdirSync(backupDir, { recursive: true, mode: 0o700 });
	const path = join(backupDir, ".upgrade.lock");
	try {
		writeFileSync(path, String(process.pid), { flag: "wx" });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		const holder = Number(readFileSync(path, "utf8"));
		let alive = false;
		try {
			process.kill(holder, 0);
			alive = true;
		} catch (probe) {
			alive = (probe as NodeJS.ErrnoException).code === "EPERM";
		}
		if (alive) throw new UpgradeError(`Another upgrade (pid ${holder}) is running`);
		writeFileSync(path, String(process.pid));
	}
	return () => rmSync(path, { force: true });
}

export async function main(argv: string[], install = installation()): Promise<number> {
	const options = parseOptions(argv);
	const release = acquireLock(install.backupDir);
	try {
		assertClean(install.repoRoot);
		const current = git(install.repoRoot, "rev-parse", "HEAD");
		if (options.rollback) {
			// A failed upgrade that already rolled back leaves a snapshot of the code that is running now.
			const snapshot = listSnapshots(install.backupDir).find((candidate) => candidate.kind === "upgrade" && candidate.commit !== current);
			if (!snapshot) throw new UpgradeError(`No snapshot of an earlier version in ${install.backupDir} to roll back to`);
			await rollBack(install, snapshot, "requested");
			return 0;
		}
		const target = options.snapshotOnly ? undefined : resolveTarget(install.repoRoot, options.ref);
		if (target?.commit === current) {
			log(`already at ${target.label} (${current.slice(0, 12)})`);
			return 0;
		}
		if (options.ifIdle) {
			const code = await busy(install);
			if (code !== undefined) return code;
		}
		log("stopping Telomi");
		await stopService(install);
		trackBusy(busyStatePath(install), false);
		const started = Date.now();
		const snapshot = takeSnapshot(install, target ? "upgrade" : "daily", current);
		log(`snapshot ${snapshot.path} took ${Date.now() - started} ms`);
		try {
			if (target) {
				log(`installing ${target.label} (${target.commit.slice(0, 12)})`);
				installCode(install, target.commit);
			}
			await startService(install);
		} catch (error) {
			if (!target) throw error;
			try {
				await rollBack(install, snapshot, (error as Error).message);
			} catch (rollbackError) {
				console.error(`[upgrade] rollback failed: ${(rollbackError as Error).message}`);
				console.error(`[upgrade] Telomi may be stopped. Recover manually from ${snapshot.path} (commit ${snapshot.commit}); see docs/upgrading.md`);
				return 2;
			}
			return 1;
		}
		for (const path of pruneSnapshots(install)) log(`removed ${path}`);
		log(target ? `running ${target.label} (${target.commit.slice(0, 12)})` : "snapshot taken; Telomi is running again");
		return 0;
	} finally {
		rmSync(install.marker, { force: true });
		release();
	}
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (error: unknown) => {
		console.error(`[upgrade] ${error instanceof Error ? error.message : String(error)}`);
		process.exitCode = 1;
	});
}
