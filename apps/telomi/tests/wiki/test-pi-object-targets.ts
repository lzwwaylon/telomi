import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWikiStageWorkspace } from '../../server/wiki/wiki-stage-workspace.js';
import { observePiMergeRead, piObjectMergeUserContext, piObjectMergePlanUserContext, validatePiObjectMergePlanFiles, validatePiObjectMergeFiles } from '../../server/wiki/pi-object-stage.js';
import { targetWriterContext, validateTargetWriter } from '../../server/wiki/pi-object-targets.js';
import { acceptPiFiles } from '../../server/wiki/pi-file-stage.js';
import { renderAgentPrompt } from '../../server/agent-runtime/prompt-registry.js';
import { wikiStageOutputHash } from '../../server/wiki/wiki-stage.js';
import type { WikiStageInput } from '../../server/wiki/wiki-stage-contract.js';

const root = mkdtempSync(join(tmpdir(), 'object-targets-'));
const inputRoot = join(root, 'input'), work = join(root, 'work');
mkdirSync(join(work, 'pages'), { recursive: true });
const a = `entry:${'a'.repeat(24)}`, b = `entry:${'b'.repeat(24)}`;
const input: WikiStageInput = { stage: 'merge-objects', key: 'target', language: 'en', goal: { title: 'Study models', description: '' },
 entries: [a, b].map(id => ({ id, revisionSha256: 'r', sourceRunId: 'run', sourceId: 'source', sourceTitle: 'Source', canonicalLocator: '', members: [], section: 'Mechanism', cue: 'Supported record', detail: 'Evidence', anchors: [] })),
 pages: [
  { ref: 'old:a', previous: true, role: 'member', page: { id: 'entity:a', kind: 'entity', title: 'Model A', description: 'Existing model', body: `## Mechanism\nOld value 30 [[${a}]].` } },
  { ref: 'new:b', previous: false, role: 'member', page: { id: 'entity:b', kind: 'entity', title: 'Model A draft', description: 'New records', body: `## Release\nNeeds 40 GB [[${b}]].` } },
 ], requiredEntries: [a, b], requiredPages: ['old:a'], topics: [], sections: [], instructions: '', previousRelations: [] };
const manifest = join(work, 'result.json'), article = join(work, 'pages/O1.md'), ledger = join(work, 'facts.json');
try {
 const catalog = JSON.parse(piObjectMergePlanUserContext(input)).catalog;
 assert.equal(catalog[0].file, 'wiki/pages/P1.md');
 writeFileSync(manifest, JSON.stringify({ jobs: [{ action: 'update', target_ref: 'P1', page_refs: ['P2', 'P1'], reason: 'Update the existing identity' }] }));
 const plan = validatePiObjectMergePlanFiles(input, work);
 assert.equal(plan.kind, 'object-target-plan');
 if (plan.kind === 'object-target-plan') assert.equal(plan.jobs[0]!.targetRef, 'old:a');
 writeFileSync(manifest, JSON.stringify({ jobs: [{ action: 'update', target_ref: 'P2', page_refs: ['P1', 'P2'], reason: 'Wrong target' }] }));
 assert.throws(() => validatePiObjectMergePlanFiles(input, work), /existing member/);
 createWikiStageWorkspace(input, inputRoot);
 const reads = new Map<string, Set<number>>();
 for (const ref of ['P1', 'P2']) observePiMergeRead(inputRoot, reads, { path: `wiki/pages/${ref}.md` }, { content: [{ type: 'text', text: readFileSync(join(inputRoot, 'pages', `${ref}.md`), 'utf8') }] });
 const facts = [{ source_section_ref: 'S1', claim: 'Old value is 30', entry_refs: ['N1'], destination_heading: 'Record' },
  { source_section_ref: 'S2', claim: 'Requires 40 GB', entry_refs: ['N2'], destination_heading: 'Record' }];
 writeFileSync(article, '---\ntitle: "Model A"\ndescription: "Combined record"\n---\n\n## Record\nOld value 30; requires 40 GB [[N1]][[N2]].\n');
 writeFileSync(manifest, JSON.stringify({ pages: [{ file: 'pages/O1.md', member_refs: ['P2', 'P1'] }], retained_refs: [], discarded_refs: [], deferred_entries: [] }));
 writeFileSync(ledger, JSON.stringify({ facts }));
 const accepted = validatePiObjectMergeFiles(input, inputRoot, work, reads);
 const target = validateTargetWriter(input, work, accepted);
 assert.equal(target.kind, 'object-target-pages');
 if (target.kind !== 'object-target-pages') throw new Error('wrong result kind');
 assert.equal(target.value.pages[0]!.id, 'entity:a');
 assert.equal(target.facts.length, 2);
 const hash = wikiStageOutputHash(work);
 writeFileSync(ledger, JSON.stringify({ facts: facts.slice(0, 1) }));
 assert.notEqual(wikiStageOutputHash(work), hash);
 assert.throws(() => validateTargetWriter(input, work, accepted), /S2.*Release/);
 writeFileSync(ledger, JSON.stringify({ facts: [{ ...facts[0], entry_refs: ['N2'] }, facts[1]] }));
 assert.throws(() => validateTargetWriter(input, work, accepted), /Cue outside/);
 writeFileSync(ledger, JSON.stringify({ facts: facts.map(fact => ({ ...fact, destination_heading: 'Renamed section' })) }));
 assert.throws(() => validateTargetWriter(input, work, accepted), error => {
  assert.match(String(error), /facts\[0\].destination_heading/);
  assert.match(String(error), /facts\[1\].destination_heading/);
  assert.match(String(error), /actual headings: \["Record"\]/);
  return true;
 });
 writeFileSync(ledger, JSON.stringify({ facts }));
 writeFileSync(article, '---\ntitle: "Model A"\ndescription: "Combined record"\n---\n\n## Record\nAccording to P1, old value 30; requires 40 GB [[N1]][[N2]].\n');
 assert.throws(() => validateTargetWriter(input, work, validatePiObjectMergeFiles(input, inputRoot, work, reads)), /temporary task references/);
 // A valid ledger in the article directory must receive precise repair feedback, never silent acceptance.
 const validArticle = '---\ntitle: "Model A"\ndescription: "Combined record"\n---\n\n## Record\nOld value 30; requires 40 GB [[N1]][[N2]].\n';
 const misplacedLedger = join(work, 'pages/facts.json');
 const errors: string[] = [];
 const prompts: string[] = [];
 const repaired = await acceptPiFiles(async (prompt, repair) => {
  prompts.push(prompt);
  if (!repair) {
   rmSync(ledger, { force: true });
   writeFileSync(misplacedLedger, JSON.stringify({ facts }));
   writeFileSync(article, validArticle.replace('Old value', 'According to P1, old value'));
  } else {
   assert.match(prompt, /\/work\/facts\.json/);
   assert.match(prompt, /temporary task references/);
   assert.doesNotMatch(prompt, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
   assert.ok(!existsSync(ledger), 'Runtime must not silently relocate the misplaced ledger');
   assert.deepEqual(JSON.parse(readFileSync(misplacedLedger, 'utf8')), { facts }, 'repair retains the valid source inventory');
   copyFileSync(misplacedLedger, ledger); // Scripted Agent follows the feedback; Runtime never copies output.
   writeFileSync(article, validArticle);
  }
 }, () => validateTargetWriter(input, work, validatePiObjectMergeFiles(input, inputRoot, work, reads)),
 piObjectMergeUserContext(input) + '\n' + targetWriterContext(input), (_turn, error) => errors.push(error), 3);
 assert.equal(prompts.length, 2, 'both independent path and prose violations arrive in the first repair');
 assert.match(errors[0]!, /^\/work\/facts\.json:/);
 assert.ok(repaired.kind === 'object-target-pages' && repaired.facts.length === facts.length);
 for (const contextInput of [input, { ...input, requiredPages: [], pages: input.pages.map(page => ({ ...page, previous: false })) }]) {
  const context = piObjectMergeUserContext(contextInput) + '\n' + targetWriterContext(contextInput);
  for (const path of ['/work/facts.json', '/work/result.json', '/work/pages']) assert.ok(context.includes(path), `User context must state ${path}`);
 }
 const system = renderAgentPrompt('wiki', 'wiki-compilation', 'system', {}, 'write-object-target-pi').content;
 for (const path of ['/work/facts.json', '/work/result.json', '/work/pages/O1.md']) assert.ok(system.includes(path), `System context must agree on ${path}`);
 writeFileSync(ledger, JSON.stringify({ facts: [] }));
 assert.throws(() => validateTargetWriter(input, work, validatePiObjectMergeFiles(input, inputRoot, work, reads)), /source sections\/Cues missing/, 'empty inventory still fails the unchanged coverage contract');
 rmSync(ledger);
 writeFileSync(manifest, JSON.stringify({ pages: [], retained_refs: ['P1', 'P2'], discarded_refs: [], deferred_entries: [] }));
 const veto = validateTargetWriter(input, work, validatePiObjectMergeFiles(input, inputRoot, work, reads));
 assert.ok(veto.kind === 'object-target-pages' && veto.facts.length === 0, 'a supported veto still needs complete reading but no ledger');
 console.log('Object target contracts preserve canonical identity, inventory source facts, bind ledger bytes and reject missing source records');
} finally { rmSync(root, { recursive: true, force: true }); }
