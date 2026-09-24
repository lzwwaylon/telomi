import { join } from "node:path";

export function runtimeRoot(goalDir: string): string {
	return join(goalDir, ".pi", "runtime");
}

export function runtimeRunsDir(goalDir: string): string {
	return join(runtimeRoot(goalDir), "runs");
}

export function runtimeStateDir(goalDir: string): string {
	return join(runtimeRoot(goalDir), "state");
}

export function runtimeCacheDir(goalDir: string): string {
	return join(runtimeRoot(goalDir), "cache");
}

/**
 * Goal-local Runtime Control Store: daemon records, checkpoints and caches.
 * These paths are persisted for restart recovery, not disposable Worker Workspaces.
 * Server-owned harness execution uses server-runtime-paths.ts instead.
 */
export function daemonRunsDirByName(goalDir: string, daemon: string): string {
	return join(runtimeRunsDir(goalDir), daemon);
}

export function daemonRunDir(goalDir: string, daemon: string, runId: string): string {
	return join(daemonRunsDirByName(goalDir, daemon), runId);
}

/**
 * 统一 runId 格式: `YYYYMMDDHHMMSS_<6char base36 rand>`(UTC)。
 * 排序友好,目录列出来就是时间顺序;6 char base36 ≈ 2.2e9,日内冲突可忽略。
 */
export function runIdNow(prefix?: string): string {
	const d = new Date();
	const stamp =
		d.getUTCFullYear().toString().padStart(4, "0") +
		(d.getUTCMonth() + 1).toString().padStart(2, "0") +
		d.getUTCDate().toString().padStart(2, "0") +
		d.getUTCHours().toString().padStart(2, "0") +
		d.getUTCMinutes().toString().padStart(2, "0") +
		d.getUTCSeconds().toString().padStart(2, "0");
	const rand = Math.random().toString(36).slice(2, 8).padEnd(6, "0");
	const base = `${stamp}_${rand}`;
	return prefix ? `${prefix}_${base}` : base;
}

export function fileIngestStateDir(goalDir: string): string {
	return join(runtimeStateDir(goalDir), "ingestion");
}

export function fileIngestJobsDir(goalDir: string): string {
	return join(fileIngestStateDir(goalDir), "jobs");
}

export function fileIngestJobPath(goalDir: string, jobId: string): string {
	return join(fileIngestJobsDir(goalDir), `${jobId}.json`);
}

export function fileIngestCacheDir(goalDir: string): string {
	return join(runtimeCacheDir(goalDir), "ingestion");
}

export function fileIngestCacheEntryDir(goalDir: string, cacheKey: string): string {
	return join(fileIngestCacheDir(goalDir), cacheKey);
}

/**
 * 只含解析产物的镜像目录，与 ingestion 缓存平级。Main Agent 沙箱挂载这里，
 * 所以原件不会随挂载树进入 Agent 上下文或逻辑工作区快照。
 */
export function parsedDocumentsDir(goalDir: string): string {
	return join(runtimeCacheDir(goalDir), "documents");
}

export function parsedDocumentsEntryDir(goalDir: string, cacheKey: string): string {
	return join(parsedDocumentsDir(goalDir), cacheKey);
}

export function goalCredentialsDir(goalDir: string): string {
	return join(goalDir, ".pi", "credentials");
}

export function citationRoot(goalDir: string): string {
	return join(goalDir, ".citations");
}

/** Native Pi project Agent definitions, separate from the configured Agent Directory. */
export function projectAgentsDir(projectDir: string): string {
	return join(projectDir, ".pi", "agents");
}
