import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { isRecord } from '../lib/values.js';
import type { NoteFirstInput, NoteFirstResult } from './note-first-contract.js';
import { createNoteFirstWorkspace } from './note-first-workspace.js';
import { objectFirstEntries } from './object-first-contract.js';
import { readNoteFirstOutput } from './note-first-stage.js';

function shape(value: unknown, keys: string[], field: string): Record<string, unknown> {
 assert(isRecord(value), `${field}: expected object`);
 assert.deepEqual(Object.keys(value).sort(), [...keys].sort(), `${field}: expected exactly ${keys.join(', ')}`);
 return value;
}
function text(value: unknown, field: string): string {
 assert(typeof value === 'string' && value.trim(), `${field}: expected nonempty text`);
 return value;
}
function rows(value: unknown, field: string): unknown[] {
 assert(Array.isArray(value), `${field}: expected array`);
 return value;
}
function refs(value: unknown, allowed: Set<string>, field: string): string[] {
 const values = rows(value, field).map(ref => text(ref, field));
 assert.equal(new Set(values).size, values.length, `${field}: duplicate reference`);
 for (const ref of values) assert(allowed.has(ref), `${field}: invalid reference ${ref}`);
 return values;
}

/** Record only complete source lines actually returned by the native read tool. */
export class ReadCoverage {
 readonly lines = new Map<string, Set<number>>();
 constructor(readonly sources: Map<string, string>) {}
 record(params: { path: string; offset?: number; limit?: number }, result: { isError?: boolean; content: Array<{ type: string; text?: string }> }): void {
  const path = posix.resolve('/work', params.path), source = this.sources.get(path);
  if (source === undefined || result.isError) return;
  const returned = result.content.filter(row => row.type === 'text').map(row => row.text ?? '').join('\n');
  const original = source.split('\n'), start = Math.max(0, (params.offset ?? 1) - 1);
  const selected = original.slice(start, params.limit === undefined ? undefined : start + params.limit);
  const seen = this.lines.get(path) ?? new Set<number>();
  let offset = 0;
  for (let index = 0; index < selected.length; index++) {
   const line = selected[index]!;
   if (!returned.startsWith(line, offset)) break;
   const end = offset + line.length;
   if (end < returned.length && returned[end] !== '\n') break;
   if (end === returned.length && start + index < original.length - 1 && index < selected.length - 1) break;
   seen.add(start + index); offset = end + 1;
  }
  this.lines.set(path, seen);
 }
 observe(params: Parameters<ReadCoverage['record']>[0], result: Parameters<ReadCoverage['record']>[1]): void { this.record(params, result); }
 full(path: string): boolean {
  const source = this.sources.get(path);
  if (source === undefined) return false;
  const lines = source.split('\n');
  return lines.every((line, index) => index === lines.length - 1 && line === '' || this.lines.get(path)?.has(index));
 }
 assertFull(path: string): void { assert(this.full(path), `read every line of ${path}; continue native read with offset when truncated`); }
 snapshot() {
  return Object.fromEntries([...this.sources.keys()].map(path => [path, {
   full: this.full(path), deliveredLines: [...(this.lines.get(path) ?? [])].sort((a, b) => a - b),
  }]));
 }
}

export function createConceptReadCoverage(input: NoteFirstInput, inputRoot: string): ReadCoverage {
 return new ReadCoverage(new Map(input.pages.map((_row, index) => {
  const ref = `P${index + 1}`;
  return [`/work/input/pages/${ref}.md`, readFileSync(join(inputRoot, 'pages', `${ref}.md`), 'utf8')];
 })));
}

export function validatePiConceptFiles(input: NoteFirstInput, inputRoot: string, work: string, reads: ReadCoverage) {
 const output: unknown = JSON.parse(readNoteFirstOutput(join(work, 'result.json')).toString('utf8'));
 const workspace = createNoteFirstWorkspace(input, inputRoot);
 const pages = new Map(input.pages.map((row, index) => [`P${index + 1}`, row]));
 const allPages = new Set(pages.keys());
 const objects = new Set([...pages].flatMap(([ref, row]) => row.page.kind === 'entity' ? [ref] : []));
 const concepts = new Set([...pages].flatMap(([ref, row]) => row.page.kind === 'concept' ? [ref] : []));
 const history = new Set([...pages].flatMap(([ref, row]) => row.previous && row.page.kind === 'concept' ? [ref] : []));
 const full = (ref: string) => reads.assertFull(`/work/input/pages/${ref}.md`);
 for (const ref of pages.keys()) if (reads.full(`/work/input/pages/${ref}.md`)) {
  workspace.read(ref);
  for (const section of workspace.overviews[ref]!.sections) workspace.read(section.section_ref);
 }
 let result: NoteFirstResult;
 if (input.stage === 'plan-concepts') {
  const value = shape(output, ['concept_jobs', 'object_only'], 'plan');
  const targets = new Set<string>(), questions = new Set<string>(), assigned = new Set<string>();
  const jobs = rows(value.concept_jobs, 'concept_jobs').map((value, index) => {
   const field = `concept_jobs[${index}]`, job = shape(value, ['question', 'scope', 'page_refs', 'target_ref'], field);
   const question = text(job.question, `${field}.question`), normalized = question.normalize('NFKC').trim().toLowerCase();
   assert(!questions.has(normalized), `${field}: duplicate question`); questions.add(normalized);
   const scope = text(job.scope, `${field}.scope`), members = refs(job.page_refs, objects, `${field}.page_refs`);
   assert(members.length, `${field}: needs supporting objects`);
   members.forEach(ref => assigned.add(ref));
   let targetRef: string | null = null;
   if (job.target_ref !== null) {
    const target = text(job.target_ref, `${field}.target_ref`);
    assert(history.has(target), `${field}: invalid existing concept target`);
    assert(!targets.has(target), `${field}: existing target has multiple writers`); targets.add(target);
    targetRef = pages.get(target)!.ref;
   }
   return { question, scope, pageRefs: members.map(ref => pages.get(ref)!.ref), targetRef };
  });
  const excluded = new Set<string>();
  const objectOnly = rows(value.object_only, 'object_only').map((value, index) => {
   const field = `object_only[${index}]`, row = shape(value, ['page_ref', 'compared_with', 'reason'], field);
   const ref = text(row.page_ref, `${field}.page_ref`), reason = text(row.reason, `${field}.reason`);
   assert(objects.has(ref) && !assigned.has(ref), `${field}: unknown object or also assigned to a concept`);
   assert(!excluded.has(ref), `${field}: duplicate object`); excluded.add(ref); full(ref);
   const counterparts = refs(row.compared_with, allPages, `${field}.compared_with`);
   for (const counterpart of counterparts) { assert(counterpart !== ref, `${field}: cannot compare an object to itself`); full(counterpart); }
   return { pageRef: pages.get(ref)!.ref, comparedWith: counterparts.map(ref => pages.get(ref)!.ref), reason };
  });
  assert.equal(new Set([...assigned, ...excluded]).size, objects.size, 'Every object needs a concept job or a verified object_only decision');
  result = { kind: 'concept-plan', jobs, objectOnly };
 } else if (input.stage === 'audit-concepts') {
  const value = shape(output, ['reviewed_pages', 'conflict_groups', 'discarded_refs'], 'audit');
  const reviewedPages = rows(value.reviewed_pages, 'reviewed_pages').map((value, index) => {
   const field = `reviewed_pages[${index}]`, row = shape(value, ['page_ref', 'reason'], field);
   const ref = text(row.page_ref, `${field}.page_ref`);
   assert(concepts.has(ref), `${field}: invalid concept`);
   return { alias: ref, pageRef: pages.get(ref)!.ref, reason: text(row.reason, `${field}.reason`) };
  });
  assert.equal(refs(reviewedPages.map(row => row.alias), concepts, 'reviewed_pages').length, concepts.size, 'reviewed_pages: every supplied concept needs a review reason');
  const consumed = new Set<string>();
  const conflictGroups = rows(value.conflict_groups, 'conflict_groups').map((value, index) => {
   const field = `conflict_groups[${index}]`, row = shape(value, ['page_refs', 'reason'], field);
   const members = refs(row.page_refs, concepts, `${field}.page_refs`), reason = text(row.reason, `${field}.reason`);
   assert(members.length >= 2, `${field}: conflict needs at least two pages`);
   for (const ref of members) { assert(!consumed.has(ref), `audit overlap: ${ref}`); consumed.add(ref); full(ref); }
   return { pageRefs: members.map(ref => pages.get(ref)!.ref), reason };
  });
  const discardedRefs = rows(value.discarded_refs, 'discarded_refs').map((value, index) => {
   const field = `discarded_refs[${index}]`, row = shape(value, ['ref', 'reason'], field), ref = text(row.ref, `${field}.ref`);
   const reason = text(row.reason, `${field}.reason`);
   assert(concepts.has(ref) && !history.has(ref) && !consumed.has(ref), `invalid discard: ${ref}`);
   consumed.add(ref); full(ref);
   return { ref: pages.get(ref)!.ref, reason };
  });
  result = { kind: 'concept-audit', reviewedPages: reviewedPages.map(({ alias: _alias, ...row }) => row), conflictGroups, discardedRefs };
 } else {
  assert(input.stage === 'concepts' || input.stage === 'merge-concepts', 'Pi concept contract only accepts concept stages');
  if (input.stage === 'concepts') {
   for (const ref of input.requiredPages) {
    const alias = [...pages].find(([, row]) => row.ref === ref)?.[0];
    assert(alias && objects.has(alias), 'Writer primary references must be supplied objects'); full(alias);
   }
   if (input.conceptTask?.targetRef) {
    const target = [...pages].find(([, row]) => row.ref === input.conceptTask!.targetRef)?.[0];
    assert(target && history.has(target), 'Writer target must be a supplied existing concept'); full(target);
   }
  } else {
   const manifest = shape(output, ['pages', 'retained_refs', 'discarded_refs'], 'merge');
   assert.deepEqual(manifest.discarded_refs, [], 'Conflict merge cannot discard members');
   for (const [ref, row] of pages) if (row.role === 'member') { assert(concepts.has(ref), 'Conflict members must be concepts'); full(ref); }
  }
  result = workspace.validate(output, work);
  assert.equal(result.kind, 'pages');
  if (result.kind !== 'pages') throw new Error('Concept writer must produce pages');
  const delivered = new Set<string>();
  for (const [path, content] of reads.sources) for (const line of reads.lines.get(path) ?? []) {
   for (const match of content.split('\n')[line]!.matchAll(/\[\[(N\d+)\]\]/gu)) {
    const entry = input.entries[Number(match[1]!.slice(1)) - 1];
    assert(entry, 'Read page contains unknown citation'); delivered.add(entry.id);
   }
  }
  for (const page of result.value.pages) assert(objectFirstEntries(page.body).every(id => delivered.has(id)), 'Output cites evidence not returned by native read');
  if (input.stage === 'concepts') {
   assert(result.value.pages.length <= 1, 'One candidate writer produces zero or one concept');
   if (input.conceptTask?.targetRef) {
    const old = input.pages.find(row => row.ref === input.conceptTask!.targetRef)!.page;
    for (const page of result.value.pages) {
     assert(objectFirstEntries(old.body).every(id => objectFirstEntries(page.body).includes(id)), 'Existing target citations must survive');
     page.id = old.id;
    }
   }
  }
 }
 return { result, receipts: workspace.receipts() };
}
