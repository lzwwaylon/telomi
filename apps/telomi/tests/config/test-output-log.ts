import assert from "node:assert/strict";
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { rotateOutputLog } from "../../server/config/output-log.js";

test("an outgrown output log keeps one generation and output continues from the start", (context) => {
	const root = mkdtempSync(join(tmpdir(), "telomi-output-log-"));
	context.after(() => rmSync(root, { recursive: true, force: true }));
	const log = join(root, "server.log");
	// Opened for appending once, as launchd opens StandardOutPath.
	const fd = openSync(log, "a");
	context.after(() => closeSync(fd));
	writeSync(fd, "old line\n".repeat(4));

	assert.equal(rotateOutputLog(log, 1_000, fd), false, "under the limit");
	writeSync(fd, "x".repeat(1_000));
	assert.equal(rotateOutputLog(log, 1_000, fd), true);
	assert.match(readFileSync(`${log}.1`, "utf8"), /^old line\n/u);
	writeSync(fd, "new line\n");
	assert.equal(readFileSync(log, "utf8"), "new line\n");

	// A second rotation replaces the single older generation.
	writeSync(fd, "y".repeat(1_000));
	assert.equal(rotateOutputLog(log, 1_000, fd), true);
	assert.match(readFileSync(`${log}.1`, "utf8"), /^new line\ny/u);
});

test("a log this process is not writing to is never touched", (context) => {
	const root = mkdtempSync(join(tmpdir(), "telomi-output-log-"));
	context.after(() => rmSync(root, { recursive: true, force: true }));
	const mine = join(root, "mine.log");
	const other = join(root, "other.log");
	writeFileSync(other, "z".repeat(5_000));
	const fd = openSync(mine, "a");
	context.after(() => closeSync(fd));
	writeSync(fd, "z".repeat(5_000));
	assert.equal(rotateOutputLog(other, 1_000, fd), false);
	assert.equal(readFileSync(other, "utf8").length, 5_000);
	assert.equal(rotateOutputLog(undefined, 1_000, fd), false);
	assert.equal(rotateOutputLog(join(root, "missing.log"), 1_000, fd), false);
});
