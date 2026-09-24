import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { stagePrimeReportWriterWorker } from "../../server/research/pipeline/prime-report-writer.js";

const root = mkdtempSync(join(tmpdir(), "report-worker-modules-"));
try {
	const runtimeRoot = join(root, "workspaces", "writer-report", "runtime");
	mkdirSync(runtimeRoot, { recursive: true });
	const worker = stagePrimeReportWriterWorker(runtimeRoot);
	const env = { ...process.env };
	delete env.PRIME_AGENT_PATHS_MODULE_PATH;
	// Stop at the first configuration guard, before importing Prime or calling a model.
	const result = spawnSync(process.execPath, ["--import", fileURLToPath(import.meta.resolve("tsx")), worker], {
		cwd: root, env, encoding: "utf-8",
	});
	assert.ifError(result.error);
	assert.equal(result.status, 1);
	assert.doesNotMatch(result.stderr, /ERR_MODULE_NOT_FOUND/);
	assert.match(result.stderr, /PRIME_AGENT_PATHS_MODULE_PATH is required/);
	console.log("Staged Report Writer resolves its module graph before validating configuration");
} finally {
	rmSync(root, { recursive: true, force: true });
}
