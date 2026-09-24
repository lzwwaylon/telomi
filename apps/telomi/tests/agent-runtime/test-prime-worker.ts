import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { spawnPrimeWorker, workerFailureReason } from "../../server/agent-runtime/prime-worker.js";
import { ResearchNodeError } from "../../server/agent-runtime/retry-policy.js";

const root = realpathSync(mkdtempSync(join(tmpdir(), "telomi-prime-worker-")));
try {
	const source = join(root, "source-agent");
	mkdirSync(source);
	writeFileSync(join(source, "auth.json"), `${JSON.stringify({ openai: { key: "secret" } })}\n`);
	const env = { ...process.env, PRIME_AGENT_CODING_AGENT_DIR: source };
	const worker = join(root, "fake-worker.mjs");
	writeFileSync(worker, `
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
const agentDir = process.env.PRIME_AGENT_CODING_AGENT_DIR;
const settings = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf-8"));
console.log(JSON.stringify({
	cwd: process.cwd(),
	home: process.env.HOME,
	tmpdir: process.env.TMPDIR,
	auth: existsSync(join(agentDir, "auth.json")),
	autoRefine: settings.autoRefine.enabled,
	rlmMaxDepth: settings.rlmMaxDepth,
	module: process.env.PRIME_AGENT_MODULE_PATH,
	kernelPolicy: Boolean(process.env.TELOMI_SRT_KERNEL_POLICY_B64),
	extra: process.env.FAKE_EXTRA,
}));
const mode = process.env.FAKE_MODE;
if (mode === "ok") {
	process.send({ type: "stage_output_candidate", submission: 1 });
	process.on("message", (message) => {
		mkdirSync(process.env.PRIME_FAKE_RUNTIME, { recursive: true });
		writeFileSync(join(process.env.PRIME_FAKE_RUNTIME, "result.json"), JSON.stringify({
			schema_version: 1, reply: message,
			usage: { input_tokens: 10, output_tokens: 5, cost_usd: 0.25, model_calls: 2 },
		}));
		process.disconnect();
		process.exit(0);
	});
} else if (mode === "validation") {
	process.send({ type: "stage_worker_failure", failure_class: "validation", error: "bad output" }, () => process.exit(1));
} else if (mode === "fail") {
	console.error("provider exploded");
	process.exit(3);
} else if (mode === "hang") {
	setInterval(() => undefined, 1000);
}
`);

	const launch = (mode: string, signal = new AbortController().signal, onMessage?: (message: unknown, reply: (value: unknown) => void) => void) => {
		const stage = join(root, mode);
		const runtimeRoot = join(stage, "runtime");
		return {
			runtimeRoot,
			run: spawnPrimeWorker({
				name: "Fake Prime",
				worker,
				agentRoot: join(stage, "agent"),
				runtimeRoot,
				env,
				extraEnv: { FAKE_MODE: mode, FAKE_EXTRA: "yes", PRIME_FAKE_RUNTIME: runtimeRoot },
				signal,
				onStdoutLine: (line) => lines.push(line),
				...(onMessage ? { onMessage } : {}),
			}),
		};
	};
	const lines: string[] = [];

	// Success: staged Agent Directory, sandbox env, IPC reply, result.json usage, credentials removed afterwards.
	const ok = launch("ok", undefined, (message, reply) => reply({ type: "stage_output_validation", accepted: true, echo: message }));
	const outcome = await ok.run;
	const seen = JSON.parse(lines[0]!) as Record<string, unknown>;
	assert.equal(seen.cwd, join(root, "ok", "agent"));
	assert.equal(seen.home, join(ok.runtimeRoot, "home"));
	assert.match(String(seen.tmpdir), /^\/tmp\/pi-srt-/u);
	assert.equal(seen.auth, true);
	assert.equal(seen.autoRefine, false);
	assert.equal(seen.rlmMaxDepth, 1);
	assert.match(String(seen.module), /prime-agent/u);
	assert.equal(seen.kernelPolicy, true);
	assert.equal(seen.extra, "yes");
	assert.deepEqual(outcome.usage, { inputTokens: 10, outputTokens: 5, costUsd: 0.25, calls: 2 });
	assert.deepEqual((outcome.result as { reply: { echo: unknown } }).reply.echo, { type: "stage_output_candidate", submission: 1 });
	assert.equal(existsSync(join(ok.runtimeRoot, "agent", "auth.json")), false, "staged credentials are removed after exit");
	assert.ok(existsSync(join(ok.runtimeRoot, "agent", "settings.json")));
	assert.equal(readFileSync(join(ok.runtimeRoot, "stdout.txt"), "utf-8"), `${lines[0]}\n`);
	assert.equal(existsSync(String(seen.tmpdir)), false, "socket directory is removed after exit");

	// Worker-reported validation failure becomes a retryable validation error.
	await assert.rejects(launch("validation", undefined, () => undefined).run, (error: unknown) =>
		error instanceof ResearchNodeError && error.failureClass === "validation" && error.retryable && error.message === "bad output");

	// Nonzero exit becomes a provider error carrying the reason the Worker printed.
	const failed = launch("fail");
	await assert.rejects(failed.run, (error: unknown) =>
		error instanceof ResearchNodeError && error.failureClass === "provider"
		&& /Fake Prime exited with code 3: provider exploded/u.test(error.message));
	assert.equal(existsSync(join(failed.runtimeRoot, "agent", "auth.json")), false);
	assert.equal(readFileSync(join(failed.runtimeRoot, "stderr.txt"), "utf-8").trim(), "provider exploded");

	// Abort terminates the child and surfaces as a non-retryable cancellation.
	const controller = new AbortController();
	const hanging = launch("hang", controller.signal);
	setTimeout(() => controller.abort(), 500);
	await assert.rejects(hanging.run, (error: unknown) =>
		error instanceof ResearchNodeError && error.failureClass === "cancelled" && !error.retryable);
	assert.equal(existsSync(join(hanging.runtimeRoot, "agent", "auth.json")), false);

	// A runtime directory inside the Agent workspace would expose staged credentials to workspace snapshots.
	await assert.rejects(spawnPrimeWorker({
		name: "Fake Prime", worker, agentRoot: join(root, "nested"), runtimeRoot: join(root, "nested", "runtime"),
		env, signal: new AbortController().signal,
	}), /must not live inside the Worker Workspace/u);

	// Missing source credentials fail before any process starts.
	await assert.rejects(spawnPrimeWorker({
		name: "Fake Prime", worker, agentRoot: join(root, "no-auth", "agent"), runtimeRoot: join(root, "no-auth", "runtime"),
		env: { ...process.env, PRIME_AGENT_CODING_AGENT_DIR: join(root, "missing") }, signal: new AbortController().signal,
	}), /credential file does not exist/u);
	// A Worker that dies without reporting a structured failure leaves Node's uncaught-exception
	// output. The Activity a user reads renders this text, so the reason survives and the frame
	// around it, which names files on the machine that ran it, does not.
	const crashDump = [
		"/Users/someone/checkout/apps/telomi/server/wiki/wiki-shard-merge.ts:554",
		"                return new Error(`[wiki-curator:worksets] ${issue}`);",
		"                       ^",
		"Error: [wiki-curator:worksets] field 'pages[0].topic_refs': contains unknown Goal Topic 'topic_c51016fb'",
		"    at curatorResultViolation (/Users/someone/checkout/apps/telomi/server/wiki/wiki-shard-merge.ts:554:9)",
		"    at async <anonymous> (/Users/someone/checkout/apps/telomi/server/wiki/prime-wiki-merge-worker.ts:115:2)",
		"",
		"Node.js v24.20.0",
	].join("\n");
	assert.equal(
		workerFailureReason(crashDump),
		"Error: [wiki-curator:worksets] field 'pages[0].topic_refs': contains unknown Goal Topic 'topic_c51016fb'",
	);
	assert.equal(workerFailureReason(crashDump).includes("/Users/"), false, "host paths must not reach the Activity");
	// Output that is not a Node crash dump has no frame to strip and passes through whole.
	assert.equal(workerFailureReason("controlled local transport stop"), "controlled local transport stop");
	assert.equal(workerFailureReason("   \n  "), "");

	console.log("spawnPrimeWorker stages, sandboxes, relays IPC, converts exit codes and cleans up");
} finally {
	rmSync(root, { recursive: true, force: true });
}
