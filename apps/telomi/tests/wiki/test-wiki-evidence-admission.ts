import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RunArtifactStore } from '../../server/agent-runtime/artifact-store.js';
import { hashWikiDirectory } from '../../server/wiki/files.js';
import { noteWikiEntries } from '../../server/wiki/note-entries.js';
import { WikiCompiler } from '../../server/wiki/wiki-compiler.js';
import { piObjectUserContext } from '../../server/wiki/pi-object-stage.js';
import { createWikiStageWorkspace } from '../../server/wiki/wiki-stage-workspace.js';
import type { SourceNotesSnapshot } from '../../server/notes/contracts.js';
import type { WikiCompilationRequest } from '../../server/wiki/contracts.js';
import type { WikiStageRequest, WikiStageOutcome } from '../../server/wiki/wiki-stage-contract.js';

const root = mkdtempSync(join(tmpdir(), 'wiki-admission-'));
const snapshot: SourceNotesSnapshot = { schema_version: 1, snapshot_id: 'input', run_id: 'run',
 pipeline: { id: 'notes', version: '1', sha256: 'a'.repeat(64) }, source_bundle_refs: [], notes: [{
 title: 'Model evidence', canonical_locator: 'https://example.test/model', provider_id: 'test', provenance_ref: 'provider:test',
 source_revision_sha256: 'b'.repeat(64), members: [], note: { schema_version: 1, source_id: 'model', sections: [{
 section_title: 'Findings', summary: 'Streaming returns audio early. The badge color is green.', cue_notes: [
 { cue: 'The model supports streaming.', note: 'Streaming returns audio before synthesis finishes.', evidence: [{ source_path: 'model.md', start_line: 1, end_line: 1, content_sha256: 'c'.repeat(64) }] },
 { cue: 'The repository uses a green badge.', note: 'The badge color is green.', evidence: [{ source_path: 'model.md', start_line: 2, end_line: 2, content_sha256: 'd'.repeat(64) }] },
 ] }] } }] };
const usage = { calls: 1, inputTokens: 10, outputTokens: 5, costUsd: 0 };
function request(name: string): WikiCompilationRequest {
 const goalDir = join(root, name, 'goal'); mkdirSync(join(goalDir, 'wiki/knowledge'), { recursive: true });
 const store = new RunArtifactStore(join(root, name, 'run'));
 const notes = store.publishText(JSON.stringify(snapshot), 'notes.json');
 return { goalDir, runId: name, runDirectory: store.root, controlDirectory: join(root, name, 'control'),
 notesSnapshot: { relative_path: notes.relativePath, sha256: notes.sha256, byte_length: notes.byteLength },
 goalContext: { title: 'TTS models', description: 'Understand synthesis mechanisms' },
 topicPlan: { schema_version: 1, goal_id: 'goal', revision: 'v1', status: 'active', topics: [{ id: 'tts', title: 'TTS', intent: 'Synthesis', questions: [], include: [], exclude: [] }] },
 env: { TELOMI_WIKI_COMPILATION_MODEL: 'test/root', TELOMI_WIKI_COMPILATION_THINKING_LEVEL: 'low' }, signal: new AbortController().signal };
}
try {
 const skipped = request('skipped'); const originalHash = hashWikiDirectory(join(skipped.goalDir, 'wiki/knowledge'));
 const stages: string[] = [];
 const skip = async ({ input }: WikiStageRequest): Promise<WikiStageOutcome> => {
  stages.push(input.stage);
  assert.equal(input.stage, 'curate-evidence', 'non-adopted evidence must not reach object construction');
  return { usage, sessionPaths: [], result: { kind: 'evidence-curation', decisions: input.requiredEntries.map(entryId => ({ entryId, action: 'skip', reason: 'No lasting contribution to the Goal' })) } };
 };
 const result = await new WikiCompiler({ runStage: skip }).compile(skipped);
 assert.deepEqual(stages, ['curate-evidence']);
 assert.deepEqual(result.curation, { adopted: 0, deferred: 0, skipped: 2 });
 assert.equal(hashWikiDirectory(result.knowledge.absolutePath), originalHash, 'rejecting all Cues preserves the entire Edition');
 assert.equal(result.usage.calls, 1, 'no concept or classification work follows an empty admission');

 const mixed = request('mixed'); const calls: string[] = [];
 const originalSnapshot = structuredClone(snapshot);
 const constructionInputs: WikiStageRequest['input'][] = [];
 const objectViews: string[] = [];
 const mergeViews: string[] = [];
 const acceptedId = noteWikiEntries(snapshot, 'v1')[0]!.id;
 const compiled = await new WikiCompiler({ runStage: async ({ input }): Promise<WikiStageOutcome> => {
  calls.push(input.stage);
  const value = { pages: [], retained_refs: [], discarded_refs: [], deferred_entries: [], relations: [] };
  if (input.stage === 'curate-evidence') return { usage, sessionPaths: [], result: { kind: 'evidence-curation', decisions: input.requiredEntries.map(entryId => ({ entryId, action: entryId === acceptedId ? 'adopt' : 'defer', reason: entryId === acceptedId ? 'Reusable synthesis mechanism' : 'Insufficient lasting value' })) } };
  constructionInputs.push(input);
  assert.ok(input.entries.every(entry => entry.id === acceptedId), 'only adopted evidence reaches construction and indexing');
  if (input.stage === 'objects') {
   objectViews.push(piObjectUserContext(input, join(root, 'object-context')));
   const workspace = createWikiStageWorkspace(input, join(root, 'object-workspace'));
   objectViews.push(workspace.read('N1'), readFileSync(join(root, 'object-workspace/evidence/N1.md'), 'utf8'));
   return { usage, sessionPaths: [], result: { kind: 'pages', consideredPages: [], value: { ...value,
    deferred_entries: [{ entry_ref: acceptedId, reason: 'Resolve the object placement during the global merge' }] } } };
  }
  if (input.stage === 'merge-objects') {
   const workspace = createWikiStageWorkspace(input, join(root, 'merge-workspace'));
   mergeViews.push(workspace.read('N1'), readFileSync(join(root, 'merge-workspace/evidence/N1.md'), 'utf8'));
   return { usage, sessionPaths: [], result: { kind: 'pages', consideredPages: [], value: { ...value, pages: [{ id: 'entity:model', kind: 'entity', title: 'Streaming model', description: 'Supports streaming', body: `## Streaming\nReturns audio early [[${acceptedId}]].`, member_refs: [] }] } } };
  }
  if (input.stage === 'plan-concepts') return { usage, sessionPaths: [], result: { kind: 'concept-plan', jobs: [], objectOnly: input.requiredPages.map(pageRef => ({ pageRef, comparedWith: [], reason: 'One concrete model' })) } };
  if (input.stage === 'page-topics') return { usage, sessionPaths: [], result: { kind: 'page-topics', sections: input.sections.map(section => ({ sectionRef: section.ref, matches: [] })) } };
  throw new Error(`Unexpected stage ${input.stage}`);
 } }).compile(mixed);
 assert.equal(calls[0], 'curate-evidence');
 assert.equal(objectViews.length, 3, 'inspect the actual object prompt, Cue reader and mounted Cue file');
 assert.equal(mergeViews.length, 2, 'inspect the downstream unplaced Cue reader and mounted file');
 for (const view of [...objectViews, ...mergeViews]) {
  assert.ok(view.includes('Streaming returns audio before synthesis finishes.'), 'admitted Cue detail remains complete');
  assert.ok(!view.includes('The badge color is green.'), 'excluded facts must not leak through the shared section summary');
 }
 assert.ok(constructionInputs.every(input => input.entries.every(entry => !Object.hasOwn(entry, 'sectionSummary'))),
  'all construction and indexing stages receive only Cue-scoped evidence');
 assert.deepEqual(compiled.curation, { adopted: 1, deferred: 1, skipped: 0 });
 const registry = JSON.parse(readFileSync(join(compiled.knowledge.absolutePath, '.note-registry.json'), 'utf8'));
 assert.deepEqual(registry.entries.map((entry: { id: string }) => entry.id), [acceptedId]);
 const { sectionSummary: _summary, ...acceptedEntry } = noteWikiEntries(snapshot, 'v1')[0]!;
 assert.deepEqual(registry.entries, [acceptedEntry], 'admission removes only the summary, preserving Cue identity and revision');
 assert.deepEqual(snapshot, originalSnapshot, 'raw Notes and summaries remain available for history and later curation');
 assert.equal(snapshot.notes[0]!.note.sections[0]!.cue_notes.length, 2, 'historical evidence is retained unmodified');
 const reconsider = request('reconsider');
 cpSync(compiled.knowledge.absolutePath, join(reconsider.goalDir, 'wiki/knowledge'), { recursive: true });
 reconsider.rebuild = true;
 const cleared = await new WikiCompiler({ runStage: skip }).compile(reconsider);
 assert.equal(cleared.pageCount, 0, 'an explicit full reconsideration removes old content when every Cue is rejected');
 assert.deepEqual(JSON.parse(readFileSync(join(cleared.knowledge.absolutePath, '.object-first-pages.json'), 'utf8')), []);
 assert.ok(hashWikiDirectory(cleared.knowledge.absolutePath) !== hashWikiDirectory(compiled.knowledge.absolutePath));
 assert.deepEqual(compiled.deferredEvidence?.entryIds, [noteWikiEntries(snapshot)[1]!.id]);
 const follow = request('follow');
 follow.deferredEvidence = compiled.deferredEvidence;
 const onlyOldAccepted = { ...snapshot, notes: [{ ...snapshot.notes[0]!, note: { ...snapshot.notes[0]!.note,
  sections: [{ ...snapshot.notes[0]!.note.sections[0]!, cue_notes: [snapshot.notes[0]!.note.sections[0]!.cue_notes[0]!] }] } }] };
 const later = new RunArtifactStore(follow.runDirectory).publishText(JSON.stringify(onlyOldAccepted), 'later.json');
 follow.notesSnapshot = { relative_path: later.relativePath, sha256: later.sha256, byte_length: later.byteLength };
 await assert.rejects(new WikiCompiler({ runStage: async ({ input }) => {
  assert.equal(input.stage, 'curate-evidence');
  assert.ok(input.requiredEntries.includes(noteWikiEntries(snapshot)[1]!.id), 'later curation reconsiders pending evidence missing from the new snapshot');
  throw new Error('pending evidence reached curation');
 } }).compile(follow), /pending evidence reached curation/);

 await assert.rejects(new WikiCompiler({ runStage: async (): Promise<WikiStageOutcome> => ({ usage, sessionPaths: [],
  result: { kind: 'evidence-curation', decisions: [{ entryId: acceptedId, action: 'adopt', reason: 'Useful' }] } }) }).compile(request('missing')), /every.*Cue|every.*Entry|partition|disposition|coverage/i);
 console.log('Wiki evidence admission tests passed');
} finally { rmSync(root, { recursive: true, force: true }); }
