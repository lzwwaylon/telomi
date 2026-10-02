import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createSrtAgentSandbox } from "../../server/agent-runtime/srt-agent-sandbox.js";

const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-file-session-cwd-")));
const work = join(root, "work"), agentDir = join(root, "agent"), sessions = join(root, "runtime", "sessions"), input = join(root, "input");
for (const path of [work, agentDir, sessions, input]) mkdirSync(path, { recursive: true });
writeFileSync(join(input, "source.md"), "Frozen input.\n");
writeFileSync(join(agentDir, "auth.json"), "{}");
writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: { "namespace-test": {
	baseUrl: "http://127.0.0.1:1", api: "openai-completions", apiKey: "unused",
	models: [{ id: "metadata-only", name: "Metadata only", reasoning: false }],
} } }));
const sandbox = createSrtAgentSandbox({ id: "pi-file-session-cwd", role: "wiki.object_builder", workDirectory: work,
	readonlyMounts: [{ hostPath: input, guestPath: "/work/wiki", access: "read-only" }],
	activeTools: ["read", "write", "edit"], network: "deny" });
let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
try {
	const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json"), allowModelNetwork: false });
	const model = modelRuntime.getModel("namespace-test", "metadata-only");
	assert.ok(model);
	const settingsManager = SettingsManager.inMemory();
	const loader = new DefaultResourceLoader({ cwd: work, agentDir, settingsManager, systemPrompt: "Write only in the Agent workspace.",
		noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
	await loader.reload();
	const manager = SessionManager.create(work, sessions);
	({ session } = await createAgentSession({ cwd: "/work", agentDir, modelRuntime, model, thinkingLevel: "off",
		settingsManager, resourceLoader: loader, sessionManager: manager,
		tools: ["read", "write", "edit"], customTools: sandbox.toolDefinitions }));
	const checkNamespace = () => {
		assert.match(session!.systemPrompt, /\nCurrent working directory: \/work\n$/u);
		assert.ok(!session!.systemPrompt.includes(work), "the SDK footer must not advertise its host storage directory");
		assert.equal(manager.getCwd(), work);
		assert.equal(manager.getSessionDir(), sessions);
		assert.ok(manager.getSessionFile()?.startsWith(`${sessions}/`), "native session logs remain under the host runtime directory");
		assert.deepEqual([...session!.getActiveToolNames()].sort(), ["edit", "read", "write"]);
	};
	const checkFileTools = async () => {
		const tools = new Map(session!.agent.state.tools.map(tool => [tool.name, tool]));
		const signal = new AbortController().signal;
		await tools.get("write")!.execute("relative-write", { path: "facts.json", content: "relative\n" }, signal);
		assert.equal(readFileSync(join(work, "facts.json"), "utf8"), "relative\n");
		await tools.get("write")!.execute("absolute-write", { path: "/work/facts.json", content: "absolute\n" }, signal);
		assert.equal(readFileSync(join(work, "facts.json"), "utf8"), "absolute\n");
		await tools.get("edit")!.execute("edit-work", { path: "facts.json", edits: [{ oldText: "absolute", newText: "edited" }] }, signal);
		const read = await tools.get("read")!.execute("read-work", { path: "/work/facts.json" }, signal);
		assert.match(JSON.stringify(read.content), /edited/u);
		await assert.rejects(() => tools.get("write")!.execute("host-write", { path: join(work, "facts.json"), content: "escape\n" }, signal), /outside the Agent workspace/u);
		await assert.rejects(() => tools.get("write")!.execute("readonly-write", { path: "/work/wiki/forbidden.md", content: "escape\n" }, signal), /read-only|outside writable paths|sandbox policy blocks/u);
		assert.equal(existsSync(join(input, "forbidden.md")), false);
		assert.equal(readFileSync(join(work, "facts.json"), "utf8"), "edited\n");
	};
	checkNamespace();
	await checkFileTools();
	session.setActiveToolsByName(["edit", "write", "read"]);
	checkNamespace();
	await session.reload();
	checkNamespace();
	await checkFileTools();
	assert.deepEqual(session.messages, [], "namespace verification initializes the real SDK without prompting a model");
} finally {
	session?.dispose();
	await sandbox.close();
	rmSync(root, { recursive: true, force: true });
}
