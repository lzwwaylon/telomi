import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "telomi-codex-store-"));
const childCode = `
import { mirrorActiveCredentialToAuthJson } from "./server/accounts/store.ts";
const worker = process.env.WORKER_ID || "unknown";
for (let index = 0; index < 40; index += 1) {
  mirrorActiveCredentialToAuthJson("openai-codex", { type: "api_key", key: worker + "-" + index });
}
`;

function runWorker(index: number): Promise<void> {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", childCode], {
			cwd: join(import.meta.dirname, "../.."),
			env: { ...process.env, TELOMI_DATA_DIR: root, WORKER_ID: String(index) },
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stderr = "";
		child.stderr.setEncoding("utf-8");
		child.stderr.on("data", (chunk) => { stderr += chunk; });
		child.on("error", reject);
		child.on("exit", (code) => {
			if (code === 0) resolve();
			else reject(new Error(`worker ${index} exited ${code}: ${stderr}`));
		});
	});
}

try {
	process.env.TELOMI_DATA_DIR = root;
	const { accountsConfigPath, loadAccountsConfig, saveAccountsConfig } = await import("../../server/accounts/store.js");
	const CODEX_ACCOUNTS_PATH = accountsConfigPath("openai-codex");
	const loadCodexAccountsConfig = () => loadAccountsConfig("openai-codex");
	const saveCodexAccountsConfig = (next: typeof config) => saveAccountsConfig("openai-codex", next);
	const config = { version: 1 as const, accounts: [], chainOrder: [], activeId: null };
	assert.deepEqual(loadCodexAccountsConfig(), config);
	saveCodexAccountsConfig(config);
	assert.deepEqual(loadCodexAccountsConfig(), config);
	assert.equal(statSync(CODEX_ACCOUNTS_PATH).mode & 0o777, 0o600);
	assert.equal(statSync(join(root, ".pi", "agent", "accounts")).mode & 0o777, 0o700);
	for (const invalid of ["", "{", "[]", "{}"]) {
		writeFileSync(CODEX_ACCOUNTS_PATH, invalid);
		assert.throws(() => loadCodexAccountsConfig());
	}
	saveCodexAccountsConfig(config);
	await Promise.all(Array.from({ length: 12 }, (_, index) => runWorker(index)));
	const authPath = join(root, ".pi", "agent", "auth.json");
	assert.equal(statSync(authPath).mode & 0o777, 0o600);
	const auth = JSON.parse(readFileSync(authPath, "utf-8")) as Record<string, { type?: string; key?: string }>;
	assert.equal(auth["openai-codex"]?.type, "api_key");
	assert.match(String(auth["openai-codex"]?.key), /^\d+-\d+$/);
	console.log("codex account store concurrent atomic write test passed");
} finally {
	rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}
