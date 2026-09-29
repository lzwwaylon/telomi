import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import { createSrtAgentSandbox } from '../agent-runtime/srt-agent-sandbox.js';
import { primeAgentDir, primeModelDefinitions, removeStagedPrimeCredentials, stagePrimeAgentDirectory } from '../agent-runtime/prime-agent-paths.js';
import { renderAgentPrompt } from '../agent-runtime/prompt-registry.js';
import { scrubResearchModelError } from '../agent-runtime/models/error-classifier.js';
import { listJsonl, writeJsonAtomic } from '../lib/fs.js';
import { hashJson, sha256 } from '../lib/hash.js';
import { toErrorMessage } from '../lib/values.js';
import { createNoteFirstWorkspace } from './note-first-workspace.js';
import { noteFirstOutputHash, noteFirstTraceUsage, readNoteFirstOutput } from './note-first-stage.js';
import type { NoteFirstInput, NoteFirstOutcome, NoteFirstResult, NoteFirstStageRequest } from './note-first-contract.js';

export const PI_OBJECT_MODEL = 'openai-codex/gpt-6-luna';
export const PI_CONCEPT_PLAN_MODEL = 'openai-codex/gpt-5.6-terra';
const thinking = 'medium';
const tools = ['read', 'write', 'edit'] as const;

export function piObjectUserContext(input: NoteFirstInput, inputRoot: string): string {
 if (input.stage !== 'objects' || input.pages.length || input.entries.length !== input.requiredEntries.length
  || new Set(input.entries.map(entry => entry.sourceId)).size !== 1) throw new Error('Pi object task expects one complete Note');
 createNoteFirstWorkspace(input, inputRoot);
 const user = JSON.stringify({ output_language: input.language, goal: input.goal,
  entries: input.entries.map((entry, index) => ({ ref: `N${index + 1}`, source_title: entry.sourceTitle,
   section: entry.section, section_summary: entry.sectionSummary ?? '', cue: entry.cue, detail: entry.detail })) });
 if (user.length > 60_000) throw new Error('Pi object Note exceeds input limit');
 return user;
}

/** Keep Topic, Cue and persistent identities out of the planner's visible catalog. */
export function piConceptPlanUserContext(input: NoteFirstInput): string {
 if (input.stage !== 'plan-concepts') throw new Error('Pi concept planner expects plan-concepts');
 const required = new Set(input.requiredPages);
 const catalog = input.pages.map((row, index) =>
  `P${index + 1} | ${required.has(row.ref) ? 'assign' : 'context'} | ${row.page.kind} | ${row.page.title} | ${row.page.description} | articles/P${index + 1}.md`).join('\n');
 return `Plan concept-writing worksets for this Wiki.\nOutput language: ${input.language}\nGoal: ${input.goal.title}${input.goal.description ? ` - ${input.goal.description}` : ''}\nAssign every article marked assign to exactly one workset of 1 to 8 primary articles. Context articles are available for comparison but are not assigned. Give each workset a concrete shared research question, useful comparisons and factual boundaries. Read an article when the catalog does not settle its placement. Write result.json with exactly {"jobs":[{"page_refs":["P1"],"instructions":"..."}]}.\n\n## Article catalog\n${catalog}`;
}

/** Mount these projected articles read-only; the original Wiki input stays Runtime-private. */
export function stagePiConceptPlanArticles(input: NoteFirstInput, inputRoot: string): void {
 createNoteFirstWorkspace(input, inputRoot);
 const articles = join(inputRoot, 'articles');
 mkdirSync(articles, { recursive: true });
 for (let index = 0; index < input.pages.length; index++) {
  const ref = `P${index + 1}`;
  const overview = JSON.parse(readFileSync(join(inputRoot, 'indexes', `${ref}.json`), 'utf8')) as { sections: Array<{ section_ref: string; heading: string }> };
  let section = 0;
  const body = readFileSync(join(inputRoot, 'pages', `${ref}.md`), 'utf8')
   .replace(/^## (.+)$/gm, (_whole, heading: string) => {
    const current = overview.sections[section++];
    if (!current || current.heading !== heading) throw new Error(`Section projection changed for ${ref}`);
    return `## ${current.section_ref} · ${heading}`;
   }).replace(/[ \t]*\[\[N\d+\]\]/g, '');
  if (section !== overview.sections.length) throw new Error(`Section projection incomplete for ${ref}`);
  writeFileSync(join(articles, `${ref}.md`), body);
 }
}

/** The Note is already in the user prompt, so Runtime records those Cues as read before validation. */
export function validatePiObjectFiles(input: NoteFirstInput, inputRoot: string, workRoot: string): NoteFirstResult {
 const workspace = createNoteFirstWorkspace(input, inputRoot);
 for (let index = 0; index < input.entries.length; index++) workspace.read(`N${index + 1}`);
 const path = join(workRoot, 'result.json');
 if (!existsSync(path)) throw new Error('output.result.json: required file is missing');
 let manifest: unknown;
 try { manifest = JSON.parse(readNoteFirstOutput(path).toString('utf8')); }
 catch (error) { throw new Error(`output.result.json: ${toErrorMessage(error)}`); }
 return workspace.validate(manifest, workRoot);
}

export function validatePiConceptPlanFiles(input: NoteFirstInput, inputRoot: string, workRoot: string): NoteFirstResult {
 const workspace = createNoteFirstWorkspace(input, inputRoot);
 const path = join(workRoot, 'result.json');
 if (!existsSync(path)) throw new Error('output.result.json: required file is missing');
 let manifest: unknown;
 try { manifest = JSON.parse(readNoteFirstOutput(path).toString('utf8')); }
 catch (error) { throw new Error(`output.result.json: ${toErrorMessage(error)}`); }
 return workspace.validate(manifest, workRoot);
}

export async function acceptPiObjectFiles(
 promptTurn: (prompt: string, repair: boolean) => Promise<void>, validate: () => NoteFirstResult,
 initialPrompt: string, onRejected: (turn: number, error: string) => void,
): Promise<NoteFirstResult> {
 let lastError = '';
 for (let turn = 0; turn < 2; turn++) {
  await promptTurn(turn === 0 ? initialPrompt
   : `Runtime rejected your files. Fix the named file or field and preserve all valid content. Exact validation feedback: ${lastError}`, turn > 0);
  try { return validate(); }
  catch (error) {
   lastError = toErrorMessage(error);
   onRejected(turn + 1, lastError);
  }
 }
 throw new Error(`Pi object files remain invalid after one repair: ${lastError}`);
}

/** The caller keeps the existing four-slot Note queue. */
export async function runPiObjectStage(request: NoteFirstStageRequest): Promise<NoteFirstOutcome> {
 return runPiFileStage(request);
}

export async function runPiConceptPlanStage(request: NoteFirstStageRequest): Promise<NoteFirstOutcome> {
 return runPiFileStage(request);
}

async function runPiFileStage(request: NoteFirstStageRequest): Promise<NoteFirstOutcome> {
 request.signal.throwIfAborted();
 mkdirSync(request.workRoot, { recursive: true });
 const planning = request.input.stage === 'plan-concepts';
 if (!planning && request.input.stage !== 'objects') throw new Error('Pi file stage supports objects and plan-concepts');
 const modelId = planning ? PI_CONCEPT_PLAN_MODEL : PI_OBJECT_MODEL;
 const prompt = renderAgentPrompt('wiki', 'note-first', 'system', {}, planning ? 'plan-concepts-pi' : 'objects-pi');
 const inputRoot = join(request.workRoot, 'input-check');
 const user = planning ? piConceptPlanUserContext(request.input) : piObjectUserContext(request.input, inputRoot);
 const systemPrompt = prompt.content;
 const identity = hashJson({ input: request.input, user, systemPrompt, registration: prompt.configSha256,
  model: modelId, thinking, tools, definitions: primeModelDefinitions(request.env),
  code: ['./pi-object-stage.ts', './note-first-workspace.ts', '../agent-runtime/srt-agent-sandbox.ts',
   '../../../extensions/telomi-srt/sandbox-spec.ts', '../../../extensions/telomi-srt/tool-operations.ts']
   .map(file => sha256(readFileSync(fileURLToPath(new URL(file, import.meta.url))))) });
 const checkpoint = join(request.workRoot, 'checkpoint.json');
 if (existsSync(checkpoint)) {
  const saved = JSON.parse(readNoteFirstOutput(checkpoint).toString('utf8'));
  if (saved.identity !== identity) throw new Error('Pi file stage input or execution contract changed across resume');
  if (saved.status === 'succeeded') {
   if (saved.outputHash !== noteFirstOutputHash(join(saved.attemptRoot, 'work'))
    || saved.resultHash !== sha256(readNoteFirstOutput(join(saved.attemptRoot, 'runtime/accepted-result.json')))
   || saved.outcomeHash !== hashJson(saved.outcome)) throw new Error('Accepted Pi file output changed');
   request.onAttemptStarted?.(saved.attemptRoot);
   return saved.outcome as NoteFirstOutcome;
  }
 }
 const attemptRoot = realpathSync(mkdtempSync(join(request.workRoot, 'attempt-')));
 const runtime = join(attemptRoot, 'runtime'), work = join(attemptRoot, 'work');
 const sessions = join(runtime, 'sessions'), validationInput = join(attemptRoot, 'input');
 const agentDirectory = join(runtime, 'agent');
 for (const directory of [runtime, work, sessions, validationInput]) mkdirSync(directory, { recursive: true });
 if (planning) stagePiConceptPlanArticles(request.input, validationInput);
 writeJsonAtomic(join(runtime, 'input.json'), request.input);
 writeJsonAtomic(join(runtime, 'agent-context.json'), { user, executionMode: 'pi-file-agent' });
 writeFileSync(join(runtime, 'user-prompt.md'), user);
 writeJsonAtomic(checkpoint, { identity, status: 'running', attemptRoot });
 request.onAttemptStarted?.(attemptRoot);
 let session: Awaited<ReturnType<typeof createAgentSession>>['session'] | undefined;
 let sandbox: ReturnType<typeof createSrtAgentSandbox> | undefined;
 try {
  stagePrimeAgentDirectory(agentDirectory, request.env);
  const modelRuntime = await ModelRuntime.create({ authPath: join(primeAgentDir(request.env), 'auth.json'),
   modelsPath: join(agentDirectory, 'models.json'), allowModelNetwork: false });
  const model = modelRuntime.getModel('openai-codex', modelId.split('/')[1]!);
  if (!model || !modelRuntime.hasConfiguredAuth(model.provider)) throw new Error(`Pi model is unavailable: ${modelId}`);
  sandbox = createSrtAgentSandbox({ id: request.input.key, role: 'wiki.object_builder', workDirectory: work,
   readonlyMounts: planning ? [{ hostPath: join(validationInput, 'articles'), guestPath: '/work/articles', access: 'read-only' }] : [],
   activeTools: tools, network: 'deny' });
  const settingsManager = SettingsManager.inMemory();
  const loader = new DefaultResourceLoader({ cwd: work, agentDir: agentDirectory, settingsManager,
   systemPrompt, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
  await loader.reload();
  ({ session } = await createAgentSession({ cwd: work, agentDir: agentDirectory, modelRuntime, model,
   thinkingLevel: thinking, scopedModels: [{ model, thinkingLevel: thinking }], settingsManager,
   resourceLoader: loader, sessionManager: SessionManager.create(work, sessions),
   tools: [...tools], customTools: sandbox.toolDefinitions }));
  if (new Set(session.getActiveToolNames()).size !== tools.length
   || tools.some(tool => !session!.getActiveToolNames().includes(tool))) throw new Error('Pi file tool allowlist changed');
  writeFileSync(join(runtime, 'effective-system-prompt.md'), session.systemPrompt);
  writeJsonAtomic(join(runtime, 'tool-definitions.json'), sandbox.toolDefinitions.map(({ name, description }) => ({ name, description })));
  writeJsonAtomic(join(runtime, 'model-metadata.json'), { provider: model.provider, id: model.id, thinking, tools, executionMode: 'pi-file-agent' });
  const active = session;
  const abort = () => { void active.abort(); };
  request.signal.addEventListener('abort', abort, { once: true });
  try {
   const result = await acceptPiObjectFiles(async (text, repair) => {
    request.signal.throwIfAborted();
    await active.prompt(text, repair ? { expandPromptTemplates: false, streamingBehavior: 'followUp' } : undefined);
    request.signal.throwIfAborted();
    const last = [...active.messages].reverse().find(row => row.role === 'assistant');
    if (!last || last.stopReason === 'error') throw new Error(`model '${modelId}' failed: ${last?.errorMessage ?? 'no assistant response'}`);
    if (`${last.provider}/${last.model}` !== modelId) throw new Error('Pi file session returned a different model');
   }, () => planning ? validatePiConceptPlanFiles(request.input, validationInput, work)
    : validatePiObjectFiles(request.input, validationInput, work), user,
    (turn, error) => appendFileSync(join(runtime, 'validation-errors.jsonl'), `${JSON.stringify({ turn, error })}\n`));
   writeJsonAtomic(join(runtime, 'accepted-result.json'), result);
   const outcome: NoteFirstOutcome = { result, usage: noteFirstTraceUsage(request.workRoot),
    sessionPaths: [...new Set(listJsonl(sessions).map(path => path.slice(0, path.indexOf('/sessions/') + '/sessions'.length)))] };
   writeJsonAtomic(checkpoint, { identity, status: 'succeeded', attemptRoot,
    outputHash: noteFirstOutputHash(work), resultHash: sha256(readNoteFirstOutput(join(runtime, 'accepted-result.json'))),
    outcomeHash: hashJson(outcome), outcome });
   return outcome;
  } finally { request.signal.removeEventListener('abort', abort); }
 } catch (error) {
  const message = scrubResearchModelError(error);
  const usage = noteFirstTraceUsage(request.workRoot);
  writeJsonAtomic(checkpoint, { identity, status: request.signal.aborted ? 'cancelled' : 'failed', attemptRoot, error: message, usage });
  throw Object.assign(new Error(message), { usage });
 } finally {
  session?.dispose();
  await sandbox?.close();
  removeStagedPrimeCredentials(agentDirectory);
 }
}
