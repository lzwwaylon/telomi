import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createSrtAgentSandbox } from "../../server/agent-runtime/srt-agent-sandbox.js";

const readOnlyWorkspace = await mkdtemp(join(tmpdir(), "telomi-readonly-agent-"));
try {
	const sandbox = createSrtAgentSandbox({
		id: "read-only-regression",
		role: "report.cornell_note",
		workDirectory: readOnlyWorkspace,
		readonlyMounts: [],
		activeTools: ["read"],
		network: "deny",
	});
	assert.equal(
		sandbox.backend,
		"srt",
		"Read-only Agents must use the unified SRT module",
	);
	await sandbox.close();
} finally {
	await rm(readOnlyWorkspace, { recursive: true, force: true });
}

console.log("Read-only Agent sandbox test passed");
