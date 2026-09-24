// Size limit for a log file a supervisor writes this process's output to (`npm run service` names it in
// TELOMI_OUTPUT_LOG). launchd opens the file once for appending and never reopens it, so renaming it
// would not help: the process keeps writing to the renamed file. Instead its content is copied to
// `<file>.1` and the file is emptied through the process's own descriptor, where appending continues
// from the start. Only output written by another process between the copy and the truncation is lost.

import { copyFileSync, fstatSync, ftruncateSync, statSync } from "node:fs";

/** Each log keeps at most this much plus one `.1` generation of the same size. */
export const OUTPUT_LOG_LIMIT_BYTES = 10 * 1024 * 1024;
const CHECK_INTERVAL_MS = 60_000;

/** Rotates `path` when it is this process's output (`fd`) and has outgrown `limit`. Returns whether it rotated. */
export function rotateOutputLog(path: string | undefined, limit = OUTPUT_LOG_LIMIT_BYTES, fd = 1): boolean {
	if (!path) return false;
	try {
		const output = fstatSync(fd);
		const file = statSync(path);
		// Never truncate a file this process is not writing to.
		if (!output.isFile() || output.ino !== file.ino || output.dev !== file.dev || output.size <= limit) return false;
		copyFileSync(path, `${path}.1`);
		ftruncateSync(fd, 0);
		return true;
	} catch {
		return false;
	}
}

/** Checks now and then every minute for the life of the process. */
export function keepOutputLogBounded(path = process.env.TELOMI_OUTPUT_LOG?.trim()): void {
	if (!path) return;
	rotateOutputLog(path);
	setInterval(() => rotateOutputLog(path), CHECK_INTERVAL_MS).unref();
}
