import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { validatePolicy } from "../../../extensions/telomi-srt/runtime.js";
import { runtimeTools } from "../../../extensions/telomi-srt/runtime-tools.js";
import {
	agentPythonEnvironment,
	agentPythonExecutable,
	agentPythonRoots,
	agentPythonVenv,
} from "./agent-python.js";
import { PRIME_RLM_MAX_DEPTH, primeAgentDir, primeKernelPython } from "./prime-agent-paths.js";

const SRT_PYTHON = fileURLToPath(new URL("../../../extensions/telomi-srt/srt-python.mjs", import.meta.url));
const SRT_RUNNER = fileURLToPath(new URL("../../../extensions/telomi-srt/srt-runner.mjs", import.meta.url));

export function primeKernelEnv(input: {
	cwd: string;
	readonlyRoots?: readonly string[];
	writableRoots: readonly string[];
	privateRoots: readonly string[];
	logPath?: string;
	env?: NodeJS.ProcessEnv;
}): NodeJS.ProcessEnv {
	const env = input.env ?? process.env;
	const cwd = realpathSync(input.cwd);
	const scratch = join(cwd, ".prime-kernel");
	mkdirSync(scratch, { recursive: true });
	const readonlyRoots = input.readonlyRoots ?? [];
	const policy = validatePolicy({
		filesystem: {
			denyRead: [...input.privateRoots],
			allowRead: [
				cwd,
				scratch,
				dirname(SRT_PYTHON),
				...readonlyRoots,
				...input.writableRoots,
				...primeKernelRoots(env),
			],
			allowWrite: [scratch, ...input.writableRoots],
			denyWrite: [...input.privateRoots, ...readonlyRoots],
		},
		network: {
			allowedDomains: [],
			deniedDomains: [],
			strictAllowlist: true,
			allowLocalBinding: true,
		},
	});
	const runtimeEnv = primeRuntimeEnv(env);
	return {
		...runtimeEnv,
		PATH: [dirname(agentPythonExecutable(env)), ...runtimeTools().binPaths, runtimeEnv.PATH].filter(Boolean).join(delimiter),
		PRIME_AGENT_KERNEL_PYTHON: SRT_PYTHON,
		PRIME_AGENT_KERNEL_FORKSERVER: "0",
		TELOMI_SRT_KERNEL_REAL_PYTHON: primeKernelPython(env),
		TELOMI_SRT_KERNEL_CWD: cwd,
		TELOMI_SRT_KERNEL_SCRATCH: scratch,
		TELOMI_SRT_KERNEL_RUNNER: SRT_RUNNER,
		TELOMI_SRT_KERNEL_POLICY_B64: Buffer.from(JSON.stringify(policy), "utf8").toString("base64url"),
		...(input.logPath ? { TELOMI_SRT_KERNEL_LOG: input.logPath } : {}),
	};
}

export function removeSrtTempDirectory(path: string): void {
	rmSync(path, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
}

export function primeRuntimeEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const result: NodeJS.ProcessEnv = { RLM_MAX_DEPTH: String(PRIME_RLM_MAX_DEPTH) };
	for (const name of ["LANG", "LC_ALL", "LC_CTYPE", "TZ"] as const) {
		if (env[name]) result[name] = env[name];
	}
	Object.assign(result, agentPythonEnvironment(env));
	if (env.PRIME_AGENT_KERNEL_PYTHON?.trim()) result.PRIME_AGENT_KERNEL_PYTHON = agentPythonExecutable(env);
	else result.PRIME_AGENT_KERNEL_VENV = agentPythonVenv(env);
	for (const name of configuredCredentialEnvNames(env)) {
		if (env[name]) result[name] = env[name];
	}
	return result;
}

function configuredCredentialEnvNames(env: NodeJS.ProcessEnv): string[] {
	const names = new Set<string>();
	for (const file of ["auth.json", "models.json"]) {
		const path = join(primeAgentDir(env), file);
		if (!existsSync(path)) continue;
		const visit = (value: unknown): void => {
			if (typeof value === "string" && /^[A-Z][A-Z0-9_]+$/u.test(value)) names.add(value);
			else if (Array.isArray(value)) value.forEach(visit);
			else if (value && typeof value === "object") Object.values(value).forEach(visit);
		};
		visit(JSON.parse(readFileSync(path, "utf8")) as unknown);
	}
	return [...names];
}

function primeKernelRoots(env: NodeJS.ProcessEnv): string[] {
	return agentPythonRoots(env);
}
