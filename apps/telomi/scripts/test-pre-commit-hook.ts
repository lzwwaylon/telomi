import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { gitEnvironmentForChecks } from "./pre-commit-plan.js";

const original = resolve(import.meta.dirname, "..");
const repo = mkdtempSync(join(tmpdir(), "telomi-hook-e2e-"));
const app = join(repo, "apps/telomi");
let locker: ChildProcess | undefined;
const env = { ...gitEnvironmentForChecks(resolve(original, "../..")), TELOMI_TEST_HOOK_LOG: join(repo, ".hook-calls"), TMPDIR: join(repo, ".hook-tmp") };
function write(path: string, text: string): void {
	mkdirSync(dirname(join(repo, path)), { recursive: true });
	writeFileSync(join(repo, path), text);
}
function git(...args: string[]): string {
	const result = spawnSync("git", args, { cwd: repo, env, encoding: "utf8" });
	assert.equal(result.status, 0, result.stderr);
	return result.stdout;
}
async function commit(timeout = 30_000): Promise<{ code: number | null; output: string; timedOut: boolean }> {
	const child = spawn("git", ["commit", "-qm", "fixture change"], { cwd: repo, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
	let output = "";
	let timedOut = false;
	child.stdout!.on("data", (chunk) => { output += chunk; });
	child.stderr!.on("data", (chunk) => { output += chunk; });
	const timer = setTimeout(() => {
		timedOut = true;
		if (child.pid) process.kill(-child.pid, "SIGTERM");
	}, timeout);
	try {
		const [code] = await once(child, "close");
		return { code, output, timedOut };
	} finally { clearTimeout(timer); }
}
try {
	git("init", "-q", "-b", "main");
	git("config", "user.email", "test@example.invalid");
	git("config", "user.name", "test");
	git("config", "core.hooksPath", "apps/telomi/hooks");
	mkdirSync(env.TMPDIR);
	write(".gitignore", "node_modules/\n.hook-calls\n.hook-tmp/\n*.tsbuildinfo\n");
	write("package.json", JSON.stringify({ private: true, workspaces: ["apps/telomi"], scripts: {
		typecheck: "npm run typecheck --workspace=telomi", test: "npm test --workspace=telomi", build: "npm run build --workspace=telomi",
	} }));
	write("apps/telomi/package.json", JSON.stringify({ name: "telomi", type: "module", scripts: {
		typecheck: "tsc --noEmit && node scripts/record.mjs typecheck", test: "node scripts/check.mjs", build: "node scripts/record.mjs build",
	} }));
	write("apps/telomi/scripts/record.mjs", "import { appendFileSync } from 'node:fs'; appendFileSync(process.env.TELOMI_TEST_HOOK_LOG, process.argv.slice(2).join(' ')+'\\n');");
	write("apps/telomi/scripts/check.mjs", "import { appendFileSync } from 'node:fs'; import { pathToFileURL } from 'node:url'; import { resolve } from 'node:path'; appendFileSync(process.env.TELOMI_TEST_HOOK_LOG, JSON.stringify(process.argv.slice(2))+'\\n'); for(const file of process.argv.slice(2)) await import(pathToFileURL(resolve(file)).href);");
	write("apps/telomi/tsconfig.json", JSON.stringify({ compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", incremental: true, types: [] }, include: ["server/wiki/*.ts"] }));
	write("apps/telomi/server/wiki/value.ts", "export const value = 0;\n");
	write("apps/telomi/tests/wiki/test-value.ts", "import assert from 'node:assert/strict'; import { value } from '../../server/wiki/value.ts'; assert.equal(value, 1);\n");
	write("apps/telomi/tests/voice/test-unrelated.ts", "throw new Error('unrelated test ran');\n");
	write("README.md", "base\n");
	mkdirSync(join(app, "hooks"));
	copyFileSync(join(original, "hooks/pre-commit"), join(app, "hooks/pre-commit"));
	for (const name of ["pre-commit-plan.ts", "affected-tests.ts", "staged-checkout.ts", "run-tests.ts", "worktree.py"]) {
		copyFileSync(join(original, "scripts", name), join(app, "scripts", name));
	}
	symlinkSync(join(original, "node_modules"), join(app, "node_modules"), "dir");
	// npm hoists deps shared by two workspaces to the repo root; the hook resolves tsx from there.
	symlinkSync(resolve(original, "../../node_modules"), join(repo, "node_modules"), "dir");
	git("add", "-A");
	git("-c", "core.hooksPath=/dev/null", "commit", "-qm", "fixture base");

	const state = join(repo, ".git/telomi-worktrees");
	mkdirSync(state, { recursive: true });
	const ready = join(state, "ready");
	locker = spawn("python3", ["-c", "import fcntl,pathlib,sys,time; f=open(sys.argv[1],'a'); fcntl.flock(f,fcntl.LOCK_EX); pathlib.Path(sys.argv[2]).touch(); time.sleep(60)", join(state, "check.lock"), ready], { stdio: "ignore" });
	for (let i = 0; i < 100 && !existsSync(ready); i++) await delay(20);
	assert.ok(existsSync(ready));
	write("README.md", "documentation change\n");
	git("add", "README.md");
	const documentation = await commit(5000);
	assert.equal(documentation.timedOut, false, "documentation commit waited for the heavy-check lock");
	assert.equal(documentation.code, 0, documentation.output);
	assert.equal(existsSync(env.TELOMI_TEST_HOOK_LOG), false, "documentation commit ran heavy checks");
	write("apps/telomi/server/wiki/value.ts", "export const value = 1;\n");
	git("add", "apps/telomi/server/wiki/value.ts");
	const cancelled = spawn("git", ["commit", "-qm", "cancelled"], { cwd: repo, env, detached: true, stdio: "ignore" });
	const exited = once(cancelled, "exit");
	try {
		// Wait until the plan is materialized and the child is waiting for the lock.
		// Generous: this test also runs inside the real hook while the full suite loads the machine.
		for (let i = 0; i < 1500 && !readdirSync(env.TMPDIR).some((entry) => existsSync(join(env.TMPDIR, entry, "checkout/.git/telomi-pre-commit-plan.json"))); i++) await delay(20);
		assert.ok(readdirSync(env.TMPDIR).some((entry) => existsSync(join(env.TMPDIR, entry, "checkout/.git/telomi-pre-commit-plan.json"))));
	} finally {
		if (cancelled.pid) process.kill(-cancelled.pid, "SIGTERM");
		await exited;
	}
	// Removing a checkout under a loaded machine takes longer than the 2s a quick poll allows.
	for (let i = 0; i < 1500 && readdirSync(env.TMPDIR).some((entry) => entry.startsWith("telomi-staged-check-")); i++) await delay(20);
	assert.ok(!readdirSync(env.TMPDIR).some((entry) => entry.startsWith("telomi-staged-check-")), "cancelled hook leaked its staged checkout");
	locker.kill();
	await once(locker, "exit");
	locker = undefined;

	for (const [staged, working, success] of [[1, 2, true], [2, 1, false]] as const) {
		write("apps/telomi/server/wiki/value.ts", `export const value = ${staged};\n`);
		git("add", "apps/telomi/server/wiki/value.ts");
		write("apps/telomi/server/wiki/value.ts", `export const value = ${working};\n`);
		writeFileSync(env.TELOMI_TEST_HOOK_LOG, "");
		const result = await commit();
		assert.equal(result.timedOut, false, result.output);
		assert.equal(result.code === 0, success, result.output);
		assert.equal(readFileSync(join(app, "server/wiki/value.ts"), "utf8"), `export const value = ${working};\n`);
		assert.equal(git("show", ":apps/telomi/server/wiki/value.ts"), `export const value = ${staged};\n`);
		const calls = readFileSync(env.TELOMI_TEST_HOOK_LOG, "utf8");
		assert.match(calls, /tests\/wiki\/test-value\.ts/);
		assert.doesNotMatch(calls, /unrelated|build/);
	}
	assert.ok(existsSync(join(repo, ".git/telomi-pre-commit-cache/tsconfig.tsbuildinfo")));
	write("apps/telomi/server/wiki/value.ts", "export const value: number = 'invalid';\n");
	git("add", "apps/telomi/server/wiki/value.ts");
	write("apps/telomi/server/wiki/value.ts", "export const value = 1;\n");
	const invalidType = await commit();
	assert.equal(invalidType.code, 1, invalidType.output);
	assert.match(invalidType.output, /not assignable to type 'number'/);
	assert.equal(readFileSync(join(app, "server/wiki/value.ts"), "utf8"), "export const value = 1;\n");
	console.log("pre-commit hook: lock-free docs, cancellation cleanup, selective tests, staged content and incremental cache invalidation passed");
} finally {
	if (locker && locker.exitCode === null && locker.signalCode === null) {
		locker.kill();
		await once(locker, "exit");
	}
	rmSync(repo, { recursive: true, force: true, maxRetries: 3 });
}
