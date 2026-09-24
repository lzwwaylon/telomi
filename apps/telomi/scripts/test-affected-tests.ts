import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { selectAffectedTests } from "./affected-tests.js";

const root = mkdtempSync(join(tmpdir(), "telomi-affected-tests-"));
const app = join(root, "apps/telomi");
const write = (file: string, content = "export {};") => {
	mkdirSync(dirname(join(app, file)), { recursive: true });
	writeFileSync(join(app, file), content);
};
const select = (...files: string[]) => selectAffectedTests(root, files.map((file) => `apps/telomi/${file}`));
try {
	write("tsconfig.json", JSON.stringify({ compilerOptions: { moduleResolution: "Bundler", baseUrl: ".", paths: { "@/*": ["web/src/*"], "@shared/*": ["shared/*"] } } }));
	write("server/wiki/leaf.ts", "export const value = 1;");
	write("server/wiki/index.ts", "export { value } from './leaf.js';");
	write("server/media/consumer.ts", "export { value } from '../wiki/index.js';");
	write("tests/wiki/test-leaf.ts", "import '../../server/wiki/leaf.js';");
	write("tests/wiki/test-dynamic.ts");
	write("tests/media/test-consumer.ts", "import '../../server/media/consumer.js';");
	write("tests/accounts/test-other.ts");
	write("tests/wiki/test-upstream-live.ts");
	write("scripts/test-harness.ts");
	write("scripts/test-worktree.ts");
	assert.deepEqual(select("scripts/worktree.py").tests, ["scripts/test-worktree.ts"]);
	write("tests/app/test-browser-startup.ts");
	assert.deepEqual(select("scripts/chrome-debug.ts").tests, ["scripts/test-worktree.ts", "tests/app/test-browser-startup.ts"]);
	assert.deepEqual(select("tests/wiki/test-leaf.ts").tests, ["tests/wiki/test-leaf.ts"]);
	assert.deepEqual(select("server/wiki/leaf.ts").tests, ["tests/media/test-consumer.ts", "tests/wiki/test-dynamic.ts", "tests/wiki/test-leaf.ts"]);
	assert.equal(select("server/wiki/leaf.ts").full, false);
	for (const file of ["server/wiki/template.md", "shared/types.ts", "package.json", "scripts/run-tests.ts", "server/new-domain/unknown.ts"]) assert.equal(select(file).full, true);
	assert.deepEqual(select("tests/wiki/test-upstream-live.ts").tests, []);
	write("web/src/leaf.ts", "export const value = 1;");
	write("tests/web/test-ui.ts", "import { value } from '@/leaf';");
	write("tests/accounts/test-alias.ts", "import { value } from '@/leaf';");
	write("tests/voice/test-voice.ts");
	assert.ok(select("web/src/leaf.ts").tests.includes("tests/accounts/test-alias.ts"));
	assert.ok(select("web/src/leaf.ts").tests.includes("tests/voice/test-voice.ts"));
	write("tests/accounts/test-import.ts", "await import('../../server/wiki/leaf.js');");
	write("tests/accounts/test-require.ts", "require('../../server/wiki/leaf.js');");
	assert.ok(select("server/wiki/leaf.ts").tests.includes("tests/accounts/test-import.ts"));
	assert.ok(select("server/wiki/leaf.ts").tests.includes("tests/accounts/test-require.ts"));
	rmSync(join(app, "server/wiki/leaf.ts"));
	assert.ok(select("server/wiki/leaf.ts").tests.includes("tests/media/test-consumer.ts"));
	rmSync(join(app, "web/src/leaf.ts"));
	assert.ok(select("web/src/leaf.ts").tests.includes("tests/accounts/test-alias.ts"));
	rmSync(join(app, "tests/wiki/test-leaf.ts"));
	assert.equal(select("tests/wiki/test-leaf.ts").full, true);
	assert.ok(!select("tests/wiki/test-leaf.ts").tests.includes("tests/wiki/test-leaf.ts"));
	write("tests/accounts/test-computed.ts", "const path = process.env.MODULE; await import(path);");
	assert.ok(select("server/wiki/index.ts").tests.includes("tests/accounts/test-computed.ts"));
	write("tests/accounts/test-test-consumer.ts", "import '../wiki/test-dynamic.js';");
	assert.ok(select("tests/wiki/test-dynamic.ts").tests.includes("tests/accounts/test-test-consumer.ts"));
	assert.deepEqual(select().tests, []);
	console.log("affected test selection passed");
} finally {
	rmSync(root, { recursive: true, force: true });
}
