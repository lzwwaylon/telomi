import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSkillsFromDir, type InlineExtension, type ToolDefinition } from '@earendil-works/pi-coding-agent';
import { registerPiUserMemory } from 'pi-user-memory';
import { validateWikiMainSessionContext } from '../main-agent/wiki-context.js';
import { frozenInteractionLedger } from '../agent-runtime/node-evaluation.js';
import { renderAgentPrompt } from '../agent-runtime/prompt-registry.js';
import { writeJsonAtomic } from '../lib/fs.js';
import { isRecord, toErrorMessage } from '../lib/values.js';
import { runPiFileStage } from './pi-file-stage.js';
import { observePiMergeRead } from './pi-object-stage.js';
import { wikiPageEntryIds } from './wiki-page-contract.js';
import { readWikiStageOutput } from './wiki-stage.js';
import { createWikiStageWorkspace } from './wiki-stage-workspace.js';
import type { WikiEvidenceCurationDecision, WikiInvestigationReview, WikiStageInput, WikiStageOutcome, WikiStageRequest } from './wiki-stage-contract.js';

function shape(value: unknown, keys: string[], field: string): Record<string, unknown> {
 if (!isRecord(value) || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key)))
  throw new Error(`${field}: expected exactly [${keys.join(', ')}]`);
 return value;
}

function text(value: unknown, field: string): string {
 if (typeof value !== 'string' || !value.trim()) throw new Error(`${field}: expected nonempty text`);
 return value;
}

/** Reviews explain delivery choices; their contents never become Source evidence. */
export function validateWikiInvestigationReviews(value: unknown): WikiInvestigationReview[] {
 if (!Array.isArray(value)) throw new Error('Wiki curation reviews must be an array');
 const ids = new Set<string>();
 return value.map((item, index) => {
  const field = `curationReviews[${index}]`;
  const row = shape(item, ['investigationId', 'question', 'answer', 'usefulFindings', 'excludedFindings'], field);
  const investigationId = text(row.investigationId, `${field}.investigationId`);
  if (!/^[a-f0-9]{24}$/u.test(investigationId) || ids.has(investigationId)) throw new Error(`${field}.investigationId: invalid or duplicate identity`);
  ids.add(investigationId);
  if (!Array.isArray(row.usefulFindings) || !Array.isArray(row.excludedFindings)) throw new Error(`${field}: findings must be arrays`);
  return { investigationId, question: text(row.question, `${field}.question`), answer: text(row.answer, `${field}.answer`),
   usefulFindings: row.usefulFindings.map((finding, i) => text(finding, `${field}.usefulFindings[${i}]`)),
   excludedFindings: row.excludedFindings.map((finding, i) => {
    const excluded = shape(finding, ['finding', 'reason'], `${field}.excludedFindings[${i}]`);
    return { finding: text(excluded.finding, `${field}.finding`), reason: text(excluded.reason, `${field}.reason`) };
   }) };
 });
}

function incomingEntries(input: WikiStageInput) {
 if (input.stage !== 'curate-evidence') throw new Error('Evidence curation expects curate-evidence');
 const entries = new Map(input.entries.map(entry => [entry.id, entry]));
 const required = new Set(input.requiredEntries);
 const historical = new Set(input.pages.flatMap(page => wikiPageEntryIds(page.page.body)));
 if (entries.size !== input.entries.length || required.size !== input.requiredEntries.length
  || input.requiredEntries.some(id => !entries.has(id) || historical.has(id))
  || input.pages.some(page => !page.previous || page.role !== 'context')) throw new Error('Evidence curation requires unique incoming Cues and read-only historical pages');
 return input.entries.flatMap((entry, index) => required.has(entry.id) ? [{ entry, ref: `N${index + 1}` }] : []);
}

/** Also validates injected Stage results at the compiler boundary. */
export function validateEvidenceCurationDecisions(input: WikiStageInput, value: unknown): WikiEvidenceCurationDecision[] {
 const incoming = new Set(incomingEntries(input).map(row => row.entry.id));
 if (!Array.isArray(value)) throw new Error('Evidence curation decisions must be an array');
 const seen = new Set<string>();
 const decisions = value.map((item, index): WikiEvidenceCurationDecision => {
  const field = `decisions[${index}]`, row = shape(item, ['entryId', 'action', 'reason'], field);
  const entryId = text(row.entryId, `${field}.entryId`);
  if (!incoming.has(entryId) || seen.has(entryId)) throw new Error(`${field}.entryId: unknown, historical or duplicate Cue`);
  if (row.action !== 'adopt' && row.action !== 'defer' && row.action !== 'skip') throw new Error(`${field}.action: expected adopt, defer or skip`);
  seen.add(entryId);
  return { entryId, action: row.action, reason: text(row.reason, `${field}.reason`) };
 });
 if (seen.size !== incoming.size) throw new Error('Evidence curation must decide every incoming Cue exactly once');
 return decisions;
}

export function piEvidenceCurationUserContext(input: WikiStageInput): string {
 const incoming = incomingEntries(input);
 return JSON.stringify({ output_language: input.language, goal: input.goal,
  maintenance_instructions: input.instructions,
  topics: input.topics.map(({ id: _id, ...topic }, index) => ({ ref: `T${index + 1}`, ...topic })),
  investigation_reviews: validateWikiInvestigationReviews(input.curationReviews ?? []),
  report_context: input.reportContext,
  incoming_cues: incoming.map(({ entry, ref }) => ({ ref, source_title: entry.sourceTitle, canonical_locator: entry.canonicalLocator,
   section: entry.section, section_summary: entry.sectionSummary ?? '', cue: entry.cue, detail: entry.detail })),
  previous_pages: input.pages.map(({ page }, index) => ({ ref: `P${index + 1}`, kind: page.kind,
   title: page.title, description: page.description, file: `wiki/pages/P${index + 1}.md`, index: `wiki/indexes/P${index + 1}.json` })) });
}

export function validatePiEvidenceCurationFiles(input: WikiStageInput, work: string) {
 const output = shape(JSON.parse(readWikiStageOutput(join(work, 'result.json')).toString('utf8')), ['decisions'], 'output');
 if (!Array.isArray(output.decisions)) throw new Error('output.decisions: expected an array');
 const aliases = new Map(incomingEntries(input).map(({ entry, ref }) => [ref, entry.id]));
 const decisions = output.decisions.map((item: unknown, index: number) => {
  const field = `output.decisions[${index}]`, row = shape(item, ['entry_ref', 'action', 'reason'], field);
  if (typeof row.entry_ref !== 'string' || !aliases.has(row.entry_ref)) throw new Error(`${field}.entry_ref: unknown or historical Cue alias`);
  return { entryId: aliases.get(row.entry_ref), action: row.action, reason: row.reason };
 });
 return { kind: 'evidence-curation' as const, decisions: validateEvidenceCurationDecisions(input, decisions) };
}

export async function runPiEvidenceCurationStage(request: WikiStageRequest): Promise<WikiStageOutcome> {
 request.signal.throwIfAborted();
 if (!incomingEntries(request.input).length) return { result: { kind: 'evidence-curation', decisions: [] },
  usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, calls: 0 }, sessionPaths: [] };
 const reads = new Map<string, Set<number>>();
 const main = request.input.mainSession ? validateWikiMainSessionContext(request.input.mainSession) : undefined;
 const skillRoot = fileURLToPath(new URL('../../agents/main/main-agent/skills/user-memory', import.meta.url));
 const skill = main ? loadSkillsFromDir({ dir: skillRoot, source: 'main-background-wiki' }).skills[0] : undefined;
 if (main && !skill) throw new Error('Background Main selection requires the bundled user-memory Skill');
 const background = main ? renderAgentPrompt('main', 'main-agent', 'system-append', {}, 'background-wiki-selection').content : '';
 const answer = request.memoryReplay === undefined ? undefined : frozenInteractionLedger(request.memoryReplay);
 let missingMemory: Error | undefined;
 const memoryExtension = (runtime: string): InlineExtension => (pi) => registerPiUserMemory(new Proxy(pi, {
  get(target, name) {
   if (name !== 'registerTool') return Reflect.get(target, name);
   return (tool: ToolDefinition) => {
    if (tool.name !== 'search_user_memory') throw new Error('Background Main memory extension exposed an unexpected Tool');
    target.registerTool({ ...tool, async execute(...args: Parameters<typeof tool.execute>) {
     const record = { kind: 'tool' as const, name: tool.name, label: tool.label, description: tool.description, arguments: args[1] };
     try {
      let result;
      if (answer) {
       try { result = answer(tool.name, args[1]) as Awaited<ReturnType<typeof tool.execute>>; }
       catch (error) { missingMemory = new Error(`Wiki Replay memory capability is missing: ${toErrorMessage(error)}`); throw missingMemory; }
       if (isRecord(result.details) && typeof result.details.wikiMemoryError === 'string') throw new Error(result.details.wikiMemoryError);
      } else result = await tool.execute(...args);
      appendFileSync(join(runtime, 'memory-searches.jsonl'), `${JSON.stringify({ ...record, result })}\n`);
      return result;
     } catch (error) {
      const message = toErrorMessage(error);
      appendFileSync(join(runtime, 'memory-searches.jsonl'), `${JSON.stringify({ ...record,
       result: { content: [{ type: 'text', text: message }], details: { wikiMemoryError: message } } })}\n`);
      throw error;
     }
    } });
   };
  },
 }), { baseUrl: request.env.HINDSIGHT_URL, bankId: request.env.HINDSIGHT_BANK_ID,
  goalId: main?.goalId, retainTurns: false });
 return runPiFileStage(request, { promptVariant: 'curate-evidence-pi', user: piEvidenceCurationUserContext(request.input),
  role: 'wiki.object_builder', executionMode: 'pi-evidence-curation', codeFiles: ['./pi-evidence-curation.ts', './pi-object-stage.ts',
   ...(main ? ['../main-agent/wiki-context.ts', '../../agents/main/main-agent/skills/user-memory/SKILL.md',
    '../../../extensions/pi-user-memory/index.ts', '../../../extensions/pi-user-memory/src/client.ts'] : [])],
  grepRoot: request.input.pages.length ? '/work/wiki/pages' : undefined,
  mainSession: main,
  systemPrefix: main ? `${main.systemPrompt}\n\n${background}\n\n` : undefined,
  skills: skill ? [{ ...skill, filePath: '/work/wiki/skills/user-memory/SKILL.md', baseDir: '/work/wiki/skills/user-memory' }] : undefined,
  extensions: main ? runtime => [memoryExtension(runtime)] : undefined,
  assertExternalInteractions() { if (missingMemory) throw missingMemory; },
  prepare(inputRoot) {
   createWikiStageWorkspace(request.input, inputRoot);
   if (skill) {
    const root = join(inputRoot, 'skills/user-memory');
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'SKILL.md'), readFileSync(skill.filePath));
   }
  },
  readonlyMounts(inputRoot) { return [{ hostPath: inputRoot, guestPath: '/work/wiki', access: 'read-only' }]; },
  observeRead(inputRoot, _runtime, parameters, result) { observePiMergeRead(inputRoot, reads, parameters, result); },
  validate(inputRoot, work, runtime) {
   const result = validatePiEvidenceCurationFiles(request.input, work);
   writeJsonAtomic(join(runtime, 'complete-page-reads.json'), [...reads].filter(([ref, lines]) =>
    lines.size === readFileSync(join(inputRoot, 'pages', `${ref}.md`), 'utf8').split('\n').length).map(([ref]) => ref));
   return result;
  },
 });
}
