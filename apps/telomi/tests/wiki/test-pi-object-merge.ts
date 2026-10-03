import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { hashJson, sha256 } from '../../server/lib/hash.js';
import { wikiStageOutputHash } from '../../server/wiki/wiki-stage.js';
import { runPiObjectMergeStage, validateObjectMergeResult } from '../../server/wiki/pi-object-merge.js';
import { wikiPageEntryIds, type WikiPagesResult } from '../../server/wiki/wiki-page-contract.js';
import type { WikiStageInput, WikiStageOutcome, WikiStageResult, WikiStageRequest } from '../../server/wiki/wiki-stage-contract.js';

const root = mkdtempSync(join(tmpdir(), 'pi-object-merge-'));
const ids = Array.from({ length: 8 }, (_, index) => `entry:${index.toString(16).padStart(24, '0')}`);
const entries = ids.map(id => ({ id, revisionSha256: 'r', sourceRunId: 'run', sourceId: 'source', sourceTitle: 'Source',
 canonicalLocator: '', members: [], section: 'Mechanism', cue: 'Fact', detail: 'Supported fact', anchors: [] }));
const input: WikiStageInput = { stage: 'merge-objects', key: 'merge', language: 'en', goal: { title: 'Models', description: '' }, entries,
 pages: ids.slice(0, 7).map((id, index) => ({ ref: `source:${index}`, previous: index === 0, role: 'member',
  page: { id: `entity:${index}`, kind: 'entity', title: index === 0 ? 'Model' : `Model draft ${index}`, description: 'Records', body: `## Record\nFact ${index} [[${id}]].` } })),
 requiredEntries: ids.slice(0, 7), requiredPages: [], topics: [], sections: [], previousRelations: [], instructions: '', unplacedEntries: [] };
const empty = (): WikiPagesResult => ({ pages: [], retained_refs: [], discarded_refs: [], deferred_entries: [], relations: [] });
const request = (name: string, value = input): WikiStageRequest => ({ input: value, workRoot: join(root, name), env: {}, signal: new AbortController().signal });

function accepted(request: WikiStageRequest, result: WikiStageResult): WikiStageOutcome {
 const attemptRoot = join(request.workRoot, 'attempt-fixture'), work = join(attemptRoot, 'work'), runtime = join(attemptRoot, 'runtime');
 mkdirSync(work, { recursive: true }); mkdirSync(runtime, { recursive: true });
 writeFileSync(join(work, 'result.json'), JSON.stringify(result));
 if (result.kind === 'object-target-pages') writeFileSync(join(work, 'facts.json'), '{"facts":[]}');
 writeFileSync(join(runtime, 'accepted-result.json'), JSON.stringify(result));
 const outcome: WikiStageOutcome = { result, usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, calls: 0 }, sessionPaths: [] };
 writeFileSync(join(request.workRoot, 'checkpoint.json'), JSON.stringify({ status: 'succeeded', attemptRoot, outcome,
  outputHash: wikiStageOutputHash(work), resultHash: sha256(readFileSync(join(runtime, 'accepted-result.json'))), outcomeHash: hashJson(outcome) }));
 return outcome;
}

const modelInvocations: Array<{ phase: string; input: WikiStageInput }> = [];
let failWriter = false;
const target = async (request: WikiStageRequest, phase: 'plan' | 'write'): Promise<WikiStageOutcome> => {
 const checkpoint = join(request.workRoot, 'checkpoint.json');
 if (existsSync(checkpoint)) return JSON.parse(readFileSync(checkpoint, 'utf8')).outcome;
 modelInvocations.push({ phase, input: request.input });
 if (phase === 'plan') {
  const old = request.input.pages.find(row => row.previous && row.role === 'member');
  return accepted(request, { kind: 'object-target-plan', jobs: [{ action: old ? 'update' : 'new', targetRef: old?.ref ?? null,
   pageRefs: request.input.pages.filter(row => row.role === 'member').map(row => row.ref), reason: 'Same model records' }] });
 }
 if (failWriter && request.input.key.endsWith('-2')) throw new Error('transient writer failure');
 const anchor = request.input.pages.find(row => row.ref === request.input.requiredPages[0]) ?? request.input.pages[0]!;
 return accepted(request, { kind: 'object-target-pages', facts: [], value: { ...empty(), pages: [{ ...anchor.page,
  body: request.input.pages.map(row => row.page.body).join('\n\n'), member_refs: request.input.pages.map(row => row.ref) }] } });
};

try {
 const first = await runPiObjectMergeStage(request('complete'), { target });
 assert.equal(first.result.kind, 'pages');
 if (first.result.kind !== 'pages') throw new Error('Unexpected result');
 assert.equal(first.result.value.pages.length, 1);
 assert.equal(first.result.value.pages[0]!.id, 'entity:0');
 assert.deepEqual(new Set(first.result.value.pages[0]!.member_refs), new Set(input.pages.map(row => row.ref)));
 assert.deepEqual(new Set(wikiPageEntryIds(first.result.value.pages[0]!.body)), new Set(ids.slice(0, 7)));
 const writers = modelInvocations.filter(row => row.phase === 'write');
 assert.deepEqual(writers.map(row => row.input.pages.filter(page => !page.previous).length), [4, 2]);
 assert.equal(writers[1]!.input.requiredPages[0], 'source:0');
 assert.equal(wikiPageEntryIds(writers[1]!.input.pages[0]!.page.body).length, 5, 'carried target retains earlier normalized Cues');
 const calls = modelInvocations.length;
 assert.deepEqual(await runPiObjectMergeStage(request('complete'), { target }), first);
 assert.equal(modelInvocations.length, calls, 'accepted parent is reused without new sessions');
 const parent = JSON.parse(readFileSync(join(root, 'complete/checkpoint.json'), 'utf8'));
 const child = JSON.parse(readFileSync(join(parent.childRoots[1], 'checkpoint.json'), 'utf8'));
 writeFileSync(join(child.attemptRoot, 'work/facts.json'), '{"facts":["tampered"]}');
 await assert.rejects(runPiObjectMergeStage(request('complete'), { target }), /artifacts changed/);

 failWriter = true;
 await assert.rejects(runPiObjectMergeStage(request('retry'), { target }), /transient writer/);
 failWriter = false;
 const beforeRetry = modelInvocations.length;
 await runPiObjectMergeStage(request('retry'), { target });
 assert.equal(modelInvocations.length, beforeRetry + 1, 'resume reuses accepted planner and first writer');

 const residualInput: WikiStageInput = { ...input, pages: input.pages.slice(0, 1), requiredEntries: [ids[0]!, ids[7]!],
  unplacedEntries: [{ entryId: ids[7]!, reason: 'Unplaced source record' }] };
 let residualCalled = false;
 const residual = async (request: WikiStageRequest) => {
  residualCalled = true;
  assert.ok(request.input.pages.every(row => row.role === 'context'));
  return accepted(request, { kind: 'pages', consideredPages: [], value: { ...empty(), pages: [{ id: 'entity:residual', kind: 'entity',
   title: 'Model supplement', description: 'Source record', body: `## Record\nNew fact [[${ids[7]}]].`, member_refs: [] }] } });
 };
 const resolved = await runPiObjectMergeStage(request('residual', residualInput), { target, residual });
 assert.ok(residualCalled);
 if (resolved.result.kind !== 'pages') throw new Error('Unexpected result');
 assert.deepEqual(resolved.result.value.pages[0]!.member_refs, ['source:0'], 'synthetic residual members do not leak into compiler ownership');
 assert.deepEqual(new Set(wikiPageEntryIds(resolved.result.value.pages[0]!.body)), new Set([ids[0], ids[7]]));

 const existing = await runPiObjectMergeStage(request('existing', { ...input, pages: input.pages.slice(0, 1), requiredEntries: [ids[0]!] }),
  { target: async () => { throw new Error('No model call needed'); } });
 if (existing.result.kind !== 'pages') throw new Error('Unexpected result');
 assert.deepEqual(existing.result.value.retained_refs, ['source:0']);
 const protectedConcept: WikiStageInput = { ...residualInput, pages: [...residualInput.pages,
  { ref: 'concept', previous: true, role: 'context', page: { id: 'concept:existing', kind: 'concept', title: 'Concept', description: 'Historical explanation', body: `## Explanation\nFact [[${ids[7]}]].` } }] };
 assert.throws(() => validateObjectMergeResult(protectedConcept, { ...empty(), retained_refs: ['source:0'], deferred_entries: [{entry_ref:ids[7]!,reason:'Discard'}] }), /Cue dispositions/);
 assert.throws(() => validateObjectMergeResult(input, { ...empty(), retained_refs: input.pages.map(row => row.ref).slice(0, -1) }), /every original member/);
 const cancelled = new AbortController(); cancelled.abort();
 await assert.rejects(runPiObjectMergeStage({ ...request('abort'), signal: cancelled.signal }, { target }), /abort/i);
 console.log('Pi object merge: bounded serial writing, old identity, residual Cues, checkpoints, corruption, retry and cancellation passed');
} finally { rmSync(root, { recursive: true, force: true }); }
