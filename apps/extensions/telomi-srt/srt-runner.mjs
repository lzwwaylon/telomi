import { spawn } from "node:child_process";

import { SandboxManager } from "@anthropic-ai/sandbox-runtime";
import { fileURLToPath } from "node:url";
import { linuxSandboxArgv } from "./linux-mounts.ts";

// This control process only resolves the system tools the sandbox wrapper is
// built from, and the SDK resolves them by spawning `which` under a short fixed
// budget. Whatever sits first on PATH therefore decides whether the sandbox can
// start: an npm bin directory or a caller-supplied entry can answer too slowly
// and the wrapper reports the shell as missing. System locations go first here.
// The target keeps the exact environment its caller asked for, restored from the
// encoded target env in srt-target.mjs.
process.env.PATH = ["/usr/bin", "/bin", ...(process.env.PATH ?? "").split(":")]
	.filter((entry, index, all) => entry !== "" && all.indexOf(entry) === index)
	.join(":");

const policyValue = process.env.TELOMI_SRT_POLICY_B64;
if (!policyValue) throw new Error("TELOMI_SRT_POLICY_B64 is required");
const policy = JSON.parse(Buffer.from(policyValue, "base64url").toString("utf8"));
delete process.env.TELOMI_SRT_POLICY_B64;

const targetValue = process.env.TELOMI_SRT_TARGET_B64;
if (!targetValue) throw new Error("TELOMI_SRT_TARGET_B64 is required");
const target = JSON.parse(Buffer.from(targetValue, "base64url").toString("utf8"));
const launcher = fileURLToPath(new URL("./srt-target.mjs", import.meta.url));

await SandboxManager.initialize(policy);
await SandboxManager.waitForNetworkInitialization();
const represented = [process.execPath, launcher].map(shellQuote).join(" ");
const wrapped = await SandboxManager.wrapWithSandboxArgv(represented, "sh", undefined, undefined, process.cwd());
const argv = process.platform === "linux" ? linuxSandboxArgv(wrapped.argv, policy.filesystem) : wrapped.argv;
const child = spawn(argv[0], argv.slice(1), {
	cwd: process.cwd(),
	env: { ...process.env, ...wrapped.env },
	detached: true,
	stdio: ["inherit", "pipe", "pipe"],
});
let stderr = "";
child.stdout.pipe(process.stdout);
child.stderr.on("data", (chunk) => {
	process.stderr.write(chunk);
	stderr = `${stderr}${chunk}`.slice(-64 * 1024);
});
const terminate = () => {
	if (!child.pid) return;
	try { process.kill(-child.pid, "SIGTERM"); } catch { child.kill("SIGTERM"); }
};
process.once("SIGTERM", terminate);
process.once("SIGINT", terminate);
const result = await new Promise((resolve, reject) => {
	child.once("error", reject);
	child.once("exit", (code, signal) => resolve({ code: code ?? 1, signal }));
});
const annotated = SandboxManager.annotateStderrWithSandboxFailures(represented, stderr);
if (annotated !== stderr) process.stderr.write(`${annotated.slice(stderr.length)}\n`);
await SandboxManager.reset();
if (result.signal) process.kill(process.pid, result.signal);
process.exitCode = result.code;

function shellQuote(value) {
	return `'${String(value).replaceAll("'", `'\\''`)}'`;
}
