import { existsSync, lstatSync, mkdtempSync, readlinkSync, realpathSync, renameSync, rmSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import { agentPythonExecutable, agentPythonVenv } from "../server/agent-runtime/agent-python.js";
import { primeAgentModulePath } from "../server/agent-runtime/prime-agent-paths.js";

const venv = agentPythonVenv();
process.env.PRIME_AGENT_KERNEL_VENV = venv;
const bootstrap = join(dirname(primeAgentModulePath()), "core", "kernel", "bootstrap.js");
if (!existsSync(bootstrap)) throw new Error(`Prime Agent kernel bootstrap does not exist: ${bootstrap}`);
const runtime = await import(pathToFileURL(bootstrap).href) as {
	ensureKernelPython(): Promise<string>;
};
const python = await runtime.ensureKernelPython();
if (python !== agentPythonExecutable()) {
	throw new Error(`Prime Agent prepared an unexpected Python executable: ${python}`);
}
// Linux's sparse read-deny mounts grant the real interpreter, not uv's version alias.
// Keep invoking the venv path (and its site-packages), but make its link target canonical.
if (process.platform === "linux" && !process.env.PRIME_AGENT_KERNEL_PYTHON?.trim()
	&& lstatSync(python).isSymbolicLink()) {
	const target = realpathSync(python);
	if (readlinkSync(python) !== target) {
		const temporary = mkdtempSync(join(dirname(python), ".python-canonical-"));
		const replacement = join(temporary, "python");
		try {
			symlinkSync(target, replacement);
			renameSync(replacement, python);
		} finally {
			rmSync(temporary, { recursive: true, force: true });
		}
	}
}
process.stdout.write(`${python}\n`);
