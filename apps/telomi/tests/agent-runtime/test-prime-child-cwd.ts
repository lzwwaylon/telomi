import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import * as prime from "prime-agent";
import type { Model } from "@earendil-works/pi-ai";
import { primeKernelEnv } from "../../server/agent-runtime/prime-agent-srt.js";
import { createProviderChildRuntimeHost, providerExecutionWorkspace, workspaceRelativeSkill } from "../../server/research/pipeline/provider-execution-workspace.js";

// Actual pinned SDK/IPython/SRT, no model or Provider calls.
const fixture = realpathSync(mkdtempSync(join(process.env.TELOMI_TEST_WORKSPACE_PARENT ?? tmpdir(), "prime-child-cwd-")));
const previousEnv = process.env;
const sessions: prime.AgentSession[] = [];
try {
	const root = join(fixture, "agent");
	const runtime = join(fixture, "runtime");
	const skill = join(root, "skills/demo");
	const sdk = fileURLToPath(new URL("../../server/research/python-tools", import.meta.url));
	mkdirSync(join(root, "work"), { recursive: true });
	mkdirSync(join(root, ".runtime"));
	mkdirSync(skill, { recursive: true });
	mkdirSync(runtime);
	writeFileSync(join(skill, "SKILL.md"), "---\nname: demo\ndescription: Test native cwd and read-only aliases.\n---\nRead local evidence.\n");
	writeFileSync(join(runtime, "credential.txt"), "private runtime credential\n");
	writeFileSync(join(root, "work/root-private.txt"), "root private draft\n");
	writeFileSync(join(root, ".runtime/private-receipt.json"), "host-only final authority\n");
	const sibling = providerExecutionWorkspace(root, "sub-sibling");
	writeFileSync(join(sibling.absolutePath, "work/private.txt"), "sibling draft\n");
	process.env = { ...primeKernelEnv({ cwd: root, readonlyRoots: [join(root, "skills"), sdk], writableRoots: [root],
		privateRoots: [runtime, join(root, ".runtime")], env: previousEnv }),
		TELOMI_PROVIDER_EXECUTION_WORKSPACES: "1", PYTHONPATH: sdk, PRIME_AGENT_SOURCE_TOKEN: "fixture-host-secret" };
	const model: Model<"openai-responses"> = { id: "fixture", name: "Fixture", api: "openai-responses", provider: "openai",
		baseUrl: "http://127.0.0.1:1", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 1024,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
	const authStorage = prime.AuthStorage.inMemory({}, { usePrimeCliConfig: false });
	const settingsManager = prime.SettingsManager.inMemory({ autoRefine: { enabled: false }, retry: { enabled: false } });
	const loader = new prime.DefaultResourceLoader({ cwd: root, agentDir: runtime, settingsManager,
		additionalSkillPaths: [skill], noSkills: true, noExtensions: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
		skillsOverride: (current) => ({ ...current, skills: current.skills.map((value) => workspaceRelativeSkill(root, value)) }) });
	await loader.reload();
	const options: prime.CreateAgentSessionOptions = { cwd: root, agentDir: runtime, authStorage,
		modelRegistry: prime.ModelRegistry.inMemory(authStorage), model, settingsManager, resourceLoader: loader,
		tools: ["ipython"], includeGoals: false, includeCompactSkill: false, prewarmIpythonKernel: false,
		rlmMaxDepth: 1, telemetryDisabled: true, autonomous: { enabled: false } };
	const { session: parent } = await prime.createAgentSession({ ...options, sessionManager: prime.SessionManager.create(root, join(runtime, "root-session")) });
	sessions.push(parent);
	const { session: baseline } = await prime.createAgentSession({ ...options,
		sessionManager: prime.SessionManager.create(root, join(runtime, "sub-baseline")), rlmDepth: 1,
		rlmSessionDir: join(runtime, "sub-baseline"), rlmParentNodeId: "sub-baseline" });
	sessions.push(baseline);
	const execute = async (session: prime.AgentSession, code: string) => {
		const result = await session.agent.state.tools.find((tool) => tool.name === "ipython")!.execute("cwd", { code });
		assert.equal(result.details.status, "ok", JSON.stringify(result));
		return result.content.filter((item) => item.type === "text").map((item) => item.text).join("\n").trim();
	};
	assert.equal(await execute(baseline, "from pathlib import Path; print(str(Path.cwd()))"), providerExecutionWorkspace(root, "sub-baseline").absolutePath);
	assert.equal(baseline.sessionManager.getCwd(), root, "Reproduces native inherited SDK cwd disagreeing with isolated kernel cwd");
	const host = createProviderChildRuntimeHost(prime, root, options);
	let published: prime.AgentSession | undefined;
	const { session: child } = await host.createRlmSubagentRuntime({ parentSession: parent, id: "sub-aligned", prompt: "fixture",
		sessionName: "aligned", sessionDir: join(runtime, "sub-aligned"), model, thinkingLevel: "off", serviceTier: "default", scopedModels: [],
		activeToolNames: ["ipython"], allowedToolNames: ["ipython"], customTools: [], includeGoals: false, includeCompactSkill: false,
		rlmDepth: 1, rlmMaxDepth: 1, rlmParentNodeId: "sub-aligned", onSessionPublished: (value) => { published = value; } });
	sessions.push(child);
	assert.equal(published, child);
	assert.equal(child.resourceLoader, parent.resourceLoader);
	assert.equal(child.agent.streamFn, parent.agent.streamFn);
	assert.deepEqual(child.getActiveToolNames(), ["ipython"]);
	assert.equal(child.sessionManager.getCwd(), providerExecutionWorkspace(root, "sub-aligned").absolutePath);
	assert.ok(child.systemPrompt.includes(`Working directory: ${child.sessionManager.getCwd()}`));
	assert.match(await execute(child, `
from pathlib import Path
import errno
import research_runtime
assert str(Path.cwd()) == ${JSON.stringify(child.sessionManager.getCwd())}
assert research_runtime.execution_id() == "sub-aligned"
assert "Test native cwd" in Path("skills/demo/SKILL.md").read_text()
for path in ${JSON.stringify([join(runtime, "credential.txt"), join(root, "work/root-private.txt"), join(sibling.absolutePath, "work/private.txt"), join(root, ".runtime/private-receipt.json")])}:
    try:
        Path(path).read_text()
    except OSError as error:
        assert error.errno in (errno.EPERM, errno.EACCES, errno.ENOENT)
    else:
        raise AssertionError("private file became visible: " + path)
Path("work/result.txt").write_text("private output")
print("Session and Kernel cwd aligned")
`), /Session and Kernel cwd aligned/);
	await host.releaseRlmSubagentRuntime!({ session: child }, {} as never, "done");
} finally {
	try { for (const session of sessions.reverse()) await session.disposeAsync(); }
	finally { process.env = previousEnv; rmSync(fixture, { recursive: true, force: true }); }
}
console.log("Prime child cwd aligns native Session/Prompt/Kernel and preserves private boundaries");
