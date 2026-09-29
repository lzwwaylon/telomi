import { lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { hashJson } from '../lib/hash.js';
import { isRecord } from '../lib/values.js';
import { splitFrontmatter } from './model/frontmatter.js';
import { objectFirstEntries, objectFirstSections, type ObjectFirstPage, type ObjectFirstPagesResult } from './object-first-contract.js';
import type { NoteFirstInput, NoteFirstResult } from './note-first-contract.js';
import { searchRows, type SearchRequest, type SearchRow } from './note-first-search.js';

export interface PageOverview {
 page_ref: string; kind: 'entity' | 'concept'; title: string; description: string;
 sections: Array<{ section_ref: string; heading: string }>;
 relations: Array<{ from: string; to: string; label: string; direction: 'incoming' | 'outgoing'; page: Pick<PageOverview, 'page_ref' | 'kind' | 'title' | 'description'> }>;
}

export interface NoteFirstWorkspace {
 userContext: string;
 read(ref: string): string;
 search(query: string | SearchRequest): string;
 searchIndex: SearchRow[];
 overviews: Record<string, PageOverview>;
 validate(output: unknown, workRoot: string): NoteFirstResult;
 receipts(): { pages: string[]; sections: string[]; entries: string[] };
}
function fail(message: string): never { throw new Error(`Note-first output: ${message}`); }
function text(value: unknown, field: string): string {
 if (typeof value !== 'string' || !value.trim()) fail(`${field}: expected non-empty text; received ${JSON.stringify(value) ?? 'undefined'}`);
 return value as string;
}
function shape(value: unknown, keys: string[], field: string): asserts value is Record<string, unknown> {
 if (!isRecord(value)) fail(`${field}: expected object with exactly [${keys.join(', ')}]; received ${JSON.stringify(value) ?? 'undefined'}`);
 const missing = keys.filter(key => !Object.hasOwn(value, key));
 const unexpected = Object.keys(value).filter(key => !keys.includes(key));
 if (missing.length || unexpected.length) fail(`${field}: expected exactly [${keys.join(', ')}]; missing: [${missing.map(key => `${field}.${key}`).join(', ')}]; unexpected: [${unexpected.map(key => `${field}.${key}`).join(', ')}]. Remove unexpected fields; this stage does not accept them, including empty arrays.`);
}
function rows(value: unknown, field: string): unknown[] {
 if (!Array.isArray(value)) fail(`${field}: expected array; received ${JSON.stringify(value) ?? 'undefined'}`);
 return value as unknown[];
}
function strings(value: unknown, field: string): string[] {
 const result = rows(value, field).map((item, index) => text(item, `${field}[${index}]`));
 const duplicates = [...new Set(result.filter((ref, index) => result.indexOf(ref) !== index))];
 if (duplicates.length) fail(`${field}: expected unique references; duplicate: [${duplicates.join(', ')}]`);
 return result;
}
function exact(actual: string[], expected: string[], field: string): void {
 const expectedDuplicates = [...new Set(expected.filter((ref, index) => expected.indexOf(ref) !== index))];
 if (expectedDuplicates.length) fail(`${field}: invalid Runtime expectation; duplicate required references: [${expectedDuplicates.join(', ')}]`);
 const missing = expected.filter(ref => !actual.includes(ref));
 const unexpected = [...new Set(actual.filter(ref => !expected.includes(ref)))];
 const duplicate = [...new Set(actual.filter((ref, index) => actual.indexOf(ref) !== index))];
 if (missing.length || unexpected.length || duplicate.length) fail(`${field}: expected each of [${expected.join(', ')}] exactly once; missing: [${missing.join(', ')}]; unexpected: [${unexpected.join(', ')}]; duplicate: [${duplicate.join(', ')}]`);
}
function outputMarkdown(root: string, file: string, field: string): string {
 try {
  if (!/^pages\/[A-Za-z0-9][A-Za-z0-9_-]{0,100}\.md$/u.test(file)) fail('page file must be pages/<name>.md');
  const base = realpathSync(root);
  const path = resolve(base, file);
  for (const target of [join(base, 'pages'), path]) if (lstatSync(target).isSymbolicLink()) fail('page files and directories cannot be symlinks');
  const local = relative(base, realpathSync(path));
  if (local.startsWith(`..${sep}`) || local === '..') fail('page path escapes work directory');
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.size > 1_000_000) fail('page must be a regular file under 1 MB');
  return readFileSync(path, 'utf8');
 } catch (error) {
  const message = error instanceof Error ? error.message.replace(/^Note-first output: /u, '') : String(error);
  return fail(`${field}: ${message}`);
 }
}

/** Agent-facing aliases stay local; only this Runtime closure sees durable identities. */
export function createNoteFirstWorkspace(input: NoteFirstInput, inputRoot: string): NoteFirstWorkspace {
 if (input.stage === 'page-topics') throw new Error('Page Topic classification uses its direct completion contract');
 const inputVersion = hashJson(input);
 const pages = new Map(input.pages.map((page, i) => [`P${i + 1}`, page]));
 const entries = new Map(input.entries.map((entry, i) => [`N${i + 1}`, entry]));
 const topics = new Map(input.topics.map((topic, i) => [`T${i + 1}`, topic]));
 const entryAliases = new Map([...entries].map(([alias, entry]) => [entry.id, alias]));
 const pageAliases = new Map([...pages].map(([alias, page]) => [page.ref, alias]));
 const calculatedSections = objectFirstSections(input.pages.map(row => row.page));
 const sections = new Map((input.sections.length ? input.sections : calculatedSections).map((section, i) => [`S${i + 1}`, section]));
 for (const section of sections.values()) {
  const actual = calculatedSections.find(candidate => candidate.ref === section.ref);
  const enriched = section as typeof section & { entryIds?: string[] };
  const { entryIds, ...core } = enriched;
  if (!actual || hashJson(actual) !== hashJson(core)) fail('input contains stale or invalid Section');
  if (entryIds) {
   const owner = input.pages.find(row => row.page.id === section.pageId)!;
   const cited = objectFirstEntries(owner.page.body.split('\n').slice(section.startLine - 1, section.endLine).join('\n'));
   exact(entryIds, cited, 'section evidence');
  }
 }
 if (entryAliases.size !== entries.size || pageAliases.size !== pages.size || new Set(input.pages.map(row => row.page.id)).size !== pages.size) fail('input identities must be unique');
 const page = (ref: unknown, field = 'page ref') => pages.get(text(ref, field)) ?? fail(`${field}: unknown page ${String(ref)}; expected an available P alias`);
 const entry = (ref: unknown, field = 'entry ref') => entries.get(text(ref, field)) ?? fail(`${field}: unknown entry ${String(ref)}; expected an available N alias`);
 const topic = (ref: unknown, field = 'topic ref') => topics.get(text(ref, field)) ?? fail(`${field}: unknown Topic ${String(ref)}; expected an available T alias`);
 const section = (ref: unknown, field = 'section ref') => sections.get(text(ref, field)) ?? fail(`${field}: unknown section ${String(ref)}; expected an available S alias`);
 const requiredPages = input.requiredPages.map(ref => pageAliases.get(ref) ?? fail('unknown required page'));
 const requiredEntries = input.requiredEntries.map(id => entryAliases.get(id) ?? fail('unknown required Entry'));
 const unplaced = new Map<string, string>();
 for (const row of input.unplacedEntries ?? []) {
  const ref = entryAliases.get(row.entryId) ?? fail('unknown unplaced Entry');
  if (input.stage !== 'merge-objects' || unplaced.has(ref)) fail('unplaced Entries must be unique and belong to merge-objects');
  unplaced.set(ref, text(row.reason, 'unplaced reason'));
 }
 const visibleEntries = new Set(input.stage === 'objects' ? entries.keys() : input.stage === 'merge-objects' ? unplaced.keys() : []);
 const unplacedIds = [...unplaced.keys()].map(ref => entry(ref).id);
 const entityEntries = new Set(input.pages.filter(row => row.page.kind === 'entity').flatMap(row => objectFirstEntries(row.page.body)));
 const historicalConceptEntries = new Set(input.pages.filter(row => row.previous && row.page.kind === 'concept').flatMap(row => objectFirstEntries(row.page.body)));
 const allowedCitations = input.stage === 'objects' ? new Set(entryAliases.keys())
  : new Set([...entityEntries, ...unplacedIds]);
 if (input.stage === 'merge-objects' && [...entityEntries, ...unplacedIds].some(id => !input.requiredEntries.includes(id))) fail('merge-objects required Entries must cover object citations and unplaced Entries');
 const aliasBody = (body: string) => body.replace(/\[\[(entry:[a-f0-9]{24})\]\]/gu, (_match, id: string) => `[[${entryAliases.get(id) ?? fail('page references unknown Entry')}]]`);
 const pageSections = (id: string) => [...sections].filter(([, candidate]) => candidate.pageId === id);
 const sectionText = (ref: string) => {
  const row = section(ref);
  const owner = input.pages.find(candidate => candidate.page.id === row.pageId)!;
  return aliasBody(owner.page.body.split('\n').slice(row.startLine - 1, row.endLine).join('\n'));
 };
 const entryText = (ref: string) => {
  const row = entry(ref);
  return `# ${ref}: ${row.sourceTitle}\n\n## ${row.section}\n\n${row.sectionSummary ?? ''}\n\n### ${row.cue}\n\n${row.detail}`;
 };
 const pageText = (ref: string) => {
  const row = page(ref).page;
  return `---\ntitle: ${JSON.stringify(row.title)}\ndescription: ${JSON.stringify(row.description)}\n---\n\n${aliasBody(row.body)}`;
 };
 const entriesById = new Map(input.entries.map(row => [row.id, row]));
 const searchIndex: SearchRow[] = [...sections].map(([ref, row]) => {
  const owner = input.pages.find(candidate => candidate.page.id === row.pageId)!;
  const sourceIds = objectFirstEntries(owner.page.body.split('\n').slice(row.startLine - 1, row.endLine).join('\n'));
  return { section_ref: ref, page_ref: pageAliases.get(owner.ref)!, kind: owner.page.kind,
   title: owner.page.title, description: owner.page.description, heading: row.heading, body: sectionText(ref),
   source_titles: [...new Set(sourceIds.map(id => entriesById.get(id)?.sourceTitle).filter((title): title is string => Boolean(title)))] };
 });
 const readSections = new Set<string>();
 const readEntries = new Set<string>();
 const readPages = new Set<string>();
 const fullRead = (ref: string) => readPages.has(ref) || (pageSections(page(ref).page.id).length > 0 && pageSections(page(ref).page.id).every(([key]) => readSections.has(key)));
 const someRead = (ref: string) => readPages.has(ref) || pageSections(page(ref).page.id).some(([key]) => readSections.has(key));
 const pageSummary = (ref: string) => {
  const row = page(ref).page;
  return { page_ref: ref, kind: row.kind, title: row.title, description: row.description };
 };
 const aliasesById = new Map([...pages].map(([ref, row]) => [row.page.id, ref]));
 const overviews: Record<string, PageOverview> = Object.fromEntries([...pages].map(([ref, row]) => [ref, {
  ...pageSummary(ref), sections: pageSections(row.page.id).map(([section_ref, section]) => ({ section_ref, heading: section.heading })), relations: [],
 }]));
 for (const relation of input.previousRelations) {
  const from = aliasesById.get(relation.from), to = aliasesById.get(relation.to);
  if (!from || !to) continue;
  for (const id of relation.entryIds) if (!entryAliases.has(id)) fail('unknown previous relation evidence');
  overviews[from].relations.push({ from, to, label: relation.label, direction: 'outgoing', page: pageSummary(to) });
  overviews[to].relations.push({ from, to, label: relation.label, direction: 'incoming', page: pageSummary(from) });
 }
 const catalog = [...pages].map(([ref, row]) => `${ref} | ${row.page.kind} | ${row.previous ? 'previous' : 'new'} | ${row.role} | ${row.page.title} | ${row.page.description} | indexes/${ref}.json`).join('\n');
 const sectionIndex = [...sections].map(([ref, row]) => `${ref} | ${[...pages].find(([, candidate]) => candidate.page.id === row.pageId)![0]} | ${row.heading}`).join('\n');
 const contracts = {
  objects: '{pages:[{file:"pages/O1.md"}],deferred_entries:[{entry_ref:"N1",reason:"..."}]}',
  'merge-objects': '{pages:[{file:"pages/O1.md",member_refs:["P1"]}],retained_refs:[],discarded_refs:[{ref:"P2",reason:"..."}],deferred_entries:[]}',
  concepts: '{pages:[{file:"pages/C1.md"}],considered_pages:[{page_ref:"P1",reason:"..."}]}',
  'merge-concepts': '{pages:[{file:"pages/C1.md",member_refs:["P1"]}],retained_refs:[],discarded_refs:[]}',
  'plan-concepts': '{jobs:[{page_refs:["P1"],instructions:"..."}]}',
  relations: '{relations:[{from:"P1",to:"P2",label:"...",entry_refs:["N1"]}],reviewed_pages:[{page_ref:"P1",reason:"..."}]}',
  'plan-topics': '{jobs:[{topic_ref:"T1",instructions:"..."}]}',
  topic: '{topic_ref:"T1",matches:[{section_ref:"S1",reason:"..."}],gaps:[]}',
 };
 const coverageLabel = input.stage === 'plan-concepts' ? 'Objects to assign exactly once (catalog coverage, not mandatory full-body reading)'
  : input.stage === 'relations' ? 'Pages to cover in candidate review (catalog coverage; read evidence-bearing sections for actual links)'
  : 'Required pages';
 const context = [
  `Required output manifest fields (exact shape; use actual references and reasons): ${contracts[input.stage]}\nMarkdown output files require exactly title and description frontmatter fields, followed by H2 sections with [[N1]]-style citations. Do not add ref or other frontmatter fields. No IDs, URLs, Markdown links, Related or Evidence sections.`,
  `Stage: ${input.stage}\nOutput language: ${input.language}\nGoal: ${input.goal.title}\n${input.goal.description}\nInstructions: ${input.instructions}`,
  `${coverageLabel}: ${requiredPages.join(', ') || '(none)'}\nRequired entries: ${requiredEntries.join(', ') || '(none)'}`,
  `## Page catalog\n${catalog || '(none)'}\nHistorical concept pages: ${input.pages.filter(row => row.previous && row.page.kind === 'concept').length}. This catalog is complete for this task; index.md repeats the task snapshot.`,
  `## Topics\n${[...topics].map(([ref, { id: _id, ...row }]) => `${ref}: ${JSON.stringify(row)}`).join('\n') || '(none)'}`,
  `## Available Cue details\n${[...visibleEntries].map(ref => { const row = entry(ref); return `${ref} | ${row.sourceTitle} | ${row.section} | ${row.cue}${unplaced.has(ref) ? ` | Upstream placement opinion: ${unplaced.get(ref)}` : ''}`; }).join('\n') || '(none; use the cited page and section text)'}${visibleEntries.size ? '\nThese visible Cue aliases are listed in evidence.md.' : ''}`,
  'Use read_wiki(ref) for complete pages and sections. Search accepts exactly one of query (an exact phrase) or terms (a list of phrases); terms use mode="any" for alternatives or mode="all" for intersection. Do not concatenate alternative terms into one query. Results provide matched fields and short candidate snippets, total and next_offset; request the next offset or narrow scope="body", kind, or page_ref when needed. Search does not prove absence beyond the terms and fields tried, and snippets do not replace complete selected content. N detail reads are restricted to the available Cue list above. Read each assigned page before concept consideration; read every consumed member before merging. Reading every section of a page counts as reading that page. Raw file reads do not create reading receipts. Choose either object or concept candidates from the supplied catalog. To expand one page, run from pathlib import Path; print(Path("../input/indexes/P1.json").read_text()) in IPython using its actual P alias. This overview contains chapter references and incoming/outgoing links to available pages, never body text. Follow either page kind or related pages as needed; an absent concept never blocks access to objects. read_wiki accepts only P/S/N aliases, never file paths. Catalog files are navigational aids; page/section bodies must be read with read_wiki for receipts.',
 ];
 if (input.stage === 'merge-objects') context.push('First read every unplaced Cue in full through read_wiki(N...), whether you ultimately adopt or discard it. Treat the upstream reason as a placement opinion, not a judgment that the Cue is worthless. Use its source provenance and scope to find existing objects from the same source or the object it describes; read relevant object pages before deciding where it belongs. Abstract or reusable content alone is not a reason for final discard: source-supported methods, findings, explanations and limitations can belong on an existing object page without defining a separate object. Resolve each Cue by adopting it into an appropriate object or returning deferred_entries with a specific final-discard reason grounded in its full text and considered placement. A new object may use member_refs:[] only when it adopts unplaced Cues. Historical concept pages are read-only context and their cited Cues cannot be discarded.');
 if (input.stage === 'concepts' || input.stage === 'merge-concepts') context.push('Cite only Cues already accepted by the supplied entity pages. Object merging owns final Cue disposition; do not submit deferred_entries in this stage.');
 if (input.stage === 'objects') context.push('pages rows contain only file. Each Note Cue must appear in an authored object or deferred_entries with a reason. Do not submit member_refs, retained_refs, discarded_refs or considered_pages.');
 if (input.stage === 'concepts') context.push('pages rows contain only file. considered_pages lists every assigned primary page exactly once with a reason after complete reading. References used as source material are not merge members; do not submit member_refs, retained_refs or discarded_refs.');
 if (input.stage === 'merge-objects' || input.stage === 'merge-concepts') context.push('Every member page must be disposed of exactly once: member_refs of one rewritten page, retained_refs, or discarded_refs with a reason. member_refs means pages consumed/replaced by the rewrite, not supporting references. To keep a page unchanged, put its P alias string in retained_refs; Runtime preserves it, so do not copy its file or submit it in pages. retained_refs is a string array such as ["P1"], not reason objects. Do not submit considered_pages.');
 if (input.stage === 'plan-concepts') context.push('Each job contains only page_refs and instructions. Assign each required object exactly once across jobs, with 1 to 8 primary pages per job. Do not submit entry_refs; Runtime supplies an empty internal Entry list.');
 if (input.stage === 'objects') {
  const note = [...entries.keys()].map(entryText).join('\n\n');
  if (note.length <= 60_000) {
   context.push(`## Complete Cornell Note\n${note}`);
   entries.forEach((_row, ref) => readEntries.add(ref));
  } else context.push(`The complete Cornell Note exceeds inline context size. Read ALL entries with read_wiki: ${[...entries.keys()].join(', ')}. Each entry includes its full chapter summary, Cue and detail; no text was truncated.`);
 }
 mkdirSync(join(inputRoot, 'pages'), { recursive: true });
 mkdirSync(join(inputRoot, 'indexes'), { recursive: true });
 for (const [ref, overview] of Object.entries(overviews)) writeFileSync(join(inputRoot, 'indexes', `${ref}.json`), JSON.stringify(overview));
 if (visibleEntries.size) mkdirSync(join(inputRoot, 'evidence'), { recursive: true });
 for (const ref of pages.keys()) writeFileSync(join(inputRoot, 'pages', `${ref}.md`), pageText(ref));
 for (const ref of visibleEntries) writeFileSync(join(inputRoot, 'evidence', `${ref}.md`), entryText(ref));
 writeFileSync(join(inputRoot, 'sections.md'), sectionIndex);
 if (visibleEntries.size) writeFileSync(join(inputRoot, 'evidence.md'), [...visibleEntries].map(ref => { const row = entry(ref); return `${ref} | ${row.sourceTitle} | ${row.section} | ${row.cue}`; }).join('\n'));
 writeFileSync(join(inputRoot, 'index.md'), context.join('\n\n'));

 function reasonRows(value: unknown, field: string, expected: string[], requireRead: boolean): Array<{ pageRef: string; reason: string }> {
  const result = rows(value, field).map((row, index) => {
   const path = `${field}[${index}]`;
   shape(row, ['page_ref', 'reason'], path);
   const ref = text(row.page_ref, `${path}.page_ref`);
   const member = page(ref, `${path}.page_ref`);
   if (requireRead && !fullRead(ref)) fail(`${path}.page_ref: read every section of ${ref} before considering it`);
   return { alias: ref, pageRef: member.ref, reason: text(row.reason, `${path}.reason`) };
  });
  exact(result.map(row => row.alias), expected, `${field}[].page_ref`);
  return result.map(({ alias: _alias, ...row }) => row);
 }

 function validate(output: unknown, workRoot: string): NoteFirstResult {
  if (input.stage === 'plan-concepts') {
   shape(output, ['jobs'], 'output');
   const allPages: string[] = [];
   const jobs = rows(output.jobs, 'output.jobs').map((row, index) => {
    const path = `output.jobs[${index}]`;
    shape(row, ['page_refs', 'instructions'], path);
    const refs = strings(row.page_refs, `${path}.page_refs`);
    if (!refs.length || refs.length > 8) fail(`${path}.page_refs: expected 1 to 8 primary pages; received ${refs.length}`);
    allPages.push(...refs);
    return { pageRefs: refs.map((ref, refIndex) => page(ref, `${path}.page_refs[${refIndex}]`).ref), entryIds: [], instructions: text(row.instructions, `${path}.instructions`) };
   });
   exact(allPages, requiredPages, 'output.jobs[].page_refs'); exact([], requiredEntries, 'input.requiredEntries');
   return { kind: 'concept-plan', jobs };
  }
  if (input.stage === 'plan-topics') {
   shape(output, ['jobs'], 'output');
   const jobs = rows(output.jobs, 'output.jobs').map((row, index) => {
    const path = `output.jobs[${index}]`;
    shape(row, ['topic_ref', 'instructions'], path);
    return { topicId: topic(row.topic_ref, `${path}.topic_ref`).id, instructions: text(row.instructions, `${path}.instructions`) };
   });
   exact(rows(output.jobs, 'output.jobs').map(row => (row as { topic_ref: string }).topic_ref), [...topics.keys()], 'output.jobs[].topic_ref');
   return { kind: 'topic-plan', jobs };
  }
  if (input.stage === 'topic') {
   shape(output, ['topic_ref', 'matches', 'gaps'], 'output');
   if (topics.size !== 1) fail('Topic worker requires one Topic');
   const topicId = topic(output.topic_ref, 'output.topic_ref').id;
   const matches = rows(output.matches, 'output.matches').map((row, index) => {
    const path = `output.matches[${index}]`;
    shape(row, ['section_ref', 'reason'], path);
    const ref = text(row.section_ref, `${path}.section_ref`);
    const target = section(ref, `${path}.section_ref`);
    if (!readSections.has(ref)) fail(`${path}.section_ref: read section ${ref} before linking it`);
    if (!/\[\[N[1-9][0-9]*\]\]/u.test(sectionText(ref))) fail(`${path}.section_ref: Topic section ${ref} must contain its own Cue evidence citations`);
    return { sectionRef: target.ref, reason: text(row.reason, `${path}.reason`) };
   });
   if (new Set(matches.map(row => row.sectionRef)).size !== matches.length) fail('output.matches[].section_ref: duplicate Topic section; expected each selected section once');
   return { kind: 'topic', topicId, matches, gaps: strings(output.gaps, 'output.gaps') };
  }
  if (input.stage === 'relations') {
   shape(output, ['relations', 'reviewed_pages'], 'output');
   const reviewedPages = reasonRows(output.reviewed_pages, 'output.reviewed_pages', requiredPages, false);
   const keys = new Set<string>();
   const relations = rows(output.relations, 'output.relations').map((row, index) => {
    const path = `output.relations[${index}]`;
    shape(row, ['from', 'to', 'label', 'entry_refs'], path);
    const from = text(row.from, `${path}.from`), to = text(row.to, `${path}.to`), label = text(row.label, `${path}.label`);
    const source = page(from, `${path}.from`).page, target = page(to, `${path}.to`).page;
    const key = `${from}\0${to}\0${label}`;
    if (from === to || keys.has(key)) fail(`${path}: self or duplicate relation (${from}, ${to}, ${JSON.stringify(label)}); expected distinct endpoints and a unique from/to/label tuple`);
    keys.add(key);
    if (!someRead(from) || !someRead(to)) fail(`${path}.from/to: read both relation endpoints before linking; unread: [${[from, to].filter(ref => !someRead(ref)).join(', ')}]`);
    const evidence = strings(row.entry_refs, `${path}.entry_refs`).map((ref, index) => entry(ref, `${path}.entry_refs[${index}]`).id);
    const available = new Set([from, to].flatMap(ref => {
     const owner = page(ref).page;
     return readPages.has(ref) ? objectFirstEntries(owner.body) : pageSections(owner.id)
      .filter(([sectionRef]) => readSections.has(sectionRef))
      .flatMap(([, section]) => objectFirstEntries(owner.body.split('\n').slice(section.startLine - 1, section.endLine).join('\n')));
    }));
    if (!evidence.length || evidence.some(id => !available.has(id))) fail(`${path}.entry_refs: relation evidence must come from completely read endpoint sections; unread or absent: ${evidence.filter(id => !available.has(id)).map(id => entryAliases.get(id)).join(', ')}`);
    return { from: source.id, to: target.id, label, entryIds: evidence };
   });
   return { kind: 'relations', relations, reviewedPages };
  }
  const merging = input.stage === 'merge-objects' || input.stage === 'merge-concepts';
  const outputFields = input.stage === 'objects' ? ['pages', 'deferred_entries']
   : input.stage === 'concepts' ? ['pages', 'considered_pages']
   : input.stage === 'merge-objects' ? ['pages', 'retained_refs', 'discarded_refs', 'deferred_entries']
   : ['pages', 'retained_refs', 'discarded_refs'];
  shape(output, outputFields, 'output');
  if (input.stage === 'objects' && [...entries.keys()].some(ref => !readEntries.has(ref))) fail('output.pages + output.deferred_entries: read every Cornell Note entry before submitting objects');
  if (input.stage === 'merge-objects') {
   const unread = [...unplaced.keys()].filter(ref => !readEntries.has(ref));
   if (unread.length) fail(`output.pages + output.deferred_entries: read every unplaced Cue in full before adopting or finally discarding it; unread: ${unread.join(', ')}`);
  }
  const expectedMembers = merging ? [...pages].filter(([, row]) => row.role === 'member').map(([ref]) => ref) : [];
  const consumed: string[] = [];
  const cited = new Set<string>();
  const ids = new Set<string>(), titles = new Set<string>(), files = new Set<string>();
  const addIdentity = (candidate: ObjectFirstPage, field: string) => {
   const title = candidate.title.normalize('NFKC').trim().toLocaleLowerCase();
   if (ids.has(candidate.id) || titles.has(title)) fail(`${field}: duplicate page identity or title ${JSON.stringify(candidate.title)}; expected unique pages`);
   ids.add(candidate.id); titles.add(title);
   for (const id of objectFirstEntries(candidate.body)) {
    if (!allowedCitations.has(id)) fail(`${field}: page cites a Cue outside the accepted entity or unplaced Cue scope: ${entryAliases.get(id) ?? id}`);
    cited.add(id);
   }
  };
  const authored = rows(output.pages, 'output.pages').map((row, index) => {
   const path = `output.pages[${index}]`;
   shape(row, merging ? ['file', 'member_refs'] : ['file'], path);
   const file = text(row.file, `${path}.file`);
   if (files.has(file)) fail(`${path}.file: duplicate page file ${JSON.stringify(file)}; expected each file once`);
   files.add(file);
   const refs = merging ? strings(row.member_refs, `${path}.member_refs`) : [];
   if (merging && !refs.length && input.stage !== 'merge-objects') fail(`${path}.member_refs: merged page requires members; expected at least one P alias`);
   for (const ref of refs) {
    if (!expectedMembers.includes(ref)) fail(`${path}.member_refs: unknown or context-only member ${ref}; expected a member from [${expectedMembers.join(', ')}]`);
    if (!fullRead(ref)) fail(`${path}.member_refs: read every section of ${ref} before rewriting`);
   }
   consumed.push(...refs);
   const { fields, body } = splitFrontmatter(outputMarkdown(workRoot, file, `${path}.file`));
   shape(fields, ['title', 'description'], `${path}.file(${file}).frontmatter`);
   const title = text(fields.title, `${path}.file(${file}).frontmatter.title`), description = text(fields.description, `${path}.file(${file}).frontmatter.description`);
   text(body, `${path}.file(${file}).body`);
   if (!/^##\s+\S/mu.test(body) || /^#\s|^---\s*$|^##\s+(?:Related|Evidence)\s*$/imu.test(body) || /(?:https?:\/\/|\]\(|<\/?[A-Za-z][^<>\n]*>|^\s*\[[^\]]+\]:)/mu.test(body)) fail(`${path}.file(${file}).body: Markdown requires H2 sections and no links, HTML, Related or Evidence sections`);
   const markers = [...body.matchAll(/\[\[([^\]]+)\]\]/gu)];
   if (!markers.length || /\[\[|\]\]/u.test(body.replace(/\[\[([^\]]+)\]\]/gu, ''))) fail(`${path}.file(${file}).body: body must cite valid short Entry markers such as [[N1]]`);
   for (const match of markers) entry(match[1], `${path}.file(${file}).body`);
   const normalized = body.replace(/\[\[([^\]]+)\]\]/gu, (_match, ref: string) => `[[${entry(ref).id}]]`).trim();
   const adoptedUnplaced = [...new Set(markers.map(match => match[1]!))].filter(ref => unplaced.has(ref));
   if (input.stage === 'merge-objects') {
    if (!refs.length && !adoptedUnplaced.length) fail(`${path}.file(${file}).body: new object must adopt an unplaced Cue when member_refs is empty`);
   }
   const kind = input.stage === 'concepts' || input.stage === 'merge-concepts' ? 'concept' : 'entity';
   const previous = refs.map(ref => page(ref)).filter(member => member.previous);
   const id = previous[0]?.page.id ?? `${kind}:${hashJson({ inputVersion, key: input.key, identity: refs.length ? refs.map(ref => page(ref).ref).sort() : file }).slice(0, 24)}`;
   const result = { id, kind, title, description, body: normalized, member_refs: refs.map(ref => page(ref).ref) } satisfies ObjectFirstPagesResult['pages'][number];
   for (const member of previous) if (objectFirstEntries(member.page.body).some(ref => !objectFirstEntries(normalized).includes(ref))) fail(`${path}.file(${file}).body: previous page citations must survive in its destination; source ${pageAliases.get(member.ref)}`);
   addIdentity(result, `${path}.file(${file})`);
   return result;
  });
  const retained = merging ? strings(output.retained_refs, 'output.retained_refs') : [];
  for (const [index, ref] of retained.entries()) {
   const path = `output.retained_refs[${index}]`;
   if (!expectedMembers.includes(ref)) fail(`${path}: unknown retained member ${ref}; expected a member from [${expectedMembers.join(', ')}]`);
   consumed.push(ref); addIdentity(page(ref).page, path);
  }
  const discarded = rows(merging ? output.discarded_refs : [], 'output.discarded_refs').map((row, index) => {
   const path = `output.discarded_refs[${index}]`;
   shape(row, ['ref', 'reason'], path);
   const ref = text(row.ref, `${path}.ref`);
   if (!expectedMembers.includes(ref) || page(ref).previous) fail(`${path}.ref: cannot discard previous or unknown page ${ref}; expected a new member page`);
   consumed.push(ref);
   return { ref: page(ref).ref, reason: text(row.reason, `${path}.reason`) };
  });
  exact(consumed, expectedMembers, 'output.pages[].member_refs + output.retained_refs + output.discarded_refs[].ref');
  const deferred = rows(input.stage === 'objects' || input.stage === 'merge-objects' ? output.deferred_entries : [], 'output.deferred_entries').map((row, index) => {
   const path = `output.deferred_entries[${index}]`;
   shape(row, ['entry_ref', 'reason'], path);
   const ref = entry(row.entry_ref, `${path}.entry_ref`).id;
   if (cited.has(ref)) fail(`${path}.entry_ref: cited Entry cannot also be deferred: ${row.entry_ref}`);
   if (input.stage === 'merge-objects') {
    if (!input.requiredEntries.includes(ref)) fail(`${path}.entry_ref: final-discard Entry must be in the object merge scope; received ${row.entry_ref}`);
    if (historicalConceptEntries.has(ref)) fail(`${path}.entry_ref: cannot discard a Cue cited by a historical concept: ${row.entry_ref}`);
   }
   return { entry_ref: ref, reason: text(row.reason, `${path}.reason`) };
  });
  const deferredIds = new Set(deferred.map(row => row.entry_ref));
  if (deferredIds.size !== deferred.length) fail(`output.deferred_entries[].entry_ref: duplicate deferred Entry: [${deferred.filter((row, index) => deferred.findIndex(other => other.entry_ref === row.entry_ref) !== index).map(row => entryAliases.get(row.entry_ref)).join(', ')}]`);
  const missingEvidence = input.requiredEntries.filter(id => !cited.has(id) && !deferredIds.has(id));
  if (missingEvidence.length) fail(`output.pages + output.deferred_entries: input Evidence was silently dropped; missing: [${missingEvidence.map(id => entryAliases.get(id)).join(', ')}]. Every required Cue needs a destination or an allowed explicit deferral.`);
  for (const row of discarded) {
   const original = input.pages.find(member => member.ref === row.ref)!;
   if (objectFirstEntries(original.page.body).some(id => !cited.has(id) && !deferredIds.has(id))) fail(`output.discarded_refs: discarded page Evidence needs a destination or deferral; page ${pageAliases.get(row.ref)}`);
  }
  const consideredPages = input.stage === 'concepts' ? reasonRows(output.considered_pages, 'output.considered_pages', requiredPages, true) : [];
  return { kind: 'pages', value: { pages: authored, retained_refs: retained.map(ref => page(ref).ref), discarded_refs: discarded, deferred_entries: deferred, relations: [] }, consideredPages };
 }
 return {
  userContext: context.join('\n\n'), searchIndex, overviews,
  validate(output, workRoot) {
   try { return validate(output, workRoot); }
   catch (error) {
    const message = error instanceof Error ? error.message.replace(/^Note-first output: /u, '') : String(error);
    return fail(`[stage=${input.stage}] ${message}`);
   }
  },
  read(ref) {
   if (pages.has(ref)) {
    const content = pageText(ref);
    const children = pageSections(page(ref).page.id);
    if (content.length > 24_000) return `Page ${ref} exceeds whole-page read size. Read ALL complete sections: ${children.map(([key, row]) => `${key} (${row.heading})`).join(', ')}. No body content was truncated or marked read.`;
    readPages.add(ref); children.forEach(([key]) => readSections.add(key)); return content;
   }
   if (sections.has(ref)) { readSections.add(ref); return `${ref}\n${sectionText(ref)}`; }
   if (entries.has(ref)) {
    if (!visibleEntries.has(ref)) fail(`Cue details are not available in ${input.stage}: ${ref}`);
    readEntries.add(ref); return entryText(ref);
   }
   return fail(`[stage=${input.stage}] read_wiki.ref: expected an available P/S/N alias, received ${JSON.stringify(ref)}. File paths are not accepted. For page metadata use IPython: from pathlib import Path; print(Path("../input/indexes/P1.json").read_text()) with the actual P alias. Then read page or section bodies with read_wiki(P... or S...) to record complete reads.`);
  },
 search(query) {
   return JSON.stringify(searchRows(searchIndex, typeof query === 'string' ? { query } : query));
  },
  receipts: () => ({ pages: [...pages.keys()].filter(fullRead), sections: [...readSections], entries: [...readEntries] }),
 };
}
