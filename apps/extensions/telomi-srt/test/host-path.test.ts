import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { parseSandboxExecutionSpec } from "../sandbox-spec.js";
import { execSrt, policyFromSpec } from "../runtime.js";

/**
 * The sandbox SDK resolves the tools it wraps a command with by spawning `which`
 * under a short fixed budget, so whatever sits first on the control process PATH
 * decides whether the sandbox can start at all. A caller-supplied PATH must not
 * be able to break that, and must still arrive unchanged at the sandboxed command.
 */
test("a caller PATH cannot break sandbox startup and still reaches the target", async () => {
	const root = mkdtempSync(join(tmpdir(), "telomi-srt-path-test-"));
	const work = join(root, "work");
	const shim = join(root, "shim");
	mkdirSync(work);
	mkdirSync(shim);
	// Stands in for any PATH entry that answers `which` too slowly or not at all.
	writeFileSync(join(shim, "which"), "#!/bin/sh\nsleep 5\nexit 1\n");
	chmodSync(join(shim, "which"), 0o755);
	const spec = parseSandboxExecutionSpec({
		version: 1,
		id: "test",
		role: "main.goal_agent",
		sessionLabel: "test",
		hostCwd: work,
		guestCwd: "/work",
		mounts: [{ hostPath: work, guestPath: "/work", access: "read-write" }],
		activeTools: ["bash"],
		env: {},
		network: { mode: "deny" },
		writablePaths: [{ guestPath: "/work", kind: "tree" }],
	});
	const output: Buffer[] = [];
	const { exitCode } = await execSrt({
		command: 'printf %s "$PATH"',
		cwd: work,
		env: { PATH: `${shim}:${process.env.PATH ?? ""}` },
		policy: policyFromSpec(spec),
		onData: (chunk) => output.push(chunk),
	});
	const text = Buffer.concat(output).toString();
	assert.equal(exitCode, 0, `sandbox startup failed: ${text}`);
	assert.equal(text.split(":")[0], shim, "the sandboxed command must keep the PATH its caller asked for");
});
