import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RunArtifactStore } from '../../server/agent-runtime/artifact-store.js';
import { WikiCompiler } from '../../server/wiki/wiki-compiler.js';
import type { SourceNotesSnapshot } from '../../server/notes/contracts.js';
import type { WikiCompilationRequest } from '../../server/wiki/contracts.js';
import type { WikiStageInput } from '../../server/wiki/wiki-stage-contract.js';
import { piObjectUserContext, piObjectMergeUserContext } from '../../server/wiki/pi-object-stage.js';
import { createWikiStageWorkspace } from '../../server/wiki/wiki-stage-workspace.js';
import { createConceptReadCoverage, validatePiConceptFiles } from '../../server/wiki/pi-concept-contract.js';
import { createPageTopicTask } from '../../server/wiki/page-topic-contract.js';
import { wikiPageSections, type WikiPageContent } from '../../server/wiki/wiki-page-contract.js';
import type { WikiNoteEntry } from '../../server/wiki/wiki-edition.js';

const root = mkdtempSync(join(tmpdir(), 'wiki-stage-contract-'));
const id = `entry:${'a'.repeat(24)}`, otherId = `entry:${'b'.repeat(24)}`;
const evidence: WikiNoteEntry = { id, revisionSha256: 'e'.repeat(64), sourceRunId: 'r', sourceId: 'source', sourceTitle: 'Complete Note', canonicalLocator: 'https://example.test', members: [], section: 'Loss', sectionSummary: 'Exact conditions', cue: 'Rate', detail: 'Exact rate 1.45% with all conditions preserved.', anchors: [] };
const first: WikiPageContent = { id: 'entity:first', kind: 'entity', title: 'First', description: 'First mechanism', body: `## Loss\nExact 1.45% [[${id}]]\n\n## Conditions\nConditional [[${id}]]` };
const second: WikiPageContent = { ...first, id: 'entity:second', title: 'Second', body: `## Loss\nDifferent condition [[${otherId}]]` };
const input = (stage: WikiStageInput['stage']): WikiStageInput => ({ stage, key: 'task', language: 'en', goal: { title: 'Methods', description: 'Research' }, entries: [evidence, { ...evidence, id: otherId, cue: 'Conditions' }], pages: [], requiredEntries: [], requiredPages: [], topics: [], sections: [], instructions: 'Use complete evidence', previousRelations: [] });
let serial = 0;
const workspace = (data: WikiStageInput) => createWikiStageWorkspace(data, join(root, `input-${++serial}`));
const work = join(root, 'work');
mkdirSync(join(work, 'pages'), { recursive: true });
function markdown(name: string, body = '## Loss\nExact 1.45% [[N1]]', title = 'Result') {
 writeFileSync(join(work, 'pages', name), `---\ntitle: ${JSON.stringify(title)}\ndescription: "Exact conditions"\n---\n\n${body}`);
}
const empty = () => ({ pages: [] as Array<{ file: string; member_refs: string[] }>, retained_refs: [] as string[], discarded_refs: [] as Array<{ ref: string; reason: string }>, deferred_entries: [] as Array<{ entry_ref: string; reason: string }> });
try {
 markdown('O1.md');
 const single = input('objects'); single.requiredEntries = [id, otherId];
 const ws = workspace(single);
 const noteContext = piObjectUserContext(single, join(root, 'native-note-context'));
 assert.ok(noteContext.includes(evidence.detail));
 assert.ok(!noteContext.includes(id), 'durable entry IDs stay out of agent context');
 ws.read('N1'); ws.read('N2');
 assert.ok(!readFileSync(join(root, 'input-1', 'evidence', 'N1.md'), 'utf8').includes(evidence.revisionSha256));
 const draft = { pages: [{ file: 'pages/O1.md' }], deferred_entries: [{ entry_ref: 'N2', reason: 'Await object placement review' }] };
 const accepted = ws.validate(draft, work);
 assert.equal(accepted.kind, 'pages');
 if (accepted.kind !== 'pages') throw new Error('wrong kind');
 assert.ok(accepted.value.pages[0]!.body.includes(id));
 assert.match(accepted.value.pages[0]!.id, /^entity:[a-f0-9]{24}$/u);
 assert.throws(() => ws.validate({ ...draft, deferred_entries: [] }, work), /silently dropped/u);
 assert.throws(() => ws.validate({ ...draft, extra: true }, work), /unexpected/u);
 assert.throws(() => ws.validate({ ...draft, deferred_entries: [{ entry_ref: 'N1', reason: 'Already cited' }] }, work), /cited/u);
 assert.throws(() => ws.validate({ ...draft, pages: [{ file: '../escape.md' }] }, work), /pages\//u);
 symlinkSync(join(work, 'pages', 'O1.md'), join(work, 'pages', 'alias.md'));
 assert.throws(() => ws.validate({ ...draft, pages: [{ file: 'pages/alias.md' }] }, work), /symlinks/u);
 markdown('Bad.md', `## Loss\nWrong [[${id}]]`);
 assert.throws(() => ws.validate({ ...draft, pages: [{ file: 'pages/Bad.md' }] }, work), /unknown entry/u);
 markdown('Bad.md', '## Loss\nWrong [[N1]] [link](elsewhere)');
 assert.throws(() => ws.validate({ ...draft, pages: [{ file: 'pages/Bad.md' }] }, work), /no links/u);

 // Technical notation is text or code, not HTML, even when it contains angle brackets.
 for (const literal of [
  '<S{id}>', '\\<S{id}\\>', '\\<speaker\\>', '&lt;speaker&gt;',
  '`<speaker>`', '`<script>alert(1)</script>`',
  '`<user@example.org>`', '\\<user@example.org\\>', '`<ftp:files>`',
  '```xml\n<speaker>\n</speaker>\n```', '    <speaker>\n    </speaker>',
 ]) {
  markdown('Literal.md', `## Mechanism\n\n${literal}\n\nSupported notation [[N1]].`);
  const value = ws.validate({ ...draft, pages: [{ file: 'pages/Literal.md' }] }, work);
  assert.ok(value.kind === 'pages' && value.value.pages[0]!.body.includes(literal), 'Validation preserves literal bytes');
 }
 for (const html of ['<speaker>', '<em>text</em>', '<script>alert(1)</script>', '<!-- hidden -->', '<!DOCTYPE html>', '\\\\<speaker>', '<speaker\n name="label">', '> <speaker>', '- <speaker>']) {
  markdown('Html.md', `## Mechanism\n\n${html}\n\nSupported statement [[N1]].`);
  assert.throws(() => ws.validate({ ...draft, pages: [{ file: 'pages/Html.md' }] }, work), /HTML/u);
 }
 for (const link of ['<user@example.org>', '<mailto:user@example.org>', '<ftp:files>']) {
  markdown('Link.md', `## Mechanism\n\n${link} [[N1]].`);
  assert.throws(() => ws.validate({ ...draft, pages: [{ file: 'pages/Link.md' }] }, work), /no links allowed at body line 4, column 1/u);
 }
 markdown('Html.md', '## Mechanism\n\nUnsafe <speaker>. [[N1]]');
 assert.throws(() => ws.validate({ ...draft, pages: [{ file: 'pages/Html.md' }] }, work), error => {
  assert.match(String(error), /pages\/Html.md.*HTML.*body line 4, column 8/u);
  assert.match(String(error), /<speaker>.*escaped text or code/u);
  return true;
 });

 const merge = input('merge-objects');
 merge.pages = [{ ref: 'old:first', page: first, previous: true, role: 'member' }, { ref: 'draft:second', page: second, previous: false, role: 'member' }];
 merge.previousRelations = [{ from: first.id, to: second.id, label: 'contrasts', entryIds: [id] }];
 merge.requiredEntries = [id, otherId];
 const mw = workspace(merge);
 assert.equal(mw.overviews.P1!.relations[0]!.to, 'P2');
 assert.equal(mw.overviews.P2!.relations[0]!.direction, 'incoming');
 assert.ok(!piObjectMergeUserContext(merge).includes(first.id));
 markdown('O1.md', '## Loss\nExact 1.45% [[N1]]\nDifferent condition [[N2]]');
 const merged = { ...empty(), pages: [{ file: 'pages/O1.md', member_refs: ['P1', 'P2'] }] };
 assert.throws(() => mw.validate(merged, work), /read every section/u);
 mw.read('S1'); assert.throws(() => mw.validate(merged, work), /read every section/u);
 mw.read('S2'); mw.read('P2');
 const mergedResult = mw.validate(merged, work);
 assert.equal(mergedResult.kind, 'pages');
 if (mergedResult.kind !== 'pages') throw new Error('wrong kind');
 assert.equal(mergedResult.value.pages[0]!.id, first.id);
 assert.deepEqual(mergedResult.value.pages[0]!.member_refs, ['old:first', 'draft:second']);
 assert.throws(() => mw.validate({ ...empty(), discarded_refs: [{ ref: 'P1', reason: 'discard' }], retained_refs: ['P2'] }, work), /previous/u);
 assert.throws(() => mw.validate({ ...empty(), retained_refs: ['P1'], discarded_refs: [{ ref: 'P2', reason: 'discard' }] }, work), /silently dropped/u);
 const retained = workspace(merge).validate({ ...empty(), retained_refs: ['P1', 'P2'] }, work);
 assert.equal(retained.kind, 'pages', 'unchanged candidates need only catalog review');
 markdown('NoOld.md', '## Loss\nDifferent [[N2]]');
 assert.throws(() => mw.validate({ ...merged, pages: [{ file: 'pages/NoOld.md', member_refs: ['P1', 'P2'] }] }, work), error => {
  assert.match(String(error), /previous page citations/u);
  assert.match(String(error), /\.\.\/input\/pages\/P1.md/u);
  return true;
 });

 assert.throws(() => mw.validate({ ...merged, deferred_entries: [
  { entry_ref: 'N1', reason: 'Already part of the same object' }, { entry_ref: 'N2', reason: 'An evaluation detail' },
 ] }, work), error => {
  assert.match(String(error), /deferred_entries\[0\].*N1/);
  assert.match(String(error), /deferred_entries\[1\].*N2/);
  return true;
 }, 'one feedback turn lists every cited/deferred conflict instead of spending all retries on the first rows');

 const concept = { ...input('concepts'), pages: merge.pages.map(row => ({ ...row, role: 'context' as const })), requiredPages: ['old:first', 'draft:second'] };
 const cw = workspace(concept);
 const considered = { pages: [], considered_pages: [{ page_ref: 'P1', reason: 'covered already' }, { page_ref: 'P2', reason: 'no reusable mechanism' }] };
 assert.throws(() => cw.validate(considered, work), /read every section/u);
 cw.read('P1'); cw.read('P2');
 assert.equal(cw.validate(considered, work).kind, 'pages');
 assert.throws(() => cw.validate({ ...considered, considered_pages: considered.considered_pages.slice(0, 1) }, work), /exactly once/u);
 const residualInput = { ...merge, unplacedEntries: [{ entryId: otherId, reason: 'Await placement' }], pages: [merge.pages[0]!] };
 const residual = workspace(residualInput);
 const resolveResidual = { ...empty(), retained_refs: ['P1'], deferred_entries: [{ entry_ref: 'N2', reason: 'Outside the object scope after full review' }] };
 assert.throws(() => residual.validate(resolveResidual, work), /read every unplaced Cue/u);
 residual.read('N2');
 assert.equal(residual.validate(resolveResidual, work).kind, 'pages');
 const historicalConcept = { ...second, id: 'concept:legacy', kind: 'concept' as const, title: 'Historical explanation' };
 const protectedResidual = workspace({ ...residualInput, pages: [...residualInput.pages,
  { ref: 'history:concept', page: historicalConcept, previous: true, role: 'context' }] });
 protectedResidual.read('N2');
 assert.throws(() => protectedResidual.validate(resolveResidual, work), /cannot discard a Cue cited by a historical concept/u,
  'A legacy concept-only Cue must be placed in objects rather than removed from historical knowledge');
 const downstream = workspace({ ...concept, stage: 'concepts' });
 assert.throws(() => downstream.read('N2'), /Cue details are not available/u);
 assert.throws(() => downstream.validate({ ...considered, deferred_entries: [] }, work), /unexpected/u);
 const plan = workspace({ ...concept, stage: 'plan-concepts' });
 assert.throws(() => plan.validate({ concept_jobs: [], object_only: [] }, work), /Pi native-read contract/u,
  'planning cannot bypass native file-read validation through the legacy workspace');
 const audit = workspace({ ...concept, stage: 'audit-concepts' });
 assert.throws(() => audit.validate({}, work), /Pi native-read contract/u);

 const topic = { id: 'long-topic-id', title: 'Loss', intent: 'Understand objectives', questions: [], include: [], exclude: [] };
 const ti = { ...concept, stage: 'topic' as const, topics: [topic], sections: wikiPageSections([first, second]).map(section => ({ ...section, entryIds: section.pageId === first.id ? [id] : [otherId] })) };
 const tw = workspace(ti);
 assert.throws(() => workspace({ ...ti, sections: ti.sections.map(section => ({ ...section, entryIds: [] })) }), /section evidence/u);
 const match = { topic_ref: 'T1', matches: [{ section_ref: 'S1', reason: 'Loss details' }], gaps: [] };
 assert.throws(() => tw.validate(match, work), /read section/u);
 tw.read('P1');
 const nav = tw.validate(match, work);
 assert.equal(nav.kind, 'topic');
 if (nav.kind !== 'topic') throw new Error('wrong kind');
 assert.equal(nav.topicId, topic.id); assert.equal(nav.matches[0]!.sectionRef, ti.sections[0]!.ref);
 const unsupported = { ...first, body: first.body + '\n\n## Unsubstantiated\nAn introductory claim.' };
 const unsupportedInput = { ...ti, pages: [{ ...ti.pages[0]!, page: unsupported }], requiredPages: [], sections: wikiPageSections([unsupported]) };
 const uw = workspace(unsupportedInput); uw.read('S3');
 assert.throws(() => uw.validate({ ...match, matches: [{ section_ref: 'S3', reason: 'Sounds relevant' }] }, work), /own Cue evidence/u);
 const tp = workspace({ ...ti, stage: 'plan-topics' });
 assert.equal(tp.validate({ jobs: [{ topic_ref: 'T1', instructions: 'Find Loss' }] }, work).kind, 'topic-plan');
 assert.throws(() => tp.validate({ jobs: [] }, work), /exactly once/u);

 const longPage = { ...first, body: `## Long\n${'Complete condition. '.repeat(1500)}1.45% [[${id}]]\n\n## End\nMore [[${id}]]` };
 const lw = workspace({ ...concept, pages: [{ ...concept.pages[0]!, page: longPage }], requiredPages: ['old:first'] });
 assert.match(lw.read('P1'), /Read ALL complete sections/u);
 assert.deepEqual(lw.receipts().pages, []);
 assert.match(lw.read('S1'), /1\.45%/u); lw.read('S2');
 assert.deepEqual(lw.receipts().pages, ['P1']);
 assert.equal(JSON.parse(lw.search('1.45%')).total, 1);
 const many = { ...first, body: Array.from({ length: 45 }, (_, i) => `## Match ${i}\nRate [[${id}]]`).join('\n\n') };
 const sw = workspace({ ...concept, pages: [{ ...concept.pages[0]!, page: many }], requiredPages: [] });
 const results = JSON.parse(sw.search('Rate'));
 assert.equal(results.total, 45); assert.equal(results.matches.length, 12); assert.equal(results.next_offset, 12);
 assert.deepEqual(sw.receipts().pages, [], 'search never claims reading');
 assert.equal(JSON.parse(sw.search({ query: 'Rate', offset: 40, limit: 12 })).matches.length, 5);
 assert.equal(JSON.parse(sw.search({ terms: ['Rate', 'absent'], mode: 'any' })).total, 45);
 assert.equal(JSON.parse(sw.search({ terms: ['Rate', 'absent'], mode: 'all' })).total, 0);
 assert.equal(JSON.parse(sw.search('Rate absent')).total, 0, 'A query is a contiguous phrase, not an implicit OR');
 assert.equal(JSON.parse(sw.search('ＲＡＴＥ')).total, 45, 'NFKC and case normalization preserve fullwidth search');
 assert.throws(() => sw.search({ query: 'Rate', terms: ['Rate'] }), /exactly one/u);
 assert.throws(() => sw.search({ query: 'Rate', page_ref: 'P999' }), /unknown page_ref/u);
 assert.throws(() => sw.search({ query: 'Rate', limit: 41 }), /limit/u);
 markdown('O1.md');
 const hugeInput = { ...single, entries: [{ ...evidence, detail: 'Full condition. '.repeat(5000) + '1.45%' }], requiredEntries: [id] };
 const hugeNote = workspace(hugeInput);
 assert.equal(JSON.parse(piObjectUserContext(hugeInput, join(root, 'native-huge-note-context'))).entries[0].detail, hugeInput.entries[0]!.detail, 'large Notes use the same complete native Pi input');
 assert.throws(() => hugeNote.validate({ pages: draft.pages, deferred_entries: [] }, work), /read every Cornell/u);
 assert.match(hugeNote.read('N1'), /1\.45%/u);
 assert.equal(hugeNote.validate({ pages: draft.pages, deferred_entries: [] }, work).kind, 'pages');
 // Exercise real compiler stage boundaries with actual Markdown/alias validation.
 // Deferred Note material is resolved in objects before concept extraction.
 const snapshot: SourceNotesSnapshot = { schema_version: 1, snapshot_id: 'snapshot', run_id: 'source-run',
  pipeline: { id: 'note', version: '1', sha256: 'a'.repeat(64) }, source_bundle_refs: [], notes: [{
   note: { schema_version: 1, source_id: 'source:method', sections: [{ section_title: 'Loss', summary: 'Conditions', cue_notes: [{ cue: 'Rate', note: 'Exact 1.45% under condition A', topic_refs: [], evidence: [{ source_path: 'source.md', content_sha256: 'b'.repeat(64), start_line: 1, end_line: 2 }] }] }] },
   title: 'Method note', canonical_locator: 'https://example.test/method', provider_id: 'test', provenance_ref: 'provider:test', source_revision_sha256: 'c'.repeat(64), members: [],
  }] };
 const request = (name: string, previous?: string): WikiCompilationRequest => {
  const base = join(root, name), goalDir = join(base, 'goal');
  if (previous) cpSync(previous, join(goalDir, 'wiki', 'knowledge'), { recursive: true });
  const store = new RunArtifactStore(join(base, 'run'));
  const incoming = structuredClone(snapshot);
  if (previous) incoming.notes[0]!.note.sections[0]!.cue_notes.push({ ...incoming.notes[0]!.note.sections[0]!.cue_notes[0]!,
   cue: 'Qualification', note: 'The measured rate is supported only under condition A.' });
  const artifact = store.publishText(JSON.stringify(incoming), 'input/notes.json');
  return { goalDir, runId: name, runDirectory: store.root, controlDirectory: join(base, 'control'),
   notesSnapshot: { relative_path: artifact.relativePath, sha256: artifact.sha256, byte_length: artifact.byteLength },
   goalContext: { title: 'Methods', description: 'Understand methods' },
   topicPlan: { schema_version: 1, goal_id: 'goal', revision: 'v1', status: 'active', topics: [topic] },
   env: { TELOMI_WIKI_COMPILATION_MODEL: 'test/root', TELOMI_PRIME_AGENT_CHILD_MODEL: 'test/child', TELOMI_WIKI_COMPILATION_THINKING_LEVEL: 'low' }, signal: new AbortController().signal };
 };
 const proposals: string[] = [];
 const compiler = new WikiCompiler({ runStage: async ({ input: stage, workRoot }) => {
  if (stage.stage === 'curate-evidence') return { result: { kind: 'evidence-curation', decisions: stage.requiredEntries.map(entryId => ({ entryId, action: 'adopt', reason: 'Supported method evidence' })) },
   usage: { inputTokens: 1, outputTokens: 1, costUsd: 0, calls: 1 }, sessionPaths: [] };
  if (stage.stage === 'page-topics') {
   const task = createPageTopicTask(stage);
   const result = { kind: 'page-topics' as const, sections: task.validate({ sections: stage.sections.map((_, index) => ({
    section_ref: `S${index + 1}`, matches: [{ topic_ref: 'T1', reason: 'Explains Loss' }],
   })) }) };
   return { result, usage: { inputTokens: 1, outputTokens: 1, costUsd: 0, calls: 1 }, sessionPaths: [] };
  }
  const w = createWikiStageWorkspace(stage, join(workRoot, 'input'));
  const out = join(workRoot, 'output'); mkdirSync(join(out, 'pages'), { recursive: true });
  let manifest: unknown;
  const pageAliases = stage.pages.map((p, i) => ({ alias: `P${i + 1}`, ...p }));
  const members = pageAliases.filter(p => p.role === 'member');
  if (stage.stage === 'objects') {
   stage.entries.forEach((_, index) => w.read(`N${index + 1}`));
   manifest = { pages: [], deferred_entries: stage.entries.map((_, i) => ({ entry_ref: `N${i + 1}`, reason: 'Await object placement' })) };
  }
  if (stage.stage === 'merge-objects') {
   for (const row of stage.unplacedEntries ?? []) w.read(`N${stage.entries.findIndex(entry => entry.id === row.entryId) + 1}`);
   members.forEach(p => w.read(p.alias));
   writeFileSync(join(out, 'pages', 'O1.md'), `---\ntitle: Source method\ndescription: Conditional method record\n---\n\n## Loss\nExact 1.45% under condition A ${stage.entries.map((_, i) => `[[N${i + 1}]]`).join(' ')}`);
   manifest = { ...empty(), pages: [{ file: 'pages/O1.md', member_refs: members.map(p => p.alias) }] };
  }
  if (stage.stage === 'plan-concepts') manifest = { concept_jobs: [{ page_refs: pageAliases.filter(p => p.page.kind === 'entity').map(p => p.alias), question: 'How does the method work?', scope: 'Explain the source-supported method and conditions', target_ref: null }], object_only: [] };
  if (stage.stage === 'audit-concepts') {
   const concepts = pageAliases.filter(p => p.page.kind === 'concept');
   manifest = { reviewed_pages: concepts.map(p => ({ page_ref: p.alias, reason: 'Compared mechanism and scope' })),
    conflict_groups: concepts.length > 1 ? [{ page_refs: concepts.map(p => p.alias), reason: 'Same method and conditions need one canonical explanation' }] : [], discarded_refs: [] };
  }
  if (stage.stage === 'concepts') {
   pageAliases.forEach(p => w.read(p.alias));
   writeFileSync(join(out, 'pages', 'C1.md'), `---\ntitle: Method\ndescription: Conditional method\n---\n\n## Loss\nExact 1.45% under condition A ${stage.entries.map((_, i) => `[[N${i + 1}]]`).join(' ')}`);
   manifest = { pages: [{ file: 'pages/C1.md' }], considered_pages: pageAliases.filter(p => stage.requiredPages.includes(p.ref)).map(p => ({ page_ref: p.alias, reason: 'Explains conditions' })) };
  }
  if (stage.stage === 'merge-concepts') {
   members.forEach(p => w.read(p.alias));
   if (members.length === 1) manifest = { pages: [], retained_refs: [members[0]!.alias], discarded_refs: [] };
   else {
    writeFileSync(join(out, 'pages', 'C1.md'), `---\ntitle: Method\ndescription: Conditional method\n---\n\n## Loss\nExact 1.45% under condition A ${stage.entries.map((_, i) => `[[N${i + 1}]]`).join(' ')}`);
    manifest = { pages: [{ file: 'pages/C1.md', member_refs: members.map(p => p.alias) }], retained_refs: [], discarded_refs: [] };
   }
  }
  if (stage.stage === 'plan-topics') manifest = { jobs: [{ topic_ref: 'T1', instructions: 'Find Loss' }] };
  if (stage.stage === 'topic') { w.read('S1'); manifest = { topic_ref: 'T1', matches: [{ section_ref: 'S1', reason: 'Explains Loss' }], gaps: [] }; }
  let result;
  if (['plan-concepts', 'concepts', 'audit-concepts', 'merge-concepts'].includes(stage.stage)) {
   const reads = createConceptReadCoverage(stage, join(workRoot, 'input'));
   for (const row of pageAliases) reads.record({ path: `input/pages/${row.alias}.md` },
    { content: [{ type: 'text', text: readFileSync(join(workRoot, 'input', 'pages', `${row.alias}.md`), 'utf8') }] });
   writeFileSync(join(out, 'result.json'), JSON.stringify(manifest));
   result = validatePiConceptFiles(stage, join(workRoot, 'input'), out, reads).result;
  } else result = w.validate(manifest, out);
  if (stage.stage === 'concepts' && result.kind === 'pages') proposals.push(result.value.pages[0]!.id);
  return { result, usage: { inputTokens: 1, outputTokens: 1, costUsd: 0, calls: 1 }, sessionPaths: [] };
 } });
 const edition1 = await compiler.compile(request('version-one'));
 const edition2 = await compiler.compile(request('version-two', edition1.knowledge.absolutePath));
 assert.equal(proposals.length, 2); assert.notEqual(proposals[0], proposals[1], 'proposals have input-version-local identity');
 const finalPages = JSON.parse(readFileSync(join(edition2.knowledge.absolutePath, '.object-first-pages.json'), 'utf8')) as WikiPageContent[];
 assert.equal(finalPages.length, 2); assert.equal(finalPages.find(page => page.kind === 'concept')!.id, proposals[0], 'merging preserves the previous published identity');
 console.log('wiki-compilation contract: aliases, dispositions, safe files, progressive reads, plans and navigation passed');
} finally { rmSync(root, { recursive: true, force: true }); }
