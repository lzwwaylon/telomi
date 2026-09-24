import { isDeepStrictEqual } from "node:util";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, globSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const dependencyFields = ["name", "version", "dependencies", "devDependencies", "optionalDependencies", "peerDependencies", "peerDependenciesMeta", "bundledDependencies", "bundleDependencies", "workspaces", "overrides", "resolutions", "packageManager", "engines", "os", "cpu"];

function cleanGitEnvironment(): NodeJS.ProcessEnv {
	return Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
}

/** Materialize the index without stashing, checking out, or rewriting the user's index. */
export function createStagedCheckout(sourceRoot: string): { root: string; dispose(): void } {
	sourceRoot = realpathSync(sourceRoot);
	const temporary = mkdtempSync(join(tmpdir(), "telomi-staged-check-"));
	const root = join(temporary, "checkout");
	const dispose = () => rmSync(temporary, { recursive: true, force: true });
	const environment = cleanGitEnvironment();
	const git = (cwd: string, args: string[], env = environment) => execFileSync("git", args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 32 * 1024 * 1024 });
	try {
		// write-tree may update the index's cache-tree extension. Give it a private copy.
		const index = join(temporary, "index");
		const sourceEnvironment: NodeJS.ProcessEnv = { ...process.env, GIT_OPTIONAL_LOCKS: "0" };
		for (const key of ["GIT_DIR", "GIT_COMMON_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY"] as const) {
			if (sourceEnvironment[key]) sourceEnvironment[key] = resolve(sourceEnvironment[key]);
		}
		const indexPath = sourceEnvironment.GIT_INDEX_FILE ?? git(sourceRoot, ["rev-parse", "--git-path", "index"], sourceEnvironment).trim();
		copyFileSync(resolve(sourceRoot, indexPath), index);
		const tree = git(sourceRoot, ["write-tree"], { ...sourceEnvironment, GIT_INDEX_FILE: index }).trim();
		git(sourceRoot, ["clone", "--quiet", "--shared", "--no-checkout", "--", sourceRoot, root]);
		git(root, ["config", "core.hooksPath", "/dev/null"]);
		git(root, ["read-tree", tree]);
		git(root, ["checkout-index", "--all", "--force"]);
		const tracked = git(root, ["ls-files", "-z"]).split("\0").filter(Boolean);
		const changed = [false, true].flatMap((staged) => git(sourceRoot, ["diff", ...(staged ? ["--cached"] : []), "--name-only", "-z"], sourceEnvironment).split("\0").filter(Boolean));
		for (const path of new Set([...tracked, ...changed])) {
			const name = basename(path);
			if (!["package.json", "package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "pnpm-lock.yaml", "pyproject.toml", "uv.lock"].includes(name)) continue;
			const stagedPath = join(root, path);
			const installedPath = join(sourceRoot, path);
			const staged = existsSync(stagedPath) ? readFileSync(stagedPath, "utf8") : undefined;
			const installed = existsSync(installedPath) ? readFileSync(installedPath, "utf8") : undefined;
			if (staged === installed) continue;
			if (name === "package.json" && staged !== undefined && installed !== undefined) {
				const stagedPackage = JSON.parse(staged);
				const installedPackage = JSON.parse(installed);
				if (dependencyFields.every((field) => isDeepStrictEqual(stagedPackage[field], installedPackage[field]))) continue;
			}
			throw new Error(`Cannot validate staged dependencies using this checkout's installation: ${path} differs between the index and working tree. Align the dependency files and reinstall before committing.`);
		}

		const workspacePackages = new Map<string, string>();
		if (existsSync(join(root, "package.json"))) {
			const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
			const patterns: string[] = Array.isArray(manifest.workspaces) ? manifest.workspaces : manifest.workspaces?.packages ?? [];
			for (const path of globSync(patterns.map((pattern) => `${pattern}/package.json`), { cwd: root })) {
				const pkg = JSON.parse(readFileSync(join(root, path), "utf8"));
				if (typeof pkg.name === "string") workspacePackages.set(pkg.name, join(root, dirname(path)));
			}
		}
		const insideSource = (path: string) => {
			const rel = relative(sourceRoot, path);
			return !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`);
		};
		function linkDependency(from: string, to: string, packageName: string): void {
			let target = workspacePackages.get(packageName) ?? from;
			if (target === from && lstatSync(from).isSymbolicLink()) {
				const resolved = realpathSync(from);
				// Workspace packages and their binaries must load staged source.
				if (insideSource(resolved) && !relative(sourceRoot, resolved).split(sep).includes("node_modules")) {
					target = join(root, relative(sourceRoot, resolved));
				}
			}
			if (!existsSync(to)) symlinkSync(target, to);
		}
		function shareModules(path: string): void {
			const from = join(sourceRoot, path, "node_modules");
			if (!existsSync(from)) return;
			const to = join(root, path, "node_modules");
			mkdirSync(to, { recursive: true });
			for (const entry of readdirSync(from)) {
				if (entry.startsWith(".") && entry !== ".bin") continue;
				if (entry.startsWith("@") || entry === ".bin") {
					mkdirSync(join(to, entry), { recursive: true });
					for (const child of readdirSync(join(from, entry))) linkDependency(join(from, entry, child), join(to, entry, child), `${entry}/${child}`);
				} else linkDependency(join(from, entry), join(to, entry), entry);
			}
		}
		for (const path of new Set([".", ...tracked.filter((path) => basename(path) === "package.json").map(dirname)])) shareModules(path);
		const shellQuote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
		for (const project of new Set(tracked.filter((path) => basename(path) === "pyproject.toml").map(dirname))) {
			const installed = join(sourceRoot, project, ".venv");
			const shadow = join(root, project, ".venv");
			if (!existsSync(installed) || existsSync(shadow)) continue;
			// Editable installs can fall back to the original source when a staged
			// deletion removes a module or turns a regular package into a namespace.
			for (const path of new Set(changed)) {
				if (path.endsWith(".py") && (path.startsWith(`${project}/src/`) || dirname(path) === project)
					&& existsSync(join(sourceRoot, path)) && !existsSync(join(root, path))) {
					throw new Error(`Cannot validate staged Python deletion: ${path} still exists in the working tree and may load through the shared environment. Align the working-tree deletion before committing.`);
				}
			}
			mkdirSync(join(shadow, "bin"), { recursive: true });
			for (const entry of readdirSync(installed)) {
				if (entry !== "bin") symlinkSync(join(installed, entry), join(shadow, entry));
			}
			if (!existsSync(join(installed, "bin"))) continue;
			const stagedProject = join(root, project);
			const pythonPath = [join(stagedProject, "src"), stagedProject].filter(existsSync).join(":");
			for (const entry of readdirSync(join(installed, "bin"))) {
				const original = join(installed, "bin", entry);
				const target = join(shadow, "bin", entry);
				if (/^python(?:\d+(?:\.\d+)?)?$/.test(entry)) {
					writeFileSync(target, `#!/bin/sh
export PYTHONPATH=${shellQuote(pythonPath)}\${PYTHONPATH:+":$PYTHONPATH"}
export PYTHONDONTWRITEBYTECODE=1
exec ${shellQuote(original)} "$@"
`, { mode: 0o755 });
				} else symlinkSync(original, target);
			}
		}
		const kernel = "apps/telomi/.prime-kernel";
		if (existsSync(join(sourceRoot, kernel)) && !existsSync(join(root, kernel))) {
			mkdirSync(dirname(join(root, kernel)), { recursive: true });
			symlinkSync(join(sourceRoot, kernel), join(root, kernel));
		}
		return { root, dispose };
	} catch (error) {
		dispose();
		throw error;
	}
}
