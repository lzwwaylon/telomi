import assert from "node:assert/strict";
import { accessSync, constants, readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

// npm workspaces hoist agent-browser to the repository root, so apps/telomi/node_modules/.bin
// does not exist on a clean install. The server must resolve the executable through the package.
test("agent-browser executable resolves through the package on a hoisted install", () => {
	const bin = fileURLToPath(import.meta.resolve("agent-browser/bin/agent-browser.js"));
	assert.doesNotThrow(() => accessSync(bin, constants.X_OK), `${bin} is not executable`);
});

// agent-browser's postinstall retargets the global `agent-browser` link to whichever checkout installed
// it last, so removing that checkout breaks the global command. The wrapper above makes the native
// binary executable on first run, so the install script is not needed.
test("agent-browser's install script stays disabled so installs never retarget the global command", () => {
	const root = JSON.parse(readFileSync(new URL("../../../../package.json", import.meta.url), "utf-8")) as { allowScripts?: Record<string, boolean> };
	assert.equal(root.allowScripts?.["agent-browser"], false);
});
