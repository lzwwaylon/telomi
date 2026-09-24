import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { discoverTests, selectShard } from "./run-tests.js";

const cwd = process.cwd();
const root = mkdtempSync(join(tmpdir(), "telomi-test-runner-"));
const runner = resolve(import.meta.dirname, "run-tests.ts");
const cssImportsSetup = readFileSync(resolve(import.meta.dirname, "../tests/web/setup-css-imports.ts"), "utf-8");
function fixture(file: string, source = 'throw new Error("Excluded test executed");'): void {
	mkdirSync(dirname(join(root, file)), { recursive: true });
	writeFileSync(join(root, file), source);
}
try {
	process.chdir(root);
	fixture("package.json", '{"type":"module"}');
	const included = [
		"scripts/test-check.ts", "tests/new-module/nested/test-new.tsx",
		"tests/evaluation/test-prime-search-live-replay.ts",
		"tests/providers/test-provider-live-manifest.ts",
		"tests/evolution/test-browser-evolution-e2e.ts",
	];
	for (const file of included) fixture(file, 'import assert from "node:assert/strict"; assert.equal(2 + 2, 4);');
	for (const file of [
		"tests/new-module/test-provider-live.ts", "tests/new-module/test-ui-live.tsx",
		"tests/providers/nested/test-browser-e2e.tsx", "tests/providers/test-browser-ownership-e2e.ts",
		"tests/agent-runtime/test-sandbox-crossvolume.ts",
		"tests/research/test-research-model-gateway.ts", "tests/new-module/setup.ts",
		"tests/new-module/test-browser-e2e.mjs",
	]) fixture(file);
	assert.deepEqual(discoverTests(), included.sort());
	assert.deepEqual(discoverTests(["tests/new-module/**/test-*.{ts,tsx}"]), ["tests/new-module/nested/test-new.tsx"]);
	assert.throws(() => discoverTests(["tests/missing/test-*.ts"]), /No deterministic tests matched/);
	// Shards partition the sorted list: every file lands in exactly one shard, in the same shard on every run.
	const all = discoverTests();
	for (const count of [1, 2, 3, all.length]) {
		const shards = Array.from({ length: count }, (_, index) => selectShard(all, `${index + 1}/${count}`));
		assert.deepEqual(shards.flat().sort(), all);
		assert.equal(new Set(shards.flat()).size, all.length, `shards of ${count} overlap`);
		assert.deepEqual(shards, Array.from({ length: count }, (_, index) => selectShard([...all], `${index + 1}/${count}`)));
	}
	assert.deepEqual(selectShard(all, "2/2"), all.filter((_, index) => index % 2 === 1));
	for (const invalid of ["0/2", "3/2", "2", "1/0", "a/b", "1/2/3", ""]) {
		assert.throws(() => selectShard(all, invalid), /--shard must be index\/count/, invalid);
	}
	assert.throws(() => selectShard(all, `${all.length + 1}/${all.length + 1}`), /selects none/);

	// Exercise the actual CLI: automatic discovery, locale and CSS import preloads, and failure status.
	symlinkSync(resolve(import.meta.dirname, "../node_modules"), join(root, "node_modules"), "dir");
	fixture("tests/web/setup-ui-locale.ts", 'process.env.TELOMI_TEST_LOCALE = "zh-CN";');
	fixture("tests/web/setup-css-imports.ts", cssImportsSetup);
	fixture("tests/goals/styles.css", "body { color: red; }");
	fixture("tests/goals/test-new.tsx", 'import assert from "node:assert/strict"; import "./styles.css"; assert.equal(process.env.TELOMI_TEST_LOCALE, "zh-CN");');
	fixture("tests/web/test-new.ts", 'import assert from "node:assert/strict"; assert.equal(process.env.TELOMI_TEST_LOCALE, "zh-CN");');
	fixture("tests/voice/test-new.ts", 'import assert from "node:assert/strict"; assert.equal(process.env.TELOMI_TEST_LOCALE, "zh-CN");');
	// The fixture CLI is a fresh test runner, not a nested node:test child.
	const env = { ...process.env };
	delete env.NODE_TEST_CONTEXT;
	const run = (...args: string[]) => spawnSync(process.execPath, ["--import", import.meta.resolve("tsx"), runner, ...args], { encoding: "utf-8", env });
	fixture("worker/child.mjs", `import assert from "node:assert/strict";
assert.equal(process.cwd().endsWith("worker"), true);
assert.equal(process.env.TELOMI_DATA_DIR, process.env.TELOMI_TEST_PARENT_DATA);
assert.equal(process.env.SOURCE_SERVICE_ARXIV_SQLITE_PATH, process.env.TELOMI_TEST_PARENT_ARXIV);
assert.equal(process.env.TELOMI_RESEARCH_SOURCE_PORT, process.env.TELOMI_TEST_PARENT_PORT);`);
	fixture("tests/web/test-fork.ts", `import { fork } from "node:child_process";
import { resolve } from "node:path";
process.env.TELOMI_TEST_PARENT_DATA = process.env.TELOMI_DATA_DIR;
process.env.TELOMI_TEST_PARENT_ARXIV = process.env.SOURCE_SERVICE_ARXIV_SQLITE_PATH;
process.env.TELOMI_TEST_PARENT_PORT = process.env.TELOMI_RESEARCH_SOURCE_PORT;
const child = fork(resolve("worker/child.mjs"), [], { cwd: resolve("worker") });
child.on("exit", (code) => { process.exitCode = code ?? 1; });`);
	// A managed worktree command inherits product config. Tests must not touch it.
	env.PI_CODING_AGENT_DIR = join(root, "private-agent");
	env.HINDSIGHT_URL = "http://127.0.0.1:12345/v1/default";
	env.AGENT_BROWSER_SOCKET_DIR = join(root, "private-browser");
	env.PRIME_AGENT_KERNEL_PYTHON = "/invalid/private/python";
	env.OPENAI_API_KEY = "fixture-only";
	fixture("tests/config/test-isolation.ts", `import assert from "node:assert/strict";
for (const key of ["PI_CODING_AGENT_DIR", "HINDSIGHT_URL", "AGENT_BROWSER_SOCKET_DIR", "PRIME_AGENT_KERNEL_PYTHON", "OPENAI_API_KEY"]) {
 assert.equal(process.env[key], undefined, key + " leaked into deterministic tests");
}`);
	const passed = run();
	assert.equal(passed.status, 0, passed.stdout + passed.stderr);
	// The CLI shard runs its own subset only; the flag is not read as a glob.
	const sharded = run("--shard", "2/3", "tests/new-module/**/test-*.{ts,tsx}", "scripts/test-*.ts");
	assert.equal(sharded.status, 0, sharded.stdout + sharded.stderr);
	assert.match(sharded.stdout, /tests\/new-module\/nested\/test-new\.tsx/);
	assert.doesNotMatch(sharded.stdout, /scripts\/test-check\.ts/);
	for (const badShard of [run("--shard", "4/3", "scripts/test-check.ts"), run("scripts/test-check.ts", "--shard")]) {
		assert.notEqual(badShard.status, 0);
		assert.match(badShard.stdout + badShard.stderr, /--shard must be index\/count/);
	}
	// Without the flag every argument is a pattern; the first one must not be dropped.
	const single = run("scripts/test-check.ts", "tests/goals/test-new.tsx");
	assert.equal(single.status, 0, single.stdout + single.stderr);
	assert.match(single.stdout, /scripts\/test-check\.ts/);
	assert.doesNotMatch(single.stdout, /tests\/web\/test-new\.ts/);
	const coordination = join(root, "coordination");
	mkdirSync(coordination);
	env.TELOMI_TEST_CONCURRENCY = "2";
	env.TELOMI_TEST_COORDINATION = coordination;
	for (const [name, peer] of [["a", "b"], ["b", "a"]]) {
		fixture(`tests/parallel/test-${name}.ts`, `import assert from "node:assert/strict";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { setTimeout } from "node:timers/promises";
const data = process.env.TELOMI_DATA_DIR;
writeFileSync(join(data, 'state.json'), ${JSON.stringify(name)}, {flag:'wx'});
const record = join(process.env.TELOMI_TEST_COORDINATION, '${name}.json');
writeFileSync(record + '.tmp', JSON.stringify({data, arxiv:process.env.SOURCE_SERVICE_ARXIV_SQLITE_PATH, port:process.env.TELOMI_RESEARCH_SOURCE_PORT}));
renameSync(record + '.tmp', record);
const other = join(process.env.TELOMI_TEST_COORDINATION, '${peer}.json');
const deadline = Date.now() + 5000;
while (!existsSync(other) && Date.now() < deadline) await setTimeout(20);
assert.ok(existsSync(other), 'test files did not run concurrently');
const sibling = JSON.parse(readFileSync(other, 'utf8'));
assert.notEqual(data, sibling.data, 'test files share product data');
assert.notEqual(process.env.SOURCE_SERVICE_ARXIV_SQLITE_PATH, sibling.arxiv, 'test files share the arXiv database');
assert.equal(dirname(process.env.SOURCE_SERVICE_ARXIV_SQLITE_PATH), data);
assert.ok(Number(process.env.TELOMI_RESEARCH_SOURCE_PORT) > 0);
assert.notEqual(process.env.TELOMI_RESEARCH_SOURCE_PORT, sibling.port, 'test files share the Source Service port');
assert.equal(readFileSync(join(data, 'state.json'), 'utf8'), ${JSON.stringify(name)});
`);
	}
	const parallel = run("tests/parallel/test-*.ts");
	assert.equal(parallel.status, 0, parallel.stdout + parallel.stderr);
	for (const name of ["a", "b"]) {
		const record = JSON.parse(readFileSync(join(coordination, `${name}.json`), "utf8"));
		assert.equal(existsSync(record.data), false, "test data must be removed after the run");
	}
	for (const invalid of ["0", "-1", "2.5", "NaN", "", "9007199254740992"]) {
		env.TELOMI_TEST_CONCURRENCY = invalid;
		const result = run("scripts/test-check.ts");
		assert.notEqual(result.status, 0);
		assert.match(result.stdout + result.stderr, /TELOMI_TEST_CONCURRENCY must be a positive safe integer/);
	}
	env.TELOMI_TEST_CONCURRENCY = "2";
	env.TELOMI_TEST_FAILURE_DATA = join(root, "failed-data-path");
	fixture("tests/new-module/test-failure.ts", 'import { writeFileSync } from "node:fs"; writeFileSync(process.env.TELOMI_TEST_FAILURE_DATA, process.env.TELOMI_DATA_DIR); throw new Error("Expected failure");');
	const failed = run("tests/new-module/test-failure.ts");
	assert.notEqual(failed.status, 0, failed.stdout + failed.stderr);
	assert.match(failed.stdout + failed.stderr, /Expected failure/);
	assert.equal(existsSync(readFileSync(env.TELOMI_TEST_FAILURE_DATA, "utf8")), false, "failed runs must also remove their test data");
	assert.notEqual(run("tests/missing/*.ts").status, 0);
	assert.notEqual(run("tests/new-module/test-provider-live.ts").status, 0);
	fixture("tests/new-module/test-failure.ts", 'import test from "node:test"; test("fails", () => { throw new Error("Expected node:test failure"); });');
	assert.notEqual(run("tests/new-module/test-failure.ts").status, 0);
} finally {
	process.chdir(cwd);
	rmSync(root, { recursive: true, force: true });
}
console.log("glob test runner discovery, exclusions, locale and CSS preloads, and exit status passed");
