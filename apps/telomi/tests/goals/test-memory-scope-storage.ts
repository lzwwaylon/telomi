import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

test("Telomi Episode scopes stay consistent across native archive, restore and concurrent retag", async () => {
	const python = fileURLToPath(new URL("../../services/hindsight/.venv/bin/python", import.meta.url));
	const script = fileURLToPath(new URL("./memory-scope-storage-check.py", import.meta.url));
	const result = await promisify(execFile)(python, ["-B", script], { maxBuffer: 16 * 1024 * 1024 });
	assert.match(result.stdout, /memory scope storage check passed/u);
});
