import { existsSync, mkdirSync, mkdtempSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { primeModelDefinitions } from '../agent-runtime/prime-agent-paths.js';
import { listJsonl, writeJsonAtomic } from '../lib/fs.js';
import { hashJson, sha256 } from '../lib/hash.js';
import { toErrorMessage } from '../lib/values.js';
import { wikiPageEntryIds, type WikiPagesResult } from './wiki-page-contract.js';
import { wikiStageCapabilityIdentity, wikiStageOutputHash, wikiStageTraceUsage, readWikiStageOutput } from './wiki-stage.js';
import { runPiObjectTargetStage, runPiResidualCueStage } from './pi-object-stage.js';
import type { WikiStageInput, WikiStageOutcome, WikiStagePageInput, WikiStageRequest } from './wiki-stage-contract.js';

type Destination = { page: WikiStagePageInput['page']; origins: string[] };

/** Global identity planning, serial target writing, and deterministic acceptance. */
export async function runPiObjectMergeStage(request: WikiStageRequest,
 options: { target?: typeof runPiObjectTargetStage; residual?: typeof runPiResidualCueStage } = {}): Promise<WikiStageOutcome> {
 request.signal.throwIfAborted();
 if (request.input.stage !== 'merge-objects') throw new Error('Object merging expects merge-objects');
 mkdirSync(request.workRoot, { recursive: true });
 const identity = hashJson({ input: request.input, semantics: wikiStageCapabilityIdentity(), models: primeModelDefinitions(request.env) });
 const checkpoint = join(request.workRoot, 'checkpoint.json');
 const saved = existsSync(checkpoint) ? JSON.parse(readWikiStageOutput(checkpoint).toString('utf8')) : undefined;
 if (saved && saved.identity !== identity) throw new Error('Object merge input or execution contract changed across resume');
 if (saved?.status === 'succeeded') {
  if (saved.resultHash !== sha256(readWikiStageOutput(join(saved.attemptRoot, 'runtime/accepted-result.json')))
   || saved.outputHash !== outputsHash(saved.childRoots) || saved.outcomeHash !== hashJson(saved.outcome))
   throw new Error('Accepted object merge artifacts changed');
  return saved.outcome;
 }
 const attemptRoot = saved?.attemptRoot ?? realpathSync(mkdtempSync(join(request.workRoot, 'attempt-')));
 const runtime = join(attemptRoot, 'runtime');
 mkdirSync(runtime, { recursive: true });
 writeJsonAtomic(join(runtime, 'input.json'), request.input);
 writeJsonAtomic(checkpoint, { identity, status: 'running', attemptRoot });
 const childRoots: string[] = [];
 const target = options.target ?? runPiObjectTargetStage;
 const residual = options.residual ?? runPiResidualCueStage;
 const execute = async (input: WikiStageInput, key: string, phase: 'plan' | 'write' | 'residual') => {
  request.signal.throwIfAborted();
  const workRoot = join(attemptRoot, key);
  const child = { ...request, input, workRoot };
  const outcome = phase === 'residual' ? await residual(child) : await target(child, phase);
  request.signal.throwIfAborted();
  childRoots.push(workRoot);
  return outcome.result;
 };
 try {
  const members = request.input.pages.filter(row => row.role === 'member');
  const origins = new Map(members.map(row => [row.ref, [row.ref]]));
  let deferred: WikiPagesResult['deferred_entries'] = [];
  if (request.input.unplacedEntries?.length) {
   const input: WikiStageInput = { ...request.input, key: `${request.input.key}/resolve-cues`,
    pages: request.input.pages.map(row => ({ ...row, role: 'context' })),
    requiredEntries: request.input.unplacedEntries.map(row => row.entryId), requiredPages: [] };
   const resolved = await execute(input, 'resolve-cues', 'residual');
   if (resolved.kind !== 'pages' || resolved.value.retained_refs.length || resolved.value.discarded_refs.length)
    throw new Error('Cue resolution must only author objects or record explicit Cue dispositions');
   deferred = resolved.value.deferred_entries;
   for (const page of resolved.value.pages) {
    if (page.member_refs.length) throw new Error('Cue resolution cannot consume context pages');
    const { member_refs: _refs, ...object } = page;
    const ref = `resolved:${object.id}`;
    members.push({ ref, page: object, previous: false, role: 'member' }); origins.set(ref, []);
   }
  }
  const requiredEntries = [...new Set(members.flatMap(row => wikiPageEntryIds(row.page.body)))];
  const planningInput: WikiStageInput = { ...request.input, key: `${request.input.key}/plan`,
   pages: [...members, ...request.input.pages.filter(row => row.role === 'context')], requiredEntries, requiredPages: [], unplacedEntries: [] };
  const destinations: Destination[] = [];
  if (!members.some(row => !row.previous)) {
   destinations.push(...members.map(row => ({ page: row.page, origins: origins.get(row.ref)! })));
  } else {
   const plan = await execute(planningInput, 'plan', 'plan');
   if (plan.kind !== 'object-target-plan') throw new Error('Object merge expected a target plan');
   const byRef = new Map(members.map(row => [row.ref, row]));
   const assigned = new Set(plan.jobs.flatMap(job => job.pageRefs));
   destinations.push(...members.filter(row => row.previous && !assigned.has(row.ref))
    .map(row => ({ page: row.page, origins: origins.get(row.ref)! })));
   const names = new Map(planningInput.pages.map((row, index) => [`P${index + 1}`, row.page.title]));
   for (let index = 0; index < plan.jobs.length; index++) {
    const job = plan.jobs[index]!;
    const group = job.pageRefs.map(ref => {
     const row = byRef.get(ref);
     if (!row) throw new Error(`Object plan consumes an unknown member: ${ref}`);
     return row;
    });
    if (job.action === 'retain') {
     destinations.push(...group.map(row => ({ page: row.page, origins: origins.get(row.ref)! })));
     continue;
    }
    const incoming = group.filter(row => !row.previous);
    let previous = group.filter(row => row.previous);
    let anchor = job.targetRef;
    let merged: Destination | undefined, veto = false;
    for (let start = 0; start < incoming.length; start += 4) {
     const scoped = [...previous, ...incoming.slice(start, start + 4)];
     if (anchor) scoped.sort((left, right) => Number(right.ref === anchor) - Number(left.ref === anchor));
     const cueIds = new Set(scoped.flatMap(row => wikiPageEntryIds(row.page.body)));
     const input: WikiStageInput = { ...request.input, key: `${request.input.key}/write-${index + 1}-${start / 4 + 1}`,
      pages: scoped, entries: request.input.entries.filter(entry => cueIds.has(entry.id)), requiredEntries: [...cueIds],
      requiredPages: anchor ? [anchor] : [], unplacedEntries: [],
      instructions: job.reason.replace(/\bP[1-9]\d*\b/gu, ref => JSON.stringify(names.get(ref) ?? ref)) };
     const written = await execute(input, `write-${index + 1}-${start / 4 + 1}`, 'write');
     if (written.kind !== 'object-target-pages') throw new Error('Object merge expected target pages');
     if (!written.value.pages.length) { veto = true; break; }
     const { member_refs: _refs, ...page } = written.value.pages[0]!;
     const consumedOrigins = scoped.flatMap(row => origins.get(row.ref)!);
     merged = { page, origins: consumedOrigins };
     anchor = anchor ?? scoped[0]!.ref;
     origins.set(anchor, consumedOrigins);
     previous = [{ ref: anchor, page, previous: true, role: 'member' }];
    }
    if (veto) destinations.push(...group.map(row => ({ page: row.page,
     origins: request.input.pages.some(original => original.role === 'member' && original.ref === row.ref) ? [row.ref] : [] })));
    else if (merged) destinations.push(merged);
    else throw new Error('Object writing job has no incoming member');
   }
  }
  const value: WikiPagesResult = { pages: [], retained_refs: [], discarded_refs: [], deferred_entries: deferred, relations: [] };
  for (const row of destinations) {
   const old = row.origins.length === 1 ? request.input.pages.find(page => page.ref === row.origins[0]) : undefined;
   if (old && hashJson(old.page) === hashJson(row.page)) value.retained_refs.push(old.ref);
   else value.pages.push({ ...row.page, member_refs: row.origins });
  }
  validateObjectMergeResult(request.input, value);
  const outcome: WikiStageOutcome = { result: { kind: 'pages', value, consideredPages: [] },
   usage: wikiStageTraceUsage(attemptRoot), sessionPaths: sessionPaths(attemptRoot) };
  writeJsonAtomic(join(runtime, 'accepted-result.json'), outcome.result);
  writeJsonAtomic(checkpoint, { identity, status: 'succeeded', attemptRoot, childRoots, outcome,
   resultHash: sha256(readWikiStageOutput(join(runtime, 'accepted-result.json'))), outputHash: outputsHash(childRoots), outcomeHash: hashJson(outcome) });
  return outcome;
 } catch (error) {
  const usage = wikiStageTraceUsage(attemptRoot), paths = sessionPaths(attemptRoot);
  writeJsonAtomic(checkpoint, { identity, status: request.signal.aborted ? 'cancelled' : 'failed', attemptRoot,
   error: toErrorMessage(error), usage, sessionPaths: paths });
  throw Object.assign(error instanceof Error ? error : new Error(toErrorMessage(error)), { usage, sessionPaths: paths });
 }
}

export function validateObjectMergeResult(input: WikiStageInput, value: WikiPagesResult): void {
 const members = input.pages.filter(row => row.role === 'member');
 const consumed = [...value.retained_refs, ...value.pages.flatMap(page => page.member_refs)];
 if (new Set(consumed).size !== consumed.length || consumed.length !== members.length || consumed.some(ref => !members.some(row => row.ref === ref)))
  throw new Error('Object merge must account for every original member exactly once');
 const pages = [...value.pages, ...value.retained_refs.map(ref => members.find(row => row.ref === ref)!.page)];
 if (new Set(pages.map(page => page.id)).size !== pages.length
  || new Set(pages.map(page => page.title.normalize('NFKC').trim().toLocaleLowerCase())).size !== pages.length)
  throw new Error('Object merge produced duplicate identities or titles across targets');
 const known = new Set(input.entries.map(entry => entry.id)), cited = new Set(pages.flatMap(page => wikiPageEntryIds(page.body)));
 const deferred = new Set(value.deferred_entries.map(row => row.entry_ref));
 const historical = new Set(input.pages.filter(row => row.previous && row.page.kind === 'concept').flatMap(row => wikiPageEntryIds(row.page.body)));
 if (deferred.size !== value.deferred_entries.length || [...deferred].some(id => cited.has(id) || !input.requiredEntries.includes(id) || historical.has(id))
  || [...cited].some(id => !known.has(id)) || input.requiredEntries.some(id => !cited.has(id) && !deferred.has(id)))
  throw new Error('Object merge lost or conflicted with required Cue dispositions');
 for (const old of members.filter(row => row.previous)) {
  const destination = value.retained_refs.includes(old.ref) ? old.page : value.pages.find(page => page.member_refs.includes(old.ref));
  if (!destination || wikiPageEntryIds(old.page.body).some(id => !wikiPageEntryIds(destination.body).includes(id)))
   throw new Error(`Object merge lost previous citations: ${old.ref}`);
 }
}

function outputsHash(roots: string[]): string {
 return hashJson(roots.map(root => {
  const checkpoint = JSON.parse(readWikiStageOutput(join(root, 'checkpoint.json')).toString('utf8'));
  const output = wikiStageOutputHash(join(checkpoint.attemptRoot, 'work'));
  const result = sha256(readWikiStageOutput(join(checkpoint.attemptRoot, 'runtime/accepted-result.json')));
  if (checkpoint.status !== 'succeeded' || output !== checkpoint.outputHash || result !== checkpoint.resultHash
   || hashJson(checkpoint.outcome) !== checkpoint.outcomeHash) throw new Error('Accepted object merge child artifacts changed');
  return { root, output, result, outcome: checkpoint.outcomeHash };
 }));
}

function sessionPaths(root: string): string[] {
 return [...new Set(listJsonl(root).filter(path => path.includes('/sessions/')).map(path => path.slice(0, path.indexOf('/sessions/') + '/sessions'.length)))];
}
