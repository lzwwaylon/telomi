import { existsSync, readFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { writeJsonAtomic } from '../lib/fs.js';
import { isRecord, toErrorMessage } from '../lib/values.js';
import { createNoteFirstWorkspace } from './note-first-workspace.js';
import { readNoteFirstOutput } from './note-first-stage.js';
import type { NoteFirstInput, NoteFirstOutcome, NoteFirstResult, NoteFirstStageRequest } from './note-first-contract.js';
import { objectFirstEntries } from './object-first-contract.js';
import { targetWriterContext, validateTargetWriter } from './pi-object-targets.js';
import { runPiFileStage } from './pi-file-stage.js';

export const PI_OBJECT_MODEL = 'openai-codex/gpt-6-luna';
export const PI_OBJECT_PLAN_MODEL = 'openai-codex/gpt-5.6-terra';
export { acceptPiFiles as acceptPiObjectFiles } from './pi-file-stage.js';

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
 return `Output language: ${input.language}\nGoal: ${input.goal.title}\n${input.goal.description}\n\n## Complete current page catalog\n${catalog}\n\nRead each incoming page, compare it with this complete existing catalog, and read any existing pages needed to decide its destination. Existing-page reads have no count limit.\n\n## File access\nOpen the listed P index and page paths under /work. Each page index provides file, sections and cue_files. Index file paths are relative to /work/wiki. S references identify sections of that page: start_line/end_line are inclusive native read coordinates in its file, and entry_refs lists its N citations. N references identify Cues: a non-null cue_files value is an available detail file; null means this stage supplies only the page's inline citation, so use that page's text. Read complete assigned page files before writing; section ranges locate passages and do not replace complete-page reads. All input files under /work/wiki are read-only; output goes under /work/pages and /work/result.json.\n${input.instructions}`;
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
 const catalog = input.pages.map((row, index) => ({ ref: `P${index + 1}`, status: 'context_only', kind: row.page.kind,
  title: row.page.title, description: row.page.description, index: `wiki/indexes/P${index + 1}.json`, file: `wiki/pages/P${index + 1}.md` }));
 const cues = input.entries.flatMap((entry, index) => required.has(entry.id) ? [{ ref: `N${index + 1}`,
  source_title: entry.sourceTitle, section: entry.section, cue: entry.cue, detail: entry.detail,
  historical_concept_refs: input.pages.flatMap((row, pageIndex) => row.previous && row.page.kind === 'concept'
   && objectFirstEntries(row.page.body).includes(entry.id) ? [`P${pageIndex + 1}`] : []) }] : []);
 return JSON.stringify({ output_language: input.language, goal: input.goal, catalog,
  required_object_adoption_refs: cues.filter(cue => cue.historical_concept_refs.length).map(cue => cue.ref), cues });
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
 const result = workspace.validate(manifest, work, { incrementalMerge: !residual, inputRoot: 'wiki' });
 if (result.kind !== 'pages') throw new Error('Pi object merge must produce pages');
 return { result, receipts: workspace.receipts(), completePageReads: [...reads].filter(([ref, lines]) =>
  lines.size === readFileSync(join(inputRoot, 'pages', `${ref}.md`), 'utf8').split('\n').length).map(([ref]) => ref) };
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

/** The caller keeps the existing four-slot Note queue. */
export async function runPiObjectStage(request: NoteFirstStageRequest): Promise<NoteFirstOutcome> {
 return runPiObjectFileStage(request);
}

export async function runPiObjectTargetStage(request: NoteFirstStageRequest, phase: 'plan' | 'write'): Promise<NoteFirstOutcome> {
 if (request.input.stage !== 'merge-objects') throw new Error('Object target stages expect merge-objects');
 return runPiObjectFileStage(request, phase === 'plan' ? 'target-plan' : 'target-write');
}

export async function runPiResidualCueStage(request: NoteFirstStageRequest): Promise<NoteFirstOutcome> {
 return runPiObjectFileStage(request, 'residual');
}

async function runPiObjectFileStage(request: NoteFirstStageRequest, mode: 'default' | 'target-plan' | 'target-write' | 'residual' = 'default'): Promise<NoteFirstOutcome> {
 const mergePlanning = mode === 'target-plan';
 const targetWriting = mode === 'target-write', residual = mode === 'residual';
 const merging = request.input.stage === 'merge-objects' && !mergePlanning;
 if (!merging && !mergePlanning && request.input.stage !== 'objects') throw new Error('Unsupported Pi object stage');
 const user = targetWriting ? `${piObjectMergeUserContext(request.input)}\n\n${targetWriterContext(request.input)}`
  : residual ? piResidualCueUserContext(request.input) : mergePlanning ? piObjectMergePlanUserContext(request.input)
  : merging ? piObjectMergeUserContext(request.input) : piObjectUserContext(request.input, join(request.workRoot, 'input-check'));
 const mergeReads = new Map<string, Set<number>>();
 return runPiFileStage(request, {
  modelId: mergePlanning ? PI_OBJECT_PLAN_MODEL : PI_OBJECT_MODEL,
  promptVariant: mergePlanning ? 'plan-object-targets-pi' : targetWriting ? 'write-object-target-pi'
   : residual ? 'resolve-object-cues-pi' : 'objects-pi',
  user, role: 'wiki.object_builder',
  grepRoot: mergePlanning || residual ? '/work/wiki/pages' : undefined,
  executionMode: mode.startsWith('target-') ? `pi-object-${mode}` : 'pi-file-agent',
  codeFiles: ['./pi-object-stage.ts', './pi-object-targets.ts'],
  prepare(inputRoot) { if (merging || mergePlanning) createNoteFirstWorkspace(request.input, inputRoot); },
  readonlyMounts(inputRoot) {
   return merging || mergePlanning ? [{ hostPath: inputRoot, guestPath: '/work/wiki', access: 'read-only' }] : [];
  },
  observeRead: merging ? (inputRoot, _runtime, parameters, result) => observePiMergeRead(inputRoot, mergeReads, parameters, result) : undefined,
  validate(inputRoot, work, runtime) {
   if (mergePlanning) return validatePiObjectMergePlanFiles(request.input, work);
   if (merging) {
    const accepted = validatePiObjectMergeFiles(request.input, inputRoot, work, mergeReads, residual);
    writeJsonAtomic(join(runtime, 'receipts.json'), accepted.receipts);
    writeJsonAtomic(join(runtime, 'complete-page-reads.json'), accepted.completePageReads);
    return targetWriting ? validateTargetWriter(request.input, work, accepted) : accepted.result;
   }
   return validatePiObjectFiles(request.input, inputRoot, work);
  },
  maxAttempts: merging || mergePlanning ? 3 : 2,
 });
}
