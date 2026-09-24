import assert from "node:assert/strict";
import test from "node:test";
import { quote } from "shell-quote";
import { linuxSandboxArgv } from "../linux-mounts.js";

const work = "/fixture/artifacts/main";
const artifacts = "/fixture/artifacts";
const policy = { allowWrite: [work], allowRead: [work, artifacts], denyWrite: [], denyRead: ["/"] };
const start = ["bwrap", "--ro-bind", "/", "/", "--bind", work, work, "--tmpfs", "/fixture", "--bind", work, work];
const parent = ["--ro-bind", artifacts, artifacts];
const mask = ["--ro-bind", "/dev/null", `${work}/.gitconfig`];
const command = ["--", "/bin/sh", "-c", "printf '%s' '--ro-bind /private /private' > result"];

// This is the ordering from the failing Linux Main Agent Bash execution.
test("restores nested writes after the read-only parent and before mandatory masks", () => {
	const argv = [...start, ...parent, ...mask, ...command];
	const expected = [...start, ...parent, "--bind", work, work, ...mask, ...command];
	assert.deepEqual(linuxSandboxArgv(argv, policy), expected);
	assert.deepEqual(linuxSandboxArgv(["sh", "-c", quote(argv)], policy), expected);
});

test("does not resurrect skipped grants, explicit write denies or hidden children", () => {
	const argv = [...start, ...parent, ...mask, ...command];
	for (const deny of ["/fixture", work, `${work}/private`]) {
		assert.deepEqual(linuxSandboxArgv(argv, { ...policy, denyWrite: [deny] }), argv);
	}
	for (const deny of [work, `${work}/private`]) {
		assert.deepEqual(linuxSandboxArgv(argv, { ...policy, denyRead: ["/", deny] }), argv);
	}
	const skipped = ["bwrap", ...parent, ...command];
	assert.deepEqual(linuxSandboxArgv(skipped, policy), skipped);
	assert.deepEqual(linuxSandboxArgv(argv, { ...policy, allowWrite: [] }), argv);
	for (const restriction of [mask, ["--tmpfs", `${work}/hidden`], ["--ro-bind", `${work}/private`, `${work}/private`], ["--ro-bind", "/masked", artifacts]]) {
		const restricted = [...start, ...restriction, ...parent, ...command];
		assert.deepEqual(linuxSandboxArgv(restricted, policy), restricted);
	}
});

test("parses argument boundaries and never interprets the target command", () => {
	const argv = ["bwrap", "--setenv", "VALUE", "--ro-bind", ...start.slice(1), ...parent, ...command];
	assert.deepEqual(linuxSandboxArgv(argv, policy), [...argv.slice(0, -command.length), "--bind", work, work, ...command]);
	for (const wrapped of [["sh", "-c", "bwrap -- true; touch /tmp/unwanted"], ["sh", "-c", "bwrap -- $COMMAND"], ["sh", "-c", "bwrap -- *.txt"], ["sh", "-c", "echo unsafe"], ["bwrap", "--unknown", "--", "true"], ["bwrap", "constructor", "--", "true"], ["bwrap", "--bind"], ["bwrap", "--"]]) {
		assert.throws(() => linuxSandboxArgv(wrapped, policy));
	}
});
