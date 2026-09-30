import assert from 'node:assert/strict';
import { piConceptUserContext } from '../../server/wiki/pi-concept-stage.js';
import { acceptPiFiles } from '../../server/wiki/pi-file-stage.js';
import type { NoteFirstInput } from '../../server/wiki/note-first-contract.js';

const input: NoteFirstInput = { stage: 'plan-concepts', key: 'plan', language: 'en',
 goal: { title: 'Mechanisms', description: 'Understand their limits' }, entries: [],
 pages: [
  { ref: 'object:internal', previous: false, role: 'context', page: { id: 'entity:internal', kind: 'entity', title: 'Method', description: 'Mechanism', body: 'Private body' } },
  { ref: 'old:internal', previous: true, role: 'context', page: { id: 'concept:internal', kind: 'concept', title: 'Existing explanation', description: 'Boundary', body: 'Private old body' } },
 ], requiredEntries: [], requiredPages: ['object:internal'], previousRelations: [], instructions: '', topics: [], sections: [] };
const context = (value: NoteFirstInput) => {
 const text = piConceptUserContext(value);
 const data = JSON.parse(text.split('\n\n## Complete page catalog\n')[0]!);
 assert(!text.includes('internal'), 'Durable identities stay private');
 assert(!text.includes('Private body'), 'Native file reads supply the bodies');
 assert(text.includes('input/pages/P1.md') && text.includes('input/pages/P2.md'));
 return data;
};
assert.deepEqual(context(input).task, {});
const writer = context({ ...input, stage: 'concepts', conceptTask: { question: 'How?', scope: 'Conditions', targetRef: 'old:internal' } });
assert.deepEqual(writer.task, { question: 'How?', scope: 'Conditions', page_refs: ['P1'], target_ref: 'P2' });
assert.equal(writer.output_language, 'en');
assert.throws(() => piConceptUserContext({ ...input, stage: 'concepts' }), /requires question/);
assert.throws(() => piConceptUserContext({ ...input, stage: 'concepts', conceptTask: { question: 'How?', scope: 'Conditions', targetRef: 'missing' } }), /Unknown concept task reference/);
const audit = context({ ...input, stage: 'audit-concepts' });
assert.deepEqual(audit.task, { concept_refs: ['P2'], existing_origin_refs: ['P2'] });
assert(!Object.hasOwn(audit, 'output_language'), 'Internal audit has no user-facing prose');
const merge = context({ ...input, stage: 'merge-concepts', instructions: 'Same explanatory question',
 pages: input.pages.map((row, index) => ({ ...row, role: index === 1 ? 'member' : 'context' })) });
assert.deepEqual(merge.task, { reason: 'Same explanatory question', member_refs: ['P2'] });

// Concept stages share exactly one repair in their original session.
const turns: Array<{ prompt: string; repair: boolean }> = [], rejected: string[] = [];
const accepted = await acceptPiFiles(async (prompt, repair) => { turns.push({ prompt, repair }); }, () => {
 if (turns.length === 1) throw new Error('Missing required description');
 return { kind: 'concept-audit', reviewedPages: [], conflictGroups: [], discardedRefs: [] };
}, 'Audit the concepts', (_turn, error) => rejected.push(error));
assert.equal(accepted.kind, 'concept-audit');
assert.equal(turns.length, 2);
assert.deepEqual(turns.map(row => row.repair), [false, true]);
assert(turns[1]!.prompt.includes(rejected[0]!));
let attempts = 0;
await assert.rejects(acceptPiFiles(async () => { attempts++; }, () => { throw new Error('Still invalid'); }, 'Build', () => {}), /invalid after 2 attempts/);
assert.equal(attempts, 2);
console.log('Pi concept contexts expose local aliases and repair within one session');
