import type { SearchRequest } from './wiki-stage-search.js';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { Type } from "@sinclair/typebox";
import { assertPrimeModelAnswered, createPrimeModelRegistry, createPrimeSettingsManager } from '../agent-runtime/prime-agent-paths.js';
import { acceptAgentOutput } from '../agent-runtime/accept-agent-output.js';
import { isThinkingLevel } from '../agent-runtime/model-config/resolve.js';
import { writeJsonAtomic } from '../lib/fs.js';
import { hashJson, sha256 } from '../lib/hash.js';
import { toErrorMessage } from '../lib/values.js';
import type { WikiStageInput, WikiStageResult } from './wiki-stage-contract.js';
import { agentPythonRoots } from '../agent-runtime/agent-python.js';
import { createRlmChildLogicalWorkspaceSnapshotter, snapshotLogicalWorkspace } from '../agent-runtime/logical-workspace-snapshot.js';
import { createStageWorkspace } from './wiki-topic-skill.js';
import { wikiStageOutputHash, wikiStageTraceUsage, readWikiStageOutput } from './wiki-stage.js';

const required = (key: string): string => { const value = process.env[key]; if (!value) throw new Error(`${key} is required`); return value; };
const { createPrimeWorkerControl } = await import(required("PRIME_WORKER_CONTROL_MODULE_PATH")) as typeof import("../agent-runtime/prime-worker-control.js");
const control = createPrimeWorkerControl();

const runtime = required("WIKI_STAGE_RUNTIME");
const cwd = required("WIKI_STAGE_WORK");
const inputRoot = required("WIKI_STAGE_INPUT_ROOT");
const input = JSON.parse(readFileSync(join(runtime, "input.json"), "utf8")) as WikiStageInput;
const topic = input.stage === "topic";
const workspace = createStageWorkspace(input, inputRoot, JSON.parse(readFileSync(join(runtime, "skills.json"), "utf8")));
const system = readFileSync(join(runtime, "system-prompt.md"), "utf8");
const user = `${readFileSync(join(runtime, "user-prompt.md"), "utf8")}\n\n${workspace.userContext}`;
writeJsonAtomic(join(runtime, "agent-context.json"), { user });
const selector = required("WIKI_STAGE_MODEL");
const thinkingLevel = required("WIKI_STAGE_THINKING");
if (!isThinkingLevel(thinkingLevel)) throw new Error("Invalid wiki-compilation thinking level");
const prime = await import(required("PRIME_AGENT_MODULE_PATH"));
const agentDir = required("PRIME_AGENT_CODING_AGENT_DIR");
const { authStorage, modelRegistry } = createPrimeModelRegistry(prime, agentDir);
const slash = selector.indexOf("/");
const model = modelRegistry.find(selector.slice(0, slash), selector.slice(slash + 1));
if (!model) throw new Error(`Unknown wiki-compilation model ${selector}`);
const settingsManager = createPrimeSettingsManager(prime.SettingsManager, cwd, agentDir);
const loadedSkills = workspace.skillRoot ? prime.loadSkillsFromDir({dir: workspace.skillRoot, source: "project"}) : {skills: [], diagnostics: []};
if (workspace.skillRoot) {
 process.env.PYTHONPATH = [join(workspace.skillRoot, "src"), process.env.PYTHONPATH].filter(Boolean).join(delimiter);
 if (loadedSkills.diagnostics.length || loadedSkills.skills.length !== 1 || loadedSkills.skills[0].kind !== "python") throw new Error("Wiki must mount as one Python-backed Skill");
}
const loader = new prime.DefaultResourceLoader({ cwd, agentDir, settingsManager, noExtensions: true, noSkills: true,
 noPromptTemplates: true, noThemes: true, noContextFiles: true, appendSystemPrompt: [system], bundledSkillsDir: null, skillsOverride: () => loadedSkills });
await loader.reload();
const sessionRoot = join(runtime, "sessions");
mkdirSync(sessionRoot, { recursive: true });
let accepted: { outputHash: string; result: WikiStageResult } | undefined;
const textResult = (text: string, isError = false) => ({ content: [{ type: "text", text }], details: {}, isError });
async function logged<T>(tool: string, parameters: unknown, operation: () => T | Promise<T>): Promise<T> {
 try {
  const output = await operation();
  appendFileSync(join(runtime, "reads.jsonl"), `${JSON.stringify({ tool, parameters, output })}\n`);
  return output;
 } catch (error) {
  appendFileSync(join(runtime, "reads.jsonl"), `${JSON.stringify({ tool, parameters, error: toErrorMessage(error) })}\n`);
  throw error;
 }
}
const { session } = await prime.createAgentSession({ cwd, agentDir, authStorage, modelRegistry, settingsManager,
 resourceLoader: loader, sessionManager: prime.SessionManager.create(cwd, sessionRoot), model, thinkingLevel,
 scopedModels: [{ model, thinkingLevel }], tools: topic ? ["ipython"] : ["ipython", "read_wiki", "search_wiki"],
 customTools: [
  ...(topic ? [] : [{ name: "read_wiki", label: "Read Wiki evidence", description: "Read a task-local P/S alias, such as P1 or S1; this tool does not read file paths. Use IPython Path.read_text() for indexes/Pn.json or other mapped metadata files. The task catalog supplies each page index path; an index is metadata, not a full read. Standalone N Cue content is available only for the complete Note in objects, or for unplaced Cues in merge-objects. Later stages use page citations without reopening Cue text. Large pages list complete sections to read individually.",
   parameters: Type.Object({ ref: Type.String() }, { additionalProperties: false }), executionMode: "sequential",
   async execute(_id: string, parameters: { ref: string }) {
    try { return textResult(await logged("read_wiki", parameters, () => workspace.read(parameters.ref))); }
    catch (error) { return textResult(toErrorMessage(error), true); }
   } },
  { name: "search_wiki", label: "Search Wiki files", description: "Find candidate sections with exactly one of query (one exact phrase) or terms (phrases matched by any/all). Do not concatenate alternatives into a query. Search title, description, heading, body and source names; scope=body limits metadata matches. Optional kind/page_ref filters. Returns total, bounded snippets, matched fields and next_offset for paging. Read complete selected content before relying on it.",
   parameters: Type.Object({ query: Type.Optional(Type.String()), terms: Type.Optional(Type.Array(Type.String(), { minItems: 1, maxItems: 12 })), mode: Type.Optional(Type.Union([Type.Literal("any"), Type.Literal("all")])), scope: Type.Optional(Type.Union([Type.Literal("all"), Type.Literal("body")])), kind: Type.Optional(Type.Union([Type.Literal("entity"), Type.Literal("concept")])), page_ref: Type.Optional(Type.String()), offset: Type.Optional(Type.Integer({minimum: 0})), limit: Type.Optional(Type.Integer({minimum: 1, maximum: 40})) }, { additionalProperties: false }), executionMode: "sequential",
   async execute(_id: string, parameters: SearchRequest) {
    try { return textResult(await logged("search_wiki", parameters, () => workspace.search(parameters))); }
    catch (error) { return textResult(toErrorMessage(error), true); }
   } },
  ]),
 ], rlmMaxDepth: 1, prewarmIpythonKernel: true, executionMode: "print", telemetryDisabled: true, autonomous: { enabled: false } });
control.registerSession(session);
const observePythonMessages = () => {
 if (!topic) return;
 for (const message of session.messages) {
  if (message.role !== "toolResult" || message.toolName !== "ipython" || message.isError) continue;
  const visible = message.content.filter((block: any) => block.type === "text").map((block: any) => block.text).join("\n");
  workspace.observe(message.toolCallId, visible);
 }
 writeJsonAtomic(join(runtime, "native-read-observations.json"), workspace.observations());
};
const logicalWorkspace = { guestCwd: cwd, mounts: [
 { hostPath: cwd, guestPath: cwd, access: 'read-write' as const, shadowPaths: ['/.prime-kernel'] },
 { hostPath: inputRoot, guestPath: inputRoot, access: 'read-only' as const },
], stage: { kind: input.stage, key: input.key }, captureMoment: 'before-first-agent-turn' as const,
 excludedMounts: [
  ...[...new Set([...agentPythonRoots(process.env), dirname(required('TELOMI_SRT_KERNEL_RUNNER'))])]
   .map(guestPath => ({ guestPath, access: 'read-only' as const, reason: 'runtime-library' as const })),
  { guestPath: join(cwd, '.prime-kernel'), access: 'read-write' as const, reason: 'runtime-state' as const },
 ] };
snapshotLogicalWorkspace({ ...logicalWorkspace, sessionId: session.sessionId, sessionRole: 'root' }, join(runtime, 'logical-workspaces', 'root'));
const snapshotChild = createRlmChildLogicalWorkspaceSnapshotter((id) => {
 const child = session.getRlmChildSession(id);
 if (!child) throw new Error('Wiki child Workspace capture requires its published native Session');
 return { ...logicalWorkspace, sessionId: child.sessionId, sessionRole: 'child' };
}, join(runtime, 'logical-workspaces'), 'child');
const unsubscribe = session.subscribe((event: any) => {
 snapshotChild(event);
 if (topic && event.type === "tool_execution_end" && event.toolName === "ipython" && !event.isError) {
  const visible = event.result.content.filter((block: any) => block.type === "text").map((block: any) => block.text).join("\n");
  workspace.observe(event.toolCallId, visible);
 }
});
writeJsonAtomic(join(runtime, "mounted-skills.json"), loader.getSkills());
writeJsonAtomic(join(runtime, "tool-definitions.json"), session.getAllTools().filter((tool: any) => session.getActiveToolNames().includes(tool.name)));
writeJsonAtomic(join(runtime, "model-metadata.json"), {id: model.id, provider: model.provider, cost: model.cost, thinking: session.thinkingLevel});
writeFileSync(join(runtime, "effective-system-prompt.md"), session.systemPrompt);
let promptFailure: { error: unknown } | undefined;
try {
 try {
  const candidate = await acceptAgentOutput({
   initialPrompt: user,
   promptTurn: async (text, repair) => {
    try {
     await session.prompt(text, { signal: control.signal, ...(repair ? { expandPromptTemplates: false, streamingBehavior: "followUp" } : {}) });
     control.signal.throwIfAborted();
     await session.waitForRlmQuiescence();
     control.signal.throwIfAborted();
     assertPrimeModelAnswered(session);
    } catch (error) { promptFailure = { error }; throw error; }
   },
   validate: () => {
    control.signal.throwIfAborted();
    observePythonMessages();
    const outputHash = wikiStageOutputHash(cwd);
    const result = workspace.validate(JSON.parse(readWikiStageOutput(join(cwd, "result.json")).toString("utf8")), cwd);
    if (outputHash !== wikiStageOutputHash(cwd)) throw new Error("Wiki output changed during validation");
    return { outputHash, result };
   },
   onRejected: (attempt, error) => appendFileSync(join(runtime, "output-validation.jsonl"), `${JSON.stringify({ attempt, error })}\n`),
  });
  const result = workspace.validate(JSON.parse(readWikiStageOutput(join(cwd, "result.json")).toString("utf8")), cwd);
  if (hashJson(result) !== hashJson(candidate.result) || candidate.outputHash !== wikiStageOutputHash(cwd)) throw new Error("Wiki output changed after acceptance");
  accepted = candidate;
  writeJsonAtomic(join(runtime, "accepted-result.json"), result);
  writeJsonAtomic(join(runtime, "receipts.json"), workspace.receipts());
  writeJsonAtomic(join(runtime, "accepted.json"), { outputHash: accepted.outputHash,
   resultHash: sha256(readWikiStageOutput(join(runtime, "accepted-result.json"))),
   receiptsHash: sha256(readWikiStageOutput(join(runtime, "receipts.json"))) });
 } finally {
  await control.abort();
  await session.waitForRlmQuiescence().catch(() => undefined);
  unsubscribe();
  observePythonMessages();
  await control.dispose();
  writeJsonAtomic(join(runtime, "receipts.json"), workspace.receipts());
  const usage = wikiStageTraceUsage(runtime);
  writeJsonAtomic(join(runtime, "result.json"), { usage: { input_tokens: usage.inputTokens, output_tokens: usage.outputTokens, cost_usd: usage.costUsd, model_calls: usage.calls },
   accessMode: topic ? "wiki-python-skill" : "wiki-tools", model: selector, nativeDelegation: false, thinkingLevel, accepted: Boolean(accepted) });
 }
} catch (error) {
 const failure = promptFailure ? promptFailure.error : error;
 if (failure !== error) console.error("Wiki cleanup failed after model failure:", toErrorMessage(error));
 if (process.send) await new Promise<void>(resolve => {
  try { process.send!({ type: "stage_worker_failure", failure_class: promptFailure ? "provider" : "validation",
   error: toErrorMessage(failure) }, () => resolve()); }
  catch { resolve(); }
 });
 throw failure;
}
