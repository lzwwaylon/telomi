import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Prime reports every attempt of a model call to subscribers, then its auto-retry drops an attempt it
// recovered from out of session.messages. A Worker must end on a failure no retry recovered, and
// must not end on one that was recovered.
const root = mkdtempSync(join(tmpdir(), "prime-recovered-model-error-"));
try {
	const agentDir = join(root, "agent");
	const skill = join(root, "skill");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(skill, { recursive: true });
	writeFileSync(join(agentDir, "auth.json"), "{}");
	writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: {
		"openai-codex": { baseUrl: "http://127.0.0.1:9/v1", api: "openai-completions", apiKey: "fixture", models: [{ id: "test-model" }] },
	} }));

	const fakePrime = join(root, "fake-prime.mjs");
	writeFileSync(fakePrime, `
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
export { AuthStorage, ModelRegistry } from ${JSON.stringify(import.meta.resolve("prime-agent"))};
export const SettingsManager = { create: () => ({ applyOverrides() {}, getAutoRefineSettings: () => ({ enabled: false }) }) };
export class DefaultResourceLoader { async reload() {} getSkills() { return { skills: [{ name: "fixture-skill" }] }; } }
export const SessionManager = { create: () => ({}) };
export async function createAgentSession(options) {
	let subscriber = () => undefined;
	const messages = [];
	return { session: {
		messages,
		subscribe(listener) { subscriber = listener; },
		async prompt() {
			appendFileSync(process.env.FAKE_PROMPT_LOG, "prompt\\n");
			const failed = { role: "assistant", provider: "openai-codex", model: "test-model", stopReason: "error", errorMessage: "429 rate limited", content: [] };
			subscriber({ type: "message_end", message: failed });
			if (process.env.FAKE_MODEL_ERROR === "final") {
				messages.push(failed);
				return;
			}
			if (process.env.FAKE_WRITE) {
				const file = join(options.cwd, process.env.FAKE_WRITE);
				mkdirSync(dirname(file), { recursive: true });
				writeFileSync(file, JSON.stringify({ decision: "approve" }));
			}
			const answered = { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Done." }] };
			subscriber({ type: "message_end", message: answered });
			messages.push(answered);
		},
		async waitForRlmQuiescence() {},
		async abort() {},
		dispose() {},
	} };
}
`);

	const runWorker = (name: string, worker: string, mode: "recovered" | "final", env: Record<string, string>) =>
		new Promise<{ status: number | null; stderr: string; prompts: number }>((resolveRun, reject) => {
			const cwd = join(root, name, "cwd");
			const runtime = join(root, name, "runtime");
			mkdirSync(cwd, { recursive: true });
			mkdirSync(runtime, { recursive: true });
			const promptLog = join(root, name, "prompts.log");
			writeFileSync(promptLog, "");
			let stderr = "";
			const child = fork(resolve(worker), [], {
				cwd,
				execArgv: ["--import", fileURLToPath(import.meta.resolve("tsx"))],
				env: {
					...process.env,
					PRIME_AGENT_CODING_AGENT_DIR: agentDir,
					TELOMI_PRIME_CREDENTIAL_SOURCE: agentDir,
					PRIME_AGENT_MODULE_PATH: fakePrime,
					FAKE_PROMPT_LOG: promptLog,
					FAKE_MODEL_ERROR: mode,
					...Object.fromEntries(Object.entries(env).map(([key, value]) => [key, value.replace("{cwd}", cwd).replace("{runtime}", runtime)])),
				},
				stdio: ["ignore", "ignore", "pipe", "ipc"],
			});
			child.stderr!.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf-8"); });
			child.once("error", reject);
			child.once("close", (status) => resolveRun({
				status,
				stderr,
				prompts: readFileSync(promptLog, "utf-8").trim().split("\n").filter(Boolean).length,
			}));
		});

	const reviewer = (name: string, mode: "recovered" | "final") => runWorker(name, "server/research/schedules/reviewer-worker.ts", mode, {
		PRIME_SCHEDULE_REVIEW_CWD: "{cwd}",
		PRIME_SCHEDULE_REVIEW_RUNTIME: "{runtime}",
		PRIME_SCHEDULE_REVIEW_THINKING_LEVEL: "medium",
		PRIME_SCHEDULE_REVIEW_ROOT_MODEL: "openai-codex/test-model",
		PRIME_SCHEDULE_REVIEW_SKILLS: JSON.stringify([skill]),
		PRIME_SCHEDULE_REVIEW_EXPECTED_SKILLS: JSON.stringify(["fixture-skill"]),
		FAKE_WRITE: "review-output/decision.json",
	});
	const reviewed = await reviewer("review-recovered", "recovered");
	assert.equal(reviewed.status, 0, `a review whose model call a retry recovered finishes: ${reviewed.stderr}`);
	assert.equal(reviewed.prompts, 1);
	const reviewFailed = await reviewer("review-final", "final");
	assert.notEqual(reviewFailed.status, 0);
	assert.match(reviewFailed.stderr, /model 'openai-codex\/test-model' failed: 429 rate limited/u,
		"a failure no retry recovered still ends the review, naming the model the Runtime reports");

	const podcast = (name: string, mode: "recovered" | "final") => runWorker(name, "server/media/podcast/writer-worker.ts", mode, {
		PRIME_PODCAST_CWD: "{cwd}",
		PRIME_PODCAST_RUNTIME: "{runtime}",
		PRIME_PODCAST_THINKING_LEVEL: "medium",
		PRIME_PODCAST_ROOT_MODEL: "openai-codex/test-model",
		PRIME_PODCAST_CHILD_MODEL: "openai-codex/test-model",
		PRIME_PODCAST_SKILL: skill,
		PRIME_PODCAST_EXPECTED_SKILL: "fixture-skill",
	});
	// The fake writes no segments, so a writer that goes on past the recovered call ends on its own
	// segment validation after its repairs, not on the recovered provider error.
	const drafted = await podcast("podcast-recovered", "recovered");
	assert.notEqual(drafted.status, 0);
	assert.doesNotMatch(drafted.stderr, /429 rate limited/u, `a recovered model call does not end the writer: ${drafted.stderr}`);
	assert.equal(drafted.prompts, 3, "the plan prompt and both segment repairs run");
	const draftFailed = await podcast("podcast-final", "final");
	assert.notEqual(draftFailed.status, 0);
	assert.match(draftFailed.stderr, /model 'openai-codex\/test-model' failed: 429 rate limited/u, "a failure no retry recovered still ends the writer");
	assert.equal(draftFailed.prompts, 1, "a failed model call is not asked to repair");
	console.log("Prime recovered model error test passed");
} finally {
	rmSync(root, { recursive: true, force: true });
}
