import { join } from 'node:path';
import { isRecord } from '../lib/values.js';
import { readNoteFirstOutput } from './note-first-stage.js';
import { objectFirstEntries, objectFirstSections } from './object-first-contract.js';
import type { NoteFirstInput, NoteFirstResult } from './note-first-contract.js';

function fields(value: unknown, keys: string[], path: string): Record<string, unknown> {
 if (!isRecord(value) || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key)))
  throw new Error(`${path}: expected exactly [${keys.join(', ')}]`);
 return value;
}

export function targetWriterContext(input: NoteFirstInput): string {
 if (input.requiredPages.length > 1) throw new Error('Object writer expects at most one canonical target');
 const target = input.requiredPages[0];
 const index = target ? input.pages.findIndex(row => row.ref === target && row.previous && row.role === 'member') : -1;
 if (target && index < 0) throw new Error('Object update target must be an assigned existing page');
 return target ? `Canonical update target: P${index + 1}. Preserve this existing page's identity. Write facts.json before the article.`
  : 'Target: a new independent object. Write facts.json before the article.';
}

export function validateTargetWriter(input: NoteFirstInput, work: string,
 accepted: { result: Extract<NoteFirstResult, { kind: 'pages' }>; completePageReads: string[] }): NoteFirstResult {
 targetWriterContext(input);
 const members = input.pages.flatMap((row, index) => row.role === 'member' ? [{ ...row, alias: `P${index + 1}` }] : []);
 const unread = members.filter(row => !accepted.completePageReads.includes(row.alias));
 if (unread.length) throw new Error(`Read all assigned sources completely, including existing pages: ${unread.map(row => row.alias).join(', ')}`);
 const value = accepted.result.value;
 if (value.pages.length > 1 || value.discarded_refs.length || value.deferred_entries.length)
  throw new Error('One target writer may author at most one page or retain members separately; preserve all input evidence');
 if (!value.pages.length) return { kind: 'object-target-pages', value, facts: [] };
 const page = value.pages[0]!;
 if (page.member_refs.length !== members.length || members.some(row => !page.member_refs.includes(row.ref)))
  throw new Error('Consume every assigned member of this target, or veto the proposal and retain the members separately');
 const anchor = input.requiredPages[0] ?? members[0]!.ref;
 if (!page.member_refs.includes(anchor)) throw new Error('The authored page must consume its canonical target member');
 page.id = members.find(row => row.ref === anchor)!.page.id;
 const aliases = [...`${page.title}\n${page.description}\n${page.body}`.replace(/\[\[entry:[a-f0-9]{24}\]\]/gu, '').matchAll(/\b[PSNI]\d+\b/gu)].map(match => match[0]);
 // ponytail: allow source-backed technical terms shaped like aliases; semantic review must check their context.
 const leaked = aliases.filter(alias => !members.some(row => `${row.page.title}\n${row.page.body}`.includes(alias)));
 if (leaked.length) throw new Error(`Knowledge prose contains temporary task references [${[...new Set(leaked)].join(', ')}]; use proper object names and inline Cue citations`);
 const headings = new Set(objectFirstSections([page]).map(section => section.heading));
 const sections = objectFirstSections(input.pages.map(row => row.page));
 const sourceSections = sections.flatMap((section, index) => {
  const owner = members.find(row => row.page.id === section.pageId);
  if (!owner) return [];
  const body = owner.page.body.split('\n').slice(section.startLine - 1, section.endLine).join('\n');
  return [{ ref: `S${index + 1}`, owner, section, ids: objectFirstEntries(body) }];
 });
 const ledger = fields(JSON.parse(readNoteFirstOutput(join(work, 'facts.json')).toString('utf8')), ['facts'], 'facts.json');
 if (!Array.isArray(ledger.facts)) throw new Error('facts.json.facts: expected an array');
 const covered = new Map<string, Set<string>>();
 const facts: Extract<NoteFirstResult, { kind: 'object-target-pages' }>['facts'] = [];
 const violations: string[] = [];
 ledger.facts.forEach((item, index) => {
  try {
  const path = `facts.json.facts[${index}]`;
  const fact = fields(item, ['source_section_ref', 'claim', 'entry_refs', 'destination_heading'], path);
  const source = sourceSections.find(row => row.ref === fact.source_section_ref);
  if (!source) throw new Error(`${path}.source_section_ref: unknown ${JSON.stringify(fact.source_section_ref)}; expected [${sourceSections.map(row => row.ref).join(', ')}]`);
  if (typeof fact.claim !== 'string' || !fact.claim.trim()) throw new Error(`${path}.claim: expected a nonempty source-supported claim`);
  if (typeof fact.destination_heading !== 'string' || !headings.has(fact.destination_heading))
   throw new Error(`${path}.destination_heading: ${JSON.stringify(fact.destination_heading)} is not an article H2 heading; actual headings: ${JSON.stringify([...headings])}`);
  if ([...fact.claim.matchAll(/\b[PSNI]\d+\b/gu)].some(match => !members.some(row => `${row.page.title}\n${row.page.body}`.includes(match[0]))))
   throw new Error(`${path}.claim: replace temporary task references with proper object names`);
  if (!Array.isArray(fact.entry_refs)) throw new Error(`${path}.entry_refs: expected an array`);
  const entryIds = fact.entry_refs.map((ref: unknown) => {
   const match = typeof ref === 'string' && /^N([1-9]\d*)$/u.exec(ref);
   const id = match ? input.entries[Number(match[1]) - 1]?.id : undefined;
   if (!id || !source.ids.includes(id)) throw new Error(`${path}.entry_refs: unknown Cue or Cue outside ${source.ref}`);
   return id;
  });
  if (source.ids.length && !entryIds.length) throw new Error(`${path}.entry_refs: cite the source Cues`);
  const seen = covered.get(source.ref) ?? new Set<string>();
  entryIds.forEach(id => seen.add(id)); covered.set(source.ref, seen);
  facts.push({ sourceRef: source.owner.ref, sourceHeading: source.section.heading, claim: fact.claim.trim(), entryIds, destinationHeading: fact.destination_heading });
  } catch (error) { violations.push(error instanceof Error ? error.message : String(error)); }
 });
 const missing = sourceSections.filter(row => !covered.has(row.ref) || row.ids.some(id => !covered.get(row.ref)!.has(id)));
 if (missing.length) violations.push(`facts.json: source sections/Cues missing from valid fact inventory: ${missing.map(row => `${row.ref} (${row.owner.alias}: ${row.section.heading})`).join(', ')}`);
 if (violations.length) throw new Error(violations.join('\n'));
 // facts.json is a coverage aid, not semantic proof; semantic completeness still requires review of the actual source bodies.
 return { kind: 'object-target-pages', value, facts };
}
