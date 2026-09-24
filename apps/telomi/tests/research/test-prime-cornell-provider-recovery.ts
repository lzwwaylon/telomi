import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = mkdtempSync(join(tmpdir(), "prime-cornell-provider-recovery-"));
try {
  const agentRoot = join(root, "agent-root");
  const runtimeRoot = join(root, "runtime");
  const agentDir = join(root, "agent");
  mkdirSync(join(agentRoot, "source"), { recursive: true });
  mkdirSync(runtimeRoot, { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, "auth.json"), "{}");
  writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: {
    "openai-codex": { baseUrl: "http://127.0.0.1:9/v1", api: "openai-completions", apiKey: "fixture", models: [{ id: "test-model" }] },
  } }));
  writeFileSync(join(agentRoot, "source", "paper.md"), "Recovered evidence\n");
  for (const name of [
    "system-prompt.md",
    "user-prompt.md",
    "repair-prompt.md",
  ]) {
    writeFileSync(join(runtimeRoot, name), `${name}\n`);
  }

  const fakePrime = join(root, "fake-prime.mjs");
  writeFileSync(
    fakePrime,
    `
import { writeFileSync } from "node:fs";
import { join } from "node:path";
export { AuthStorage, ModelRegistry } from ${JSON.stringify(import.meta.resolve("prime-agent"))};
export const SettingsManager = { create: () => ({ getAutoRefineSettings: () => ({ enabled: false }) }) };
export class DefaultResourceLoader { async reload() {} }
export const SessionManager = { create: () => ({}) };
// Like Prime: every attempt reaches subscribers, and an attempt its auto-retry recovered from is
// dropped from session.messages, so only a failure no retry recovered stays the latest message.
export async function createAgentSession(options) {
	let subscriber = () => undefined;
	const messages = [];
	return { session: {
		messages,
		subscribe(listener) { subscriber = listener; },
		async prompt() {
			if (process.env.FAKE_PROVIDER_ERROR !== "none") {
				const failed = {
					role: "assistant", stopReason: "error", errorMessage: "WebSocket closed 1006",
					usage: { input: 1, output: 0, cost: { total: 0 } },
				};
				subscriber({ type: "message_end", message: failed });
				if (process.env.FAKE_PROVIDER_ERROR === "final") {
					messages.push(failed);
					return;
				}
			}
			if (process.env.FAKE_VALID_OUTPUT === "true") {
				writeFileSync(join(options.cwd, "cornell-note.json"), JSON.stringify({ sections: [{
					section_title: "Recovered section", summary: "The valid artifact survived the transport error.",
					cue_notes: [{ cue: "Recovery", note: "Evidence remains valid.", evidence: [
						{ source_path: "paper.md", start_line: 1, end_line: 1 },
					] }],
				}] }));
			}
			const answered = {
				role: "assistant", stopReason: "stop",
				usage: { input: 1, output: 1, cost: { total: 0 } },
			};
			subscriber({ type: "message_end", message: answered });
			messages.push(answered);
		},
		async abort() {},
		dispose() {},
	} };
}
`,
  );

  const runWorker = (validOutput: boolean, providerError: "none" | "recovered" | "final" = "none") => new Promise<{
    status: number | null;
    stderr: string;
    submissions: number;
    failureClass?: string;
    failureError?: string;
  }>((resolveRun, reject) => {
    let stderr = "";
    let submissions = 0;
    let failureClass: string | undefined;
    let failureError: string | undefined;
    const child = fork(
      resolve("server/research/pipeline/prime-cornell-note-worker.mjs"),
      [],
      {
        cwd: agentRoot,
        env: {
          ...process.env,
          PRIME_AGENT_EVIDENCE_CWD: agentRoot,
          PRIME_AGENT_EVIDENCE_RUNTIME: runtimeRoot,
          PRIME_AGENT_CODING_AGENT_DIR: agentDir,
          PRIME_AGENT_EVIDENCE_PROVIDER: "openai-codex",
          PRIME_AGENT_EVIDENCE_MODEL: "test-model",
          PRIME_AGENT_EVIDENCE_SKILLS: "[]",
          PRIME_AGENT_EVIDENCE_THINKING: "medium",
          TELOMI_PRIME_CREDENTIAL_SOURCE: agentDir,
          PRIME_AGENT_MODULE_PATH: fakePrime,
          PRIME_AGENT_PATHS_MODULE_PATH: resolve("server/agent-runtime/prime-agent-paths.ts"),
          FAKE_VALID_OUTPUT: String(validOutput),
          FAKE_PROVIDER_ERROR: providerError,
        },
        stdio: ["ignore", "ignore", "pipe", "ipc"],
      },
    );
    child.stderr!.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf-8"); });
    child.on("message", (message: unknown) => {
      if (!message || typeof message !== "object") return;
      if ((message as { type?: unknown }).type === "stage_worker_failure") {
        failureClass = String((message as { failure_class?: unknown }).failure_class);
        failureError = String((message as { error?: unknown }).error);
        return;
      }
      if ((message as { type?: unknown }).type !== "stage_output_candidate") return;
      const submission = (message as { submission: number }).submission;
      submissions += 1;
      child.send({
        type: "stage_output_validation",
        submission,
        accepted: validOutput && existsSync(join(agentRoot, "cornell-note.json")),
        error: "cornell-note.json is missing",
      });
    });
    child.once("error", reject);
    child.once("close", (status) => resolveRun({ status, stderr, submissions, failureClass, failureError }));
  });

  const answered = await runWorker(true);
  assert.equal(answered.status, 0, answered.stderr);
  assert.equal(answered.submissions, 1);
  const recovered = await runWorker(true, "recovered");
  assert.equal(recovered.status, 0, recovered.stderr);
  assert.equal(recovered.submissions, 1);
  const rejected = await runWorker(false, "final");
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /WebSocket closed 1006/u);
  assert.equal(rejected.submissions, 1, "a model call no retry recovered is not asked to repair");
  assert.equal(rejected.failureClass, "provider");
  assert.equal(rejected.failureError, "WebSocket closed 1006");
  // A failure Prime's auto-retry recovered from is not the note's outcome: its output still gets repaired.
  const recoveredThenInvalid = await runWorker(false, "recovered");
  assert.notEqual(recoveredThenInvalid.status, 0);
  assert.equal(recoveredThenInvalid.submissions, 3);
  assert.equal(recoveredThenInvalid.failureClass, "validation");
  assert.equal(recoveredThenInvalid.failureError, "cornell-note.json is missing");
  const invalid = await runWorker(false);
  assert.notEqual(invalid.status, 0);
  assert.equal(invalid.submissions, 3);
  assert.equal(invalid.failureClass, "validation");
  assert.equal(invalid.failureError, "cornell-note.json is missing");
  console.log("Prime Cornell provider recovery test passed");
} finally {
  rmSync(root, { recursive: true, force: true });
}
