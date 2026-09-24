import { spawn } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

import { runtimeControlRoot } from "../workspaces/server-runtime-paths.js";
import { hashDirectory, sha256 } from "../lib/hash.js";
import { primeKernelPython } from "./prime-agent-paths.js";

export interface PreparedPythonSkill {
	skillRoot: string;
	importName: string;
	environmentHash: string;
	pythonPaths: string[];
	lockPath: string;
}

export async function preparePythonSkillEnvironment(
	skillRoot: string,
	options: { dataDir?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<PreparedPythonSkill | undefined> {
	const pyproject = join(skillRoot, "pyproject.toml");
	if (!existsSync(pyproject)) return undefined;
	const skillName = basename(skillRoot);
	const importName = skillName.replaceAll("-", "_");
	const sourceRoot = join(skillRoot, "src");
	if (!existsSync(join(sourceRoot, importName, "__init__.py"))) {
		throw new Error(`Python Skill '${skillName}' is missing src/${importName}/__init__.py`);
	}
	const environmentHash = sha256(JSON.stringify({
		schemaVersion: 1,
		python: primeKernelPython(options.env),
		skill: hashDirectory(skillRoot),
	}));
	const root = join(runtimeControlRoot(options.dataDir), "skill-envs", environmentHash);
	const readyPath = join(root, "ready.json");
	if (!existsSync(readyPath)) await buildEnvironment(root, pyproject, importName, sourceRoot, options.env ?? process.env);
	const ready = JSON.parse(readFileSync(readyPath, "utf-8")) as { environmentHash?: string; lockSha256?: string };
	if (ready.environmentHash !== environmentHash || typeof ready.lockSha256 !== "string") {
		throw new Error(`Python Skill environment '${environmentHash}' is invalid`);
	}
	return {
		skillRoot,
		importName,
		environmentHash,
		pythonPaths: [sourceRoot, join(root, "site-packages")],
		lockPath: join(root, "requirements.lock"),
	};
}

async function buildEnvironment(
	target: string,
	pyproject: string,
	importName: string,
	sourceRoot: string,
	env: NodeJS.ProcessEnv,
): Promise<void> {
	mkdirSync(dirname(target), { recursive: true });
	const temporary = mkdtempSync(join(dirname(target), `.${basename(target)}-`));
	const lockPath = join(temporary, "requirements.lock");
	const sitePackages = join(temporary, "site-packages");
	mkdirSync(sitePackages, { recursive: true });
	try {
		await run("uv", ["pip", "compile", pyproject, "--python-version", "3.11", "-o", lockPath], env);
		await run("uv", ["pip", "install", "--target", sitePackages, "-r", lockPath], env);
		await run(primeKernelPython(env), ["-c", `import ${importName}`], {
			...env,
			PYTHONPATH: [sourceRoot, sitePackages, env.PYTHONPATH].filter(Boolean).join(":"),
		});
		writeFileSync(join(temporary, "ready.json"), `${JSON.stringify({
			schemaVersion: 1,
			environmentHash: basename(target),
			lockSha256: sha256(readFileSync(lockPath)),
			createdAt: new Date().toISOString(),
		}, null, 2)}\n`, { encoding: "utf-8", flag: "wx", mode: 0o600 });
		try {
			renameSync(temporary, target);
		} catch (error) {
			if (!existsSync(join(target, "ready.json"))) throw error;
		}
	} finally {
		if (existsSync(temporary)) rmSync(temporary, { recursive: true, force: true });
	}
}

function run(command: string, args: string[], env: NodeJS.ProcessEnv): Promise<void> {
	return new Promise((resolvePromise, reject) => {
		const stderr: Buffer[] = [];
		const child = spawn(command, args, { env, stdio: ["ignore", "ignore", "pipe"] });
		child.stderr!.on("data", (chunk: Buffer) => stderr.push(chunk));
		child.once("error", reject);
		child.once("exit", (code, signal) => {
			if (code === 0) resolvePromise();
			else reject(new Error(`${command} ${args[0] ?? ""} failed with ${signal ?? `exit ${code}`}: ${Buffer.concat(stderr).toString("utf-8").trim().slice(-4_000)}`));
		});
	});
}
