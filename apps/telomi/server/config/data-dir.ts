// 统一的 data 目录解析。优先级：
//   1. TELOMI_DATA_DIR 环境变量（start.sh 会 export；app.ts 启动时回写）
//   2. <appRoot>/data - 项目内的默认运行时数据目录。
//
// 所有需要 dataDir 的模块（含绕过 server/app.ts 的独立脚本）都应 import
// 这个函数，而不是各自写 `process.env.TELOMI_DATA_DIR || join(appRoot, "data")`，
// 否则漏设环境变量的进程会把数据写回 repo 旧目录，造成分叉。

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(here, "../..");
/** The application directory of this checkout, where its `.env` files and default directories live. */
export const applicationRoot = appRoot;

export function resolveDataDir(env: NodeJS.ProcessEnv = process.env, root = appRoot): string {
	const configured = env.TELOMI_DATA_DIR?.trim();
	if (configured) return configured;
	return join(root, "data");
}

// Re-downloadable or rebuildable content (model downloads, fetched material). Kept out of the data
// directory so that backing up, snapshotting or migrating the data directory never carries it;
// deleting this directory costs only time.
export function resolveCacheDir(env: NodeJS.ProcessEnv = process.env, root = appRoot): string {
	const configured = env.TELOMI_CACHE_DIR?.trim();
	if (configured) return configured;
	return join(root, "cache");
}

// Snapshots taken by `npm run upgrade`. Next to the data directory by default, so a copy-on-write
// clone stays on the same volume.
export function resolveBackupDir(env: NodeJS.ProcessEnv = process.env, root = appRoot): string {
	const configured = env.TELOMI_BACKUP_DIR?.trim();
	if (configured) return resolve(root, configured);
	return join(dirname(resolve(root, resolveDataDir(env, root))), "backups");
}

/** Present, with the upgrade's pid, while `npm run upgrade` stops, snapshots or replaces the installation. */
export function upgradeMarkerPath(env: NodeJS.ProcessEnv = process.env, root = appRoot): string {
	return join(resolveBackupDir(env, root), ".upgrade-in-progress");
}

/**
 * The pid of an upgrade that is changing this installation right now. Telomi must not start then: a
 * supervisor restarting the old version would write to data that is being snapshotted or replaced.
 */
export function upgradeInProgress(env: NodeJS.ProcessEnv = process.env, root = appRoot): number | undefined {
	const marker = upgradeMarkerPath(env, root);
	if (!existsSync(marker)) return undefined;
	const pid = Number(readFileSync(marker, "utf8"));
	if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
	try {
		process.kill(pid, 0);
		return pid;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM" ? pid : undefined; // A crashed upgrade does not block forever.
	}
}

/** A data or cache directory Telomi must not open; startup reports the message and exits. */
export class DataDirectoryError extends Error {}
