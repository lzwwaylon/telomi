import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, globSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { CHECKS, duplicateHelpers, gitEnvironmentForChecks, liveImports, parseNameStatus, planChecks, planCommands, documentationOnly } from "./pre-commit-plan.js";

// Category checks no longer bundle the full TypeScript test suite.
for (const file of ["server/evolution/browser-trigger.ts", "server/lib/fs.ts", "server/wiki/compiler.ts", "server/cornell/contracts.ts"]) {
	assert.deepEqual(planChecks([`apps/telomi/${file}`]), ["typecheck"]);
}
assert.deepEqual(planChecks(["apps/telomi/server/app.ts"]), ["typecheck", "operations-contract"]);
assert.deepEqual(planChecks(["apps/telomi/server/evaluation/operations-contract.ts"]), ["typecheck", "operations-contract"]);
for (const file of ["agents/evolution/browser-skill-evolution/agent.yaml", "agents/evolution/browser-skill-evolution/skills/browser-skill-evolution/SKILL.md", "agents/research/prime-search/agent.md", "docs/evolution-module-design.md", "hooks/pre-commit", "scripts/worktree.py", "scripts/test-worktree.py"]) {
	assert.deepEqual(planChecks([`apps/telomi/${file}`]), []);
}
assert.deepEqual(planChecks(["apps/telomi/server/research/providers/browser.ts"]), ["typecheck", "provider-contract"]);
assert.deepEqual(planChecks(["apps/telomi/services/research-source-service/src/research_source_service/api.py"]), ["provider-contract"]);
assert.deepEqual(planChecks(["apps/telomi-audio-local/app.py"]), ["audio-service"]);
assert.deepEqual(planChecks(["apps/telomi-audio-local/README.md"]), []);
assert.ok(!planChecks(["apps/telomi/server/providers/source-service-client.ts"]).some((check) => check.startsWith("provider-live")));
assert.deepEqual(CHECKS.typecheck, [{ script: "typecheck", dir: "apps/telomi" }]);
assert.ok(CHECKS["provider-contract"]!.some((command) => command.script === "test:research-api"));
assert.equal(documentationOnly(["README.md", "apps/telomi/docs/development/testing.md"]), true);
assert.equal(documentationOnly(["apps/telomi/agents/research/prime-search/agent.md"]), false);
assert.equal(documentationOnly(["apps/telomi/server/wiki/template.md"]), false);
assert.equal(documentationOnly(["README.md", "apps/telomi/server/wiki/compiler.ts"]), false);

const serverFile = "apps/telomi/server/example.ts";
for (const source of [
	"function isInside() {}", "async function* listFiles() {}",
	"const isRecord = (value: unknown) => !!value;", "let writeAtomic: Function;",
	"function outer() { function toErrorMessage() {} }",
	"const alias = function listJsonl() {};", "const writeFileAtomic = () => {};",
]) assert.equal(duplicateHelpers(serverFile, source).length, 1, source);
for (const source of [
	'import { isRecord } from "./lib/values.js";',
	'export { listJsonl } from "./lib/fs.js";',
	'// function isRecord() {}\nconst text = "function isInside() {}";',
	"interface Shape { isRecord(): boolean }",
]) assert.deepEqual(duplicateHelpers(serverFile, source), [], source);
assert.deepEqual(duplicateHelpers("apps/telomi/server/lib/values.ts", "function isRecord() {}"), []);
assert.equal(duplicateHelpers("apps/telomi/server/lib/copy.ts", "function isRecord() {}").length, 1);
assert.deepEqual(duplicateHelpers("apps/extensions/telomi-srt/runtime.ts", "function isInside() {}"), []);

// All application server modules must stay consolidated, not only the staged files.
const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
for (const file of globSync("server/**/*.{ts,tsx,js,mjs,cjs,mts,cts}", { cwd: appRoot })) {
	const source = readFileSync(join(appRoot, file), "utf-8");
	assert.deepEqual(duplicateHelpers(`apps/telomi/${file}`, source), [], file);
	assert.doesNotMatch(source, /["'][^"']*main-agent\/log(?:\.[cm]?[jt]s)?["']/u, file);
}
assert.equal(existsSync(join(appRoot, "server/main-agent/log.ts")), false);

const test = "apps/telomi/tests/research/test-new.ts";
assert.deepEqual(liveImports(test, 'import { streamSimple } from "@earendil-works/pi-ai";'), ["@earendil-works/pi-ai"]);
assert.deepEqual(liveImports(test, 'import { getModel } from "@earendil-works/pi-ai/providers/all";'), ["@earendil-works/pi-ai/providers/all"]);
assert.deepEqual(liveImports(test, 'import { Agent } from "@earendil-works/pi-agent-core";'), ["@earendil-works/pi-agent-core"]);
assert.deepEqual(liveImports(test, 'import { getResearchSourceServiceManager } from "../../server/providers/source-service-client.js";'),
	["../../server/providers/source-service-client.js"]);
assert.deepEqual(liveImports(test, 'import { createResearchSourceRegistry } from "../../server/research/sources/builtin-registry.js";'),
	["../../server/research/sources/builtin-registry.js"]);
assert.deepEqual(liveImports(test, 'import { x } from "../../server/research/sources/providers/youtube/index.js";'),
	["../../server/research/sources/providers/youtube/index.js"]);
assert.deepEqual(liveImports(test, 'import { createResearchModelGateway } from "../../server/agent-runtime/models/model-gateway.js";'),
	["../../server/agent-runtime/models/model-gateway.js"]);
assert.deepEqual(liveImports(test, 'const m = await import("../../server/agent-runtime/pi-ai.js");'), ["../../server/agent-runtime/pi-ai.js"]);
assert.deepEqual(liveImports(test, 'import type { AgentTool } from "@earendil-works/pi-agent-core";'), []);
assert.deepEqual(liveImports(test, 'import type { ResearchProviderRequest } from "../../server/providers/search-types.js";'), []);
assert.deepEqual(liveImports(test, 'import { SessionManager } from "@earendil-works/pi-coding-agent";\nimport assert from "node:assert/strict";'), []);
assert.deepEqual(liveImports(test, 'import "./setup.js";\nimport { runVoiceTranscriptionPipeline } from "../../server/voice/transcription-pipeline.js";'), []);

assert.deepEqual(parseNameStatus("A\0a.ts\0M\0b.ts\0R100\0old.ts\0new.ts\0D\0gone.ts\0C100\0source.ts\0copy.ts\0"), {
	added: ["a.ts", "new.ts", "copy.ts"], changed: ["b.ts"], deleted: ["old.ts", "gone.ts"],
});
assert.throws(() => parseNameStatus("R100\0old.ts\0"), /Incomplete staged rename/u);
assert.throws(() => parseNameStatus("D\0"), /Incomplete staged name-status/u);

assert.deepEqual(planChecks(["apps/telomi/server/citations/preview.ts"]), ["typecheck"]);

const planRepo = mkdtempSync(join(tmpdir(), "telomi-command-plan-"));
try {
	const write = (file: string, content = "export {};") => {
		mkdirSync(dirname(join(planRepo, "apps/telomi", file)), { recursive: true });
		writeFileSync(join(planRepo, "apps/telomi", file), content);
	};
	write("tsconfig.json", JSON.stringify({ compilerOptions: { moduleResolution: "Bundler" } }));
	write("server/wiki/leaf.ts", "export const value = 1;");
	write("tests/wiki/test-leaf.ts", "import '../../server/wiki/leaf.js';");
	write("tests/media/test-consumer.ts", "import '../../server/wiki/leaf.js';");
	write("tests/accounts/test-unrelated.ts");
	const plan = (...files: string[]) => planCommands(planRepo, files.map((file) => `apps/telomi/${file}`));
	assert.deepEqual(plan("docs/development/testing.md").commands, []);
	assert.deepEqual(plan("tests/wiki/test-leaf.ts").commands, [
		{ dir: "apps/telomi", script: "typecheck" },
		{ dir: "apps/telomi", script: "test", args: ["tests/wiki/test-leaf.ts"] },
	]);
	const affected = plan("server/wiki/leaf.ts");
	assert.deepEqual(affected.commands.find((command) => command.script === "test")?.args, ["tests/media/test-consumer.ts", "tests/wiki/test-leaf.ts"]);
	assert.ok(affected.reasons.length > 0);
	assert.ok(!affected.commands.some((command) => command.script === "build"));
	const full = ["typecheck", "test", "build"].map((script) => ({ dir: ".", script }));
	assert.deepEqual(plan("shared/types.ts").commands, full);
	assert.deepEqual(plan("server/app.ts").commands, full);
	assert.deepEqual(plan("package.json").commands, full);
	assert.deepEqual(plan("server/wiki/template.md").commands, full);
	assert.ok(plan("services/research-source-service/api.py").commands.some((command) => command.script === "test:research-api"));
	rmSync(join(planRepo, "apps/telomi/server/wiki/leaf.ts"));
	assert.deepEqual(plan("server/wiki/leaf.ts").commands, affected.commands);
	rmSync(join(planRepo, "apps/telomi/tests/wiki/test-leaf.ts"));
	assert.deepEqual(plan("tests/wiki/test-leaf.ts").commands, full);
} finally {
	rmSync(planRepo, { recursive: true, force: true });
}

// End to end: the hook entry point against a staged file in a throwaway repo with the same layout.
const script = resolve(dirname(fileURLToPath(import.meta.url)), "pre-commit-plan.ts");
const repo = mkdtempSync(join(tmpdir(), "telomi-pre-commit-"));
try {
	const env = gitEnvironmentForChecks(repo);
	assert.equal(env.GIT_DIR, undefined);
	assert.equal(env.GIT_WORK_TREE, undefined);
	assert.equal(env.GIT_INDEX_FILE, undefined);
	const run = (...args: string[]) => {
		const result = spawnSync("git", args, { cwd: repo, encoding: "utf-8", env });
		assert.equal(result.status, 0, result.stderr);
		return result;
	};
	run("init", "-q");
	run("config", "user.email", "test@example.invalid");
	run("config", "user.name", "test");
	mkdirSync(join(repo, "apps/telomi"), { recursive: true });
	writeFileSync(join(repo, "apps/telomi/tsconfig.json"), JSON.stringify({ compilerOptions: { moduleResolution: "Bundler" } }));
	run("add", "apps/telomi/tsconfig.json");
	run("-c", "core.hooksPath=/dev/null", "commit", "-qm", "test baseline");
	mkdirSync(join(repo, "apps/telomi/tests/research"), { recursive: true });
	writeFileSync(join(repo, "apps/telomi/tests/research/test-live.ts"), 'import { getResearchSourceServiceManager } from "../../server/providers/source-service-client.js";\n');
	writeFileSync(join(repo, "apps/telomi/tests/research/test-pure.ts"), 'import assert from "node:assert/strict";\n');
	run("add", "-A");
	const hook = () => spawnSync(process.execPath, ["--import", import.meta.resolve("tsx"), script, "--stdin0", "--dry-run"], {
		cwd: repo, encoding: "utf-8", env, input: run("diff", "--cached", "--name-status", "-z", "--diff-filter=ACMRD").stdout,
	});
	const rejected = hook();
	assert.equal(rejected.status, 1, rejected.stderr);
	assert.match(rejected.stderr, /REJECT apps\/telomi\/tests\/research\/test-live\.ts imports \.\.\/\.\.\/server\/providers\/source-service-client\.js/u);
	assert.match(rejected.stderr, /Attestation/u);

	run("rm", "-q", "--cached", "apps/telomi/tests/research/test-live.ts");
	const accepted = hook();
	assert.equal(accepted.status, 0, accepted.stderr);
	assert.match(accepted.stdout, /PLAN 2 checks against staged content/u);
	assert.match(accepted.stdout, /CHECK npm run typecheck \(apps\/telomi\)/u);
	assert.match(accepted.stdout, /CHECK npm run test -- tests\/research\/test-pure\.ts \(apps\/telomi\)/u);
	assert.doesNotMatch(accepted.stdout, /CHECK npm run build/u);

	// The staged source is authoritative, even if the working copy has been fixed.
	const duplicate = "apps/telomi/server/example.ts";
	mkdirSync(dirname(join(repo, duplicate)), { recursive: true });
	writeFileSync(join(repo, duplicate), "export function isRecord(value: unknown) { return !!value; }\n");
	run("add", duplicate);
	writeFileSync(join(repo, duplicate), 'import { isRecord } from "./lib/values.js";\n');
	const duplicateRejected = hook();
	assert.equal(duplicateRejected.status, 1, duplicateRejected.stdout);
	assert.match(duplicateRejected.stderr, /REJECT.*example\.ts.*isRecord.*lib\/values/u);
	run("add", duplicate);
	assert.equal(hook().status, 0);
} finally {
	rmSync(repo, { recursive: true, force: true });
}

console.log("pre-commit plan tests passed");
