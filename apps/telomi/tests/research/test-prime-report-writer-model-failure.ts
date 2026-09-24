import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// A model call that fails ends the Report Writer as that model error, not as the outline file the
// model never got to write; a model that answers without writing it still fails the contract.
const root = mkdtempSync(join(tmpdir(), "prime-report-writer-model-failure-"));
try {
	const agentRoot = join(root, "agent-root");
	const runtimeRoot = join(root, "runtime");
	const agentDir = join(root, "agent");
	const skill = join(root, "skills", "report-skill");
	for (const directory of [join(agentRoot, "inputs"), runtimeRoot, agentDir, skill]) mkdirSync(directory, { recursive: true });
	writeFileSync(join(agentDir, "auth.json"), "{}");
	writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: {
		"openai-codex": { baseUrl: "http://127.0.0.1:9/v1", api: "openai-completions", apiKey: "fixture", models: [{ id: "test-model" }] },
	} }));
	writeFileSync(join(agentRoot, "inputs", "materials.json"), JSON.stringify({ schema_version: 1, kind: "findout", refs: ["note-1"] }));
	for (const name of ["system-prompt.md", "initial-prompt.md", "delegation-prompt.md", "final-prompt.md", "final-repair-prompt.md"]) {
		writeFileSync(join(runtimeRoot, name), `${name}\n`);
	}

	const fakePrime = join(root, "fake-prime.mjs");
	writeFileSync(fakePrime, `
import { appendFileSync } from "node:fs";
import { join } from "node:path";
export { AuthStorage, ModelRegistry } from ${JSON.stringify(import.meta.resolve("prime-agent"))};
export const SettingsManager = { create: () => ({ applyOverrides() {}, getAutoRefineSettings: () => ({ enabled: false }) }) };
export class DefaultResourceLoader { async reload() {} getSkills() { return { skills: [{ name: "report-skill" }] }; } }
export const SessionManager = { create: () => ({}) };
export async function createAgentSession() {
	const messages = [];
	return { session: {
		messages,
		subscribe() {},
		async prompt(text) {
			appendFileSync(join(process.env.PRIME_AGENT_REPORT_RUNTIME, "prompts.log"), JSON.stringify(text) + "\\n");
			messages.push({ role: "user", content: text });
			messages.push(process.env.FAKE_MODEL_ERROR
				? { role: "assistant", content: [], stopReason: "error", errorMessage: process.env.FAKE_MODEL_ERROR }
				: { role: "assistant", content: [{ type: "text", text: "Done." }], stopReason: "stop" });
		},
		async waitForRlmQuiescence() {},
		async abort() {},
		dispose() {},
	} };
}
`);

	const runWorker = (modelError?: string) => new Promise<{ status: number | null; prompts: number; failureClass?: string; failureError?: string }>((resolveRun, reject) => {
		rmSync(join(runtimeRoot, "prompts.log"), { force: true });
		let failureClass: string | undefined;
		let failureError: string | undefined;
		const child = fork(resolve("server/research/pipeline/prime-report-writer-worker.ts"), [], {
			cwd: agentRoot,
			execArgv: ["--import", fileURLToPath(import.meta.resolve("tsx"))],
			env: {
				...process.env,
				PRIME_AGENT_REPORT_CWD: agentRoot,
				PRIME_AGENT_REPORT_RUNTIME: runtimeRoot,
				PRIME_AGENT_CODING_AGENT_DIR: agentDir,
				TELOMI_PRIME_CREDENTIAL_SOURCE: agentDir,
				PRIME_AGENT_REPORT_SKILLS: JSON.stringify([skill]),
				PRIME_AGENT_REPORT_EXPECTED_SKILLS: JSON.stringify(["report-skill"]),
				PRIME_AGENT_REPORT_COMPLETED_SECTIONS: "[]",
				PRIME_AGENT_REPORT_ROOT_PROVIDER: "openai-codex",
				PRIME_AGENT_REPORT_ROOT_MODEL: "test-model",
				PRIME_AGENT_REPORT_CHILD_PROVIDER: "openai-codex",
				PRIME_AGENT_REPORT_CHILD_MODEL: "test-model",
				PRIME_AGENT_REPORT_THINKING_LEVEL: "medium",
				PRIME_AGENT_REPORT_KNOWLEDGE_MODE: "findout",
				PRIME_AGENT_MODULE_PATH: fakePrime,
				PRIME_AGENT_PATHS_MODULE_PATH: resolve("server/agent-runtime/prime-agent-paths.ts"),
				FAKE_MODEL_ERROR: modelError ?? "",
			},
			stdio: ["ignore", "ignore", "ignore", "ipc"],
		});
		child.on("message", (message: { type?: unknown; failure_class?: unknown; error?: unknown }) => {
			if (message?.type !== "stage_worker_failure") return;
			failureClass = String(message.failure_class);
			failureError = String(message.error);
		});
		child.once("error", reject);
		child.once("close", (status) => resolveRun({
			status,
			prompts: readFileSync(join(runtimeRoot, "prompts.log"), "utf-8").trim().split("\n").length,
			failureClass,
			failureError,
		}));
	});

	const failedCall = await runWorker("402 Insufficient Balance");
	assert.notEqual(failedCall.status, 0);
	assert.equal(failedCall.failureClass, "provider");
	assert.equal(failedCall.failureError, "402 Insufficient Balance");
	assert.equal(failedCall.prompts, 1, "a failed model call is not asked to repair a file it never wrote");

	const missingOutline = await runWorker();
	assert.notEqual(missingOutline.status, 0);
	assert.equal(missingOutline.failureClass, "validation");
	assert.equal(missingOutline.failureError, "work/report-outline.json is missing");
	assert.equal(missingOutline.prompts, 2);
	console.log("Prime Report Writer model failure test passed");
} finally {
	rmSync(root, { recursive: true, force: true });
}
