import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// The entry point loads the checkout's env files (which may set TELOMI_DATA_DIR) before anything else.
// Static imports are evaluated before its first statement, and many modules freeze data paths into
// constants when they load, so a static import that reaches one of them silently uses the default
// data directory under a supervisor that starts `server/index.ts` directly.
const BOOTSTRAP_MODULES = ["./config/environment.js", "./config/output-log.js"];

function staticImports(path: URL): string[] {
	return [...readFileSync(path, "utf8").matchAll(/^import\s[^;]*?from\s+"([^"]+)";/gmu)].map((match) => match[1]!);
}

test("the server entry point statically imports only modules that read no configuration", () => {
	const entry = new URL("../../server/index.ts", import.meta.url);
	for (const specifier of staticImports(entry)) {
		assert.ok(specifier.startsWith("node:") || BOOTSTRAP_MODULES.includes(specifier),
			`server/index.ts statically imports ${specifier}; import it dynamically after loadProjectEnvironment()`);
	}
	for (const module of BOOTSTRAP_MODULES) {
		const source = new URL(`../../server/${module.slice(2).replace(/\.js$/u, ".ts")}`, import.meta.url);
		for (const specifier of staticImports(source)) {
			assert.ok(specifier.startsWith("node:"), `${module} must import only Node built-ins, found ${specifier}`);
		}
	}
});
