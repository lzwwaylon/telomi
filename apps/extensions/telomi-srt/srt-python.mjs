#!/usr/bin/env node

// Python-compatible launcher used by Prime to place every Python kernel in SRT.
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import { primeExecutionToken, providerExecutionChildId, providerExecutionWorkspace } from "./prime-workspace.ts";

const realPython = required("TELOMI_SRT_KERNEL_REAL_PYTHON");
const rootCwd = realpathSync(required("TELOMI_SRT_KERNEL_CWD"));
const childId = process.env.TELOMI_PROVIDER_EXECUTION_WORKSPACES === "1" && process.env.RLM_DEPTH !== "0"
	? providerExecutionChildId(process.env.RLM_SESSION_DIR) : undefined;
if (process.env.TELOMI_PROVIDER_EXECUTION_WORKSPACES === "1" && Number(process.env.RLM_DEPTH) > 0 && !childId) {
	throw new Error("Provider child kernel requires a valid native child session identity");
}
const executionWorkspace = childId ? providerExecutionWorkspace(rootCwd, childId).absolutePath : undefined;
const cwd = executionWorkspace ?? rootCwd;
const runner = realpathSync(required("TELOMI_SRT_KERNEL_RUNNER"));
const policy = JSON.parse(Buffer.from(required("TELOMI_SRT_KERNEL_POLICY_B64"), "base64url").toString("utf8"));
if (executionWorkspace) {
	// Read access is allowed by default in SRT. Deny the parent tree explicitly,
	// then reopen only this execution and the immutable staged Skill tree.
	policy.filesystem.denyRead.push(rootCwd);
	policy.filesystem.allowRead = policy.filesystem.allowRead.filter((path) => !inside(rootCwd, realpathIfPresent(path)));
	policy.filesystem.allowRead.push(executionWorkspace);
	if (existsSync(join(rootCwd, "skills"))) policy.filesystem.allowRead.push(join(rootCwd, "skills"));
	policy.filesystem.allowWrite = policy.filesystem.allowWrite
		.filter((path) => !inside(rootCwd, realpathIfPresent(path)));
	policy.filesystem.allowWrite.push(executionWorkspace);
}
const connectionIndex = process.argv.indexOf("-f");
const connectionPath = connectionIndex >= 0 ? process.argv[connectionIndex + 1] : undefined;
if (connectionPath && existsSync(connectionPath)) {
	const root = dirname(realpathSync(connectionPath));
	policy.filesystem.allowRead = [...new Set([...policy.filesystem.allowRead, root])];
	policy.filesystem.allowWrite = [...new Set([...policy.filesystem.allowWrite, root])];
}
const logPath = process.env.TELOMI_SRT_KERNEL_LOG;
if (logPath && process.argv.some((arg) => arg === "ipykernel_launcher" || arg === "rlm.repl")) {
	appendFileSync(logPath, `${JSON.stringify({ pid: process.pid, connection_path: connectionPath, sandbox: "srt" })}\n`);
}
const target = {
	command: realPython,
	args: process.argv.slice(2),
	env: kernelEnv(process.env),
};
const runnerEnv = { ...process.env };
delete runnerEnv.PRIME_AGENT_SOURCE_TOKEN;
const child = spawn(process.execPath, [runner], {
	cwd,
	env: {
		...runnerEnv,
		TELOMI_SRT_POLICY_B64: Buffer.from(JSON.stringify(policy), "utf8").toString("base64url"),
		TELOMI_SRT_TARGET_B64: Buffer.from(JSON.stringify(target), "utf8").toString("base64url"),
	},
	stdio: "inherit",
});
const terminate = () => child.kill("SIGTERM");
process.once("SIGTERM", terminate);
process.once("SIGINT", terminate);
const code = await new Promise((resolveExit, reject) => {
	child.once("error", reject);
	child.once("exit", (exitCode) => resolveExit(exitCode ?? 1));
});
process.exitCode = code;

function kernelEnv(env) {
	const result = {};
	for (const [name, value] of Object.entries(env)) {
		if (value === undefined) continue;
		if (["PATH", "LANG", "LC_ALL", "LC_CTYPE", "TZ", "PYTHONPATH", "PYTHONNOUSERSITE", "VIRTUAL_ENV"].includes(name)
			|| name.startsWith("RLM_")
			|| name.startsWith("PRIME_AGENT_")) result[name] = value;
	}
	const scratch = executionWorkspace ? join(executionWorkspace, ".prime-kernel") : required("TELOMI_SRT_KERNEL_SCRATCH");
	return {
		...result,
		...(env.PRIME_AGENT_SOURCE_TOKEN ? {
			PRIME_AGENT_SOURCE_TOKEN: primeExecutionToken(env.PRIME_AGENT_SOURCE_TOKEN, childId ?? "root"),
		} : {}),
		...(executionWorkspace ? {
			PRIME_AGENT_ARTIFACT_WORKSPACE: executionWorkspace,
			PRIME_AGENT_SOURCE_LOG: join(executionWorkspace, "work", "provider.jsonl"),
		} : {}),
		HOME: scratch,
		TMPDIR: scratch,
		TMP: scratch,
		TEMP: scratch,
		PYTHONDONTWRITEBYTECODE: "1",
	};
}

function inside(root, candidate) {
	const path = relative(root, candidate);
	return path === "" || (path !== ".." && !path.startsWith("../") && !isAbsolute(path));
}

function realpathIfPresent(path) {
	return existsSync(path) ? realpathSync(path) : path;
}

function required(name) {
	const value = process.env[name]?.trim();
	if (!value) throw new Error(`${name} is required`);
	return value;
}
