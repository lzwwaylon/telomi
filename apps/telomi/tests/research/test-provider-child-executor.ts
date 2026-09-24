import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AuthStorage, createAgentSession, DefaultResourceLoader, ModelRegistry, SessionManager, SettingsManager } from "prime-agent";
import { restoreProviderChildInput, stageProviderChildSkills } from "../../server/research/pipeline/provider-child-executor.js";

import { listFilesRecursive } from "../../server/lib/fs.js";
import { workspaceRelativeSkill } from "../../server/research/pipeline/provider-execution-workspace.js";

const root = mkdtempSync(join(tmpdir(), "provider-child-"));
try {
	const input = join(root, "input");
	const output = join(root, "output");
	mkdirSync(join(input, "work"), { recursive: true });
	mkdirSync(join(output, "work"), { recursive: true });
	writeFileSync(join(output, "work", ".execution-id"), "sub-fresh");
	writeFileSync(join(input, "work", ".execution-id"), "sub-historical");
	writeFileSync(join(input, "work", "task-data.txt"), "frozen dependency");
	mkdirSync(join(input, "skills"));
	writeFileSync(join(input, "skills", "old.md"), "old skill");
	restoreProviderChildInput(input, output);
	assert.equal(readFileSync(join(output, "work", "task-data.txt"), "utf8"), "frozen dependency");
	assert.equal(readFileSync(join(output, "work", ".execution-id"), "utf8"), "sub-fresh");
	assert.equal(existsSync(join(output, "skills")), false);
	symlinkSync(join(input, "work", "task-data.txt"), join(input, "escape"));
	assert.throws(() => restoreProviderChildInput(input, output), /symbolic links/u);
	const linkedWork = join(root, "linked-work");
	mkdirSync(linkedWork);
	symlinkSync(join(input, "work"), join(linkedWork, "work"));
	assert.throws(() => restoreProviderChildInput(linkedWork, output), /symbolic links/u);


	const fakePrime = join(root, "prime.mjs");
	writeFileSync(fakePrime, `
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
export { AuthStorage, ModelRegistry } from ${JSON.stringify(import.meta.resolve("prime-agent"))};
export const SettingsManager = {create: () => ({applyOverrides(){}, getAutoRefineSettings: () => ({enabled:false})})};
export class DefaultResourceLoader { async reload() {} }
export const SessionManager = {create: (_cwd, directory) => ({getSessionDir:()=>directory, newSession: ({rlmDepth}) => assert.equal(rlmDepth,1)})};
export async function createAgentSession(options) {
 assert.equal(options.rlmDepth,1);
 assert.equal(options.rlmMaxDepth,1);
 assert.equal(options.rlmParentNodeId,'sub-replay');
 assert.match(options.rlmSessionDir,/sub-replay$/);
 assert.deepEqual(options.tools,['ipython','submit_candidate_ledger']);
 assert.deepEqual(options.customTools.map(tool=>tool.name),['submit_candidate_ledger']);
 assert.equal(options.thinkingLevel,'medium');
 assert.equal(options.serviceTier,'flex');
 return {session:{
 subscribe(){},
 prompt(){throw new Error('Root prompt must never run')},
 async promptAndWait(content, parameters){
  assert.equal(content,'[task from parent]\\n\\nfrozen task');
  assert.equal(parameters.source,'extension');
  assert.equal(parameters.expandPromptTemplates,false);
  assert.equal(parameters.customMessage.customType,'agent_message');
  assert.equal(parameters.customMessage.details.fromRelationship,'parent');
  writeFileSync(process.env.PROOF,'child executed');
 },
 async waitForRlmQuiescence(){}, async abort(){}, dispose(){}
 }};
}
`);
	const agentDir = join(root, "credentials");
	mkdirSync(agentDir);
	writeFileSync(join(agentDir, "auth.json"), "{}");
	writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: {
		fixture: { api: "openai-completions", baseUrl: "http://127.0.0.1:9", apiKey: "fixture", models: [{ id: "test", reasoning: true }] },
	} }));
	const inputPath = join(root, "sdk-input.json");
	writeFileSync(inputPath, JSON.stringify({
		cwd: output, sessionDir: join(root, "sessions", "sub-replay"), provider: "fixture", model: "test",
		thinking: "medium", prompt: "frozen task", skills: [], tools: ["ipython", "submit_candidate_ledger"],
		serviceTier: "flex", contractTools: true, scopedModels: [], rlmMaxDepth: 1, childReplayId: "sub-replay",
	}));
	execFileSync(process.execPath, ["--import", "tsx", fileURLToPath(new URL("../../server/research/pipeline/prime-search-sdk-worker.ts", import.meta.url))], {
		env: { ...process.env, PRIME_SEARCH_SDK_INPUT: inputPath, PRIME_AGENT_CODING_AGENT_DIR: agentDir,
			TELOMI_PRIME_CREDENTIAL_SOURCE: agentDir, PRIME_AGENT_MODULE_PATH: fakePrime, PROOF: join(root, "proof") },
		stdio: "pipe",
	});
	assert.equal(readFileSync(join(root, "proof"), "utf8"), "child executed");
	const frozenRoot = join(root, "frozen");
	const frozenSkills = join(frozenRoot, "skills");
	const skill = (base: string, name: string, body: string) => {
		mkdirSync(base, { recursive: true });
		writeFileSync(join(base, "SKILL.md"), `---\nname: ${name}\ndescription: ${name} capability\n---\n${body}\n`);
		return base;
	};
	const oldBrowser = skill(join(frozenSkills, "provider-workers/browser/browser-skill"), "browser-skill", "Old browser procedure");
	writeFileSync(join(oldBrowser, "obsolete.txt"), "Must not leak into the Candidate");
	const arxiv = skill(join(frozenSkills, "provider-workers/arxiv/arxiv-skill"), "arxiv-skill", "Frozen arxiv procedure");
	writeFileSync(join(arxiv, "reference.txt"), "Frozen auxiliary reference");
	const goalSkill = skill(join(frozenSkills, "root-agent/goal-skill"), "goal-skill", "Frozen Goal capability");
	mkdirSync(join(goalSkill, "src/goal_skill"), { recursive: true });
	writeFileSync(join(goalSkill, "src/goal_skill/__init__.py"), 'VALUE = "frozen"\n');
	writeFileSync(join(goalSkill, "pyproject.toml"), '[project]\nname = "goal-skill"\nversion = "0.1.0"\n');
	const candidate = skill(join(root, "candidate/browser-skill"), "browser-skill", "Candidate browser procedure");
	const staged = stageProviderChildSkills(output, frozenSkills, { id: "browser", workerSkills: ["browser-skill"],
		implementationVersion: "1", capability: "browser", supportedContentTypes: [], fullTextAvailability: "browser_render",
		credentialRequirement: "none", reliabilityTier: 1, freshness: "realtime", costClass: "low", latencyClass: "low" },
		{ browser: [candidate] }, process.execPath);
	assert.equal(staged.skillRoots.length, 3);
	assert.equal(readFileSync(join(staged.skillsDirectory, "provider-workers/arxiv/arxiv-skill/reference.txt"), "utf8"), "Frozen auxiliary reference");
	assert.match(readFileSync(join(staged.skillsDirectory, "provider-workers/browser/browser-skill/SKILL.md"), "utf8"), /Candidate browser procedure/);
	assert.equal(existsSync(join(staged.skillsDirectory, "provider-workers/browser/browser-skill/obsolete.txt")), false);
	assert.equal(readFileSync(join(staged.skillsDirectory, "root-agent/goal-skill/src/goal_skill/__init__.py"), "utf8"), 'VALUE = "frozen"\n');
	// Exercise installed SDK construction without prompting or contacting a model. The native
	// inline child constructor is the reference; production replay only uses the public SDK.
	const authStorage = AuthStorage.create(join(agentDir, "auth.json"), { usePrimeCliConfig: false });
	const modelRegistry = ModelRegistry.create(authStorage, join(agentDir, "models.json"));
	const settingsManager = SettingsManager.create(output, agentDir);
	settingsManager.applyOverrides({ autoRefine: { enabled: false } });
	const resourceLoader = new DefaultResourceLoader({ cwd: output, agentDir, settingsManager,
		additionalSkillPaths: listFilesRecursive(frozenSkills, { absolute: true }).filter((path) => path.endsWith("/SKILL.md")).map(dirname),
		skillsOverride: (current) => ({ ...current, skills: current.skills.map((item) => workspaceRelativeSkill(frozenRoot, item)) }),
		noExtensions: true, noSkills: true, noContextFiles: true, noThemes: true, noPromptTemplates: true });
	await resourceLoader.reload();
	const replayLoader = new DefaultResourceLoader({ cwd: output, agentDir, settingsManager,
		additionalSkillPaths: staged.skillRoots,
		skillsOverride: (current) => ({ ...current, skills: current.skills.map((item) => workspaceRelativeSkill(output, item)) }),
		noExtensions: true, noSkills: true, noContextFiles: true, noThemes: true, noPromptTemplates: true });
	await replayLoader.reload();
	assert.deepEqual(replayLoader.getSkills().skills.map((item) => item.name).sort(), ["arxiv-skill", "browser-skill", "goal-skill"]);
	const model = modelRegistry.find("fixture", "test")!;
	const common = { cwd: output, agentDir, authStorage, modelRegistry, settingsManager, resourceLoader,
		model, thinkingLevel: "medium" as const, serviceTier: "flex" as const, tools: ["ipython"],
		rlmMaxDepth: 1, prewarmIpythonKernel: false, telemetryDisabled: true as const, autonomous: { enabled: false } };
	const { session: parent } = await createAgentSession({ ...common, sessionManager: SessionManager.create(output, join(root, "parent")) });
	const nativeDirectory = join(root, "native", "sub-reference");
	const { session: native } = Reflect.get(parent, "_createInlineRlmSubagentRuntime").call(parent, {
		parentSession: parent, id: "sub-reference", prompt: "frozen task", sessionName: "reference",
		sessionDir: nativeDirectory, model, thinkingLevel: "medium", serviceTier: "flex", scopedModels: [],
		activeToolNames: ["ipython"], allowedToolNames: ["ipython"], customTools: [], includeGoals: false,
		rlmDepth: 1, rlmMaxDepth: 1, rlmParentNodeId: "sub-reference",
	});
	const replayDirectory = join(root, "replay", "sub-replay");
	const replayManager = SessionManager.create(output, replayDirectory);
	replayManager.newSession({ rlmDepth: 1 });
	const { session: replay } = await createAgentSession({ ...common, resourceLoader: replayLoader, sessionManager: replayManager,
		rlmDepth: 1, rlmParentNodeId: "sub-replay", rlmSessionDir: replayDirectory });
	try {
		const normalize = (prompt: string, sessionFile: string) => prompt.replaceAll(sessionFile, "<SESSION>")
			.replaceAll(parent.sessionId, "your parent agent");
		assert.equal(normalize(replay.systemPrompt, replay.sessionFile!), normalize(native.systemPrompt, native.sessionFile));
		assert.deepEqual(replay.getActiveToolNames(), native.getActiveToolNames());
		assert.equal(replay.rlmDepth, native.rlmDepth);
		assert.equal(replay.thinkingLevel, native.thinkingLevel);
		assert.equal(replay.serviceTier, native.serviceTier);
		assert.equal(replay.sessionManager.getHeader()?.rlmDepth, 1);
		assert.throws(() => replay.handleAgentMessageHostRequest("agent_message.send", { target: "parent", message: "done" }),
			/agent messaging is not available/u, "Replay cannot acknowledge delivery to a nonexistent parent");
	} finally {
		await replay.disposeAsync();
		await native.disposeAsync();
		await parent.disposeAsync();
	}

} finally {
	rmSync(root, { recursive: true, force: true });
}
console.log("provider child executor contract passed");
