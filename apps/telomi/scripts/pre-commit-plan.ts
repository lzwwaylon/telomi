/**
 * Pre-commit plan: maps staged paths to deterministic checks and rejects
 * local copies of shared helpers and newly added tests that import a Provider SDK or model client.
 *
 * Never runs an Agent, Browser, model, or live Provider. Real verification of
 * semantic behavior goes through Attestation in the external evaluation environment.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { copyFileSync, existsSync, globSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join, posix, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";
import { selectAffectedTests } from "./affected-tests.js";
import { createStagedCheckout } from "./staged-checkout.js";

export interface StagedChanges {
	added: string[];
	changed: string[];
	deleted: string[];
}

export interface Command {
	script: string;
	dir: string;
	args?: string[];
}

const app = (script: string): Command => ({ script, dir: "apps/telomi" });

export const CHECKS: Record<string, Command[]> = {
	"typecheck": [app("typecheck")],
	"operations-contract": [app("test:operations-openapi")],
	"provider-contract": [app("test:provider-python-sdk"), app("test:research-api")],
	"audio-service": [app("test:audio-python")],
};

/** Import specifiers a test file must not touch. Exact list, no heuristics. */
export const LIVE_IMPORTS = {
	packages: [
		"@earendil-works/pi-ai",
		"@earendil-works/pi-agent-core",
	],
	modules: [
		"apps/telomi/server/agent-runtime/models/model-gateway",
		"apps/telomi/server/agent-runtime/pi-ai",
		"apps/telomi/server/accounts/stream-fallback",
		"apps/telomi/server/providers/source-service-client",
		"apps/telomi/server/research/sources/builtin-registry",
		"apps/telomi/server/research/sources/providers/",
	],
};

export function planChecks(changedPaths: string[]): string[] {
	const checks = new Set<string>();
	for (const raw of changedPaths) {
		const path = `/${normalize(raw)}`;
		if (/\.(cjs|js|json|mjs|mts|cts|ts|tsx)$/u.test(path) && !path.includes("/agents/")) checks.add("typecheck");
		if (isOperationsContract(path)) checks.add("operations-contract");
		if (isProvider(path)) checks.add("provider-contract");
		if (path.includes("/telomi-audio-local/") && path.endsWith(".py")) checks.add("audio-service");
	}
	return Object.keys(CHECKS).filter((check) => checks.has(check));
}

/** Only inert documentation bypasses the staged snapshot and heavy-check lock. */
export function documentationOnly(paths: readonly string[]): boolean {
	return paths.every((path) => /\.(md|txt)$/u.test(path) && (
		/^(README|CONTRIBUTING|LICENSE)(\.|$)/u.test(path)
		|| path.startsWith("docs/") || path.startsWith("apps/telomi/docs/")
		|| /^apps\/(?:telomi|telomi-audio-local|extensions\/[^/]+)\/(?:README|CONTRIBUTING|LICENSE)\./u.test(path)
		|| path.startsWith(".github/ISSUE_TEMPLATE/") || path.startsWith(".github/PULL_REQUEST_TEMPLATE")
	));
}

export function planCommands(root: string, paths: string[]): { commands: Command[]; reasons: string[] } {
	if (documentationOnly(paths)) return { commands: [], reasons: ["Only documentation changed"] };
	const selection = selectAffectedTests(root, paths);
	const commands: Command[] = selection.full
		? ["typecheck", "test", "build"].map((script) => ({ dir: ".", script }))
		: [];
	for (const check of planChecks(paths)) {
		if (selection.full && (check === "typecheck" || check === "operations-contract")) continue;
		commands.push(...CHECKS[check]!);
	}
	if (!selection.full && selection.tests.length) commands.push({ ...app("test"), args: selection.tests });
	const manifestPath = join(root, "package.json");
	if (existsSync(manifestPath)) {
		const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
		const patterns: string[] = Array.isArray(manifest.workspaces) ? manifest.workspaces : manifest.workspaces?.packages ?? [];
		const dependenciesChanged = paths.some((path) => ["package.json", "package-lock.json", "npm-shrinkwrap.json"].includes(path));
		for (const file of globSync(patterns.map((pattern) => `${pattern}/package.json`), { cwd: root })) {
			const dir = dirname(file).replaceAll("\\", "/");
			if (dir === "apps/telomi" || !dependenciesChanged && !paths.some((path) => path.startsWith(dir + "/"))) continue;
			const pkg = JSON.parse(readFileSync(join(root, file), "utf8"));
			for (const script of ["typecheck", "test"]) {
				if (pkg.scripts?.[script] && !(selection.full && script === "typecheck")) commands.push({ dir, script });
			}
		}
	}
	return { commands: [...new Map(commands.map((command) => [JSON.stringify(command), command])).values()], reasons: selection.reasons };
}

/** Canonical helpers and their common aliases; only server/lib may declare them. */
const SHARED_HELPERS: Record<string, string> = {
	isInside: "paths", isInsideRoot: "paths", assertInside: "paths", assertInsideRoot: "paths", ensureWithinRoot: "paths",
	safeSegment: "paths", safeName: "paths", sanitizeFileName: "paths", basenameNoExt: "paths",
	isFileNameSegment: "paths", assertFileNameSegment: "paths", assertSafeRelativePath: "paths",
	writeAtomic: "fs", writeFileAtomic: "fs", writeJsonAtomic: "fs", atomicWrite: "fs", atomicWriteJson: "fs", writeTextAtomic: "fs",
	atomicWriteBytes: "fs", writeJson: "fs", readJson: "fs", readJsonl: "fs", appendJsonl: "fs", listJsonDir: "fs",
	listJsonl: "fs", listFiles: "fs", listFilesRecursive: "fs", walkFiles: "fs",
	isRecord: "values", toErrorMessage: "values", clipSummary: "values", assertNoDuplicates: "values",
	stableJson: "hash", hashJson: "hash", envBoolean: "env", envNumber: "env",
};

/** Parse declarations, so comments, strings and ordinary imports cannot trigger rejection. */
export function duplicateHelpers(file: string, source: string): string[] {
	if (!file.startsWith("apps/telomi/server/")
		|| !/\.(cjs|js|mjs|mts|cts|ts|tsx)$/u.test(file)) return [];
	const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
	const violations: string[] = [];
	const visit = (node: ts.Node): void => {
		if ((ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isVariableDeclaration(node))
			&& node.name && ts.isIdentifier(node.name) && Object.hasOwn(SHARED_HELPERS, node.name.text)
			&& file !== `apps/telomi/server/lib/${SHARED_HELPERS[node.name.text]}.ts`) {
			const line = parsed.getLineAndCharacterOfPosition(node.name.getStart(parsed)).line + 1;
			violations.push(`${file}:${line} declares ${node.name.text}; import server/lib/${SHARED_HELPERS[node.name.text]}.js instead`);
		}
		ts.forEachChild(node, visit);
	};
	visit(parsed);
	return violations;
}

export function isTestFile(path: string): boolean {
	return path.startsWith("apps/telomi/tests/") && /\.(cjs|js|mjs|mts|ts|tsx)$/u.test(path);
}

/** Returns the offending import specifiers of one test file. */
export function liveImports(file: string, source: string): string[] {
	const pattern = /(?:^|\n)\s*import\s+(?!type[\s{])[^;'"]*?from\s*["']([^"']+)["']|(?:^|\n)\s*import\s*["']([^"']+)["']|\b(?:import|require)\s*\(\s*["']([^"']+)["']\s*\)/gu;
	const found: string[] = [];
	for (const match of source.matchAll(pattern)) {
		const spec = match[1] ?? match[2] ?? match[3]!;
		if (isLiveImport(file, spec)) found.push(spec);
	}
	return found;
}

function isLiveImport(file: string, spec: string): boolean {
	if (!spec.startsWith(".")) return LIVE_IMPORTS.packages.some((pkg) => spec === pkg || spec.startsWith(`${pkg}/`));
	const module = posix.join(posix.dirname(normalize(file)), spec).replace(/\.(js|ts|mjs|mts|tsx)$/u, "");
	return LIVE_IMPORTS.modules.some((entry) => entry.endsWith("/") ? module.startsWith(entry) : module === entry || module.startsWith(`${entry}/`));
}

function normalize(value: string): string {
	const path = value.trim().replaceAll("\\", "/");
	if (!path || path.startsWith("/") || path.split("/").includes("..")) throw new Error(`Changed path must be repository-relative: ${value}`);
	return path;
}

function isProvider(path: string): boolean {
	return path.includes("/providers/") || path.includes("/server/research/sources/")
		|| path.endsWith("/server/research/pipeline/browser-tool-extension.ts")
		|| path.includes("/server/research/python-tools/") || path.includes("/services/research-source-service/")
		|| path.includes("/server/research/provider-") || path.includes("/server/research/pipeline/provider-")
		|| path.includes("/agents/research/prime-search/skills/") || path.includes("provider-adapter");
}

function isOperationsContract(path: string): boolean {
	return path.includes("/server/evaluation/operations-") || path.endsWith("/server/evaluation/api.ts")
		|| path.endsWith("/server/config/network.ts") || path.endsWith("/server/app.ts")
		|| path.endsWith("/scripts/generate-operations-openapi.ts")
		|| path.endsWith("/tests/evaluation/test-operations-listener.ts");
}

/** Deleted and old rename paths still affect surviving consumers. */
export function parseNameStatus(input: string): StagedChanges {
	const tokens = input.split("\0");
	const changes: StagedChanges = { added: [], changed: [], deleted: [] };
	for (let index = 0; index < tokens.length && tokens[index];) {
		const status = tokens[index++]!;
		const path = tokens[index++];
		if (!path) throw new Error("Incomplete staged name-status record");
		if (/^[RC]/u.test(status)) {
			const destination = tokens[index++];
			if (!destination) throw new Error("Incomplete staged rename/copy record");
			if (status.startsWith("R")) changes.deleted.push(path);
			changes.added.push(destination);
		} else if (status === "A") changes.added.push(path);
		else if (status === "D") changes.deleted.push(path);
		else changes.changed.push(path);
	}
	return changes;
}

interface ExecutionPlan {
	root: string;
	sourceRoot: string;
	commands: Command[];
}

function transferTypeCache(checkout: string, cache: string, save: boolean): void {
	for (const name of ["tsconfig.tsbuildinfo", "tsconfig.tests.tsbuildinfo"]) {
		const local = join(checkout, "apps/telomi", name);
		const stored = join(cache, name);
		const [from, to] = save ? [local, stored] : [stored, local];
		if (!existsSync(from) || !lstatSync(from).isFile() || existsSync(to) && !lstatSync(to).isFile()) continue;
		mkdirSync(dirname(to), { recursive: true });
		const temporary = `${to}.${process.pid}.tmp`;
		copyFileSync(from, temporary);
		renameSync(temporary, to);
	}
}

function executePlan(plan: ExecutionPlan): number {
	const checkEnv = gitEnvironmentForChecks(plan.sourceRoot);
	checkEnv.PYTHONPATH = [join(plan.root, "apps/telomi/services/research-source-service/src"), join(plan.root, "apps/telomi-audio-local")].join(delimiter);
	checkEnv.PYTHONDONTWRITEBYTECODE = "1";
	const cache = join(git(plan.sourceRoot, "rev-parse", "--absolute-git-dir").trim(), "telomi-pre-commit-cache");
	transferTypeCache(plan.root, cache, false);
	try {
		for (const command of plan.commands) {
			const result = spawnSync("npm", ["run", command.script, ...(command.args?.length ? ["--", ...command.args] : [])], {
				cwd: resolve(plan.root, command.dir), stdio: "inherit", env: checkEnv,
			});
			if (result.status !== 0) {
				console.error(`FAIL ${command.script}${result.error ? `: ${result.error.message}` : result.signal ? `: ${result.signal}` : ""}`);
				return result.status ?? 1;
			}
		}
		return 0;
	} finally { transferTypeCache(plan.root, cache, true); }
}

async function main(args: string[]): Promise<number> {
	for (const key of ["GIT_DIR", "GIT_COMMON_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY"]) {
		if (process.env[key]) process.env[key] = resolve(process.env[key]!);
	}
	const execution = option(args, "--execute")[0];
	if (execution) return executePlan(JSON.parse(readFileSync(execution, "utf8")));
	const root = git(process.cwd(), "rev-parse", "--show-toplevel").trim();
	const changes = args.includes("--stdin0") ? parseNameStatus(await readStdin()) : { added: [], changed: [], deleted: [] };
	changes.added.push(...option(args, "--added"));
	changes.changed.push(...option(args, "--changed"));
	changes.deleted.push(...option(args, "--deleted"));
	git(root, "diff", "--cached", "--check");

	let rejected = false;
	for (const file of [...changes.added, ...changes.changed].filter((file) => file.startsWith("apps/telomi/server/"))) {
		for (const violation of duplicateHelpers(file, git(root, "show", `:${file}`))) {
			console.error(`REJECT ${violation}`);
			rejected = true;
		}
	}
	for (const file of changes.added.filter(isTestFile)) {
		for (const spec of liveImports(file, git(root, "show", `:${file}`))) {
			console.error(`REJECT ${file} imports ${spec}`);
			console.error("New tests must not call Providers or models. Verify real behavior through Attestation (apps/telomi/docs/development/attestation.md).");
			rejected = true;
		}
	}
	if (rejected) return 1;
	const paths = [...new Set([...changes.added, ...changes.changed, ...changes.deleted])];
	if (documentationOnly(paths)) {
		console.log("PLAN no heavy checks: documentation or empty change");
		return 0;
	}
	// Listen before the checkout exists: a signal without a listener exits at once and skips its disposal.
	let child: ChildProcess | undefined;
	const forward = (signal: NodeJS.Signals) => { child?.kill(signal); };
	const interrupt = () => forward("SIGINT");
	const terminate = () => forward("SIGTERM");
	process.on("SIGINT", interrupt);
	process.on("SIGTERM", terminate);
	const snapshot = createStagedCheckout(root);
	try {
		const plan = planCommands(snapshot.root, paths);
		console.log(`PLAN ${plan.commands.length} checks against staged content`);
		for (const reason of plan.reasons) console.log(`REASON ${reason}`);
		for (const command of plan.commands) {
			const details = args.includes("--dry-run") ? command.args?.join(" ") : command.args?.length ? `${command.args.length} selected test files` : "";
			console.log(`CHECK npm run ${command.script}${details ? ` -- ${details}` : ""} (${command.dir})`);
		}
		if (args.includes("--dry-run") || !plan.commands.length) return 0;
		const path = join(snapshot.root, ".git", "telomi-pre-commit-plan.json");
		writeFileSync(path, JSON.stringify({ root: snapshot.root, sourceRoot: root, commands: plan.commands }), { mode: 0o600 });
		child = spawn("python3", [join(root, "apps/telomi/scripts/worktree.py"), "--root", root, "check", "--",
			process.execPath, "--import", import.meta.resolve("tsx"), fileURLToPath(import.meta.url), "--execute", path], { cwd: root, stdio: "inherit" });
		const started = child;
		return await new Promise<number>((done, reject) => {
			started.once("error", reject);
			started.once("close", (code) => done(code ?? 1));
		});
	} finally {
		snapshot.dispose();
		process.off("SIGINT", interrupt);
		process.off("SIGTERM", terminate);
	}
}

/** Hooks export repository-local Git variables. Tests may create other repos. */
export function gitEnvironmentForChecks(cwd: string): NodeJS.ProcessEnv {
	const env = { ...process.env };
	for (const name of git(cwd, "rev-parse", "--local-env-vars").trim().split("\n")) delete env[name];
	return env;
}

function git(cwd: string, ...args: string[]): string {
	const result = spawnSync("git", args, { cwd, encoding: "utf-8", env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" }, maxBuffer: 32 * 1024 * 1024 });
	if (result.status !== 0) throw new Error(result.stderr.trim() || `git ${args.join(" ")} failed`);
	return result.stdout;
}

function option(args: string[], name: string): string[] {
	return args.flatMap((value, index) => value === name && args[index + 1] ? [args[index + 1]!] : []);
}

async function readStdin(): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
	return Buffer.concat(chunks).toString("utf-8");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	process.exitCode = await main(process.argv.slice(2));
}
