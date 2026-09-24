import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadProjectEnvironment } from "../../server/config/environment.js";

const root = mkdtempSync(join(tmpdir(), "telomi-worktree-env-"));
try {
	writeFileSync(join(root, ".env"), 'PORT=8787\nTELOMI_DATA_DIR="/main/data"\nSECRET="preserved"\n');
	writeFileSync(join(root, ".env.local"), 'PORT=8788\nEXPLICIT="from file"\n');
	writeFileSync(join(root, ".env.worktree"), 'PORT=21001\nTELOMI_DATA_DIR="/worktree with spaces/data"\n');
	const env: Record<string, string> = { EXPLICIT: "parent" };
	loadProjectEnvironment(root, env);
	assert.deepEqual(env, { PORT: "21001", TELOMI_DATA_DIR: "/worktree with spaces/data", SECRET: "preserved", EXPLICIT: "parent" });
} finally {
	rmSync(root, { recursive: true, force: true });
}
console.log("worktree environment overlay and explicit parent precedence passed");
