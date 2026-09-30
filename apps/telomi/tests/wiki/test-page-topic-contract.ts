import assert from 'node:assert/strict';
import { createPageTopicTask } from '../../server/wiki/page-topic-contract.js';
import type { NoteFirstInput } from '../../server/wiki/note-first-contract.js';
import { objectFirstSections } from '../../server/wiki/object-first-contract.js';
import { renderAgentPrompt } from '../../server/agent-runtime/prompt-registry.js';

const prompt = renderAgentPrompt('wiki', 'note-first', 'system', {}, 'page-topics');
assert.ok(prompt.content.includes('section_ref') && prompt.content.includes('topic_ref'));
assert.ok(!prompt.content.includes('{{'), 'registered prompt must render without unresolved variables');

const entryId = `entry:${'a'.repeat(24)}`;
function inputFor(body: string): NoteFirstInput {
 const page = { id: 'entity:private', kind: 'entity' as const, title: 'Private metadata title', description: 'Private metadata description', body };
 return {
  stage: 'page-topics', key: 'private-key', language: 'en', goal: { title: 'Private goal', description: 'Private goal description' },
  pages: [{ ref: 'private-ref', page, role: 'context', previous: true }], sections: objectFirstSections([page]),
  topics: [
   { id: 'topic:water', title: 'Water conservation', intent: 'Understand water use', questions: ['How is water conserved?'], include: ['Irrigation'], exclude: ['Electricity alone'] },
   { id: 'topic:energy', title: 'Energy efficiency', intent: 'Understand energy use', questions: ['How is energy reduced?'], include: ['Lighting'], exclude: ['Aesthetics alone'] },
  ],
  entries: [{ id: entryId, revisionSha256: 'r', sourceRunId: 'private-run', sourceId: 'private-source', sourceTitle: 'Private source title', canonicalLocator: 'https://private.example', members: [], section: 'Private cue section', cue: 'Private cue', detail: 'Private cue detail', anchors: [] }],
  requiredEntries: [], requiredPages: [], instructions: 'Private instructions', previousRelations: [],
 };
}
const body = `Background context before any H2. [[${entryId}]]\n\n## Water\nDrip irrigation reduced water consumption. [[${entryId}]]\n\n## Lighting\nLEDs reduced electricity consumption. [[${entryId}]]\n\n## Notes\nThis section only explains the document layout.\n`;
const input = inputFor(body);
const task = createPageTopicTask(input);
const context = JSON.parse(task.userContext);
assert.deepEqual(Object.keys(context), ['output_language', 'topics', 'preamble', 'sections']);
assert.equal(context.preamble, 'Background context before any H2. \n');
assert.deepEqual(context.sections.map((row: { section_ref: string }) => row.section_ref), ['S1', 'S2', 'S3']);
assert.equal([context.preamble, ...context.sections.map((row: { body: string }) => row.body)].join('\n'), body.replaceAll(`[[${entryId}]]`, ''));
assert.ok(!task.userContext.includes('Private') && !task.userContext.includes(entryId));
assert.doesNotMatch(task.userContext, /\[\[(?:entry:|N\d)/u);
assert.equal(input.pages[0]!.page.body, body, 'Model projection must not change canonical evidence or section positions');
assert.deepEqual(context.topics[0], { topic_ref: 'T1', title: 'Water conservation', intent: 'Understand water use', questions: ['How is water conserved?'], include: ['Irrigation'], exclude: ['Electricity alone'] });

const changedMetadata = structuredClone(input);
Object.assign(changedMetadata.pages[0]!.page, { id: 'concept:another-id', kind: 'concept', title: 'Water', description: 'A different description' });
changedMetadata.sections = objectFirstSections(changedMetadata.pages.map(row => row.page));
assert.equal(createPageTopicTask(changedMetadata).userContext, task.userContext, 'page metadata cannot change model input');
const enriched = { ...input, sections: input.sections.map((row, index) => ({ ...row, entryIds: index < 2 ? [entryId] : [] })) };
assert.equal(createPageTopicTask(enriched).userContext, task.userContext, 'Runtime evidence enrichment stays private');
assert.throws(() => createPageTopicTask({ ...input, sections: enriched.sections.map(row => ({ ...row, entryIds: [] })) }), /evidence/);

const valid = { sections: [
 { section_ref: 'S1', matches: [{ topic_ref: 'T1', reason: 'The section describes irrigation water savings.' }] },
 { section_ref: 'S2', matches: [{ topic_ref: 'T2', reason: 'The section describes electricity savings.' }, { topic_ref: 'T1', reason: 'A second structurally valid classification.' }] },
 { section_ref: 'S3', matches: [] },
] };
assert.deepEqual(task.validate(valid), input.sections.map((section, index) => ({ sectionRef: section.ref, matches: valid.sections[index]!.matches.map(match => ({ topicId: input.topics[Number(match.topic_ref.slice(1)) - 1]!.id, reason: match.reason })) })));
assert.equal(task.validate({ sections: [...valid.sections].reverse() })[0]!.sectionRef, input.sections[2]!.ref);
assert.equal(task.validate({ sections: valid.sections.map(row => ({ ...row, matches: [] })) }).length, 3);

for (const malformed of [
 null, [], { sections: null }, { ...valid, gaps: [] }, { sections: valid.sections.slice(1) },
 { sections: [...valid.sections, valid.sections[0]] },
 { sections: [{ ...valid.sections[0], section_ref: 'S9' }, ...valid.sections.slice(1)] },
 { sections: [{ ...valid.sections[0], extra: true }, ...valid.sections.slice(1)] },
 { sections: [{ section_ref: 'S1' }, ...valid.sections.slice(1)] },
 { sections: [{ ...valid.sections[0], matches: {} }, ...valid.sections.slice(1)] },
 ...[
  { topic_ref: 'T9', reason: 'Unknown Topic' }, { topic_ref: 'T1', reason: 'Evidence [[N1]]' },
  { topic_ref: 'T1', reason: `Evidence [[${entryId}]]` }, { topic_ref: 'T1', reason: 'Evidence [^1]' }, { topic_ref: 'T1', reason: ' ' },
  { topic_ref: 'T1', reason: 'Extra field', extra: 1 }, { topic_ref: 'T1' },
 ].map(match => ({ sections: [{ section_ref: 'S1', matches: [match] }, ...valid.sections.slice(1)] })),
 { sections: [{ ...valid.sections[0], matches: [valid.sections[0]!.matches[0], valid.sections[0]!.matches[0]] }, ...valid.sections.slice(1)] },
]) assert.throws(() => task.validate(malformed), 'malformed or incomplete output must fail');

const contextMatch = { sections: [...valid.sections.slice(0, 2),
 { section_ref: 'S3', matches: [{ topic_ref: 'T1', reason: 'Related context without a local Cue' }] }] };
assert.deepEqual(task.validate(contextMatch)[2], { sectionRef: input.sections[2]!.ref, matches: [] },
 'Runtime excludes uncited context from navigation without asking the classifier to infer hidden evidence');
assert.deepEqual(task.validate(contextMatch).slice(0, 2), task.validate(valid).slice(0, 2), 'supported matches remain unchanged');
assert.throws(() => task.validate({ sections: [...valid.sections.slice(0, 2),
 { section_ref: 'S3', matches: [{ topic_ref: 'T9', reason: 'Unknown Topic even for context' }] }] }), /unknown/);

for (const invalidInput of [
 { ...input, stage: 'topic' as const }, { ...input, pages: [] }, { ...input, pages: [...input.pages, ...input.pages] },
 { ...input, sections: input.sections.slice(1) }, { ...input, sections: [input.sections[0]!, input.sections[0]!, input.sections[2]!] },
 { ...input, sections: input.sections.map((row, index) => index ? row : { ...row, startLine: 1 }) },
 { ...input, topics: [...input.topics, input.topics[0]!] }, { ...input, entries: [] },
 { ...input, entries: [...input.entries, ...input.entries] }, inputFor('No navigable H2 sections'),
]) assert.throws(() => createPageTopicTask(invalidInput));

const literal = inputFor(`## Measurement\nN1 = 32, interval [0, 1], 1.45%, and **bold** remain meaningful. [[${entryId}]]`);
assert.ok(JSON.parse(createPageTopicTask(literal).userContext).sections[0].body.includes('N1 = 32, interval [0, 1], 1.45%, and **bold**'));

const second = inputFor(`## Museum access\nVisitors can enter using ramps. [[${entryId}]]\n\n\`\`\`md\n## This is quoted code, not another section\n\`\`\`\n\n## Museum access\nAudio guides describe exhibits. [[${entryId}]]`);
second.topics = [{ id: 'topic:access', title: 'Accessible services', intent: 'Understand visitor accessibility', questions: [], include: ['Mobility and sensory access'], exclude: ['Ticket prices'] }];
const secondTask = createPageTopicTask(second);
const secondContext = JSON.parse(secondTask.userContext);
assert.equal(secondContext.preamble, '');
assert.equal(secondContext.sections.length, 2, 'reuse canonical section parsing for fences and duplicate headings');
assert.equal(secondContext.sections.map((row: { body: string }) => row.body).join('\n'), second.pages[0]!.page.body.replaceAll(`[[${entryId}]]`, ''));
assert.equal(secondTask.validate({ sections: ['S1', 'S2'].map(section_ref => ({ section_ref, matches: [{ topic_ref: 'T1', reason: 'The section describes visitor accessibility.' }] })) }).length, 2);
console.log('Page Topic contract preserves complete bodies, hides metadata and validates exhaustive section classifications');
