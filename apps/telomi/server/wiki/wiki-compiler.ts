/** Note-scoped Wiki construction with Runtime-owned evidence and navigation. */
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RunArtifactStore } from "../agent-runtime/artifact-store.js";
import type { ResearchModelUsage } from "../agent-runtime/model-usage.js";
import { validateCornellNotesSnapshot } from "../cornell/contracts.js";
import { hashJson } from "../lib/hash.js";
import { writeJsonAtomic } from "../lib/fs.js";
import { toErrorMessage } from "../lib/values.js";
import { mapConcurrentFairly } from "../lib/fair-concurrency.js";
import { pinWikiModelSelection, projectWikiEvidence, sessionTraceRef } from "./compilation-runtime.js";
import { requireWikiGoalContext, validateGoalTopicPlan, wikiLanguage, type WikiCompilationRequest, type WikiCompilationResult,
 type WikiCompilationBatchFailure, type GoalTopicPlan, type WikiGoalContext } from "./contracts.js";
import { hashWikiDirectory } from "./files.js";
import { noteWikiEntries } from "./note-entries.js";
import { wikiPageEntryIds, wikiPageSections, type WikiPageContent, type WikiPagesResult, type WikiPageSection, type WikiTopicResult } from "./wiki-page-contract.js";
import { readPreviousWikiEdition, writeWikiEdition, writeWikiIndex, type PreviousWikiEdition } from "./wiki-edition.js";
import { wikiStageCapabilityIdentity, runWikiStageKind } from "./wiki-stage.js";
import type { WikiStageInput, WikiStageOutcome, WikiStagePageInput, WikiStageResult, WikiStageRequest } from "./wiki-stage-contract.js";
export type { WikiStageRequest } from "./wiki-stage-contract.js";

const zero = (): ResearchModelUsage => ({ inputTokens: 0, outputTokens: 0, costUsd: 0, calls: 0 });
const empty = (): WikiPagesResult => ({ pages: [], retained_refs: [], discarded_refs: [], deferred_entries: [], relations: [] });
const codeIdentity = () => hashJson({ stages: wikiStageCapabilityIdentity(), compiler:
 ['./wiki-compiler.ts', './wiki-page-contract.ts', './wiki-edition.ts', '../lib/fair-concurrency.ts']
 .map(path => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8')) });
const cited = (pages: WikiPageContent[]) => new Set(pages.flatMap(page => wikiPageEntryIds(page.body)));
const sumUsage = (outcomes: Array<Pick<WikiStageOutcome, 'usage'>>) => outcomes.reduce((a, { usage: b }) => ({ inputTokens: a.inputTokens + b.inputTokens,
 outputTokens: a.outputTokens + b.outputTokens, costUsd: a.costUsd + b.costUsd, calls: a.calls + b.calls }), zero());
function expect<K extends WikiStageResult['kind']>(outcome: WikiStageOutcome, kind: K): Extract<WikiStageResult, { kind: K }> {
 if (outcome.result.kind !== kind) throw new Error(`Wiki compilation expected ${kind}, received ${outcome.result.kind}`);
 return outcome.result as Extract<WikiStageResult, { kind: K }>;
}
function pageInputs(pages: WikiPageContent[], role: 'member' | 'context', previous = false, prefix: string = role): WikiStagePageInput[] {
 return pages.map(page => ({ ref: `${prefix}:${page.id}`, page, role, previous }));
}
function materialize(input: WikiStageInput, result: WikiPagesResult): WikiPageContent[] {
 const members = new Map(input.pages.filter(p => p.role === 'member').map(p => [p.ref, p]));
 const used = [...result.pages.flatMap(p => p.member_refs), ...result.retained_refs, ...result.discarded_refs.map(p => p.ref)];
 if (new Set(used).size !== used.length || used.length !== members.size || used.some(ref => !members.has(ref))) {
  throw new Error('Wiki compilation merge must account for every member exactly once');
 }
 for (const member of members.values()) {
  if (!member.previous) continue;
  const target = result.retained_refs.includes(member.ref) ? member.page : result.pages.find(p => p.member_refs.includes(member.ref));
  if (!target || wikiPageEntryIds(member.page.body).some(ref => !wikiPageEntryIds(target.body).includes(ref))) {
   throw new Error('Wiki compilation previous Page lost its identity disposition or citations');
  }
 }
 const pages = [...result.pages.map(({ member_refs: _refs, ...page }) => page), ...result.retained_refs.map(ref => members.get(ref)!.page)];
 if (new Set(pages.map(p => p.id)).size !== pages.length) throw new Error('Wiki compilation duplicate final Page ID');
 const known = new Set(input.entries.map(e => e.id)), refs = cited(pages), deferred = new Set(result.deferred_entries.map(e => e.entry_ref));
 if ([...refs].some(ref => !known.has(ref)) || [...deferred].some(ref => !known.has(ref) || refs.has(ref))) throw new Error('Wiki compilation invalid evidence disposition');
 if (input.requiredEntries.some(ref => !refs.has(ref) && !deferred.has(ref))) throw new Error('Wiki compilation required evidence missing');
 return pages;
}
function sectionEvidence(pages: WikiPageContent[]): Array<WikiPageSection & { entryIds: string[] }> {
 return wikiPageSections(pages).map(section => ({ ...section, entryIds: wikiPageEntryIds(
  pages.find(page => page.id === section.pageId)!.body.split('\n').slice(section.startLine - 1, section.endLine).join('\n')) }));
}

export interface WikiReindexRequest {
 knowledgeRoot: string; topicPlan: GoalTopicPlan; goalContext: WikiGoalContext;
 workRoot: string; env?: NodeJS.ProcessEnv; signal: AbortSignal;
}
export interface WikiReindexResult {
 knowledgeRoot: string; pageCount: number; usage: ResearchModelUsage; sessionPaths: string[];
 failedTopics: Array<{ topicId: string; error: string }>;
}

export class WikiCompiler {
 constructor(private readonly options: { runStage?: (request: WikiStageRequest) => Promise<WikiStageOutcome> } = {}) {}

 async compile(request: WikiCompilationRequest): Promise<WikiCompilationResult> {
  request.signal.throwIfAborted();
  const goal = requireWikiGoalContext(request.goalContext), topics = validateGoalTopicPlan(request.topicPlan);
  const store = new RunArtifactStore(request.runDirectory), artifact = store.openFile(request.cornellNotesSnapshot);
  const evidence = projectWikiEvidence(validateCornellNotesSnapshot(JSON.parse(readFileSync(artifact.absolutePath, 'utf8'))));
  const base = join(request.goalDir, 'wiki', 'knowledge'), baseKnowledgeSha256 = hashWikiDirectory(base);
  const priorStatus = join(base, '.note-first-status.json');
  if (!request.rebuild && existsSync(priorStatus) && JSON.parse(readFileSync(priorStatus, 'utf8')).complete !== true) {
   throw new Error('Incomplete Wiki compilation output cannot seed a new Edition; resume its original compilation to retry failed tasks');
  }
  const previous: PreviousWikiEdition = request.rebuild ? { pages: [], entries: [], files: new Map(), relations: [] } : await readPreviousWikiEdition(base);
  const env = pinWikiModelSelection(request.controlDirectory, request.env ?? process.env);
  const compilationId = `wiki-compilation-${hashJson({ notes: artifact.sha256, baseKnowledgeSha256, goal, topics, rebuild: request.rebuild === true,
   model: env.TELOMI_WIKI_CURATOR_MODEL, thinking: env.TELOMI_WIKI_CURATOR_THINKING_LEVEL, contract: 3, implementation: codeIdentity() }).slice(0, 24)}`;
  const workRoot = join(request.controlDirectory, 'wiki-compilation', compilationId);
  mkdirSync(workRoot, { recursive: true });
  const record = join(workRoot, 'result.json');
  if (existsSync(record)) {
   const saved = JSON.parse(readFileSync(record, 'utf8')) as WikiCompilationResult;
   if (store.describeDirectory(saved.knowledge.relativePath).sha256 !== saved.knowledge.sha256) throw new Error('Wiki compilation published artifact changed');
   return { ...saved, status: 'reused' };
  }
  const incoming = noteWikiEntries(evidence, topics.revision), registry = new Map(previous.entries.map(e => [e.id, e]));
  for (const entry of incoming) {
   if (registry.has(entry.id) && registry.get(entry.id)!.revisionSha256 !== entry.revisionSha256) throw new Error('Wiki compilation conflicting Entry revision');
   registry.set(entry.id, entry);
  }
  const entries = [...registry.values()];
  const outcomes: WikiStageOutcome[] = [], failedAttempts: Array<{ usage: ResearchModelUsage; sessionPaths: string[] }> = [];
  const failures: WikiCompilationBatchFailure[] = [];
  const finalDiscards = new Map<string, { entry_ref: string; reason: string }>();
  const discardedPath = join(base, '.discarded-cues.json');
  if (!request.rebuild && existsSync(discardedPath)) {
   const saved: unknown = JSON.parse(readFileSync(discardedPath, 'utf8'));
   if (!Array.isArray(saved)) throw new Error('Invalid final Cue discard ledger');
   for (const row of saved) {
    if (!row || typeof row.entry_id !== 'string' || typeof row.reason !== 'string' || !row.reason.trim()
     || !registry.has(row.entry_id) || finalDiscards.has(row.entry_id) || cited(previous.pages).has(row.entry_id)) {
     throw new Error('Final Cue discard ledger conflicts with previous knowledge');
    }
    finalDiscards.set(row.entry_id, { entry_ref: row.entry_id, reason: row.reason });
   }
  }
  const unplacedReasons = new Map<string, string>();
  const priorAccounted = cited(previous.pages);
  for (const id of finalDiscards.keys()) priorAccounted.add(id);
  const deferredPath = join(base, '.deferred-notes.json');
  if (!request.rebuild && existsSync(deferredPath)) for (const row of JSON.parse(readFileSync(deferredPath, 'utf8'))) priorAccounted.add(row.entry_id);
  const pendingEntries = new Set<string>(), available = new Set(previous.entries.map(e => e.id));
  const fail = (index: number, ids: string[], error: unknown) => {
   request.signal.throwIfAborted();
   const details = error as { usage?: ResearchModelUsage };
   failures.push({ batchIndex: index, sourceIds: ids, message: toErrorMessage(error), usage: details?.usage ?? zero() });
   writeJsonAtomic(join(workRoot, 'failures.json'), failures);
  };
  const make = (stage: WikiStageInput['stage'], key: string, patch: Partial<WikiStageInput> = {}): WikiStageInput => ({
   stage, key, language: wikiLanguage(goal), goal, entries, pages: [], requiredEntries: [], requiredPages: [], topics: [], sections: [], instructions: '', previousRelations: [], unplacedEntries: [], ...patch });
  const run = async (input: WikiStageInput) => {
   request.signal.throwIfAborted();
   const sessions = new Set<string>();
   const recordSessions = (paths: string[]) => {
    paths.forEach(path => sessions.add(path));
    sessionTraceRef(request.controlDirectory, hashJson(input.key).slice(0, 16),
     [...sessions].map(path => ({ path, label: input.stage })));
   };
   try {
    const outcome = await (this.options.runStage ?? runWikiStageKind)({ input, workRoot: join(workRoot, input.key, hashJson(input).slice(0, 24)), env, signal: request.signal,
     onAttemptStarted: attemptRoot => recordSessions([join(attemptRoot, 'runtime', 'sessions')]) });
    recordSessions(outcome.sessionPaths);
    request.signal.throwIfAborted();
    outcomes.push(outcome);
    return outcome;
   } catch (error) {
    const details = error as { usage?: ResearchModelUsage; sessionPaths?: string[] };
    recordSessions(details?.sessionPaths ?? []);
    failedAttempts.push({ usage: details?.usage ?? zero(), sessionPaths: details?.sessionPaths ?? [] });
    throw error;
   }
  };
  let compilationStages = 2;
  const globalStage = async (input: WikiStageInput, index: number) => {
   const progress = { kind: input.stage, stageIndex: index, totalStages: compilationStages, pageCount: 0, usage: zero(),
    traceRef: sessionTraceRef(request.controlDirectory, hashJson(input.key).slice(0, 16), []) };
   request.onStageProgress?.({ ...progress, status: 'running' });
   try {
    const outcome = await run(input);
    request.onStageProgress?.({ ...progress, status: 'succeeded', usage: outcome.usage,
     pageCount: outcome.result.kind === 'pages' ? outcome.result.value.pages.length + outcome.result.value.retained_refs.length : 0 });
    return outcome;
   } catch (error) {
    request.onStageProgress?.({ ...progress, status: 'failed', message: toErrorMessage(error), usage: (error as { usage?: ResearchModelUsage })?.usage ?? zero() });
    throw error;
   }
  };
  try {
   writeJsonAtomic(join(workRoot, 'execution-contract.json'), { version: 3, objectUnit: 'one-complete-cornell-note', concurrency: 4,
    scheduling: 'dynamic-queue', cueDispositionOwner: 'merge-objects', conceptEvidence: 'accepted-objects-only',
    data: 'object-notes; unplaced-cues-at-object-merge; downstream-page-and-section-views', diagnosticOnly: false });
   request.onStarted?.(evidence.notes.length);
   const drafts = await mapConcurrentFairly(evidence.notes, 4, async (note, index) => {
    const noteIds = new Set(noteWikiEntries({ ...evidence, notes: [note] }, topics.revision).map(e => e.id));
    const noteEntries = incoming.filter(e => noteIds.has(e.id));
    const key = `objects/${hashJson({ source: note.note.source_id, revision: note.source_revision_sha256,
     ...(note.source_run_id ? { sourceRun: note.source_run_id } : {}) }).slice(0, 24)}`;
    const input = make('objects', key, { entries: noteEntries, requiredEntries: noteEntries.map(e => e.id),
     instructions: `Process this one complete Cornell Note: ${note.title}. Its sections and all Cue details are supplied in full.` });
    const progress = { batchIndex: index, totalBatches: evidence.notes.length, pageCount: 0, usage: zero(), reused: false, traceRef: sessionTraceRef(request.controlDirectory, hashJson(input.key).slice(0, 16), []) };
    if (noteEntries.length && noteEntries.every(entry => priorAccounted.has(entry.id))) {
     request.onBatchProgress?.({ ...progress, status: 'succeeded', reused: true });
     return [];
    }
    request.onBatchProgress?.({ ...progress, status: 'running' });
    try {
     const outcome = await run(input), result = expect(outcome, 'pages');
     materialize(input, result.value);
     for (const row of result.value.deferred_entries) unplacedReasons.set(row.entry_ref, row.reason);
     noteEntries.forEach(e => available.add(e.id));
     request.onBatchProgress?.({ ...progress, status: 'succeeded', pageCount: result.value.pages.length, usage: outcome.usage });
     return result.value.pages.map(({ member_refs: _refs, ...page }) => ({ ref: `${key}:${page.id}`, page, previous: false, role: 'member' as const }));
    } catch (error) {
     noteEntries.filter(e => !available.has(e.id)).forEach(e => pendingEntries.add(e.id));
     fail(index, [note.note.source_id], error);
     request.onBatchProgress?.({ ...progress, status: 'failed', message: toErrorMessage(error), usage: (error as { usage?: ResearchModelUsage })?.usage ?? zero() });
     return [];
    }
   }, request.signal);
   const usable = entries.filter(e => available.has(e.id));
   const objectMembers = [...pageInputs(previous.pages.filter(p => p.kind === 'entity'), 'member', true, 'previous'), ...drafts.flat()];
   const objectDraftCues = cited(objectMembers.map(p => p.page));
   const unplaced = usable.filter(e => !objectDraftCues.has(e.id) && !finalDiscards.has(e.id));
   const historicalConcepts = pageInputs(previous.pages.filter(p => p.kind === 'concept'), 'context', true, 'history');
   const mergeObjectsInput = make('merge-objects', 'merge-objects', { entries: usable, pages: [...objectMembers, ...historicalConcepts],
    requiredEntries: [...new Set([...objectDraftCues, ...unplaced.map(e => e.id)])],
    unplacedEntries: unplaced.map(e => ({ entryId: e.id, reason: unplacedReasons.get(e.id) ?? 'Not yet represented in an accepted object page; resolve its object placement or final disposition.' })) });
   const mergedObjects = expect(await globalStage(mergeObjectsInput, 0), 'pages').value;
   const objects = materialize(mergeObjectsInput, mergedObjects);
   const objectCues = cited(objects);
   for (const row of mergedObjects.deferred_entries) finalDiscards.set(row.entry_ref, row);
   for (const entry of usable) {
    if (objectCues.has(entry.id) === finalDiscards.has(entry.id)) throw new Error(`Cue must be adopted into objects or finally discarded: ${entry.id}`);
   }
   if ([...cited(historicalConcepts.map(row => row.page))].some(id => !objectCues.has(id))) {
    throw new Error('Historical concept evidence must be repaired into objects before concept processing');
   }
   writeJsonAtomic(join(workRoot, 'object-cue-disposition.json'), { adoptedEntryIds: [...objectCues],
    incomingUnplacedEntries: mergeObjectsInput.unplacedEntries, discarded: [...finalDiscards.values()] });
   const objectRefs = pageInputs(objects, 'context');
   const planInput = make('plan-concepts', 'plan-concepts', { entries: usable, pages: [...objectRefs, ...historicalConcepts],
    requiredPages: objectRefs.map(p => p.ref) });
   const conceptPlan = expect(await globalStage(planInput, 1), 'concept-plan');
   const primary = new Set(planInput.requiredPages), history = new Map(historicalConcepts.map(row => [row.ref, row]));
   const targets = new Set<string>();
   for (const job of conceptPlan.jobs) {
    if (!job.pageRefs.length || new Set(job.pageRefs).size !== job.pageRefs.length
     || job.pageRefs.some(ref => !primary.has(ref)) || !job.question.trim() || !job.scope.trim()) throw new Error('Invalid concept question workset');
    if (job.targetRef !== null) {
     if (!history.has(job.targetRef) || targets.has(job.targetRef)) throw new Error('Concept update targets must be existing pages with one writer');
     targets.add(job.targetRef);
    }
   }
   const assigned = new Set(conceptPlan.jobs.flatMap(job => job.pageRefs));
   assertPartition([...assigned, ...conceptPlan.objectOnly.map(row => row.pageRef)], planInput.requiredPages, 'concept object disposition');
   writeJsonAtomic(join(workRoot, 'concept-object-disposition.json'), { jobs: conceptPlan.jobs, objectOnly: conceptPlan.objectOnly });
   compilationStages += conceptPlan.jobs.length;
   const conceptResults = await mapConcurrentFairly(conceptPlan.jobs, 4, async (job, index) => {
    const input = make('concepts', `concepts/${hashJson(job).slice(0, 24)}`, { entries: usable, pages: planInput.pages,
     requiredPages: job.pageRefs, conceptTask: { question: job.question, scope: job.scope, targetRef: job.targetRef } });
    try {
     const result = expect(await globalStage(input, 2 + index), 'pages');
     materialize(input, result.value);
     if (result.value.pages.length > 1 || result.value.deferred_entries.length || [...cited(result.value.pages)].some(id => !objectCues.has(id))) {
      throw new Error('One concept question produces zero or one page backed by accepted objects');
     }
     if (job.targetRef) for (const page of result.value.pages) {
      const target = history.get(job.targetRef)!.page;
      if (page.id !== target.id || wikiPageEntryIds(target.body).some(ref => !wikiPageEntryIds(page.body).includes(ref))) {
       throw new Error('Concept writer must preserve its existing target identity and citations');
      }
     }
     assertPartition(result.consideredPages.map(p => p.pageRef), job.pageRefs, 'concept considered objects');
     return { input, result, job };
    } catch (error) { fail(evidence.notes.length + index, job.pageRefs, error); return null; }
   }, request.signal);
   const conceptMembers = historicalConcepts.map(row => ({ ...row, role: 'member' as const }));
   for (const row of conceptResults) {
    if (!row || !row.result.value.pages.length) continue;
    const { member_refs: _refs, ...page } = row.result.value.pages[0]!;
    if (row.job.targetRef) {
     const index = conceptMembers.findIndex(member => member.ref === row.job.targetRef);
     if (index < 0) throw new Error('Concept target disappeared before integration');
     conceptMembers[index] = { ...conceptMembers[index]!, page };
    } else conceptMembers.push({ ref: `${row.input.key}:${page.id}`, page, previous: false, role: 'member' });
   }
   let concepts = conceptMembers.map(row => row.page), nextCompilationStage = 2 + conceptPlan.jobs.length;
   if (conceptMembers.length) {
    compilationStages++;
    const auditInput = make('audit-concepts', 'audit-concepts', { entries: usable, pages: [...conceptMembers, ...objectRefs],
     requiredPages: conceptMembers.map(row => row.ref) });
    const audit = expect(await globalStage(auditInput, nextCompilationStage++), 'concept-audit');
    assertPartition(audit.reviewedPages.map(row => row.pageRef), auditInput.requiredPages, 'concept catalog review');
    const members = new Map(conceptMembers.map(row => [row.ref, row]));
    const consumed = new Set<string>();
    for (const group of audit.conflictGroups) {
     if (group.pageRefs.length < 2 || !group.reason.trim()) throw new Error('Concept conflict group requires distinct members and a reason');
     for (const ref of group.pageRefs) {
      if (!members.has(ref) || consumed.has(ref)) throw new Error('Concept conflict groups must be disjoint known pages');
      consumed.add(ref);
     }
    }
    for (const row of audit.discardedRefs) {
     if (!members.has(row.ref) || members.get(row.ref)!.previous || consumed.has(row.ref) || !row.reason.trim()) {
      throw new Error('Concept audit can withdraw only a new page outside conflict groups');
     }
     consumed.add(row.ref);
    }
    concepts = conceptMembers.filter(row => !consumed.has(row.ref)).map(row => row.page);
    compilationStages += audit.conflictGroups.length;
    for (const group of audit.conflictGroups) {
     const selected = group.pageRefs.map(ref => members.get(ref)!);
     const input = make('merge-concepts', `merge-concepts/${hashJson(group).slice(0, 24)}`, { entries: usable,
      pages: [...selected, ...objectRefs], instructions: group.reason });
     const merged = expect(await globalStage(input, nextCompilationStage++), 'pages').value;
     if (merged.discarded_refs.length || merged.deferred_entries.length) throw new Error('Concept conflict merge cannot discard members or evidence');
     concepts.push(...materialize(input, merged));
    }
   }
   const conceptCues = cited(concepts);
   if ([...conceptCues].some(id => !objectCues.has(id))) throw new Error('Final concepts require evidence backed by accepted objects');
   if (new Set(concepts.map(page => page.id)).size !== concepts.length
    || new Set(concepts.map(page => page.title.normalize('NFKC').trim().toLocaleLowerCase())).size !== concepts.length) {
    throw new Error('Final concept identities and titles must be unique');
   }
   for (const old of historicalConcepts) if (wikiPageEntryIds(old.page.body).some(id => !conceptCues.has(id))) {
    throw new Error('Historical concept citations must survive final integration');
   }
   const pages = [...objects, ...concepts];
   compilationStages += topics.topics.length ? pages.length : 0;
   const sections = sectionEvidence(pages), knowledgeHash = hashJson({ pages, entries });
   const indexed = await this.index({ make, run: (input, ordinal) => globalStage(input, nextCompilationStage + ordinal), pages, sections, topics, knowledgeHash,
    onFailure: (index, id, error) => fail(evidence.notes.length + conceptPlan.jobs.length + index, [id], error), signal: request.signal });
   const refs = cited(pages);
   if ([...finalDiscards.keys()].some(id => refs.has(id))) throw new Error('Finally discarded Cue reappeared in knowledge');
   for (const entry of entries) if (!refs.has(entry.id) && !pendingEntries.has(entry.id) && !finalDiscards.has(entry.id)) {
    throw new Error(`Wiki compilation unaccounted evidence ${entry.id}`);
   }
   request.signal.throwIfAborted();
   if (hashWikiDirectory(base) !== baseKnowledgeSha256) throw new Error('Previous Wiki changed during wiki-compilation compilation');
   const discarded = [...finalDiscards.values()];
   const candidateRoot = join(workRoot, `knowledge-${hashJson({ pages, indexed, discarded, failures }).slice(0, 24)}`);
   writeWikiEdition(candidateRoot, pages, entries, empty(), previous);
   writeJsonAtomic(join(candidateRoot, '.discarded-cues.json'), discarded.map(row => ({ entry_id: row.entry_ref, reason: row.reason })));
   writeWikiIndex(candidateRoot, pages, indexed, sections, topics, previous);
   writeJsonAtomic(join(candidateRoot, '.note-first-status.json'), { version: 3, complete: failures.length === 0, cueDispositionOwner: 'merge-objects',
    discardedCueCount: discarded.length,
    failures, pendingEntryIds: [...pendingEntries].filter(id => !refs.has(id)), objectNotes: evidence.notes.length, conceptJobs: conceptPlan.jobs.length });
   const candidateHash = new RunArtifactStore(workRoot).describeDirectory(candidateRoot.slice(workRoot.length + 1)).sha256;
   const outputPath = `artifacts/wiki-compilations/${compilationId}/knowledge-${candidateHash.slice(0, 24)}`;
   const knowledge = existsSync(join(request.runDirectory, outputPath)) ? store.describeDirectory(outputPath) : store.publishDirectory(candidateRoot, outputPath);
   if (knowledge.sha256 !== candidateHash) throw new Error('Wiki compilation publication differs from candidate');
   const result: WikiCompilationResult = { status: 'compiled', publicationReady: failures.length === 0, compilationId, baseKnowledgeSha256, knowledge, pageCount: pages.length,
    usage: sumUsage([...outcomes, ...failedAttempts]), agentStages: outcomes.length + failedAttempts.length, sessionPaths: [...outcomes, ...failedAttempts].flatMap(outcome => outcome.sessionPaths), failedBatches: failures };
   if (!failures.length) writeJsonAtomic(record, result);
   else writeJsonAtomic(join(workRoot, 'partial-result.json'), result);
   return result;
  } catch (error) {
   throw Object.assign(error instanceof Error ? error : new Error(toErrorMessage(error)), {
    usage: sumUsage([...outcomes, ...failedAttempts]),
    sessionPaths: [...new Set([...outcomes.flatMap(outcome => outcome.sessionPaths), ...failedAttempts.flatMap(attempt => attempt.sessionPaths)])],
   });
  }
 }

 private async index(input: { make: (stage: WikiStageInput['stage'], key: string, patch?: Partial<WikiStageInput>) => WikiStageInput;
  run: (input: WikiStageInput, ordinal: number) => Promise<WikiStageOutcome>; pages: WikiPageContent[]; sections: WikiPageSection[]; topics: GoalTopicPlan;
  knowledgeHash: string; onFailure: (index: number, topic: string, error: unknown) => void; signal: AbortSignal }): Promise<WikiTopicResult> {
  if (!input.topics.topics.length) return { knowledgeHash: input.knowledgeHash, topicPlanRevision: input.topics.revision, topics: [] };
  const topicIds = new Set(input.topics.topics.map(topic => topic.id));
  const results = await mapConcurrentFairly(input.pages, 4, async (page, index) => {
   const pageEntries = new Set(wikiPageEntryIds(page.body));
   const task = input.make('page-topics', `page-topics/${hashJson(page.id).slice(0, 16)}`, {
    pages: pageInputs([page], 'context'), sections: input.sections.filter(section => section.pageId === page.id), topics: input.topics.topics });
   task.entries = task.entries.filter(entry => pageEntries.has(entry.id));
   try {
    const result = expect(await input.run(task, index), 'page-topics');
    assertPartition(result.sections.map(section => section.sectionRef), task.sections.map(section => section.ref), 'Page Topic section coverage');
    for (const section of result.sections) {
     if (new Set(section.matches.map(match => match.topicId)).size !== section.matches.length
      || section.matches.some(match => !topicIds.has(match.topicId) || !match.reason.trim())) throw new Error('Page Topic returned invalid or duplicate Topic matches');
    }
    return { sections: result.sections, error: null };
   } catch (error) {
    input.signal.throwIfAborted();
    return { sections: [], error: `${page.id}: ${toErrorMessage(error)}` };
   }
  }, input.signal);
  const errors = results.flatMap(result => result.error ? [result.error] : []);
  // A failed page may match any Topic. Preserve partial matches but never publish them as complete.
  const error = errors.length ? `Page Topic matching failed: ${errors.join('; ')}` : undefined;
  const topics = input.topics.topics.map((topic, index) => {
   const matches = results.flatMap(result => result.sections.flatMap(section => section.matches
    .filter(match => match.topicId === topic.id).map(match => ({ sectionRef: section.sectionRef, reason: match.reason }))));
   if (error) input.onFailure(index, topic.id, new Error(error));
   return { topicId: topic.id, sections: matches.map(match => match.sectionRef), matches, gaps: [],
    status: error ? 'failed' as const : 'succeeded' as const, ...(error ? { error } : {}) };
  });
  return { knowledgeHash: input.knowledgeHash, topicPlanRevision: input.topics.revision, topics };
 }

 async reindex(input: WikiReindexRequest): Promise<WikiReindexResult> {
  const goal = requireWikiGoalContext(input.goalContext), topics = validateGoalTopicPlan(input.topicPlan);
  const before = hashWikiDirectory(input.knowledgeRoot), previous = await readPreviousWikiEdition(input.knowledgeRoot);
  const env = pinWikiModelSelection(input.workRoot, input.env ?? process.env);
  const outcomes: WikiStageOutcome[] = [], failedAttempts: Array<{ usage: ResearchModelUsage; sessionPaths: string[] }> = [];
  const failedTopics: Array<{ topicId: string; error: string }> = [];
  const make = (stage: WikiStageInput['stage'], key: string, patch: Partial<WikiStageInput> = {}): WikiStageInput => ({ stage, key,
   language: wikiLanguage(goal), goal, entries: previous.entries, pages: [], requiredEntries: [], requiredPages: [], topics: [], sections: [], instructions: '', previousRelations: [], ...patch });
  const sections = sectionEvidence(previous.pages);
  const index = await this.index({ make, pages: previous.pages, sections, topics, knowledgeHash: hashJson({ pages: previous.pages, entries: previous.entries }),
   run: async stage => {
    try {
     const outcome = await (this.options.runStage ?? runWikiStageKind)({ input: stage, workRoot: join(input.workRoot, stage.key), env, signal: input.signal });
     input.signal.throwIfAborted(); outcomes.push(outcome); return outcome;
    } catch (error) {
     const details = error as { usage?: ResearchModelUsage; sessionPaths?: string[] };
     failedAttempts.push({ usage: details?.usage ?? zero(), sessionPaths: details?.sessionPaths ?? [] });
     throw error;
    }
   },
   onFailure: (_index, topicId, error) => failedTopics.push({ topicId, error: toErrorMessage(error) }), signal: input.signal });
  input.signal.throwIfAborted();
  if (hashWikiDirectory(input.knowledgeRoot) !== before) throw new Error('Wiki changed during Topic reindex');
  const knowledgeRoot = mkdtempSync(join(input.workRoot, 'knowledge-'));
  cpSync(input.knowledgeRoot, knowledgeRoot, { recursive: true });
  if (hashWikiDirectory(knowledgeRoot) !== before) throw new Error('Wiki changed while copying Topic input');
  writeWikiIndex(knowledgeRoot, previous.pages, index, sections, topics, previous);
  return { knowledgeRoot, pageCount: previous.pages.length, usage: sumUsage([...outcomes, ...failedAttempts]), sessionPaths: [...outcomes, ...failedAttempts].flatMap(o => o.sessionPaths), failedTopics };
 }
}
function assertPartition(actual: string[], expected: string[], label: string) {
 if (new Set(actual).size !== actual.length || actual.length !== expected.length || actual.some(ref => !expected.includes(ref))) throw new Error(`Invalid ${label}: every input must be assigned exactly once`);
}
