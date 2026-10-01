import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeJsonAtomic } from '../lib/fs.js';
import type { NoteFirstInput, NoteFirstOutcome, NoteFirstStageRequest } from './note-first-contract.js';
import { createNoteFirstWorkspace } from './note-first-workspace.js';
import { createConceptReadCoverage, validatePiConceptFiles, type ReadCoverage } from './pi-concept-contract.js';
import { runPiFileStage } from './pi-file-stage.js';

export const PI_CONCEPT_MODEL = 'openai-codex/gpt-5.6-terra';
const variants = {
 'plan-concepts': 'question-plan-pi', concepts: 'concepts-pi',
 'audit-concepts': 'audit-concepts-pi', 'merge-concepts': 'merge-concepts-pi',
} as const;

function catalog(input: NoteFirstInput): string {
 return input.pages.map((row, index) => `P${index + 1} | ${row.page.kind} | ${row.previous ? 'existing' : 'supplied'} | ${row.page.title} | ${row.page.description} | input/pages/P${index + 1}.md`).join('\n');
}

/** Only projected page files and their local aliases are exposed to the Agent. */
export function piConceptUserContext(input: NoteFirstInput): string {
 if (!(input.stage in variants)) throw new Error('Unsupported Pi concept stage');
 const alias = (ref: string): string => {
  const index = input.pages.findIndex(row => row.ref === ref);
  if (index < 0) throw new Error(`Unknown concept task reference ${ref}`);
  return `P${index + 1}`;
 };
 let task: Record<string, unknown> = {};
 if (input.stage === 'concepts') {
  if (!input.conceptTask) throw new Error('Concept writer requires question, scope and target');
  task = { question: input.conceptTask.question, scope: input.conceptTask.scope,
   page_refs: input.requiredPages.map(alias), target_ref: input.conceptTask.targetRef === null ? null : alias(input.conceptTask.targetRef) };
 } else if (input.stage === 'audit-concepts') {
  task = { concept_refs: input.pages.flatMap((row, index) => row.page.kind === 'concept' ? [`P${index + 1}`] : []),
   existing_origin_refs: input.pages.flatMap((row, index) => row.previous && row.page.kind === 'concept' ? [`P${index + 1}`] : []) };
 } else if (input.stage === 'merge-concepts') {
  task = { reason: input.instructions, member_refs: input.pages.filter(row => row.role === 'member').map(row => alias(row.ref)) };
 }
 return JSON.stringify({ ...(input.stage === 'audit-concepts' ? {} : { output_language: input.language }), goal: input.goal, task }, null, 2)
  + '\n\n## Complete page catalog\n' + catalog(input);
}

export async function runPiConceptStage(request: NoteFirstStageRequest): Promise<NoteFirstOutcome> {
 const stage = request.input.stage;
 if (!(stage in variants)) throw new Error('Unsupported Pi concept stage');
 let coverage: ReadCoverage;
 return runPiFileStage(request, {
  modelId: PI_CONCEPT_MODEL, referenceVariant: 'concept-common', promptVariant: variants[stage as keyof typeof variants],
  user: piConceptUserContext(request.input), executionMode: `pi-concept-${stage}`, role: 'wiki.object_builder',
  grepRoot: stage === 'plan-concepts' || stage === 'audit-concepts' ? '/work/input/pages' : undefined,
  codeFiles: ['./pi-concept-stage.ts', './pi-concept-contract.ts', './note-first-contract.ts', './object-first-contract.ts'],
  prepare(inputRoot) {
   createNoteFirstWorkspace(request.input, inputRoot);
   writeFileSync(join(inputRoot, 'catalog.md'), catalog(request.input));
   coverage = createConceptReadCoverage(request.input, inputRoot);
  },
  readonlyMounts(inputRoot) {
   return [{ hostPath: join(inputRoot, 'pages'), guestPath: '/work/input/pages', access: 'read-only' },
    { hostPath: join(inputRoot, 'catalog.md'), guestPath: '/work/input/catalog.md', access: 'read-only' }];
  },
  observeRead(_inputRoot, runtime, parameters, result) {
   coverage.observe(parameters, result);
   writeJsonAtomic(join(runtime, 'read-coverage.json'), coverage.snapshot());
  },
  validate(inputRoot, work, runtime) {
   const accepted = validatePiConceptFiles(request.input, inputRoot, work, coverage);
   writeJsonAtomic(join(runtime, 'receipts.json'), accepted.receipts);
   writeJsonAtomic(join(runtime, 'read-coverage.json'), coverage.snapshot());
   return accepted.result;
  },
 });
}
