import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	classifyProviderError,
	isRequestCancellation,
} from "../../server/accounts/error-classify.js";

assert.equal(
	isRequestCancellation("Request was aborted"),
	true,
	"a caller abort must be recognized as request cancellation",
);
assert.equal(
	isRequestCancellation(new DOMException("This operation was aborted", "AbortError")),
	true,
	"AbortError must be recognized as request cancellation",
);
assert.equal(
	isRequestCancellation("model 'openai-codex/gpt-5.4' was cancelled by the caller"),
	true,
	"the research runtime cancellation message must be recognized",
);
assert.equal(isRequestCancellation("429 rate_limit_exceeded"), false);
assert.equal(classifyProviderError("429 rate_limit_exceeded"), "quota");

const isolatedHome = mkdtempSync(join(tmpdir(), "telomi-codex-cancel-"));
const childCode = `
import assert from "node:assert/strict";
import { codexAccountManager } from "./server/accounts/manager.ts";

await codexAccountManager.load();
const account = await codexAccountManager.addAccount({
  label: "cancellation invariant",
  credential: { type: "api_key", key: "test-only-key" },
});
const broken = await codexAccountManager.addAccount({
  label: "broken fallback",
  credential: { type: "api_key", key: "broken-test-only-key" },
});
await codexAccountManager.reorderChain([account.id, broken.id]);
await codexAccountManager.setActive(broken.id);
assert.equal(
  codexAccountManager.pickFallbackCandidate(new Set())?.account.id,
  broken.id,
  "the active account must be attempted before the fallback chain",
);
await codexAccountManager.recordFailure(
  broken.id,
  "auth",
  "No API key for provider: openai-codex",
);
assert.equal(codexAccountManager.snapshot().activeId, account.id);
assert.equal(
  codexAccountManager.pickFallbackCandidate(new Set())?.account.id,
  account.id,
);
await codexAccountManager.recordFailure(
  account.id,
  "permanent",
  "Request was aborted",
);
const current = codexAccountManager.snapshot().accounts.find(
  (candidate) => candidate.id === account.id,
);
assert.equal(current?.status, "ok");
assert.equal(current?.lastErrorClass, undefined);
assert.equal(current?.lastErrorMessage, undefined);
`;

try {
	await runIsolatedManagerTest(childCode, isolatedHome);
} finally {
	rmSync(isolatedHome, { recursive: true, force: true });
}

console.log("codex account runtime cancellation test passed");

function runIsolatedManagerTest(code: string, home: string): Promise<void> {
	return new Promise((resolve, reject) => {
		const child = spawn(
			process.execPath,
			["--import", "tsx", "--input-type=module", "-e", code],
			{
				cwd: join(import.meta.dirname, "../.."),
				env: { ...process.env, TELOMI_DATA_DIR: home },
				stdio: ["ignore", "ignore", "pipe"],
			},
		);
		let stderr = "";
		child.stderr.setEncoding("utf-8");
		child.stderr.on("data", (chunk: string) => {
			stderr += chunk;
		});
		child.once("error", reject);
		child.once("exit", (exitCode) => {
			if (exitCode === 0) {
				resolve();
				return;
			}
			reject(
				new Error(
					`isolated manager test exited ${exitCode ?? "null"}: ${stderr}`,
				),
			);
		});
	});
}
