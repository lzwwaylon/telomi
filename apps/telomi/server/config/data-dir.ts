// 统一的 data 目录解析。优先级：
//   1. TELOMI_DATA_DIR 环境变量（start.sh 会 export；app.ts 启动时回写）
//   2. <appRoot>/data - 项目内的默认运行时数据目录。
//
// 所有需要 dataDir 的模块（含绕过 server/app.ts 的独立脚本）都应 import
// 这个函数，而不是各自写 `process.env.TELOMI_DATA_DIR || join(appRoot, "data")`，
// 否则漏设环境变量的进程会把数据写回 repo 旧目录，造成分叉。

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

/** A data or cache directory Telomi must not open; startup reports the message and exits. */
export class DataDirectoryError extends Error {}
