import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import { createSrtAgentSandbox } from '../agent-runtime/srt-agent-sandbox.js';
import { primeAgentDir, primeModelDefinitions, removeStagedPrimeCredentials, stagePrimeAgentDirectory } from '../agent-runtime/prime-agent-paths.js';
import { renderAgentPrompt } from '../agent-runtime/prompt-registry.js';
import { scrubResearchModelError } from '../agent-runtime/models/error-classifier.js';
import { listJsonl, writeJsonAtomic } from '../lib/fs.js';
import { hashJson, sha256 } from '../lib/hash.js';
import { isRecord, toErrorMessage } from '../lib/values.js';
import { createNoteFirstWorkspace } from './note-first-workspace.js';
import { noteFirstOutputHash, noteFirstTraceUsage, readNoteFirstOutput } from './note-first-stage.js';
import type { NoteFirstInput, NoteFirstOutcome, NoteFirstResult, NoteFirstStageRequest } from './note-first-contract.js';
import { targetWriterContext, validateTargetWriter } from './pi-object-targets.js';

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

/** Bound new records per writer, while existing target reads stay unrestricted. */
export function piObjectMergeUserContext(input: NoteFirstInput): string {
 const incoming = input.pages.filter(row => !row.previous && row.role === 'member');
 if (input.stage !== 'merge-objects' || incoming.length < 1 || incoming.length > 4 || input.unplacedEntries?.length)
  throw new Error('Pi target writer expects 1 to 4 incoming pages and no unplaced Cues');
 const catalog = input.pages.map((row, index) =>
  `P${index + 1} | ${row.role === 'context' ? 'context' : row.previous ? 'existing' : 'incoming'} | ${row.page.kind} | ${row.page.title} | ${row.page.description} | wiki/indexes/P${index + 1}.json | wiki/pages/P${index + 1}.md`).join('\n');
 return `Output language: ${input.language}\nGoal: ${input.goal.title}\n${input.goal.description}\n\n## Complete current page catalog\n${catalog}\n\nRead each incoming page, compare it with this complete existing catalog, and read any existing pages needed to decide its destination. Existing-page reads have no count limit. Page indexes contain section headings and recorded relationships. All input files under /work/wiki are read-only; output goes under /work/pages and /work/result.json.\n${input.instructions}`;
}

/** Global object planning sees the entire catalog and may expand uncertain bodies. */
export function piObjectMergePlanUserContext(input: NoteFirstInput): string {
 if (input.stage !== 'merge-objects' || !input.pages.some(row => row.role === 'member' && !row.previous) || input.unplacedEntries?.length)
  throw new Error('Object target planning requires incoming members and no unplaced Cues');
 const catalog = input.pages.map((row, index) => ({ ref: `P${index + 1}`,
  status: row.role === 'context' ? 'context' : row.previous ? 'existing' : 'incoming',
  kind: row.page.kind, title: row.page.title, description: row.page.description,
  index: `wiki/indexes/P${index + 1}.json`, file: `wiki/pages/P${index + 1}.md` }));
 return JSON.stringify({ output_language: input.language, goal: input.goal, catalog });
}

export function piResidualCueUserContext(input: NoteFirstInput): string {
 const required = new Set(input.unplacedEntries?.map(row => row.entryId));
 if (input.stage !== 'merge-objects' || !required.size || input.pages.some(row => row.role !== 'context'))
  throw new Error('Residual Cue resolution expects unplaced Cues and context-only pages');
 const catalog = input.pages.map((row, index) => ({ ref: `P${index + 1}`, kind: row.page.kind,
  title: row.page.title, description: row.page.description, index: `wiki/indexes/P${index + 1}.json`, file: `wiki/pages/P${index + 1}.md` }));
 const cues = input.entries.flatMap((entry, index) => required.has(entry.id) ? [{ ref: `N${index + 1}`,
  source_title: entry.sourceTitle, section: entry.section, cue: entry.cue, detail: entry.detail }] : []);
 return JSON.stringify({ output_language: input.language, goal: input.goal, catalog, cues });
}

export function validatePiObjectMergePlanFiles(input: NoteFirstInput, work: string): NoteFirstResult {
 const output = JSON.parse(readNoteFirstOutput(join(work, 'result.json')).toString('utf8'));
 const exactFields = (value: unknown, keys: string[], field: string): Record<string, unknown> => {
  if (!isRecord(value) || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key)))
   throw new Error(`${field}: expected exactly [${keys.join(', ')}]`);
  return value;
 };
 exactFields(output, ['jobs'], 'output');
 if (!Array.isArray(output.jobs)) throw new Error('output.jobs: expected an array');
 const aliases = new Map(input.pages.map((row, index) => [`P${index + 1}`, row]));
 const assigned = new Map<string, string>();
 const violations: string[] = [];
 const jobs = output.jobs.map((value: unknown, index: number) => {
  const field = `output.jobs[${index}]`;
  const row = exactFields(value, ['action', 'target_ref', 'page_refs', 'reason'], field);
  if (!Array.isArray(row.page_refs) || !row.page_refs.length || typeof row.reason !== 'string' || !row.reason.trim())
   throw new Error(`${field}: requires nonempty page_refs and a specific reason`);
  let incoming = 0;
  const pageRefs = row.page_refs.map((ref: unknown, memberIndex: number) => {
   if (typeof ref !== 'string' || !aliases.has(ref) || aliases.get(ref)!.role !== 'member')
    throw new Error(`${field}.page_refs[${memberIndex}]: unknown or context-only member ${String(ref)}`);
   if (assigned.has(ref)) violations.push(`${field}.page_refs[${memberIndex}]: ${ref} is also assigned to ${assigned.get(ref)}; combine overlapping candidate groups into one job`);
   assigned.set(ref, `${field}.page_refs[${memberIndex}]`);
   const member = aliases.get(ref)!;
   if (!member.previous) incoming++;
   return member.ref;
  });
  if (!incoming) violations.push(`${field}: each job requires an incoming member; existing-only jobs are not allowed`);
  {
   if (!['update', 'new', 'retain'].includes(String(row.action))) throw new Error(`${field}.action: expected update, new or retain`);
   const previous = row.page_refs.filter(ref => aliases.get(String(ref))!.previous);
   if (row.action === 'update') {
    if (typeof row.target_ref !== 'string' || !previous.includes(row.target_ref))
     throw new Error(`${field}.target_ref: update requires an existing member of this group`);
   } else if (row.target_ref !== null || previous.length || (row.action === 'retain' && pageRefs.length !== 1))
    throw new Error(`${field}: new/retain requires a null target and incoming members only; retain requires one page`);
   return { action: row.action as 'update' | 'new' | 'retain', targetRef: row.target_ref === null ? null : aliases.get(String(row.target_ref))!.ref, pageRefs, reason: row.reason.trim() };
  }
 });
 const missing = [...aliases].filter(([ref, row]) => row.role === 'member' && !row.previous && !assigned.has(ref)).map(([ref]) => ref);
 if (missing.length) violations.push(`output.jobs: every incoming page requires one decision; missing: [${missing.join(', ')}]`);
 if (violations.length) throw new Error(violations.join('\n'));
 return { kind: 'object-target-plan', jobs };
}

/** Count only complete lines actually returned by Pi read, including offset/limit continuations. */
export function observePiMergeRead(inputRoot: string, reads: Map<string, Set<number>>,
 parameters: { path: string; offset?: number; limit?: number }, result: { content: Array<{ type: string; text?: string }> }): void {
 const path = posix.resolve('/work', parameters.path);
 const match = /^\/work\/wiki\/pages\/(P\d+)\.md$/u.exec(path);
 if (!match) return;
 const ref = match[1]!;
 const lines = readFileSync(join(inputRoot, 'pages', `${ref}.md`), 'utf8').split('\n');
 const visible = result.content.filter(block => block.type === 'text').map(block => block.text ?? '').join('\n').split('\n');
 const start = Math.max(0, (parameters.offset ?? 1) - 1);
 const read = reads.get(ref) ?? new Set<number>();
 const count = Math.min(visible.length, parameters.limit ?? lines.length, lines.length - start);
 for (let index = 0; index < count && visible[index] === lines[start + index]; index++) read.add(start + index);
 reads.set(ref, read);
}

export function validatePiObjectMergeFiles(input: NoteFirstInput, inputRoot: string, work: string, reads: Map<string, Set<number>>, residual = false) {
 const workspace = createNoteFirstWorkspace(input, inputRoot);
 // Residual Cue details are supplied in full in the user prompt.
 if (residual) input.entries.forEach((entry, index) => { if (input.unplacedEntries?.some(row => row.entryId === entry.id)) workspace.read(`N${index + 1}`); });
 const incoming = input.pages.flatMap((row, index) => !row.previous && row.role === 'member' ? [`P${index + 1}`] : []);
 for (const [ref, lines] of reads) {
  if (lines.size !== readFileSync(join(inputRoot, 'pages', `${ref}.md`), 'utf8').split('\n').length) continue;
  workspace.read(ref);
  // Large pages are represented by complete sections in the shared validator.
  if (!workspace.receipts().pages.includes(ref)) for (const section of workspace.overviews[ref]!.sections) workspace.read(section.section_ref);
 }
 for (const ref of incoming) {
  const total = readFileSync(join(inputRoot, 'pages', `${ref}.md`), 'utf8').split('\n').length;
  if (reads.get(ref)?.size !== total) throw new Error(`Read the complete incoming page ${ref} before deciding its placement`);
 }
 const manifest = JSON.parse(readNoteFirstOutput(join(work, 'result.json')).toString('utf8'));
 // Incremental output is a patch: untouched existing members survive without model bookkeeping.
 if (isRecord(manifest) && Array.isArray(manifest.pages) && Array.isArray(manifest.retained_refs) && Array.isArray(manifest.discarded_refs)) {
  const mentioned = new Set([...manifest.retained_refs,
   ...manifest.pages.flatMap(row => isRecord(row) && Array.isArray(row.member_refs) ? row.member_refs : []),
   ...manifest.discarded_refs.map(row => isRecord(row) ? row.ref : undefined)]);
  input.pages.forEach((row, index) => {
   const ref = `P${index + 1}`;
   if (row.previous && row.role === 'member' && !mentioned.has(ref)) (manifest.retained_refs as unknown[]).push(ref);
  });
 }
 const result = workspace.validate(manifest, work, { incrementalMerge: !residual });
 if (result.kind !== 'pages') throw new Error('Pi object merge must produce pages');
 return { result, receipts: workspace.receipts(), completePageReads: [...reads].filter(([ref, lines]) =>
  lines.size === readFileSync(join(inputRoot, 'pages', `${ref}.md`), 'utf8').split('\n').length).map(([ref]) => ref) };
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
 initialPrompt: string, onRejected: (turn: number, error: string) => void, maxAttempts = 2,
): Promise<NoteFirstResult> {
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

/** The caller keeps the existing four-slot Note queue. */
export async function runPiObjectStage(request: NoteFirstStageRequest): Promise<NoteFirstOutcome> {
 return runPiFileStage(request);
}

export async function runPiConceptPlanStage(request: NoteFirstStageRequest): Promise<NoteFirstOutcome> {
 return runPiFileStage(request);
}

export async function runPiObjectTargetStage(request: NoteFirstStageRequest, phase: 'plan' | 'write'): Promise<NoteFirstOutcome> {
 if (request.input.stage !== 'merge-objects') throw new Error('Object target stages expect merge-objects');
 return runPiFileStage(request, phase === 'plan' ? 'target-plan' : 'target-write');
}

export async function runPiResidualCueStage(request: NoteFirstStageRequest): Promise<NoteFirstOutcome> {
 return runPiFileStage(request, 'residual');
}

async function runPiFileStage(request: NoteFirstStageRequest, mode: 'default' | 'target-plan' | 'target-write' | 'residual' = 'default'): Promise<NoteFirstOutcome> {
 request.signal.throwIfAborted();
 mkdirSync(request.workRoot, { recursive: true });
 const planning = request.input.stage === 'plan-concepts';
 const mergePlanning = mode === 'target-plan';
 const targetWriting = mode === 'target-write', residual = mode === 'residual';
 const merging = request.input.stage === 'merge-objects' && !mergePlanning ;
 if (!planning && !merging && !mergePlanning  && request.input.stage !== 'objects') throw new Error('Unsupported Pi file stage');
 const modelId = planning || mergePlanning ? PI_CONCEPT_PLAN_MODEL : PI_OBJECT_MODEL;
 const variant = mode === 'target-plan' ? 'plan-object-targets-pi' : targetWriting ? 'write-object-target-pi' : residual ? 'resolve-object-cues-pi'
  : planning ? 'plan-concepts-pi' : 'objects-pi';
 const prompt = renderAgentPrompt('wiki', 'note-first', 'system', {}, variant);
 const inputRoot = join(request.workRoot, 'input-check');
 const user = targetWriting ? `${piObjectMergeUserContext(request.input)}\n\n${targetWriterContext(request.input)}` : residual ? piResidualCueUserContext(request.input)
  : planning ? piConceptPlanUserContext(request.input) : mergePlanning ? piObjectMergePlanUserContext(request.input)
  : merging ? piObjectMergeUserContext(request.input) : piObjectUserContext(request.input, inputRoot);
 const systemPrompt = prompt.content;
 const identity = hashJson({ input: request.input, user, systemPrompt, registration: prompt.configSha256,
  model: modelId, thinking, tools, definitions: primeModelDefinitions(request.env),
  code: ['./pi-object-stage.ts', './pi-object-targets.ts', './note-first-stage.ts', './note-first-workspace.ts', '../agent-runtime/srt-agent-sandbox.ts',
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
 if (merging || mode === 'target-plan') createNoteFirstWorkspace(request.input, validationInput);
 const mergeReads = new Map<string, Set<number>>();
 writeJsonAtomic(join(runtime, 'input.json'), request.input);
 const executionMode = mode.startsWith('target-') ? `pi-object-${mode}` : mergePlanning ? 'pi-object-merge-planner' : 'pi-file-agent';
 writeJsonAtomic(join(runtime, 'agent-context.json'), { user, executionMode });
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
   readonlyMounts: planning ? [{ hostPath: join(validationInput, 'articles'), guestPath: '/work/articles', access: 'read-only' }]
    : merging || mode === 'target-plan' ? [{ hostPath: validationInput, guestPath: '/work/wiki', access: 'read-only' }] : [],
   activeTools: tools, network: 'deny' });
  const settingsManager = SettingsManager.inMemory();
  const loader = new DefaultResourceLoader({ cwd: work, agentDir: agentDirectory, settingsManager,
   systemPrompt, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
  await loader.reload();
  const customTools = sandbox.toolDefinitions.map(tool => !merging || tool.name !== 'read' ? tool : {
   ...tool, async execute(...args: Parameters<typeof tool.execute>) {
    const result = await tool.execute(...args);
    observePiMergeRead(validationInput, mergeReads, args[1] as { path: string; offset?: number; limit?: number }, result);
    return result;
   },
  });
  ({ session } = await createAgentSession({ cwd: work, agentDir: agentDirectory, modelRuntime, model,
   thinkingLevel: thinking, scopedModels: [{ model, thinkingLevel: thinking }], settingsManager,
   resourceLoader: loader, sessionManager: SessionManager.create(work, sessions),
   tools: [...tools], customTools }));
  if (new Set(session.getActiveToolNames()).size !== tools.length
   || tools.some(tool => !session!.getActiveToolNames().includes(tool))) throw new Error('Pi file tool allowlist changed');
  writeFileSync(join(runtime, 'effective-system-prompt.md'), session.systemPrompt);
  writeJsonAtomic(join(runtime, 'tool-definitions.json'), sandbox.toolDefinitions.map(({ name, description }) => ({ name, description })));
  writeJsonAtomic(join(runtime, 'model-metadata.json'), { provider: model.provider, id: model.id, thinking, tools, executionMode });
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
   }, () => {
    if (mergePlanning) return validatePiObjectMergePlanFiles(request.input, work);

    if (merging) {
     const accepted = validatePiObjectMergeFiles(request.input, validationInput, work, mergeReads, residual);
     writeJsonAtomic(join(runtime, 'receipts.json'), accepted.receipts);
     writeJsonAtomic(join(runtime, 'complete-page-reads.json'), accepted.completePageReads);
     return targetWriting ? validateTargetWriter(request.input, work, accepted) : accepted.result;
    }
    return planning ? validatePiConceptPlanFiles(request.input, validationInput, work)
     : validatePiObjectFiles(request.input, validationInput, work);
   }, user,
    (turn, error) => appendFileSync(join(runtime, 'validation-errors.jsonl'), `${JSON.stringify({ turn, error })}\n`), merging || mergePlanning ? 3 : 2);
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
