import { lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import type { Nodes } from 'mdast';
import remarkParse from 'remark-parse';
import { unified } from 'unified';
import { hashJson } from '../lib/hash.js';
import { isRecord } from '../lib/values.js';
import { splitFrontmatter } from './model/frontmatter.js';
import { wikiPageEntryIds, wikiPageSections, type WikiPageContent, type WikiPagesResult } from './wiki-page-contract.js';
import type { WikiStageInput, WikiStageResult } from './wiki-stage-contract.js';
import { searchRows, type SearchRequest, type SearchRow } from './wiki-stage-search.js';

export interface PageOverview {
 page_ref: string; kind: 'entity' | 'concept'; title: string; description: string;
 file: string;
 sections: Array<{ section_ref: string; heading: string; start_line: number; end_line: number; entry_refs: string[] }>;
 cue_files: Record<string, string | null>;
 relations: Array<{ from: string; to: string; label: string; direction: 'incoming' | 'outgoing'; page: Pick<PageOverview, 'page_ref' | 'kind' | 'title' | 'description'> }>;
}

export interface WikiStageWorkspace {
 read(ref: string): string;
 search(query: string | SearchRequest): string;
 searchIndex: SearchRow[];
 overviews: Record<string, PageOverview>;
 validate(output: unknown, workRoot: string, options?: { incrementalMerge?: boolean; inputRoot?: 'wiki' | '../input' }): WikiStageResult;
 receipts(): { pages: string[]; sections: string[]; entries: string[] };
}
function fail(message: string): never { throw new Error(`Wiki compilation output: ${message}`); }
const markdownParser = unified().use(remarkParse);
function validateMarkdownMarkup(body: string, field: string): void {
 const nodes: Nodes[] = [markdownParser.parse(body)];
 for (const node of nodes) {
  if (node.type === 'link') {
   const start = node.position!.start;
   fail(`${field}: no links allowed at body line ${start.line}, column ${start.column}: ${JSON.stringify(node.url.slice(0, 120))}. Use escaped text or code for literal notation.`);
  }
  if (node.type === 'html') {
   const start = node.position!.start;
   fail(`${field}: HTML is not allowed at body line ${start.line}, column ${start.column}: ${JSON.stringify(node.value.slice(0, 120))}. Use escaped text or code for literal notation.`);
  }
  if ('children' in node) for (const child of node.children) nodes.push(child);
 }
}
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
  const message = error instanceof Error ? error.message.replace(/^Wiki compilation output: /u, '') : String(error);
  return fail(`${field}: ${message}`);
 }
}

/** Agent-facing aliases stay local; only this Runtime closure sees durable identities. */
export function createWikiStageWorkspace(input: WikiStageInput, inputRoot: string): WikiStageWorkspace {
 if (input.stage === 'page-topics') throw new Error('Page Topic classification uses its direct completion contract');
 const inputVersion = hashJson(input);
 const pages = new Map(input.pages.map((page, i) => [`P${i + 1}`, page]));
 const entries = new Map(input.entries.map((entry, i) => [`N${i + 1}`, entry]));
 const topics = new Map(input.topics.map((topic, i) => [`T${i + 1}`, topic]));
 const entryAliases = new Map([...entries].map(([alias, entry]) => [entry.id, alias]));
 const pageAliases = new Map([...pages].map(([alias, page]) => [page.ref, alias]));
 const calculatedSections = wikiPageSections(input.pages.map(row => row.page));
 const sections = new Map((input.sections.length ? input.sections : calculatedSections).map((section, i) => [`S${i + 1}`, section]));
 for (const section of sections.values()) {
  const actual = calculatedSections.find(candidate => candidate.ref === section.ref);
  const enriched = section as typeof section & { entryIds?: string[] };
  const { entryIds, ...core } = enriched;
  if (!actual || hashJson(actual) !== hashJson(core)) fail('input contains stale or invalid Section');
  if (entryIds) {
   const owner = input.pages.find(row => row.page.id === section.pageId)!;
   const cited = wikiPageEntryIds(owner.page.body.split('\n').slice(section.startLine - 1, section.endLine).join('\n'));
   exact(entryIds, cited, 'section evidence');
  }
 }
 if (entryAliases.size !== entries.size || pageAliases.size !== pages.size || new Set(input.pages.map(row => row.page.id)).size !== pages.size) fail('input identities must be unique');
 const page = (ref: unknown, field = 'page ref') => pages.get(text(ref, field)) ?? fail(`${field}: unknown page ${String(ref)}; expected an available P alias`);
 const entry = (ref: unknown, field = 'entry ref') => entries.get(text(ref, field)) ?? fail(`${field}: unknown entry ${String(ref)}; expected an available N alias`);
 const topic = (ref: unknown, field = 'topic ref') => topics.get(text(ref, field)) ?? fail(`${field}: unknown Topic ${String(ref)}; expected an available T alias`);
 const section = (ref: unknown, field = 'section ref') => sections.get(text(ref, field)) ?? fail(`${field}: unknown section ${String(ref)}; expected an available S alias`);
 const requiredPages = input.requiredPages.map(ref => pageAliases.get(ref) ?? fail('unknown required page'));
 for (const id of input.requiredEntries) if (!entryAliases.has(id)) fail('unknown required Entry');
 const unplaced = new Map<string, string>();
 for (const row of input.unplacedEntries ?? []) {
  const ref = entryAliases.get(row.entryId) ?? fail('unknown unplaced Entry');
  if (input.stage !== 'merge-objects' || unplaced.has(ref)) fail('unplaced Entries must be unique and belong to merge-objects');
  unplaced.set(ref, text(row.reason, 'unplaced reason'));
 }
 const visibleEntries = new Set(input.stage === 'objects' ? entries.keys() : input.stage === 'merge-objects' ? unplaced.keys() : []);
 const unplacedIds = [...unplaced.keys()].map(ref => entry(ref).id);
 const entityEntries = new Set(input.pages.filter(row => row.page.kind === 'entity').flatMap(row => wikiPageEntryIds(row.page.body)));
 const historicalConceptEntries = new Set(input.pages.filter(row => row.previous && row.page.kind === 'concept').flatMap(row => wikiPageEntryIds(row.page.body)));
 const allowedCitations = input.stage === 'objects' ? new Set(entryAliases.keys())
  : new Set([...entityEntries, ...unplacedIds]);
 if (input.stage === 'merge-objects' && [...input.pages.filter(row => row.role === 'member' && row.page.kind === 'entity')
  .flatMap(row => wikiPageEntryIds(row.page.body)), ...unplacedIds].some(id => !input.requiredEntries.includes(id))) fail('merge-objects required Entries must cover object citations and unplaced Entries');
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
  const sourceIds = wikiPageEntryIds(owner.page.body.split('\n').slice(row.startLine - 1, row.endLine).join('\n'));
  return { section_ref: ref, page_ref: pageAliases.get(owner.ref)!, kind: owner.page.kind,
   title: owner.page.title, description: owner.page.description, heading: row.heading, body: sectionText(ref),
   source_titles: [...new Set(sourceIds.map(id => entriesById.get(id)?.sourceTitle).filter((title): title is string => Boolean(title)))] };
 });
 const readSections = new Set<string>();
 const readEntries = new Set<string>();
 const readPages = new Set<string>();
 const fullRead = (ref: string) => readPages.has(ref) || (pageSections(page(ref).page.id).length > 0 && pageSections(page(ref).page.id).every(([key]) => readSections.has(key)));
 const pageSummary = (ref: string) => {
  const row = page(ref).page;
  return { page_ref: ref, kind: row.kind, title: row.title, description: row.description };
 };
 const aliasesById = new Map([...pages].map(([ref, row]) => [row.page.id, ref]));
 const overviews: Record<string, PageOverview> = Object.fromEntries([...pages].map(([ref, row]) => {
  // Native read coordinates include the staged frontmatter; durable Sections keep body coordinates.
  const lineOffset = pageText(ref).split('\n').length - row.page.body.split('\n').length;
  const cueAlias = (id: string) => entryAliases.get(id) ?? fail('page references unknown Entry');
  return [ref, {
   ...pageSummary(ref), file: `pages/${ref}.md`,
   sections: pageSections(row.page.id).map(([section_ref, section]) => ({ section_ref, heading: section.heading,
    start_line: section.startLine + lineOffset, end_line: section.endLine + lineOffset,
    entry_refs: wikiPageEntryIds(row.page.body.split('\n').slice(section.startLine - 1, section.endLine).join('\n')).map(cueAlias) })),
   cue_files: Object.fromEntries(wikiPageEntryIds(row.page.body).map(cueAlias)
    .map(alias => [alias, visibleEntries.has(alias) ? `evidence/${alias}.md` : null])),
   relations: [],
  }];
 }));
 for (const relation of input.previousRelations) {
  const from = aliasesById.get(relation.from), to = aliasesById.get(relation.to);
  if (!from || !to) continue;
  for (const id of relation.entryIds) if (!entryAliases.has(id)) fail('unknown previous relation evidence');
  overviews[from].relations.push({ from, to, label: relation.label, direction: 'outgoing', page: pageSummary(to) });
  overviews[to].relations.push({ from, to, label: relation.label, direction: 'incoming', page: pageSummary(from) });
 }
 const sectionIndex = [...sections].map(([ref, row]) => `${ref} | ${[...pages].find(([, candidate]) => candidate.page.id === row.pageId)![0]} | ${row.heading}`).join('\n');
 mkdirSync(join(inputRoot, 'pages'), { recursive: true });
 mkdirSync(join(inputRoot, 'indexes'), { recursive: true });
 for (const [ref, overview] of Object.entries(overviews)) writeFileSync(join(inputRoot, 'indexes', `${ref}.json`), JSON.stringify(overview));
 if (visibleEntries.size) mkdirSync(join(inputRoot, 'evidence'), { recursive: true });
 for (const ref of pages.keys()) writeFileSync(join(inputRoot, 'pages', `${ref}.md`), pageText(ref));
 for (const ref of visibleEntries) writeFileSync(join(inputRoot, 'evidence', `${ref}.md`), entryText(ref));
 writeFileSync(join(inputRoot, 'sections.md'), sectionIndex);
 if (visibleEntries.size) writeFileSync(join(inputRoot, 'evidence.md'), [...visibleEntries].map(ref => { const row = entry(ref); return `${ref} | ${row.sourceTitle} | ${row.section} | ${row.cue}`; }).join('\n'));

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

 function validate(output: unknown, workRoot: string, options: { incrementalMerge?: boolean; inputRoot?: 'wiki' | '../input' } = {}): WikiStageResult {
  if (input.stage === 'plan-concepts' || input.stage === 'audit-concepts') fail('This stage uses the Pi native-read contract');
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
  const inputPagePath = (ref: string) => `${options.inputRoot ?? '../input'}/pages/${ref}.md`;
  const violations: string[] = [];
  const consumed: string[] = [];
  const memberLocations = new Map<string, string[]>();
  const consume = (ref: string, location: string) => {
   consumed.push(ref);
   memberLocations.set(ref, [...(memberLocations.get(ref) ?? []), location]);
  };
  const cited = new Set<string>();
  const ids = new Set<string>(), titles = new Set<string>(), files = new Set<string>();
  const addIdentity = (candidate: WikiPageContent, field: string) => {
   const title = candidate.title.normalize('NFKC').trim().toLocaleLowerCase();
   if (ids.has(candidate.id) || titles.has(title)) violations.push(`${field}: duplicate page identity or title ${JSON.stringify(candidate.title)}; expected unique pages`);
   ids.add(candidate.id); titles.add(title);
   for (const id of wikiPageEntryIds(candidate.body)) {
    if (!allowedCitations.has(id)) violations.push(`${field}: page cites a Cue outside the accepted entity or unplaced Cue scope: ${entryAliases.get(id) ?? id}`);
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
   for (const [memberIndex, ref] of refs.entries()) {
    if (!expectedMembers.includes(ref)) fail(`${path}.member_refs: unknown or context-only member ${ref}; expected a member from [${expectedMembers.join(', ')}]`);
    if (!fullRead(ref)) violations.push(`${path}.member_refs: read every section of ${ref} before rewriting; input file: ${inputPagePath(ref)}`);
    consume(ref, `${path}.member_refs[${memberIndex}] (${file})`);
   }
   if (options.incrementalMerge && !refs.some(ref => !page(ref).previous)) {
    violations.push(`${path}.file(${file}).member_refs: [${refs.join(', ')}] is an existing-only rewrite. Remove this rewrite from output.pages to retain these existing pages unchanged; Runtime automatically retains untouched existing members. Do not add an incoming ref merely to satisfy the rule: a member may be consumed only when its content is actually integrated, and only by one destination.`);
   }
   const { fields, body } = splitFrontmatter(outputMarkdown(workRoot, file, `${path}.file`));
   shape(fields, ['title', 'description'], `${path}.file(${file}).frontmatter`);
   const title = text(fields.title, `${path}.file(${file}).frontmatter.title`), description = text(fields.description, `${path}.file(${file}).frontmatter.description`);
   text(body, `${path}.file(${file}).body`);
   if (!/^##\s+\S/mu.test(body) || /^#\s|^---\s*$|^##\s+(?:Related|Evidence)\s*$/imu.test(body) || /(?:https?:\/\/|\]\(|^\s*\[[^\]]+\]:)/mu.test(body)) fail(`${path}.file(${file}).body: Markdown requires H2 sections and no links, HTML, Related or Evidence sections`);
   validateMarkdownMarkup(body, `${path}.file(${file}).body`);
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
   const result = { id, kind, title, description, body: normalized, member_refs: refs.map(ref => page(ref).ref) } satisfies WikiPagesResult['pages'][number];
   for (const member of previous) {
    const missing = wikiPageEntryIds(member.page.body).filter(ref => !wikiPageEntryIds(normalized).includes(ref));
    const source = pageAliases.get(member.ref)!;
    if (missing.length) violations.push(`${path}.file(${file}).body: previous page citations must survive in its destination; source ${source} (${inputPagePath(source)}); missing: [${missing.map(id => entryAliases.get(id)).join(', ')}]. Restore their supported prose and original citations.`);
   }
   addIdentity(result, `${path}.file(${file})`);
   return result;
  });
  const retained = merging ? strings(output.retained_refs, 'output.retained_refs') : [];
  for (const [index, ref] of retained.entries()) {
   const path = `output.retained_refs[${index}]`;
   if (!expectedMembers.includes(ref)) fail(`${path}: unknown retained member ${ref}; expected a member from [${expectedMembers.join(', ')}]`);
   consume(ref, path); addIdentity(page(ref).page, path);
  }
  const discarded = rows(merging ? output.discarded_refs : [], 'output.discarded_refs').map((row, index) => {
   const path = `output.discarded_refs[${index}]`;
   shape(row, ['ref', 'reason'], path);
   const ref = text(row.ref, `${path}.ref`);
   if (!expectedMembers.includes(ref) || page(ref).previous) fail(`${path}.ref: cannot discard previous or unknown page ${ref}; expected a new member page`);
   consume(ref, `${path}.ref`);
   return { ref: page(ref).ref, reason: text(row.reason, `${path}.reason`) };
  });
  try { exact(consumed, expectedMembers, 'output.pages[].member_refs + output.retained_refs + output.discarded_refs[].ref'); }
  catch (error) {
   const duplicates = [...memberLocations].filter(([, locations]) => locations.length > 1)
    .map(([ref, locations]) => `${ref}: ${locations.join('; ')}`).join('\n');
   violations.push(`${String(error instanceof Error ? error.message : error).replace(/^Wiki compilation output: /u, '')}${duplicates ? `\nDuplicate member locations:\n${duplicates}\nKeep each consumed member in exactly one destination; correct both the manifest and affected article content.` : ''}`);
  }
  const deferred = rows(input.stage === 'objects' || input.stage === 'merge-objects' ? output.deferred_entries : [], 'output.deferred_entries').map((row, index) => {
   const path = `output.deferred_entries[${index}]`;
   shape(row, ['entry_ref', 'reason'], path);
   const ref = entry(row.entry_ref, `${path}.entry_ref`).id;
   if (cited.has(ref)) violations.push(`${path}.entry_ref: cited Entry cannot also be deferred: ${row.entry_ref}. Remove this deferred entry and preserve its supported records and citations in the authored object.`);
   if (input.stage === 'merge-objects') {
    if (!input.requiredEntries.includes(ref)) fail(`${path}.entry_ref: final-discard Entry must be in the object merge scope; received ${row.entry_ref}`);
    if (historicalConceptEntries.has(ref)) {
     const owners = [...pages].filter(([, row]) => row.previous && row.page.kind === 'concept' && wikiPageEntryIds(row.page.body).includes(ref))
      .map(([alias]) => `${alias} (${inputPagePath(alias)})`).join(', ');
     violations.push(`${path}.entry_ref: cannot discard a Cue cited by a historical concept: ${row.entry_ref}; source pages: ${owners}. Integrate its supported detail into the corresponding object or concrete research work, even when it is not an independent object.`);
    }
   }
   return { entry_ref: ref, reason: text(row.reason, `${path}.reason`) };
  });
  const deferredIds = new Set(deferred.map(row => row.entry_ref));
  if (deferredIds.size !== deferred.length) violations.push(`output.deferred_entries[].entry_ref: duplicate deferred Entry: [${deferred.filter((row, index) => deferred.findIndex(other => other.entry_ref === row.entry_ref) !== index).map(row => entryAliases.get(row.entry_ref)).join(', ')}]`);
  const missingEvidence = input.requiredEntries.filter(id => !cited.has(id) && !deferredIds.has(id));
  if (missingEvidence.length) {
   const sources = missingEvidence.map(id => {
    const locations = [...pages].filter(([, row]) => wikiPageEntryIds(row.page.body).includes(id))
     .map(([ref]) => `${ref} (${inputPagePath(ref)})`).join(', ');
    const alias = entryAliases.get(id)!;
    return `${alias}: ${locations || `unplaced Cue ${alias}`}; Cue: ${JSON.stringify(entry(alias).cue)}`;
   }).join('\n');
   violations.push(`output.pages + output.deferred_entries: input Evidence was silently dropped; missing: [${missingEvidence.map(id => entryAliases.get(id)).join(', ')}]. Every required Cue needs a destination or an allowed explicit deferral.\nMissing Cue source locations:\n${sources}`);
  }
  for (const row of discarded) {
   const original = input.pages.find(member => member.ref === row.ref)!;
   if (wikiPageEntryIds(original.page.body).some(id => !cited.has(id) && !deferredIds.has(id))) violations.push(`output.discarded_refs: discarded page Evidence needs a destination or deferral; page ${pageAliases.get(row.ref)}`);
  }
  const consideredPages = input.stage === 'concepts' ? reasonRows(output.considered_pages, 'output.considered_pages', requiredPages, true) : [];
  if (violations.length) fail(violations.join('\n'));
  return { kind: 'pages', value: { pages: authored, retained_refs: retained.map(ref => page(ref).ref), discarded_refs: discarded, deferred_entries: deferred, relations: [] }, consideredPages };
 }
 return {
  searchIndex, overviews,
  validate(output, workRoot, options) {
   try { return validate(output, workRoot, options); }
   catch (error) {
    const message = error instanceof Error ? error.message.replace(/^Wiki compilation output: /u, '') : String(error);
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
   return fail(`[stage=${input.stage}] read.ref: expected an available P/S/N alias, received ${JSON.stringify(ref)}. File paths are not accepted as aliases. Native read accesses the page files and indexes through this task's mounted input paths.`);
  },
 search(query) {
   return JSON.stringify(searchRows(searchIndex, typeof query === 'string' ? { query } : query));
  },
  receipts: () => ({ pages: [...pages.keys()].filter(fullRead), sections: [...readSections], entries: [...readEntries] }),
 };
}
