import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_AGENT_PYTHON_VENV = fileURLToPath(new URL("../../.prime-kernel", import.meta.url));
const pythonRoots = new Map<string, string[]>();

export function agentPythonVenv(env: NodeJS.ProcessEnv = process.env): string {
	const path = resolve(env.PRIME_AGENT_KERNEL_VENV?.trim() || DEFAULT_AGENT_PYTHON_VENV);
	// Worktrees may share a venv through a symlink. Use the same path as the SRT
	// allowlist without resolving bin/python itself (which would discard the venv).
	return existsSync(path) ? realpathSync(path) : path;
}

export function agentPythonExecutable(env: NodeJS.ProcessEnv = process.env): string {
	const python = resolve(env.PRIME_AGENT_KERNEL_PYTHON?.trim() || join(agentPythonVenv(env), "bin", "python"));
	// Resolve the containing directory, not the executable symlink into system Python.
	return existsSync(dirname(python)) ? join(realpathSync(dirname(python)), basename(python)) : python;
}

export function agentPythonRoots(env: NodeJS.ProcessEnv = process.env): string[] {
	const python = agentPythonExecutable(env);
	const venv = env.PRIME_AGENT_KERNEL_PYTHON?.trim() ? dirname(dirname(python)) : agentPythonVenv(env);
	if (!existsSync(python)) return [venv];
	let roots = pythonRoots.get(python);
	if (!roots) {
		// A system interpreter's installation prefix may be /usr. Grant its library
		// directories instead of reopening the entire prefix under a root read-deny.
		const libraries: string[] = JSON.parse(execFileSync(python, ["-I", "-B", "-c", `
import json, sysconfig
print(json.dumps([sysconfig.get_path(key) for key in ("stdlib", "platstdlib", "purelib", "platlib")]
    + [sysconfig.get_config_var("LIBDIR")]))
`], { encoding: "utf-8", timeout: 10_000 }));
		roots = [...new Set([
			...(existsSync(join(venv, "pyvenv.cfg")) ? [venv] : []),
			python, realpathSync(python),
			...libraries.filter((path) => typeof path === "string" && existsSync(path)),
		].map((path) => realpathSync(path)))];
		pythonRoots.set(python, roots);
	}
	return [...roots];
}

export function agentPythonEnvironment(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
	const python = agentPythonExecutable(env);
	return {
		PATH: [dirname(python), env.PATH].filter(Boolean).join(delimiter),
		PYTHONNOUSERSITE: "1",
		VIRTUAL_ENV: env.PRIME_AGENT_KERNEL_PYTHON?.trim() ? dirname(dirname(python)) : agentPythonVenv(env),
	};
}
