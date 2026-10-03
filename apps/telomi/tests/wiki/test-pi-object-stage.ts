import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acceptPiObjectFiles, piObjectUserContext,
 validatePiObjectFiles, piObjectMergeUserContext, observePiMergeRead,
 validatePiObjectMergeFiles, piResidualCueUserContext, piObjectMergePlanUserContext, validatePiObjectMergePlanFiles } from '../../server/wiki/pi-object-stage.js';
import { createWikiStageWorkspace } from '../../server/wiki/wiki-stage-workspace.js';
import { createSrtAgentSandbox } from '../../server/agent-runtime/srt-agent-sandbox.js';
import { renderAgentPrompt } from '../../server/agent-runtime/prompt-registry.js';
import type { WikiStageInput } from '../../server/wiki/wiki-stage-contract.js';

const root = mkdtempSync(join(tmpdir(), 'pi-object-files-'));
const inputRoot = join(root, 'input'), work = join(root, 'work');
mkdirSync(inputRoot); mkdirSync(join(work, 'pages'), { recursive: true });
const a = `entry:${'a'.repeat(24)}`, b = `entry:${'b'.repeat(24)}`;
const entries = [a, b].map((id, index) => ({ id, revisionSha256: 'r', sourceRunId: 'run', sourceId: 'source', sourceTitle: 'Source', canonicalLocator: '', members: [],
 section: 'Methods', sectionSummary: 'Conditions', cue: `Cue ${index}`, detail: `Detail ${index}`, anchors: [] }));
const input: WikiStageInput = { stage: 'objects', key: 'objects/demo', language: 'en', goal: { title: 'Study methods', description: '' }, entries,
 pages: [], requiredEntries: [a, b], requiredPages: [], previousRelations: [], instructions: '', topics: [], sections: [] };
const page = join(work, 'pages/O1.md'), manifest = join(work, 'result.json');
try {
 const piSystem = renderAgentPrompt('wiki', 'wiki-compilation', 'system', {}, 'objects-pi').content;
 assert.match(piSystem, /First identify the research subject or subjects/);
 assert.match(piSystem, /Use the write tool to create one file per object/);
 const user = piObjectUserContext(input, inputRoot);
 assert.deepEqual(Object.keys(JSON.parse(user)), ['output_language', 'goal', 'entries']);
 assert.ok(!user.includes('Create research object pages'));
 writeFileSync(page, '---\ntitle: "Method A"\ndescription: "A method with conditions"\n---\n\n## Mechanism\nEvidence [[N1]].\n');
 writeFileSync(manifest, JSON.stringify({ pages: [{ file: 'pages/O1.md' }], deferred_entries: [] }));
 assert.throws(() => validatePiObjectFiles(input, inputRoot, work), /silently dropped; missing: \[N2\]/);
 writeFileSync(page, '---\ntitle: "Method A"\ndescription: "A method with conditions"\n---\n\n## Mechanism\nEvidence [[N1]] and [[N2]].\n');
 assert.equal(validatePiObjectFiles(input, inputRoot, work).kind, 'pages');
 writeFileSync(page, '---\ntitle: "Method A"\n---\n\n## Mechanism\nEvidence [[N1]] and [[N2]].\n');
 assert.throws(() => validatePiObjectFiles(input, inputRoot, work), /frontmatter.*description/);
 writeFileSync(manifest, '{"pages":[');
 assert.throws(() => validatePiObjectFiles(input, inputRoot, work), /output\.result\.json:.*JSON/);
 const prompts: string[] = [], rejected: string[] = [];
 const repaired = await acceptPiObjectFiles(async (text, repair) => {
  prompts.push(text);
  if (repair) writeFileSync(manifest, JSON.stringify({ pages: [{ file: 'pages/O1.md' }], deferred_entries: [] }));
 }, () => {
  if (prompts.length === 2) writeFileSync(page, '---\ntitle: "Method A"\ndescription: "A method with conditions"\n---\n\n## Mechanism\nEvidence [[N1]] and [[N2]].\n');
  return validatePiObjectFiles(input, inputRoot, work);
 }, 'Build the pages', (_turn, error) => rejected.push(error));
 assert.equal(repaired.kind, 'pages');
 assert.equal(prompts.length, 2);
 assert.match(rejected[0]!, /output\.result\.json/);
 assert.ok(prompts[1]!.includes(rejected[0]!));
 const threePrompts: string[] = [], threeErrors: string[] = [];
 const thirdAccepted = await acceptPiObjectFiles(async text => { threePrompts.push(text); }, () => {
  if (threePrompts.length < 3) throw new Error(`remaining violation ${threePrompts.length}`);
  return repaired;
 }, 'Build the pages', (_turn, error) => threeErrors.push(error), 3);
 assert.equal(thirdAccepted, repaired);
 assert.equal(threePrompts.length, 3);
 assert.ok(threePrompts[1]!.includes(threeErrors[0]!));
 assert.ok(threePrompts[2]!.includes(threeErrors[1]!));
 let exhaustedTurns = 0;
 await assert.rejects(acceptPiObjectFiles(async () => { exhaustedTurns++; }, () => {
  throw new Error('unresolved violation');
 }, 'Build the pages', () => {}, 3), /3 attempts.*unresolved violation/);
 assert.equal(exhaustedTurns, 3, 'three attempts includes the initial submission');
 const sandbox = createSrtAgentSandbox({ id: 'pi-object-test', role: 'wiki.object_builder', workDirectory: work,
  readonlyMounts: [], activeTools: ['read', 'write', 'edit'], network: 'deny' });
 assert.deepEqual(sandbox.tools.map(tool => tool.name), ['read', 'write', 'edit']);
 await sandbox.close();
 const mergeInput: WikiStageInput = { ...input, stage: 'merge-objects', pages: [
  { ref: 'old:a', previous: true, role: 'member', page: { id: 'entity:a', kind: 'entity', title: 'Method A', description: 'Existing method', body: `## Mechanism\nEvidence [[${a}]].` } },
  { ref: 'new:b', previous: false, role: 'member', page: { id: 'entity:b', kind: 'entity', title: 'Method A draft', description: 'New observations', body: `## Observations\nEvidence [[${b}]].` } },
 ] };
 const mergeRoot = join(root, 'merge-input');
 createWikiStageWorkspace(mergeInput, mergeRoot);
 // Follow the Runtime's paths, not inferred filenames for section or Cue aliases.
 for (const ref of ['P1', 'P2']) {
  const index = JSON.parse(readFileSync(join(mergeRoot, `indexes/${ref}.json`), 'utf8'));
  const lines = readFileSync(join(mergeRoot, `pages/${ref}.md`), 'utf8').split('\n');
  assert.equal(index.file, `pages/${ref}.md`);
  assert.ok(index.sections.every((section: { start_line?: number; end_line?: number }) =>
   Number.isInteger(section.start_line) && Number.isInteger(section.end_line)), 'Section locations need staged-file line ranges');
  for (const section of index.sections) {
   const body = lines.slice(section.start_line - 1, section.end_line).join('\n');
   assert.ok(body.startsWith(`## ${section.heading}`));
   assert.deepEqual(section.entry_refs, [...body.matchAll(/\[\[(N\d+)\]\]/gu)].map(match => match[1]));
   section.entry_refs.forEach((cue: string) => assert.equal(index.cue_files[cue], null,
    'Target writing receives inline citations, without standalone Cue files'));
  }
 }
 const mergeUser = piObjectMergeUserContext(mergeInput);
 assert.match(mergeUser, /P1 \| existing/);
 assert.match(mergeUser, /P2 \| incoming/);
 assert.match(mergeUser, /wiki\/indexes\/P1.json \| wiki\/pages\/P1.md/);
 assert.match(mergeUser, /cue_files.*null means this stage supplies only the page's inline citation/);
 const writerSystem = renderAgentPrompt('wiki', 'wiki-compilation', 'system', {}, 'write-object-target-pi').content;
 assert.match(writerSystem, /Open only the file paths listed in the catalog or indexes/);
 const mappedRoot = join(root, 'mapped-input');
 const mappedInput: WikiStageInput = { ...mergeInput, pages: [{ ...mergeInput.pages[0]!,
  page: { ...mergeInput.pages[0]!.page, body: `Preamble.\n\n## Repeated\nEvidence [[${a}]].\n\n\`\`\`md\n## Code heading\n\`\`\`\n\n## Repeated\nEvidence [[${a}]].\n` } }, mergeInput.pages[1]!] };
 createWikiStageWorkspace(mappedInput, mappedRoot);
 const mappedSandbox = createSrtAgentSandbox({ id: 'mapped-object-test', role: 'wiki.object_builder', workDirectory: work,
  readonlyMounts: [{ hostPath: mappedRoot, guestPath: '/work/wiki', access: 'read-only' }],
  activeTools: ['read', 'write', 'edit'], network: 'deny' });
 try {
  const read = mappedSandbox.tools.find(tool => tool.name === 'read')!;
  const reads = new Map<string, Set<number>>(), signal = new AbortController().signal;
  const parameters = { path: '/work/wiki/indexes/P1.json' };
  const indexResult = await read.execute('mapped-index', parameters, signal, () => undefined);
  observePiMergeRead(mappedRoot, reads, parameters, indexResult);
  assert.equal(reads.size, 0, 'Reading an index does not certify a page read');
  const index = JSON.parse(indexResult.content.filter(block => block.type === 'text').map(block => block.text).join('\n'));
  assert.deepEqual(index.sections.map((section: { heading: string }) => section.heading), ['Repeated', 'Repeated']);
  for (const section of index.sections) {
   const parameters = { path: `/work/wiki/${index.file}`, offset: section.start_line,
    limit: section.end_line - section.start_line + 1 };
   const result = await read.execute(`mapped-${section.section_ref}`, parameters, signal, () => undefined);
   assert.match(result.content.filter(block => block.type === 'text').map(block => block.text).join('\n'), /^## Repeated\nEvidence \[\[N1\]\]/);
   observePiMergeRead(mappedRoot, reads, parameters, result);
  }
  assert.notEqual(reads.get('P1')!.size, readFileSync(join(mappedRoot, index.file), 'utf8').split('\n').length,
   'Chapter ranges do not replace complete reads of frontmatter, preamble and trailing lines');
 } finally { await mappedSandbox.close(); }
 assert.doesNotThrow(() => piObjectMergeUserContext({ ...mergeInput,
  pages: [...Array.from({ length: 8 }, () => mergeInput.pages[0]!), mergeInput.pages[1]!] }));
 assert.throws(() => piObjectMergeUserContext({ ...mergeInput, pages: Array.from({ length: 5 }, () => mergeInput.pages[1]!) }), /1 to 4 incoming/);
 const plannerUser = JSON.parse(piObjectMergePlanUserContext(mergeInput));
 assert.deepEqual(Object.keys(plannerUser), ['output_language', 'goal', 'catalog']);
 assert.equal(plannerUser.catalog[0].file, 'wiki/pages/P1.md');
 assert.ok(!JSON.stringify(plannerUser).includes(a));
 const planRow = { action: 'update', target_ref: 'P1', page_refs: ['P1', 'P2'], reason: 'Same independently identifiable method' };
 writeFileSync(manifest, JSON.stringify({ jobs: [planRow] }));
 const mergePlan = validatePiObjectMergePlanFiles(mergeInput, work);
 assert.equal(mergePlan.kind, 'object-target-plan');
 if (mergePlan.kind === 'object-target-plan') assert.deepEqual(mergePlan.jobs[0]!.pageRefs, ['old:a', 'new:b']);
 writeFileSync(manifest, JSON.stringify({ jobs: [] }));
 assert.throws(() => validatePiObjectMergePlanFiles(mergeInput, work), /missing: \[P2\]/);
 writeFileSync(manifest, JSON.stringify({ jobs: [planRow, { ...planRow, action: 'retain', target_ref: null, page_refs: ['P2'] }] }));
 assert.throws(() => validatePiObjectMergePlanFiles(mergeInput, work), /also assigned/);
 writeFileSync(manifest, JSON.stringify({ jobs: [{ ...planRow, page_refs: ['P9'] }] }));
 assert.throws(() => validatePiObjectMergePlanFiles(mergeInput, work), /unknown or context-only/);
 writeFileSync(manifest, JSON.stringify({ jobs: [{ ...planRow, page_refs: ['P1'] }] }));
 assert.throws(() => validatePiObjectMergePlanFiles(mergeInput, work), /existing-only jobs/);
 writeFileSync(manifest, JSON.stringify({ jobs: [{ ...planRow, reason: ' ' }] }));
 assert.throws(() => validatePiObjectMergePlanFiles(mergeInput, work), /specific reason/);
 writeFileSync(manifest, JSON.stringify({ jobs: [planRow], discarded_refs: ['P1'] }));
 assert.throws(() => validatePiObjectMergePlanFiles(mergeInput, work), /expected exactly/);
 const mergeReads = new Map<string, Set<number>>();
 writeFileSync(manifest, JSON.stringify({ pages: [{ file: 'pages/O1.md', member_refs: ['P1', 'P2'] }], retained_refs: [], discarded_refs: [], deferred_entries: [] }));
 assert.throws(() => validatePiObjectMergeFiles(mergeInput, mergeRoot, work, mergeReads), /complete incoming page P2/);
 const observe = (ref: string, offset = 1, limit?: number) => {
  const lines = readFileSync(join(mergeRoot, `pages/${ref}.md`), 'utf8').split('\n');
  observePiMergeRead(mergeRoot, mergeReads, { path: `wiki/pages/${ref}.md`, offset, limit },
   { content: [{ type: 'text', text: lines.slice(offset - 1, limit ? offset - 1 + limit : undefined).join('\n') }] });
 };
 observe('P2');
 observe('P1', 1, 2);
 assert.throws(() => validatePiObjectMergeFiles(mergeInput, mergeRoot, work, mergeReads), /read every section of P1/);
 observe('P1', 3);
 const acceptedMerge = validatePiObjectMergeFiles(mergeInput, mergeRoot, work, mergeReads);
 assert.deepEqual(acceptedMerge.completePageReads, ['P2', 'P1']);
 assert.equal(acceptedMerge.result.kind, 'pages');
 if (acceptedMerge.result.kind === 'pages') {
  assert.equal(acceptedMerge.result.value.pages[0]!.id, 'entity:a');
  assert.match(acceptedMerge.result.value.pages[0]!.body, new RegExp(a));
  assert.match(acceptedMerge.result.value.pages[0]!.body, new RegExp(b));
 }
 const historicalPending = { ...mergeInput.pages[1]!, ref: 'history:b', previous: true, role: 'context' as const,
  page: { ...mergeInput.pages[1]!.page, id: 'concept:history', kind: 'concept' as const } };
 const pendingInput: WikiStageInput = { ...mergeInput,
  pages: [{ ...mergeInput.pages[0]!, role: 'context' }, historicalPending], requiredEntries: [b],
  unplacedEntries: [{ entryId: b, reason: 'Not yet in objects' }] };
 assert.match(piResidualCueUserContext(pendingInput), /Detail 1/);
 const pendingContext = JSON.parse(piResidualCueUserContext(pendingInput));
 assert.deepEqual(pendingContext.cues[0].historical_concept_refs, ['P2']);
 assert.deepEqual(pendingContext.required_object_adoption_refs, ['N2']);
 assert.ok(pendingContext.catalog.every((row: { status: string }) => row.status === 'context_only'));
 const mixedPending = { ...pendingInput, requiredEntries: [a, b],
  unplacedEntries: [{ entryId: a, reason: 'No accepted object yet' }, { entryId: b, reason: 'Historical concept evidence' }] };
 assert.deepEqual(JSON.parse(piResidualCueUserContext(mixedPending)).required_object_adoption_refs, ['N2'],
  'mandatory adoption is derived from historical concept usage, not every unplaced Cue');
 const residualSystem = renderAgentPrompt('wiki', 'wiki-compilation', 'system', {}, 'resolve-object-cues-pi').content;
 assert.match(residualSystem, /Adoption is recorded only by inline \[\[N#\]\] citations/);
 assert.match(residualSystem, /Every pages\[\]\.member_refs is \[\]/);
 assert.match(residualSystem, /"deferred_entries":\[\]/);
 createWikiStageWorkspace(pendingInput, mergeRoot);
 const pendingIndex = JSON.parse(readFileSync(join(mergeRoot, 'indexes/P2.json'), 'utf8'));
 assert.equal(pendingIndex.cue_files.N2, 'evidence/N2.md');
 assert.match(readFileSync(join(mergeRoot, pendingIndex.cue_files.N2), 'utf8'), /Detail 1/,
  'Available residual Cue pointers resolve to the actual committed input file');
 writeFileSync(page, '---\ntitle: "Method B"\ndescription: "Additional source record"\n---\n\n## Mechanism\nEvidence [[N2]].\n');
 writeFileSync(manifest, JSON.stringify({ pages: [{ file: 'pages/O1.md', member_refs: [] }], retained_refs: [], discarded_refs: [], deferred_entries: [] }));
 const pendingResolved = validatePiObjectMergeFiles(pendingInput, mergeRoot, work, new Map(), true);
 writeFileSync(manifest, JSON.stringify({ pages: [{ file: 'pages/O1.md', member_refs: ['N2'] }], retained_refs: [], discarded_refs: [], deferred_entries: [] }));
 assert.throws(() => validatePiObjectMergeFiles(pendingInput, mergeRoot, work, new Map(), true), /unknown or context-only member N2/,
  'Cue aliases never become consumable page members');
 writeFileSync(manifest, JSON.stringify({ pages: [{ file: 'pages/O1.md', member_refs: [] }], retained_refs: [], discarded_refs: [],
  deferred_entries: [{ entry_ref: 'N2', reason: 'Included in the authored draft' }] }));
 assert.throws(() => validatePiObjectMergeFiles(pendingInput, mergeRoot, work, new Map(), true), /cited Entry cannot also be deferred/,
  'adopted Cues cannot appear in the final non-adoption ledger');
 writeFileSync(manifest, JSON.stringify({ pages: [], retained_refs: [], discarded_refs: [], deferred_entries: [{ entry_ref: 'N2', reason: 'Only a detail' }] }));
 assert.throws(() => validatePiObjectMergeFiles(pendingInput, mergeRoot, work, new Map(), true), error => {
  assert.match(String(error), /historical concept.*N2/);
  assert.match(String(error), /wiki\/pages\/P2.md/); return true;
 }, 'historical detail feedback names the real Pi source path');
 assert.equal(pendingResolved.result.value.pages.length, 1, 'resolving pending Cues does not require rewriting read-only old objects');
 assert.deepEqual(pendingResolved.result.value.pages[0]!.member_refs, []);
 assert.throws(() => createWikiStageWorkspace({ ...pendingInput, pages: mergeInput.pages.slice(0, 1) }, mergeRoot),
  /required Entries must cover/, 'real members still require full citation coverage');
 writeFileSync(manifest, JSON.stringify({ pages: [{ file: 'pages/O1.md', member_refs: ['P1', 'P2'] }], retained_refs: [], discarded_refs: [], deferred_entries: [] }));
 const extra = `entry:${'c'.repeat(24)}`;
 const aggregateInput: WikiStageInput = { ...mergeInput,
  entries: [...entries, { ...entries[0]!, id: extra }], requiredEntries: [a, b, extra],
  pages: [{ ...mergeInput.pages[0]!, page: { ...mergeInput.pages[0]!.page, body: `## Mechanism\nEvidence [[${a}]] and [[${extra}]].` } }, mergeInput.pages[1]!] };
 createWikiStageWorkspace(aggregateInput, mergeRoot);
 mergeReads.clear(); observe('P1'); observe('P2');
 writeFileSync(page, '---\ntitle: "Method A"\ndescription: "A method with conditions"\n---\n\n## Mechanism\nEvidence [[N3]].\n');
 assert.throws(() => validatePiObjectMergeFiles(aggregateInput, mergeRoot, work, mergeReads), error => {
  const message = String(error);
  assert.match(message, /previous page citations.*P1.*N1/);
  assert.match(message, /silently dropped; missing: \[N1, N2\]/);
  assert.match(message, /wiki\/pages\/P2.md/);
  return true;
 }, 'one repair must see both old and incoming citation losses');
 createWikiStageWorkspace(mergeInput, mergeRoot);
 mergeReads.clear(); observe('P1'); observe('P2');
 writeFileSync(page, '---\ntitle: "Method A"\ndescription: "A method with conditions"\n---\n\n## Mechanism\nEvidence [[N1]].\n');
 writeFileSync(manifest, JSON.stringify({ pages: [{ file: 'pages/O1.md', member_refs: ['P1'] }], retained_refs: ['P2'], discarded_refs: [], deferred_entries: [] }));
 assert.throws(() => validatePiObjectMergeFiles(mergeInput, mergeRoot, work, mergeReads), error => {
  assert.match(String(error), /output.pages\[0\].*pages\/O1.md.*P1/);
  assert.match(String(error), /remove this rewrite/i);
  return true;
 });
 writeFileSync(page, '---\ntitle: "Method A"\ndescription: "A method with conditions"\n---\n\n## Mechanism\nEvidence [[N1]] and [[N2]].\n');
 writeFileSync(join(work, 'pages/O2.md'), '---\ntitle: "Method B"\ndescription: "Another record"\n---\n\n## Mechanism\nEvidence [[N2]].\n');
 writeFileSync(manifest, JSON.stringify({ pages: [
  { file: 'pages/O1.md', member_refs: ['P1', 'P2'] }, { file: 'pages/O2.md', member_refs: ['P2'] },
 ], retained_refs: [], discarded_refs: [], deferred_entries: [] }));
 assert.throws(() => validatePiObjectMergeFiles(mergeInput, mergeRoot, work, mergeReads), error => {
  assert.match(String(error), /duplicate: \[P2\]/);
  assert.match(String(error), /output.pages\[0\].member_refs\[1\] \(pages\/O1.md\)/);
  assert.match(String(error), /output.pages\[1\].member_refs\[0\] \(pages\/O2.md\)/);
  return true;
 });
 writeFileSync(manifest, JSON.stringify({ pages: [], retained_refs: ['P2'], discarded_refs: [], deferred_entries: [] }));
 const retainedMerge = validatePiObjectMergeFiles(mergeInput, mergeRoot, work, mergeReads).result;
 if (retainedMerge.kind === 'pages') assert.deepEqual(retainedMerge.value.retained_refs, ['new:b', 'old:a']);
 writeFileSync(manifest, JSON.stringify({ pages: [], retained_refs: [], discarded_refs: [], deferred_entries: [] }));
 assert.throws(() => validatePiObjectMergeFiles(mergeInput, mergeRoot, work, mergeReads), /missing: \[P2\]/);
 // A truncated response cannot certify the unread final line.
 mergeReads.clear();
 const p2Lines = readFileSync(join(mergeRoot, 'pages/P2.md'), 'utf8').split('\n');
 observePiMergeRead(mergeRoot, mergeReads, { path: '/work/wiki/pages/P2.md' },
  { content: [{ type: 'text', text: p2Lines.slice(0, -1).join('\n') + '\n[Showing lines; continue with offset]' }] });
 assert.throws(() => validatePiObjectMergeFiles(mergeInput, mergeRoot, work, mergeReads), /complete incoming page P2/);
 console.log('Pi object files preserve field-specific validation feedback');
} finally { rmSync(root, { recursive: true, force: true }); }
