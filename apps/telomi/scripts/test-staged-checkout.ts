import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { createStagedCheckout } from "./staged-checkout.js";

const fixture = mkdtempSync(join(tmpdir(), "test-staged-checkout-' "));
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
const git = (...args: string[]) => execFileSync("git", args, { cwd: fixture, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const put = (path: string, value: string) => { mkdirSync(dirname(join(fixture, path)), { recursive: true }); writeFileSync(join(fixture, path), value); };
try {
	git("init", "--quiet");
	put(".gitignore", "node_modules/\n.venv/\n.prime-kernel/\n.env\n");
	put("package.json", JSON.stringify({ private: true, type: "module", workspaces: ["packages/*"] }));
	put("packages/dep/package.json", JSON.stringify({ name: "@fixture/dep", type: "module", exports: "./index.js" }));
	put("packages/dep/index.js", "export default 'committed';\n");
	put("caller.js", "import value from '@fixture/dep'; console.log(value);\n");
	put("deleted.js", "old\n");
	put("service/pyproject.toml", "[project]\nname = 'fixture'\n");
	put("service/src/fixture_source.py", "value = 'staged Python'\n");
	put("service/src/fixture_package/__init__.py", "value = 'original package'\n");
	git("add", ".");
	// An unborn repository also has an index that can be checked.
	let snapshot = createStagedCheckout(fixture);
	assert.equal(readFileSync(join(snapshot.root, "deleted.js"), "utf8"), "old\n");
	snapshot.dispose();
	git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "core.hooksPath=/dev/null", "commit", "--quiet", "-m", "fixture");
	put("packages/dep/index.js", "export default 'staged';\n");
	put("caller.js", "import value from '@fixture/dep'; console.log('staged caller: ' + value);\n");
	put("packages/dep/nested.js", "import value from 'nested'; console.log(value);\n");
	git("rm", "deleted.js");
	git("add", ".");
	put("packages/dep/index.js", "export default 'unstaged';\n");
	put("caller.js", "throw new Error('unstaged caller');\n");
	put("untracked.js", "private\n");
	put(".env", "SECRET=private\n");
	put("node_modules/.cache/typecheck.tsbuildinfo", "private mutable cache\n");
	mkdirSync(join(fixture, "node_modules/@fixture"), { recursive: true });
	symlinkSync("../../packages/dep", join(fixture, "node_modules/@fixture/dep"));
	put("node_modules/external/package.json", JSON.stringify({ type: "module", exports: "./index.js" }));
	put("node_modules/external/index.js", "export default 'installed';\n");
	put("packages/dep/node_modules/nested/package.json", JSON.stringify({ type: "module", exports: "./index.js" }));
	put("packages/dep/node_modules/nested/index.js", "export default 'nested installed';\n");
	mkdirSync(join(fixture, "node_modules/.bin"), { recursive: true });
	symlinkSync("../../packages/dep/index.js", join(fixture, "node_modules/.bin/fixture-dep"));
	put("service/.venv/marker", "installed\n");
	mkdirSync(join(fixture, "service/.venv/bin"), { recursive: true });
	const python = execFileSync("python3", ["-c", "import sys; print(sys.executable)"], { env, encoding: "utf8" }).trim();
	symlinkSync(python, join(fixture, "service/.venv/bin/python"));
	symlinkSync(python, join(fixture, "service/.venv/bin/python3"));
	put("service/src/fixture_source.py", "value = 'unstaged Python'\n");
	put("apps/telomi/.prime-kernel/marker", "installed\n");
	const indexBefore = readFileSync(join(fixture, ".git/index"));
	const statusBefore = git("status", "--porcelain=v1", "-z");
	const stashBefore = git("stash", "list");
	snapshot = createStagedCheckout(fixture);
	try {
		assert.equal(execFileSync(process.execPath, ["caller.js"], { cwd: snapshot.root, env, encoding: "utf8" }).trim(), "staged caller: staged");
		assert.equal(execFileSync(process.execPath, ["--input-type=module", "-e", "import value from 'external'; console.log(value)"], { cwd: snapshot.root, env, encoding: "utf8" }).trim(), "installed");
		assert.equal(execFileSync(process.execPath, ["packages/dep/nested.js"], { cwd: snapshot.root, env, encoding: "utf8" }).trim(), "nested installed");
		assert.equal(readFileSync(join(snapshot.root, "node_modules/.bin/fixture-dep"), "utf8"), "export default 'staged';\n");
		assert.equal(existsSync(join(snapshot.root, "deleted.js")), false);
		assert.equal(existsSync(join(snapshot.root, "untracked.js")), false);
		assert.equal(existsSync(join(snapshot.root, ".env")), false);
		assert.equal(existsSync(join(snapshot.root, "node_modules/.cache")), false);
		assert.equal(readFileSync(join(snapshot.root, "service/.venv/marker"), "utf8"), "installed\n");
		for (const interpreter of ["python", "python3"]) {
			assert.equal(execFileSync(join(snapshot.root, "service/.venv/bin", interpreter), ["-c", "import fixture_source; print(fixture_source.value)"], {
				cwd: fixture, env: { ...env, PYTHONPATH: join(fixture, "service/src") }, encoding: "utf8",
			}).trim(), "staged Python");
		}
		assert.equal(existsSync(join(snapshot.root, "service/src/__pycache__")), false);
		assert.equal(readFileSync(join(fixture, "service/src/fixture_source.py"), "utf8"), "value = 'unstaged Python'\n");
		assert.equal(readFileSync(join(snapshot.root, "apps/telomi/.prime-kernel/marker"), "utf8"), "installed\n");
		assert.equal(execFileSync("git", ["show", ":packages/dep/index.js"], { cwd: snapshot.root, env, encoding: "utf8" }), "export default 'staged';\n");
		assert.deepEqual(readFileSync(join(fixture, ".git/index")), indexBefore);
		assert.equal(git("status", "--porcelain=v1", "-z"), statusBefore);
		assert.equal(git("stash", "list"), stashBefore);
		assert.equal(readFileSync(join(fixture, "caller.js"), "utf8"), "throw new Error('unstaged caller');\n");
	} finally { snapshot.dispose(); }
	assert.equal(existsSync(snapshot.root), false);
	// An original regular package would shadow the snapshot's namespace package
	// through an editable-install .pth entry or the inherited PYTHONPATH.
	git("rm", "--cached", "service/src/fixture_package/__init__.py");
	assert.throws(() => { createStagedCheckout(fixture).dispose(); }, /staged Python deletion.*fixture_package\/__init__\.py/);
	rmSync(join(fixture, "service/src/fixture_package/__init__.py"));
	snapshot = createStagedCheckout(fixture);
	snapshot.dispose();
	put("service/src/fixture_package/__init__.py", "value = 'original package'\n");
	git("add", "service/src/fixture_package/__init__.py");
	// Git commit may supply an alternate index relative to the hook's cwd.
	const alternateIndex = join(fixture, "alternate-index");
	copyFileSync(join(fixture, ".git/index"), alternateIndex);
	put("alternate.js", "alternate staged source\n");
	execFileSync("git", ["add", "alternate.js"], { cwd: fixture, env: { ...env, GIT_INDEX_FILE: alternateIndex } });
	const alternateBefore = readFileSync(alternateIndex);
	const previousIndex = process.env.GIT_INDEX_FILE;
	try {
		process.env.GIT_INDEX_FILE = relative(process.cwd(), alternateIndex);
		snapshot = createStagedCheckout(fixture);
		try {
			assert.equal(readFileSync(join(snapshot.root, "alternate.js"), "utf8"), "alternate staged source\n");
			assert.equal(execFileSync("git", ["config", "core.hooksPath"], { cwd: snapshot.root, env, encoding: "utf8" }).trim(), "/dev/null");
			assert.deepEqual(readFileSync(alternateIndex), alternateBefore);
		} finally { snapshot.dispose(); }
	} finally {
		if (previousIndex === undefined) delete process.env.GIT_INDEX_FILE;
		else process.env.GIT_INDEX_FILE = previousIndex;
	}
	const pkg = JSON.parse(readFileSync(join(fixture, "package.json"), "utf8"));
	put("package.json", JSON.stringify({ ...pkg, scripts: { test: "unstaged script" } }));
	snapshot = createStagedCheckout(fixture);
	snapshot.dispose();
	put("package.json", JSON.stringify({ ...pkg, dependencies: { example: "1" } }));
	assert.throws(() => createStagedCheckout(fixture), /package.json differs/);
	put("package.json", JSON.stringify(pkg));
	put("service/uv.lock", "version = 1\n");
	git("add", "service/uv.lock");
	put("service/uv.lock", "version = 2\n");
	assert.throws(() => createStagedCheckout(fixture), /uv.lock differs/);
	console.log("staged checkout: index isolation, workspace imports, deletion, dependencies and cleanup passed");
} finally { rmSync(fixture, { recursive: true, force: true }); }
