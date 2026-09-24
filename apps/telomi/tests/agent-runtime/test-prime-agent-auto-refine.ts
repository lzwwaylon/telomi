import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import {
	PRIME_AUTONOMOUS_CONFIG,
	PRIME_AUTO_REFINE_ENABLED,
	PRIME_RLM_MAX_DEPTH,
	createPrimeSettingsManager,
	createPrimeTraceEventFilter,
	projectPrimeChildLifecycleEvent,
	primeAgentModulePath,
	stagePrimeAgentDirectory,
} from "../../server/agent-runtime/prime-agent-paths.js";
import { primeKernelEnv, primeRuntimeEnv } from "../../server/agent-runtime/prime-agent-srt.js";
import { agentPythonExecutable } from "../../server/agent-runtime/agent-python.js";

assert.equal(PRIME_AUTO_REFINE_ENABLED, false);
assert.equal(PRIME_RLM_MAX_DEPTH, 1);
assert.equal(PRIME_AUTONOMOUS_CONFIG.enabled, false);
assert.match(primeAgentModulePath({}), /\/node_modules\/prime-agent\/dist\/index\.js$/u);
assert.equal(primeRuntimeEnv({}).RLM_MAX_DEPTH, "1");
const projectKernel = join(tmpdir(), "telomi-project-kernel");
const projectKernelEnv = { PATH: "/host/bin", PRIME_AGENT_KERNEL_VENV: projectKernel };
assert.equal(agentPythonExecutable(projectKernelEnv), join(projectKernel, "bin", "python"));
assert.deepEqual(primeRuntimeEnv(projectKernelEnv), {
	RLM_MAX_DEPTH: "1",
	PATH: `${join(projectKernel, "bin")}${delimiter}/host/bin`,
	PYTHONNOUSERSITE: "1",
	VIRTUAL_ENV: projectKernel,
	PRIME_AGENT_KERNEL_VENV: projectKernel,
});

let runtimeOverride: unknown;
const sdkSettings = createPrimeSettingsManager({
	create: () => ({
		applyOverrides: (override: unknown) => { runtimeOverride = override; },
		getAutoRefineSettings: () => ({ enabled: false }),
	}),
}, "/work", "/agent");
assert.deepEqual(runtimeOverride, { autoRefine: { enabled: false } });
assert.equal(sdkSettings.getAutoRefineSettings().enabled, false);

const shouldRecordTraceEvent = createPrimeTraceEventFilter();
assert.equal(shouldRecordTraceEvent({ type: "message_end" }), false,
	"SDK lifecycle indexes must not duplicate Prime's native message Trace");
assert.equal(shouldRecordTraceEvent({ type: "tool_execution_end" }), false,
	"SDK lifecycle indexes must not duplicate Prime's native Tool Trace");
assert.equal(shouldRecordTraceEvent({ type: "rlm_child_update", child: { status: "running" } }), false);
assert.equal(shouldRecordTraceEvent({ type: "rlm_child_update", child: { id: "sub-1", status: "running" } }), true);
assert.equal(shouldRecordTraceEvent({ type: "rlm_child_update", child: { id: "sub-1", status: "running" } }), false);
assert.equal(shouldRecordTraceEvent({ type: "rlm_child_update", child: { id: "sub-1", status: "done" } }), true);
assert.equal(shouldRecordTraceEvent({ type: "rlm_child_update", child: { id: "sub-1", status: "done" } }), false);
assert.deepEqual(projectPrimeChildLifecycleEvent({
	type: "rlm_child_update",
	child: { id: "sub-1", status: "done", sessionDir: "/sessions/sub-1", answerPreview: "duplicated answer" },
}), { type: "rlm_child_update", child: { id: "sub-1", status: "done", sessionDir: "/sessions/sub-1" } });
assert.equal(projectPrimeChildLifecycleEvent({ type: "message_end", message: { role: "assistant" } }), undefined);

const serverRoot = fileURLToPath(new URL("../../server/", import.meta.url));
assert.deepEqual(sourceFiles(serverRoot)
	.filter((path) => readFileSync(path, "utf-8").includes("/opt/homebrew/lib/node_modules/prime-agent")), []);
const reportWriterSource = readFileSync(join(serverRoot, "research", "pipeline", "prime-report-writer.ts"), "utf-8");
assert.match(reportWriterSource, /PRIME_AGENT_PATHS_MODULE_PATH: PRIME_AGENT_PATHS_MODULE/u);
assert.doesNotMatch(reportWriterSource, /WORKER_MODULES = \[[^\]]*prime-agent-paths/u);
assert.match(
	readFileSync(join(serverRoot, "research", "pipeline", "prime-report-writer-worker.ts"), "utf-8"),
	/await import\(required\("PRIME_AGENT_PATHS_MODULE_PATH"\)\)/u,
);
const directSettingsCallers = sourceFiles(serverRoot)
	.filter((path) => readFileSync(path, "utf-8").includes(".SettingsManager.create("))
	.map((path) => relative(serverRoot, path));
assert.deepEqual(directSettingsCallers, ["research/pipeline/prime-cornell-note-worker.mjs"]);
assert.match(
	readFileSync(join(serverRoot, directSettingsCallers[0]!), "utf-8"),
	/getAutoRefineSettings\(\)\.enabled !== false/u,
);
// The Cornell Note worker is copied into each Run workspace and executed from there, so a relative
// import into server/ would not resolve. It stays self-contained: only node: built-ins statically,
// and Runtime modules by absolute path handed to it in its environment.
assert.deepEqual(
	[...readFileSync(join(serverRoot, directSettingsCallers[0]!), "utf-8").matchAll(/^import .* from "([^"]+)";$/gmu)]
		.map((match) => match[1]).filter((specifier) => !specifier!.startsWith("node:")),
	[],
	"prime-cornell-note-worker.mjs must not import server modules",
);
// 全部 Prime 入口的枚举。子进程只能由 spawnPrimeWorker 启动；进程内 SDK 会话只有 Wiki Maintainer，
// 且必须从同一 staging 函数取 Agent Directory。新增入口没有走启动器时，这里会失败。
const primeSpawners = sourceFiles(serverRoot)
	.filter((path) => {
		const source = readFileSync(path, "utf-8");
		return /from "node:child_process"/u.test(source) && source.includes("PRIME_AGENT_MODULE_PATH");
	})
	.map((path) => relative(serverRoot, path));
assert.deepEqual(primeSpawners, ["agent-runtime/prime-worker.ts"], "Prime subprocesses must be launched by spawnPrimeWorker");
// 更宽的网：任何 import node:child_process 且提到 Prime 的文件都要在这里登记，说明它不是新的 Prime 入口。
const childProcessPrimeMentions = sourceFiles(serverRoot)
	.filter((path) => {
		const source = readFileSync(path, "utf-8");
		return /from "node:child_process"/u.test(source) && /prime/iu.test(source);
	})
	.map((path) => relative(serverRoot, path))
	.sort();
assert.deepEqual(childProcessPrimeMentions, [
	"agent-runtime/agent-python.ts", // Resolves interpreter libraries without starting an Agent.
	"agent-runtime/prime-worker.ts", // 唯一的 Prime 子进程启动器
	"agent-runtime/python-environment.ts", // 用 Kernel Python 准备 Skill 依赖，不启动 Prime
	"evaluation/node-backtest.ts", // 回放 Prime Search 记录，不启动 Prime
	"providers/browser/session-registry.ts", // Browser 会话，不启动 Prime
	"research/pipeline/prime-report-writer.ts", // 用 Kernel Python 跑 prose lint，不启动 Prime
	"research/provider-sdk-assets.ts", // Provider Python SDK 资产，不启动 Prime
], "a file that spawns processes and mentions Prime must be registered here or launch through spawnPrimeWorker");
const primeModuleResolvers = sourceFiles(serverRoot)
	.filter((path) => path !== join(serverRoot, "agent-runtime", "prime-agent-paths.ts"))
	.filter((path) => readFileSync(path, "utf-8").includes("primeAgentModulePath("))
	.map((path) => relative(serverRoot, path))
	.sort();
assert.deepEqual(primeModuleResolvers, [
	"agent-runtime/prime-worker.ts",
	"research/pipeline/prime-search-batch.ts",
	"research/pipeline/provider-child-executor.ts", // Uses the same runPrime launcher and isolated Agent Directory.
	"wiki/note-wiki-maintainer.ts",
], "every Prime entry is enumerated here");
assert.doesNotMatch(readFileSync(join(serverRoot, "research", "pipeline", "prime-search-batch.ts"), "utf-8"), /await import\(/u,
	"Search Batch only records the module path in Launch Conditions; it does not load Prime itself");
const inProcessPrimeSessions = sourceFiles(serverRoot)
	.filter((path) => readFileSync(path, "utf-8").includes("await import(primeAgentModulePath("))
	.map((path) => relative(serverRoot, path));
assert.deepEqual(inProcessPrimeSessions, ["wiki/note-wiki-maintainer.ts"]);
for (const path of inProcessPrimeSessions) {
	assert.match(readFileSync(join(serverRoot, path), "utf-8"), /stagePrimeAgentDirectory\(/u,
		`${path} must take its Agent Directory from stagePrimeAgentDirectory`);
}
const stagingCallers = sourceFiles(serverRoot)
	.filter((path) => path !== join(serverRoot, "agent-runtime", "prime-agent-paths.ts"))
	.filter((path) => readFileSync(path, "utf-8").includes("stagePrimeAgentDirectory("))
	.map((path) => relative(serverRoot, path))
	.sort();
assert.deepEqual(stagingCallers, ["agent-runtime/prime-worker.ts", "wiki/note-wiki-maintainer.ts"]);
assert.match(readFileSync(join(serverRoot, "agent-runtime", "prime-worker.ts"), "utf-8"),
	/settings\.autoRefine\?\.enabled !== PRIME_AUTO_REFINE_ENABLED/u, "the launcher asserts the staged Auto Refine value");

const directAutonomousFlagCallers = sourceFiles(serverRoot)
	.filter((path) => path !== join(serverRoot, "agent-runtime", "prime-agent-paths.ts"))
	.filter((path) => readFileSync(path, "utf-8").includes('"--autonomous"'))
	.map((path) => relative(serverRoot, path));
assert.deepEqual(directAutonomousFlagCallers, [], "Prime CLI autonomous flags must use the global configuration");

const root = mkdtempSync(join(tmpdir(), "telomi-prime-settings-"));
try {
	const source = join(root, "source");
	const target = join(root, "target");
	const kernelWork = join(root, "kernel-work");
	const kernelPrivate = join(root, "kernel-private");
	mkdirSync(source);
	mkdirSync(kernelWork);
	mkdirSync(kernelPrivate);
	const kernelEnv = primeKernelEnv({
		cwd: kernelWork,
		writableRoots: [kernelWork],
		privateRoots: [kernelPrivate],
	});
	assert.ok(kernelEnv.PRIME_AGENT_KERNEL_PYTHON);
	assert.equal(execFileSync(kernelEnv.PRIME_AGENT_KERNEL_PYTHON, [
		"-c",
		'import os, site, sys; assert sys.prefix == os.environ["VIRTUAL_ENV"]; assert not site.ENABLE_USER_SITE; print(sys.prefix)',
	], { encoding: "utf-8", env: kernelEnv }).trim(), kernelEnv.VIRTUAL_ENV);
	writeFileSync(join(source, "auth.json"), "{}\n");
	stagePrimeAgentDirectory(target, { PRIME_AGENT_CODING_AGENT_DIR: source });
	const staged = JSON.parse(readFileSync(join(target, "settings.json"), "utf-8")) as {
		autoRefine?: { enabled?: boolean };
		rlmMaxDepth?: number;
	};
	assert.equal(staged.autoRefine?.enabled, false);
	assert.equal(staged.rlmMaxDepth, 1);
} finally {
	rmSync(root, { recursive: true, force: true });
}

console.log("Prime Auto Refine and CLI autonomous mode are disabled globally");

function sourceFiles(root: string): string[] {
	return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
		const path = join(root, entry.name);
		if (entry.isDirectory()) return sourceFiles(path);
		return /\.(?:mjs|ts)$/u.test(entry.name) ? [path] : [];
	});
}
