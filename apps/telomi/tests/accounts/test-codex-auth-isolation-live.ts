import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveAgentPath } from "../../server/config/agent-directory.js";
import { codexAccountManager } from "../../server/accounts/manager.js";
import { SrtStageRuntime } from "../../server/agent-runtime/agent-stage-runtime.js";
import { RunArtifactStore } from "../../server/agent-runtime/artifact-store.js";

const require = createRequire(import.meta.url);
const lockfile = require("../../node_modules/@earendil-works/pi-coding-agent/node_modules/proper-lockfile") as {
	lock(path: string, options: Record<string, unknown>): Promise<() => Promise<void>>;
};

await codexAccountManager.load();
assert.ok(codexAccountManager.getActiveCredential(), "configure at least one Codex account");

const authPath = resolveAgentPath("auth.json");
const authBefore = readFileSync(authPath, "utf-8");
const root = mkdtempSync(join(tmpdir(), "telomi-codex-auth-isolation-live-"));
const release = await lockfile.lock(authPath, {
	realpath: false,
	stale: 600_000,
	retries: { retries: 10, minTimeout: 25, maxTimeout: 100 },
});

try {
	const expected = { status: "complete", result: "request-local Codex auth passed" };
	const result = await new SrtStageRuntime().runStage({
		runId: "codex-auth-isolation-live",
		stageId: "locked-shared-auth-file",
		attemptId: "1",
		role: "codex-auth-isolation-live",
		promptConfig: {
			domain: "research",
			id: "report-writer",
			sandboxRole: "report.report_writer",
		},
		session: { key: "codex-auth-isolation-live", policy: "fresh" },
		modelPolicy: {
			preferred: ["openai-codex/gpt-5.4-mini"],
			fallback: [],
			reasoning: "low",
			maxRetries: 1,
			maxTokens: 300,
		},
		systemPrompt: [
			"You are verifying request-local Codex authentication.",
			"Do not call any Tool and do not write any file.",
			"Return only the exact JSON requested by the user.",
		].join("\n"),
		userPrompt: `Return exactly ${JSON.stringify(expected)} with no code fence or explanation.`,
		workDirectory: join(root, "work"),
		readonlyMounts: [],
		controlDirectory: join(root, "control"),
		artifactStore: new RunArtifactStore(join(root, "published")),
		output: {
			kind: "json_candidate",
			publishRelativePath: "result.json",
			validate: ({ entryPath }) => {
				const value = JSON.parse(readFileSync(entryPath, "utf-8")) as typeof expected;
				assert.deepEqual(value, expected);
				return value;
			},
		},
		signal: new AbortController().signal,
	});

	assert.deepEqual(result.value, expected);
	assert.equal(
		readFileSync(authPath, "utf-8"),
		authBefore,
		"a model request must not mutate the shared auth.json",
	);
	console.log(JSON.stringify({ passed: true, usage: result.usage }));
} finally {
	await release();
	rmSync(root, { recursive: true, force: true });
}
