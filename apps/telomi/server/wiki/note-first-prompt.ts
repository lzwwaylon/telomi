import assert from 'node:assert/strict';
import type { NoteFirstInput } from './note-first-contract.js';

/** Keep the complete shared contract and exactly this worker's stage instructions. */
export function stagePrompt(source: string, stage: NoteFirstInput['stage']): string {
 const stages = ['objects', 'merge-objects', 'plan-concepts', 'concepts', 'merge-concepts', 'relations', 'plan-topics', 'topic'];
 const markers = [...source.matchAll(/^(objects|merge-objects|plan-concepts|concepts|merge-concepts|relations|plan-topics|topic): /gm)];
 assert.deepEqual(markers.map(match => match[1]), stages, 'Require every stage exactly once in authored order');
 const index = stages.indexOf(stage);
 assert(index >= 0, 'Unknown Wiki stage');
 return source.slice(0, markers[0]!.index).trimEnd() + '\n\n'
  + source.slice(markers[index]!.index, markers[index + 1]?.index ?? source.length).trim() + '\n';
}
