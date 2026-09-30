import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderAgentPrompt } from '../../server/agent-runtime/prompt-registry.js';
import type { NoteFirstInput, NoteFirstStage } from '../../server/wiki/note-first-contract.js';
import { createNoteFirstWorkspace } from '../../server/wiki/note-first-workspace.js';
import { createConceptReadCoverage, ReadCoverage, validatePiConceptFiles } from '../../server/wiki/pi-concept-contract.js';

const root = mkdtempSync(join(tmpdir(), 'pi-concept-contract-'));
const a = `entry:${'a'.repeat(24)}`, b = `entry:${'b'.repeat(24)}`;
const base: NoteFirstInput = {
 stage: 'plan-concepts', key: 'concept-contract', language: 'en', goal: { title: 'Mechanisms', description: '' },
 entries: [a, b].map(id => ({ id, revisionSha256: 'r', sourceRunId: 'run', sourceId: 'source', sourceTitle: 'Source', canonicalLocator: '', members: [], section: 'Mechanism', cue: 'Cue', detail: 'Detail', anchors: [] })),
 pages: [
  { ref: 'object:a', previous: false, role: 'context', page: { id: 'entity:a', kind: 'entity', title: 'A', description: 'A mechanism', body: `## Mechanism\nFirst condition [[${a}]].\nA limitation.` } },
  { ref: 'object:b', previous: false, role: 'context', page: { id: 'entity:b', kind: 'entity', title: 'B', description: 'Another mechanism', body: `## Mechanism\nDifferent condition [[${b}]].` } },
  { ref: 'old:c', previous: true, role: 'context', page: { id: 'concept:old', kind: 'concept', title: 'Old explanation', description: 'Existing boundary', body: `## Boundary\nOld knowledge [[${a}]].` } },
 ],
 requiredEntries: [], requiredPages: ['object:a', 'object:b'], previousRelations: [], instructions: '', topics: [], sections: [],
};
function setup(stage: NoteFirstStage, patch: Partial<NoteFirstInput> = {}) {
 const input = { ...base, stage, ...patch }, inputRoot = join(root, `${stage}-${Math.random()}`, 'input'), work = join(inputRoot, '..', 'work');
 mkdirSync(join(work, 'pages'), { recursive: true });
 createNoteFirstWorkspace(input, inputRoot);
 const coverage = createConceptReadCoverage(input, inputRoot);
 const save = (value: unknown) => writeFileSync(join(work, 'result.json'), JSON.stringify(value));
 const read = (ref: string) => coverage.observe({ path: `input/pages/${ref}.md` }, { content: [{ type: 'text', text: readFileSync(join(inputRoot, 'pages', `${ref}.md`), 'utf8') }] });
 const check = () => validatePiConceptFiles(input, inputRoot, work, coverage).result;
 return { input, inputRoot, work, coverage, save, read, check };
}
const job = (question: string, page_refs = ['P1'], target_ref: string | null = null) => ({ question, scope: 'Supported mechanism and limits', page_refs, target_ref });
const prose = (name: string, citations: string) => `---\ntitle: "${name}"\ndescription: "A reusable explanation"\n---\n\n## Mechanism\nSupported distinction ${citations}.\n`;
try {
 const partial = new ReadCoverage(new Map([['/work/input/pages/P1.md', 'one\ntwo\nthree\n']]));
 partial.record({ path: 'input/catalog.md' }, { content: [{ type: 'text', text: 'one\ntwo\nthree\n' }] });
 assert(!partial.full('/work/input/pages/P1.md'), 'Catalog reads cannot establish body coverage');
 partial.record({ path: 'input/pages/P1.md' }, { content: [{ type: 'text', text: 'one\ntw' }] });
 assert(!partial.full('/work/input/pages/P1.md'), 'Truncated partial lines cannot establish body coverage');
 partial.record({ path: 'input/pages/P1.md', offset: 2, limit: 2 }, { content: [{ type: 'text', text: 'two\nthree\n[more lines]' }] });
 assert(partial.full('/work/input/pages/P1.md'), 'Offset continuations accumulate actual complete lines');
 const errorRead = new ReadCoverage(new Map([['/work/input/pages/P1.md', 'one']]));
 errorRead.record({ path: 'input/pages/P1.md' }, { isError: true, content: [{ type: 'text', text: 'one' }] });
 assert(!errorRead.full('/work/input/pages/P1.md'));

 const plan = setup('plan-concepts');
 plan.save({ concept_jobs: [job('Mechanism?', ['P1', 'P2']), job('Boundary?', ['P1'])], object_only: [] });
 const planned = plan.check();
 assert.equal(planned.kind, 'concept-plan');
 if (planned.kind === 'concept-plan') assert.deepEqual(planned.jobs[1]!.pageRefs, ['object:a'], 'Objects can support multiple explanations');
 plan.save({ concept_jobs: [job('Mechanism?', ['P1'])], object_only: [] });
 assert.throws(plan.check, /Every object needs/);
 plan.save({ concept_jobs: [job('Mechanism?')], object_only: [{ page_ref: 'P2', compared_with: ['P1'], reason: 'Comparison lacks explanatory differences' }] });
 assert.throws(plan.check, /read every line.*P2/);
 plan.read('P2'); assert.throws(plan.check, /read every line.*P1/);
 plan.read('P1');
 const excluded = plan.check();
 if (excluded.kind === 'concept-plan') assert.deepEqual(excluded.objectOnly[0]!.comparedWith, ['object:a']);
 plan.save({ concept_jobs: [job('Mechanism?', ['P1'], 'P3'), job('Different boundary?', ['P2'], 'P3')], object_only: [] });
 assert.throws(plan.check, /multiple writers/);
 plan.save({ concept_jobs: [job('Mechanism?', ['P1'], 'P2')], object_only: [] });
 assert.throws(plan.check, /invalid existing concept target/);

 const writer = setup('concepts', { requiredPages: ['object:a'], conceptTask: { question: 'Mechanism?', scope: 'Condition', targetRef: 'old:c' } });
 writer.save({ pages: [], considered_pages: [{ page_ref: 'P1', reason: 'No independently useful explanation' }] });
 assert.throws(writer.check, /read every line.*P1/);
 writer.read('P1'); assert.throws(writer.check, /read every line.*P3/);
 writer.read('P3'); assert.equal(writer.check().kind, 'pages', 'A fully reviewed writer can produce zero candidates');
 writeFileSync(join(writer.work, 'pages/C1.md'), prose('Updated explanation', '[[N1]]'));
 writer.save({ pages: [{ file: 'pages/C1.md' }], considered_pages: [{ page_ref: 'P1', reason: 'Mechanism supports the boundary' }] });
 const written = writer.check();
 if (written.kind === 'pages') assert.equal(written.value.pages[0]!.id, 'concept:old');
 writeFileSync(join(writer.work, 'pages/C1.md'), prose('Updated explanation', '[[N2]]'));
 assert.throws(writer.check, /evidence not returned/);
 writer.read('P2'); assert.throws(writer.check, /Existing target citations/);

 const auditPages = [base.pages[2]!, { ...base.pages[2]!, ref: 'candidate:d', previous: false, page: { ...base.pages[2]!.page, id: 'concept:new', title: 'New explanation' } }, ...base.pages.slice(0, 2)];
 const audit = setup('audit-concepts', { pages: auditPages, requiredPages: [] });
 const reviewed_pages = [{ page_ref: 'P1', reason: 'Historical boundary' }, { page_ref: 'P2', reason: 'Same explanatory question' }];
 audit.save({ reviewed_pages, conflict_groups: [], discarded_refs: [] });
 assert.equal(audit.check().kind, 'concept-audit', 'No conflict needs no forced full-catalog body read');
 audit.save({ reviewed_pages: reviewed_pages.slice(0, 1), conflict_groups: [], discarded_refs: [] });
 assert.throws(audit.check, /every supplied concept/);
 audit.save({ reviewed_pages, conflict_groups: [{ page_refs: ['P1', 'P2'], reason: 'Same question' }], discarded_refs: [] });
 assert.throws(audit.check, /read every line/);
 audit.read('P1'); audit.read('P2');
 const audited = audit.check();
 if (audited.kind === 'concept-audit') assert.deepEqual(audited.conflictGroups[0]!.pageRefs, ['old:c', 'candidate:d']);
 audit.save({ reviewed_pages, conflict_groups: [{ page_refs: ['P1', 'P2'], reason: 'Same question' }], discarded_refs: [{ ref: 'P2', reason: 'No value' }] });
 assert.throws(audit.check, /invalid discard/);
 audit.save({ reviewed_pages, conflict_groups: [], discarded_refs: [{ ref: 'P1', reason: 'No value' }] });
 assert.throws(audit.check, /invalid discard/);
 audit.save({ reviewed_pages, conflict_groups: [], discarded_refs: [{ ref: 'P2', reason: 'No useful explanation' }] });
 assert.equal(audit.check().kind, 'concept-audit');

 const merge = setup('merge-concepts', { pages: auditPages.map((row, index) => ({ ...row, role: index < 2 ? 'member' : 'context' })), requiredPages: [] });
 merge.read('P1'); merge.read('P2'); merge.read('P4');
 writeFileSync(join(merge.work, 'pages/C1.md'), prose('Merged explanation', '[[N2]]'));
 merge.save({ pages: [{ file: 'pages/C1.md', member_refs: ['P1', 'P2'] }], retained_refs: [], discarded_refs: [] });
 assert.throws(merge.check, /previous page citations must survive in its destination/);
 writeFileSync(join(merge.work, 'pages/C1.md'), prose('Merged explanation', '[[N1]] [[N2]]'));
 assert.equal(merge.check().kind, 'pages');
 merge.save({ pages: [], retained_refs: ['P1'], discarded_refs: [{ ref: 'P2', reason: 'Duplicate' }] });
 assert.throws(merge.check, /Conflict merge cannot discard/);
 for (const variant of ['question-plan-pi', 'concepts-pi', 'audit-concepts-pi', 'merge-concepts-pi']) {
  const prompt = renderAgentPrompt('wiki', 'note-first', 'reference', {}, 'concept-common').content + '\n'
   + renderAgentPrompt('wiki', 'note-first', 'system', {}, variant).content;
  assert(prompt.includes('Native read, write and edit are available.'));
  assert(prompt.includes('Write exactly'));
 }
} finally { rmSync(root, { recursive: true, force: true }); }
