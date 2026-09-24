import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveDataDir } from "../../server/config/data-dir.js";
import {
	resolveAgentDir,
} from "../../server/config/agent-directory.js";
import { ensureHindsightBankId, loadSettings } from "../../server/config/settings.js";

const configured = process.env.TELOMI_DATA_DIR;
const configuredAgent = process.env.PI_CODING_AGENT_DIR;
delete process.env.TELOMI_DATA_DIR;
delete process.env.PI_CODING_AGENT_DIR;

try {
	const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
	assert.equal(resolveDataDir(), resolve(appRoot, "data"));
	assert.equal(resolveAgentDir(), resolve(appRoot, "data/.pi/agent"));
	process.env.PI_CODING_AGENT_DIR = join(appRoot, "configured-agent");
	assert.equal(resolveAgentDir(), join(appRoot, "configured-agent"));
	assert.equal(resolveAgentDir(join(appRoot, "isolated-data")), join(appRoot, "isolated-data/.pi/agent"));
} finally {
	if (configured === undefined) delete process.env.TELOMI_DATA_DIR;
	else process.env.TELOMI_DATA_DIR = configured;
	if (configuredAgent === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = configuredAgent;
}

const memoryRoot = mkdtempSync(join(tmpdir(), "telomi-memory-config-"));
const previousDataDir = process.env.TELOMI_DATA_DIR;
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
try {
	process.env.TELOMI_DATA_DIR = memoryRoot;
	delete process.env.PI_CODING_AGENT_DIR;
	const env: NodeJS.ProcessEnv = {};
	assert.equal(ensureHindsightBankId(env), loadSettings().memory?.bankId);
	assert.equal(ensureHindsightBankId({}), env.HINDSIGHT_BANK_ID);
} finally {
	if (previousDataDir === undefined) delete process.env.TELOMI_DATA_DIR;
	else process.env.TELOMI_DATA_DIR = previousDataDir;
	if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	rmSync(memoryRoot, { recursive: true, force: true });
}

console.log("Data directory resolution test passed");
