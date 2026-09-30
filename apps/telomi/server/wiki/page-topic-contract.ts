import { hashJson } from '../lib/hash.js';
import { assertNoDuplicates, isRecord } from '../lib/values.js';
import type { NoteFirstInput } from './note-first-contract.js';
import { objectFirstEntries, objectFirstSections } from './object-first-contract.js';

function fail(message: string): never { throw new Error(`Page Topic task: ${message}`); }
function shape(value: unknown, keys: string[], field: string): asserts value is Record<string, unknown> {
 if (!isRecord(value) || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) fail(`${field}: expected exactly [${keys.join(', ')}]`);
}
function rows(value: unknown, field: string): unknown[] {
 if (!Array.isArray(value)) fail(`${field}: expected array`);
 return value;
}
function text(value: unknown, field: string): string {
 if (typeof value !== 'string' || !value.trim()) fail(`${field}: expected non-empty text`);
 return value;
}

/** One complete body is supplied inline; durable identities stay in this Runtime closure. */
export function createPageTopicTask(input: NoteFirstInput): {
 userContext: string;
 validate(output: unknown): Array<{ sectionRef: string; matches: Array<{ topicId: string; reason: string }> }>;
} {
 if (input.stage !== 'page-topics' || input.pages.length !== 1) fail('expected page-topics with exactly one page');
 const page = input.pages[0]!.page;
 const actualSections = objectFirstSections([page]);
 if (!actualSections.length || input.sections.length !== actualSections.length) fail('input must include every body section');
 assertNoDuplicates(input.sections.map(row => row.ref), 'input sections');
 for (const section of input.sections) {
  const actual = actualSections.find(row => row.ref === section.ref);
  const { entryIds, ...core } = section as typeof section & { entryIds?: string[] };
  if (!actual || hashJson(actual) !== hashJson(core)) fail('input contains stale or invalid section');
  if (entryIds) {
   const cited = objectFirstEntries(page.body.split('\n').slice(section.startLine - 1, section.endLine).join('\n'));
   if (entryIds.length !== new Set(entryIds).size || hashJson([...entryIds].sort()) !== hashJson([...cited].sort())) fail('input section evidence does not match its body');
  }
 }
 assertNoDuplicates(input.topics.map(row => row.id), 'input topics');
 assertNoDuplicates(input.entries.map(row => row.id), 'input entries');
 const entries = new Set(input.entries.map(row => row.id));
 // Evidence stays attached to canonical sections in Runtime, not in the classification prompt.
 const modelBody = (body: string) => body.replace(/\[\[(entry:[a-f0-9]{24})\]\]/gu, (_match, id: string) => {
  if (!entries.has(id)) fail('body references unknown Entry');
  return '';
 });
 const lines = page.body.split('\n');
 const sections = new Map(actualSections.map((row, index) => [`S${index + 1}`, row]));
 const topics = new Map(input.topics.map((row, index) => [`T${index + 1}`, row]));
 const body = (section: typeof actualSections[number]) => lines.slice(section.startLine - 1, section.endLine).join('\n');
 const userContext = JSON.stringify({
  output_language: input.language,
  topics: [...topics].map(([topic_ref, { title, intent, questions, include, exclude }]) => ({ topic_ref, title, intent, questions, include, exclude })),
  preamble: modelBody(lines.slice(0, actualSections[0]!.startLine - 1).join('\n')),
  sections: [...sections].map(([section_ref, section]) => ({ section_ref, body: modelBody(body(section)) })),
 });
 return {
  userContext,
  validate(output) {
   shape(output, ['sections'], 'output');
   const seen = new Set<string>();
   const result = rows(output.sections, 'output.sections').map((row, index) => {
    const path = `output.sections[${index}]`;
    shape(row, ['section_ref', 'matches'], path);
    const ref = text(row.section_ref, `${path}.section_ref`);
    const section = sections.get(ref);
    if (!section || seen.has(ref)) fail(`${path}.section_ref: unknown or duplicate section ${ref}`);
    seen.add(ref);
    const seenTopics = new Set<string>();
    const matches = rows(row.matches, `${path}.matches`).map((match, matchIndex) => {
     const matchPath = `${path}.matches[${matchIndex}]`;
     shape(match, ['topic_ref', 'reason'], matchPath);
     const topicRef = text(match.topic_ref, `${matchPath}.topic_ref`);
     const topic = topics.get(topicRef);
     if (!topic || seenTopics.has(topicRef)) fail(`${matchPath}.topic_ref: unknown or duplicate Topic ${topicRef}`);
     seenTopics.add(topicRef);
     const reason = text(match.reason, `${matchPath}.reason`);
     if (/\[\[(?:entry:[a-f0-9]{24}|N\d+)\]\]|\[\^[^\]]+\]/u.test(reason)) fail(`${matchPath}.reason: use plain prose without internal citation markers`);
     return { topicId: topic.id, reason };
    });
    // Cue markers stay hidden from the classifier; Runtime owns link eligibility.
    // Uncited sections remain reading context, but cannot become navigation targets.
    return { sectionRef: section.ref, matches: objectFirstEntries(body(section)).length ? matches : [] };
   });
   const missing = [...sections.keys()].filter(ref => !seen.has(ref));
   if (missing.length) fail(`output.sections: missing sections [${missing.join(', ')}]; return every section exactly once`);
   return result;
  },
 };
}
