import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import type { InlineExtension, Skill } from '@earendil-works/pi-coding-agent';
import type { WikiMainSessionContext } from '../main-agent/wiki-context.js';
import { snapshotLogicalWorkspace } from '../agent-runtime/logical-workspace-snapshot.js';
import { createSrtAgentSandbox } from '../agent-runtime/srt-agent-sandbox.js';
import type { SrtAgentSandboxOptions } from '../agent-runtime/srt-agent-sandbox.js';
import { modelDefinitionHash } from '../agent-runtime/model-policy.js';
import { createWikiModelRuntime, wikiModelSelection } from './wiki-pi-runtime.js';
import { renderAgentPrompt } from '../agent-runtime/prompt-registry.js';
import { scrubResearchModelError } from '../agent-runtime/models/error-classifier.js';
import { listJsonl, writeJsonAtomic } from '../lib/fs.js';
import { hashJson, sha256 } from '../lib/hash.js';
import { toErrorMessage } from '../lib/values.js';
import { hashWikiDirectory } from './files.js';
import { wikiStageOutputHash, wikiStageTraceUsage, readWikiStageOutput } from './wiki-stage.js';
import type { WikiStageOutcome, WikiStageResult, WikiStageRequest } from './wiki-stage-contract.js';

const fileTools = ['read', 'write', 'edit'] as const;
export interface PiReadParameters { path: string; offset?: number; limit?: number }
export interface PiReadResult { content: Array<{ type: string; text?: string }> }
interface PiFileStageOptions {
 promptVariant: string;
 referenceVariant?: string;
 grepRoot?: '/work/wiki/pages' | '/work/input/pages';
 user: string;
 executionMode: string;
 role: SrtAgentSandboxOptions['role'];
 codeFiles: string[];
 prepare(inputRoot: string): void;
 readonlyMounts(inputRoot: string): SrtAgentSandboxOptions['readonlyMounts'];
 observeRead?(inputRoot: string, runtime: string, parameters: PiReadParameters, result: PiReadResult): void;
 validate(inputRoot: string, work: string, runtime: string): WikiStageResult;
 maxAttempts?: number;
 mainSession?: WikiMainSessionContext;
 systemPrefix?: string;
 skills?: Skill[];
 extensions?(runtime: string): InlineExtension[];
 assertExternalInteractions?(): void;
}

function piSessionPaths(root: string): string[] {
 return [...new Set(listJsonl(root).filter(path => path.includes('/sessions/'))
  .map(path => path.slice(0, path.indexOf('/sessions/') + '/sessions'.length)))];
}

/** Runtime-owned evidence is immutable alongside accepted model output. */
function acceptedArtifactHash(runtime: string): string {
 const sourcePath = join(runtime, 'source-hashes.json');
 if (existsSync(sourcePath)) {
  const sources = JSON.parse(readWikiStageOutput(sourcePath).toString('utf8')) as Array<{ path: string; sha256: string }>;
  for (const source of sources) if (sha256(readWikiStageOutput(source.path)) !== source.sha256) throw new Error('Accepted Pi source changed');
 }
 return hashJson({ logicalWorkspace: hashWikiDirectory(join(runtime, 'logical-workspaces')), metadata: ['input.json', 'receipts.json', 'read-coverage.json', 'complete-page-reads.json', 'source-hashes.json', 'main-session-fork.json', 'memory-searches.jsonl', 'effective-system-prompt.md', 'user-prompt.md', 'model-metadata.json']
  .filter(file => existsSync(join(runtime, file)))
  .map(file => ({ file, sha256: sha256(readWikiStageOutput(join(runtime, file))) })) });
}

export async function acceptPiFiles(
 promptTurn: (prompt: string, repair: boolean) => Promise<void>, validate: () => WikiStageResult,
 initialPrompt: string, onRejected: (turn: number, error: string) => void, maxAttempts = 2,
): Promise<WikiStageResult> {
 if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 3) throw new Error('Pi file stages allow 1 to 3 validation attempts');
 let lastError = '';
 for (let turn = 0; turn < maxAttempts; turn++) {
  await promptTurn(turn === 0 ? initialPrompt
   : `Runtime rejected your files. This is attempt ${turn + 1} of ${maxAttempts}, including the initial submission. Address every listed violation in this same session, preserve all valid content, and recheck the complete manifest and affected files after editing. Member references describe content actually consumed, not a way to silence validation. Exact validation feedback:\n${lastError}`, turn > 0);
  try { return validate(); }
  catch (error) {
   lastError = toErrorMessage(error);
   onRejected(turn + 1, lastError);
  }
 }
 throw new Error(`Pi files remain invalid after ${maxAttempts} attempts: ${lastError}`);
}

/** Native SDK execution shared by object and concept file stages. */
export async function runPiFileStage(request: WikiStageRequest, options: PiFileStageOptions): Promise<WikiStageOutcome> {
 request.signal.throwIfAborted();
 mkdirSync(request.workRoot, { recursive: true });
 const main = options.mainSession;
 if (main && request.input.stage !== 'curate-evidence') throw new Error('Only Wiki evidence selection may fork Main context');
 const selection = main ? { selector: main.model, provider: main.model.slice(0, main.model.indexOf('/')),
  modelId: main.model.slice(main.model.indexOf('/') + 1), thinking: main.thinking } : wikiModelSelection(request.env);
 const { selector: modelId, thinking } = selection;
 const { user } = options;
 const fileToolNames = options.grepRoot ? [...fileTools, 'grep' as const] : fileTools;
 const tools = main ? [...fileToolNames, 'search_user_memory'] : [...fileToolNames];
 const prompt = renderAgentPrompt('wiki', 'wiki-compilation', 'system', {}, options.promptVariant);
 const prefix = options.referenceVariant ? renderAgentPrompt('wiki', 'wiki-compilation', 'reference', {}, options.referenceVariant).content + '\n' : '';
 const systemPrompt = (options.systemPrefix ?? '') + prefix + prompt.content + (options.grepRoot
  ? `\nNative grep is also available for discovering relevant passages in ${options.grepRoot}. Search exact terms or patterns when catalog summaries leave uncertainty. Search matches do not establish complete reading: use native read on selected pages, and retain all existing full-read requirements.\n`
  : '');
 const identity = hashJson({ input: request.input, user, systemPrompt, registration: prompt.configSha256,
  model: modelId, thinking, tools, role: options.role, executionMode: options.executionMode,
  mainSession: main, memoryReplay: request.memoryReplay, skills: options.skills,
  maxAttempts: options.maxAttempts ?? 2, definition: modelDefinitionHash(modelId, request.env),
  code: [...options.codeFiles, './pi-file-stage.ts', './wiki-pi-runtime.ts', './wiki-stage.ts', './wiki-stage-workspace.ts',
   '../agent-runtime/srt-agent-sandbox.ts', '../agent-runtime/logical-workspace-snapshot.ts', '../../../extensions/telomi-srt/sandbox-spec.ts',
   '../../../extensions/telomi-srt/tool-operations.ts'].map(file => sha256(readFileSync(fileURLToPath(new URL(file, import.meta.url))))) });
 const checkpoint = join(request.workRoot, 'checkpoint.json');
 if (existsSync(checkpoint)) {
  const saved = JSON.parse(readWikiStageOutput(checkpoint).toString('utf8'));
  if (saved.identity !== identity) throw new Error('Pi file stage input or execution contract changed across resume');
  if (saved.status === 'succeeded') {
   if (saved.outputHash !== wikiStageOutputHash(join(saved.attemptRoot, 'work'))
    || saved.resultHash !== sha256(readWikiStageOutput(join(saved.attemptRoot, 'runtime/accepted-result.json')))
   || saved.outcomeHash !== hashJson(saved.outcome)
   || saved.artifactHash !== acceptedArtifactHash(join(saved.attemptRoot, 'runtime'))) throw new Error('Accepted Pi file output changed');
   request.onAttemptStarted?.(saved.attemptRoot);
   return saved.outcome as WikiStageOutcome;
  }
 }
 const attemptRoot = realpathSync(mkdtempSync(join(request.workRoot, 'attempt-')));
 const runtime = join(attemptRoot, 'runtime'), work = join(attemptRoot, 'work');
 const sessions = join(runtime, 'sessions'), validationInput = join(attemptRoot, 'input');
 const agentDirectory = join(runtime, 'agent');
 for (const directory of [runtime, work, sessions, validationInput]) mkdirSync(directory, { recursive: true });
 options.prepare(validationInput);
 const readonlyMounts = options.readonlyMounts(validationInput);
 const sources: Array<{ path: string; sha256: string }> = [];
 const snapshotSource = (path: string): void => {
  if (statSync(path).isDirectory()) for (const file of readdirSync(path).sort()) snapshotSource(join(path, file));
  else sources.push({ path, sha256: sha256(readWikiStageOutput(path)) });
 };
 for (const mount of readonlyMounts) snapshotSource(mount.hostPath);
 writeJsonAtomic(join(runtime, 'source-hashes.json'), sources);
 writeJsonAtomic(join(runtime, 'input.json'), request.input);
 const executionMode = options.executionMode;
 writeJsonAtomic(join(runtime, 'agent-context.json'), { user, executionMode });
 writeFileSync(join(runtime, 'user-prompt.md'), user);
 const manager = SessionManager.create(work, sessions);
 if (main) {
  const initialEntryIds = main.messages.map(message => manager.appendMessage(structuredClone(message)));
  writeJsonAtomic(join(runtime, 'main-session-fork.json'), { sourceSessionId: main.sessionId,
   forkSessionId: manager.getSessionId(), goalId: main.goalId, initialEntryIds });
 }
 writeJsonAtomic(checkpoint, { identity, status: 'running', attemptRoot });
 request.onAttemptStarted?.(attemptRoot);
 let session: Awaited<ReturnType<typeof createAgentSession>>['session'] | undefined;
 let sandbox: ReturnType<typeof createSrtAgentSandbox> | undefined;
 try {
  const { modelRuntime, model } = await createWikiModelRuntime(request.env, request.signal, selection);
  sandbox = createSrtAgentSandbox({ id: request.input.key, role: options.role, workDirectory: work,
   readonlyMounts,
   activeTools: fileToolNames, network: 'deny' });
  const settingsManager = SettingsManager.inMemory();
  const loader = new DefaultResourceLoader({ cwd: work, agentDir: agentDirectory, settingsManager,
   systemPrompt, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
   extensionFactories: options.extensions?.(runtime),
   skillsOverride: options.skills ? () => ({ skills: options.skills!, diagnostics: [] }) : undefined });
  await loader.reload();
  const customTools = sandbox.toolDefinitions.map(tool => !options.observeRead || tool.name !== 'read' ? tool : {
   ...tool, async execute(...args: Parameters<typeof tool.execute>) {
    const result = await tool.execute(...args);
    options.observeRead!(validationInput, runtime, args[1] as PiReadParameters, result);
    return result;
   },
  });
  ({ session } = await createAgentSession({ cwd: '/work', agentDir: agentDirectory, modelRuntime, model,
   thinkingLevel: thinking, scopedModels: [{ model, thinkingLevel: thinking }], settingsManager,
   resourceLoader: loader, sessionManager: manager,
   tools: [...tools], customTools }));
  if (new Set(session.getActiveToolNames()).size !== tools.length
   || tools.some(tool => !session!.getActiveToolNames().includes(tool))) throw new Error('Pi file tool allowlist changed');
  writeFileSync(join(runtime, 'effective-system-prompt.md'), session.systemPrompt);
  writeJsonAtomic(join(runtime, 'tool-definitions.json'), session.agent.state.tools.map(({ name, description }) => ({ name, description })));
  writeJsonAtomic(join(runtime, 'model-metadata.json'), { provider: model.provider, id: model.id, thinking, tools, executionMode });
  writeJsonAtomic(join(runtime, 'mounted-skills.json'), loader.getSkills());
  snapshotLogicalWorkspace({ ...sandbox.logicalWorkspace, sessionId: session.sessionId, sessionRole: 'root',
   stage: { kind: request.input.stage, key: request.input.key }, captureMoment: 'before-first-agent-turn' },
   join(runtime, 'logical-workspaces', 'root'));
  const active = session;
  const abort = () => { void active.abort(); };
  request.signal.addEventListener('abort', abort, { once: true });
  try {
   const result = await acceptPiFiles(async (text, repair) => {
    request.signal.throwIfAborted();
    await active.prompt(text, repair ? { expandPromptTemplates: false, streamingBehavior: 'followUp' } : undefined);
    request.signal.throwIfAborted();
    options.assertExternalInteractions?.();
    const last = [...active.messages].reverse().find(row => row.role === 'assistant');
    if (!last || last.stopReason === 'error') throw new Error(`model '${modelId}' failed: ${last?.errorMessage ?? 'no assistant response'}`);
    if (`${last.provider}/${last.model}` !== modelId) throw new Error('Pi file session returned a different model');
    // Validators may regenerate canonical projections; check the bytes the Agent read first.
    acceptedArtifactHash(runtime);
   }, () => {
    return options.validate(validationInput, work, runtime);
   }, user,
    (turn, error) => appendFileSync(join(runtime, 'validation-errors.jsonl'), `${JSON.stringify({ turn, error })}\n`), options.maxAttempts ?? 2);
   writeJsonAtomic(join(runtime, 'accepted-result.json'), result);
   const outcome: WikiStageOutcome = { result, usage: wikiStageTraceUsage(request.workRoot),
    sessionPaths: piSessionPaths(request.workRoot) };
   writeJsonAtomic(checkpoint, { identity, status: 'succeeded', attemptRoot,
    outputHash: wikiStageOutputHash(work), resultHash: sha256(readWikiStageOutput(join(runtime, 'accepted-result.json'))),
    artifactHash: acceptedArtifactHash(runtime), outcomeHash: hashJson(outcome), outcome });
   return outcome;
  } finally { request.signal.removeEventListener('abort', abort); }
 } catch (error) {
  const message = scrubResearchModelError(error);
  const usage = wikiStageTraceUsage(request.workRoot);
  const sessionPaths = piSessionPaths(request.workRoot);
  writeJsonAtomic(checkpoint, { identity, status: request.signal.aborted ? 'cancelled' : 'failed', attemptRoot, error: message, usage, sessionPaths });
  throw Object.assign(new Error(message), { usage, sessionPaths });
 } finally {
  try { session?.dispose(); }
  finally { await sandbox?.close(); }
 }
}
