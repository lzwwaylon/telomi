// Format version 2: every piece of installation state lives in the data directory, and
// re-downloadable caches live in the cache directory.
//
// Each step is safe to re-run after a crash at any point: a move is a rename, or a copy into
// `<target>.partial` renamed into place, and a step whose target already exists is done. Nothing
// is deleted except an unfinished `.partial` copy and empty directories standing in a target.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { legacyBrowserPaths, managedBrowserPaths, parseArgs, stopChrome } from "../../scripts/chrome-debug.js";
import { hindsightPython, memoryDatabaseDir, memoryDatabaseUrl } from "../goals/memory/hindsight-runtime.js";
import { readJson } from "../lib/fs.js";
import { runtimeControlRoot } from "../workspaces/server-runtime-paths.js";
import { applicationRoot, DataDirectoryError, resolveCacheDir, resolveDataDir } from "./data-dir.js";
import { loadProjectEnvironment } from "./environment.js";
import type { DataMigration } from "./data-format.js";

const log = (message: string) => console.log(`[telomi] ${message}`);

export const moveInstallationStateIntoDataDirectory: DataMigration = {
	name: "move User Memory, the managed browser profile and caches into place",
	run(dataDir) {
		const checkout: NodeJS.ProcessEnv = {};
		loadProjectEnvironment(applicationRoot, checkout);
		return moveInstallationState(dataDir, process.env, checkout);
	},
};

/**
 * `env` is this process's configuration; `checkout` is only what the checkout's own env files say.
 * State outside the data directory is found through the checkout's configuration, so it belongs to
 * this data directory only when the checkout itself selects it (or its default): a process pointed
 * at another directory for one run, such as an evaluation instance or a test, must never take the
 * checkout's memory, browser or caches.
 */
export async function moveInstallationState(
	dataDir: string,
	env: NodeJS.ProcessEnv,
	checkout: NodeJS.ProcessEnv,
	legacyBrowser = legacyBrowserPaths,
): Promise<void> {
	if (resolve(resolveDataDir(env)) !== resolve(dataDir)) return;
	const owned = resolve(resolveDataDir(checkout)) === resolve(dataDir);
	// Without an explicit URL the instance is named after this very directory.
	if (owned || !env.HINDSIGHT_API_DATABASE_URL?.trim()) moveMemoryDatabase(dataDir, env);
	if (!owned) return;
	await moveManagedBrowser(dataDir, legacyBrowser);
	const legacyCaches = join(runtimeControlRoot(dataDir), "research-source-service");
	const cacheDir = resolveCacheDir(env);
	if (!env.SOURCE_SERVICE_HF_HOME?.trim()) {
		moveTree(join(legacyCaches, "huggingface"), join(cacheDir, "huggingface"), "leave");
	}
	if (!env.SOURCE_SERVICE_MATERIAL_CACHE_ROOT?.trim()) {
		moveTree(join(legacyCaches, "material-cache"), join(cacheDir, "material-cache"), "leave");
	}
}

/** The pg0 instance named by an embedded-database URL, as Hindsight parses it. */
export function pg0InstanceName(url: string): string | undefined {
	if (url === "pg0") return "hindsight";
	if (!url.startsWith("pg0://")) return undefined;
	return url.slice("pg0://".length).split("@").at(-1)!.split(":")[0] || undefined;
}

function moveMemoryDatabase(dataDir: string, env: NodeJS.ProcessEnv): void {
	const name = pg0InstanceName(memoryDatabaseUrl(env));
	if (!name) return;
	const instance = join(env.HOME || homedir(), ".pg0", "instances", name);
	// Before format version 2, Telomi never chose a data directory for pg0, so its files are only
	// ever in pg0's default location. An instance recorded elsewhere has already moved to its owner.
	const source = join(instance, "data");
	const metadata = join(instance, "instance.json");
	const recorded = existsSync(metadata) ? readJson<{ data_dir?: string }>(metadata).data_dir : undefined;
	if (!existsSync(source) || (recorded && resolve(recorded) !== resolve(source))) return;
	const target = memoryDatabaseDir(dataDir);
	// PostgreSQL files are only copied from a stopped cluster.
	const stopped = spawnSync(hindsightPython(env), ["-c",
		"import sys; from pg0 import Pg0; p = Pg0(name=sys.argv[1]); p.stop(); sys.exit(1 if p.info().running else 0)", name],
	{ encoding: "utf8", env: { ...env, PYTHONDONTWRITEBYTECODE: "1" } });
	if (stopped.status !== 0) {
		throw new DataDirectoryError(`Could not stop the User Memory database ${name} before moving it: ${stopped.stderr.trim() || stopped.status}`);
	}
	moveTree(source, target, "copy");
}

async function moveManagedBrowser(dataDir: string, legacy: typeof legacyBrowserPaths): Promise<void> {
	if (!existsSync(legacy.profileDir)) return;
	if (browserUsing(legacy.profileDir)) {
		const stateFile = join(legacy.stateDir, "chrome-debug.json");
		const state = existsSync(stateFile) ? readJson<{ port?: number }>(stateFile) : undefined;
		if (state?.port) {
			const { options } = parseArgs(["stop", "--port", String(state.port), "--profile-dir", legacy.profileDir, "--state-dir", legacy.stateDir]);
			await stopChrome(options).catch(() => undefined);
		}
		if (browserUsing(legacy.profileDir)) {
			throw new DataDirectoryError(`The managed browser is still running from ${legacy.profileDir}; close it and start Telomi again.`);
		}
	}
	moveTree(legacy.profileDir, managedBrowserPaths(dataDir).profileDir, "copy");
}

function browserUsing(profileDir: string): boolean {
	const listed = spawnSync("ps", ["-axo", "args="], { encoding: "utf8" });
	const flag = `--user-data-dir=${profileDir}`;
	return listed.stdout.split("\n").some((line) => line.includes(`${flag} `) || line.endsWith(flag));
}

/**
 * Moves `source` to `target`. Across file systems, state is copied and its original kept; a cache
 * is left where it is, since it can be downloaded again.
 */
export function moveTree(source: string, target: string, acrossFileSystems: "copy" | "leave"): void {
	if (!existsSync(source)) return;
	if (existsSync(target)) {
		if (!isEmptyTree(target)) {
			log(`kept ${source}: ${target} already exists`);
			return;
		}
		rmSync(target, { recursive: true });
	}
	mkdirSync(dirname(target), { recursive: true });
	try {
		renameSync(source, target);
		log(`moved ${source} to ${target}`);
		return;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
	}
	if (acrossFileSystems === "leave") {
		log(`left ${source} in place (another file system); it is no longer used and can be deleted`);
		return;
	}
	copyTree(source, target);
	log(`copied ${source} to ${target}; the original is kept and can be deleted once Telomi works`);
}

/** Copies into `<target>.partial`, then renames it into place, so `target` only ever appears complete. */
export function copyTree(source: string, target: string): void {
	const partial = `${target}.partial`;
	rmSync(partial, { recursive: true, force: true });
	// `cp -p` keeps directory permissions, which fs.cpSync does not: PostgreSQL refuses a data
	// directory that is not private to its owner.
	const copied = spawnSync("cp", ["-pR", source, partial], { encoding: "utf8" });
	if (copied.status !== 0) throw new DataDirectoryError(`Could not copy ${source} to ${partial}: ${copied.stderr.trim() || copied.status}`);
	renameSync(partial, target);
}

function isEmptyTree(path: string): boolean {
	return readdirSync(path, { withFileTypes: true })
		.every((entry) => entry.isDirectory() && isEmptyTree(join(path, entry.name)));
}
