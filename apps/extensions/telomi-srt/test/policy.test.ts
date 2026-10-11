import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { parseSandboxExecutionSpec } from "../sandbox-spec.js";
import { execSrt, policyFromSpec } from "../runtime.js";
import { runtimeTools } from "../runtime-tools.js";
import { createSrtBashOps, createSrtReadOps, createSrtWriteOps, SrtWorkspace } from "../tool-operations.js";

test("directory mount aliases support ordinary find while file mounts remain files", async (t) => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "srt-directory-alias-")));
	const work = join(root, "work"), input = join(root, "input");
	mkdirSync(work); mkdirSync(input);
	const file = join(input, "frozen.txt");
	writeFileSync(file, "frozen\n");
	const workspace = new SrtWorkspace(parseSandboxExecutionSpec({
		version: 1, id: "directory-alias", role: "main.goal_agent", sessionLabel: "directory-alias",
		hostCwd: work, guestCwd: "/work", mounts: [
			{ hostPath: work, guestPath: "/work", access: "read-write" },
			{ hostPath: input, guestPath: "/input", access: "read-only" },
			{ hostPath: file, guestPath: "/frozen.txt", access: "read-only" },
		], activeTools: ["bash"], env: { SOURCE_TREE: "/input", SOURCE_FILE: "/frozen.txt" },
		network: { mode: "deny" }, writablePaths: [{ guestPath: "/work", kind: "tree" }],
	}));
	t.after(() => { workspace.close(); rmSync(root, { recursive: true, force: true }); });
	const bash = createSrtBashOps(workspace);
	const execute = async (command: string) => {
		let output = "";
		const result = await bash.exec(command, "/work", { onData: chunk => { output += chunk.toString(); },
			signal: new AbortController().signal, timeout: 10 });
		return { ...result, output };
	};
	for (const command of ["find /input -type f", 'find "$SOURCE_TREE" -type f']) {
		const result = await execute(command);
		assert.equal(result.exitCode, 0, result.output);
		assert.match(result.output, /frozen\.txt/u, "directory mounts behave like directories without symlink flags");
		const found = result.output.trim();
		assert.equal((await createSrtReadOps(workspace).readFile(found)).toString(), "frozen\n", "native tools can use the exact path returned by Bash");
		await assert.rejects(createSrtWriteOps(workspace).writeFile(found, "changed"), /read-only/u);
	}
	for (const command of ["cat /frozen.txt", 'cat "$SOURCE_FILE"']) {
		const result = await execute(command);
		assert.equal(result.exitCode, 0, result.output);
		assert.equal(result.output, "frozen\n");
	}
	assert.equal((await createSrtReadOps(workspace).readFile(workspace.env().SOURCE_FILE!)).toString(), "frozen\n");
	await assert.rejects(createSrtWriteOps(workspace).writeFile(workspace.env().SOURCE_FILE!, "changed"), /read-only/u);
	const other = new SrtWorkspace(workspace.spec);
	t.after(() => other.close());
	assert.throws(() => workspace.hostPath(other.env().SOURCE_FILE!), /outside/u, "only this Workspace's registered aliases are accepted");
	assert.notEqual((await execute("printf changed > /input/frozen.txt")).exitCode, 0);
	assert.notEqual((await execute("printf changed > /frozen.txt")).exitCode, 0);
	assert.equal(readFileSync(file, "utf8"), "frozen\n");
});

test("unsupported optional tool wrappers are not executed or granted", (t) => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "srt-tool-wrapper-")));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const marker = join(root, "executed");
	writeFileSync(join(root, "jq"), `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 });
	assert.deepEqual(runtimeTools(root), { readPaths: [], binPaths: [] });
	assert.equal(existsSync(marker), false);
});

test("SRT enforces declared mounts and denies unrelated host reads", async (t) => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "telomi-srt-test-")));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const external = realpathSync(mkdtempSync(join(process.platform === "darwin" ? "/private/tmp" : tmpdir(), "srt-external-")));
	t.after(() => rmSync(external, { recursive: true, force: true }));
	const work = join(root, "work");
	const input = join(root, "input");
	mkdirSync(work);
	mkdirSync(input);
	writeFileSync(join(input, "frozen.txt"), "frozen\n");
	writeFileSync(join(external, "canary.txt"), "external canary\n");
	symlinkSync(external, join(work, "external-link"), "dir");
	const spec = parseSandboxExecutionSpec({
		version: 1,
		id: "test",
		role: "main.goal_agent",
		sessionLabel: "test",
		hostCwd: work,
		guestCwd: "/work",
		mounts: [
			{ hostPath: work, guestPath: "/work", access: "read-write" },
			{ hostPath: input, guestPath: "/input", access: "read-only" },
		],
		activeTools: ["bash"],
		env: {},
		network: { mode: "deny" },
		writablePaths: [{ guestPath: "/work", kind: "tree" }],
	});
	assert.equal((await execSrt({ command: "touch ok", cwd: work, policy: policyFromSpec(spec) })).exitCode, 0);
	assert.notEqual((await execSrt({ command: `touch ${join(input, "blocked")}`, cwd: work, policy: policyFromSpec(spec) })).exitCode, 0);
	const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;
	const probe = `
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");
assert.equal(fs.readFileSync(process.env.INPUT_FILE, "utf8"), "frozen\\n");
for (const directory of [process.env.EXTERNAL_DIR, "external-link"]) {
    const file = directory + "/canary.txt";
    assert.throws(() => fs.readFileSync(file), error => ["EPERM", "EACCES", "ENOENT"].includes(error.code));
    const child = spawnSync(process.execPath, ["-e", "require('node:fs').readFileSync(process.argv[1])", file]);
    assert.equal(child.error, undefined, "subprocess must start to verify inherited permissions");
    assert.notEqual(child.status, 0, "subprocess must not read external content");
    try { assert.ok(!fs.readdirSync(directory).includes("canary.txt")); }
    catch (error) { assert.ok(["EPERM", "EACCES", "ENOENT"].includes(error.code)); }
}
`;
	const policy = policyFromSpec(spec);
	assert.ok(policy.filesystem.denyRead.includes("/"));
	let output = "";
	assert.equal((await execSrt({ command: `${quote(process.execPath)} -e ${quote(probe)}`, cwd: work, policy,
		env: { INPUT_FILE: join(input, "frozen.txt"), EXTERNAL_DIR: external }, timeoutSeconds: 30,
		onData: (chunk) => { output += chunk.toString(); },
	})).exitCode, 0, output);
	process.env.TELOMI_SRT_HOST_SECRET_TEST = "must-not-leak";
	try {
		assert.equal((await execSrt({
			command: "test -z \"$TELOMI_SRT_HOST_SECRET_TEST\" && test \"$TELOMI_SRT_ALLOWED_TEST\" = visible",
			cwd: work,
			env: { TELOMI_SRT_ALLOWED_TEST: "visible" },
			policy: policyFromSpec(spec),
		})).exitCode, 0);
	} finally {
		delete process.env.TELOMI_SRT_HOST_SECRET_TEST;
	}
});

test("old sandbox fields fail instead of falling back", () => {
	assert.throws(() => parseSandboxExecutionSpec({
		version: 1,
		id: "old",
		role: "main.goal_agent",
		sessionLabel: "old",
		hostCwd: "/tmp",
		guestCwd: "/work",
		mounts: [{ hostPath: "/tmp", guestPath: "/work", access: "read-write" }],
		activeTools: ["bash"],
		env: {},
		network: { mode: "deny" },
		writablePaths: [{ guestPath: "/work", kind: "tree" }],
		environment: { python: {} },
	}), /unsupported fields/u);
});
