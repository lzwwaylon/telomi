import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderAgentPrompt } from '../../server/agent-runtime/prompt-registry.js';
import { piEvidenceCurationUserContext, validateEvidenceCurationDecisions, validatePiEvidenceCurationFiles, validateWikiInvestigationReviews } from '../../server/wiki/pi-evidence-curation.js';
import { runWikiStageKind } from '../../server/wiki/wiki-stage.js';
import { createWikiStageWorkspace } from '../../server/wiki/wiki-stage-workspace.js';
import type { WikiStageInput } from '../../server/wiki/wiki-stage-contract.js';

const root = mkdtempSync(join(tmpdir(), 'wiki-evidence-curation-'));
const ids = ['a', 'b', 'c', 'd'].map(char => `entry:${char.repeat(24)}`);
const entries = ids.map((id, index) => ({ id, revisionSha256: 'r', sourceRunId: 'run', sourceId: `source-${index}`,
 sourceTitle: 'Original Source', canonicalLocator: '', members: [], section: 'Architecture', cue: `Cue ${index}`, detail: `Complete detail ${index}`, anchors: [] }));
const review = { investigationId: 'f'.repeat(24), question: 'What changed?', answer: 'A conversational answer, not evidence.',
 usefulFindings: ['Architecture change'], excludedFindings: [{ finding: 'A transient release detail', reason: 'No lasting contribution' }] };
const input: WikiStageInput = { stage: 'curate-evidence', key: 'curate-evidence', language: 'en',
 goal: { title: 'Understand speech generation', description: '' }, entries, requiredEntries: ids.slice(1),
 pages: [{ ref: 'previous:model', previous: true, role: 'context', page: { id: 'model', kind: 'entity',
  title: 'Existing model', description: 'Existing grounded knowledge', body: `## Architecture\nHistorical detail [[${ids[0]}]].` } }],
 requiredPages: [], topics: [{ id: 'mechanisms', title: 'Mechanisms', intent: 'Understand models', questions: [], include: [], exclude: [] }],
 sections: [], previousRelations: [], instructions: 'Keep durable mechanism evidence; leave transient badge details out.', curationReviews: [review] };
try {
 const manifest = join(root, 'result.json');
 const decisions = ['adopt', 'defer', 'skip'].map((action, index) => ({ entry_ref: `N${index + 2}`, action, reason: `Specific reason ${index}` }));
 const write = (value: unknown) => writeFileSync(manifest, JSON.stringify(value));
 write({ decisions });
 const accepted = validatePiEvidenceCurationFiles(input, root);
 assert.deepEqual(accepted, { kind: 'evidence-curation', decisions: decisions.map((row, index) => ({ entryId: ids[index + 1], action: row.action, reason: row.reason })) });
 for (const invalid of [
  decisions.slice(1), [...decisions, decisions[0]], [{ ...decisions[0], entry_ref: 'N1' }, ...decisions.slice(1)],
  [{ ...decisions[0], entry_ref: 'N99' }, ...decisions.slice(1)], [{ ...decisions[0], action: 'ignore' }, ...decisions.slice(1)],
  [{ ...decisions[0], reason: ' ' }, ...decisions.slice(1)], [{ ...decisions[0], score: 1 }, ...decisions.slice(1)],
 ]) {
  write({ decisions: invalid });
  assert.throws(() => validatePiEvidenceCurationFiles(input, root));
 }
 assert.throws(() => validateEvidenceCurationDecisions(input, accepted.decisions.slice(1)), /every incoming Cue/);
 assert.throws(() => validateEvidenceCurationDecisions(input, [{ entryId: ids[0], action: 'skip', reason: 'Cannot remove history' }, ...accepted.decisions]), /historical/);
 assert.throws(() => piEvidenceCurationUserContext({ ...input, requiredEntries: ids }), /historical pages/);
 assert.throws(() => validateWikiInvestigationReviews([{ ...review, usefulFindings: [1] }]), /nonempty text/);
 assert.throws(() => validateWikiInvestigationReviews([review, review]), /duplicate identity/);
 assert.throws(() => validateWikiInvestigationReviews([{ ...review, tool: 'injected' }]), /exactly/);
 const context = JSON.parse(piEvidenceCurationUserContext(input));
 assert.deepEqual(context.incoming_cues.map((row: { ref: string }) => row.ref), ['N2', 'N3', 'N4']);
 assert.deepEqual(context.investigation_reviews, [review]);
 assert.equal(context.maintenance_instructions, input.instructions);
 assert.equal(context.incoming_cues[0].detail, entries[1]!.detail);
 assert.equal(context.topics[0].id, undefined, 'Topic identities stay Runtime-owned');
 assert.ok(!piEvidenceCurationUserContext(input).includes(ids[0]!));
 const inputRoot = join(root, 'input');
 createWikiStageWorkspace(input, inputRoot);
 assert.match(readFileSync(join(inputRoot, 'pages', 'P1.md'), 'utf8'), /Historical detail \[\[N1\]\]/);
 assert.match(renderAgentPrompt('wiki', 'wiki-compilation', 'system', {}, 'curate-evidence-pi').content, /non-evidence context/);
 const empty = await runWikiStageKind({ input: { ...input, requiredEntries: [] }, workRoot: join(root, 'no-model'),
  env: {}, signal: new AbortController().signal });
 assert.deepEqual(empty.result, { kind: 'evidence-curation', decisions: [] });
 assert.equal(empty.usage.calls, 0, 'no incoming evidence must not invoke a model');
 assert.deepEqual(empty.sessionPaths, []);
 console.log('Wiki evidence curation scope, decisions, non-evidence review and empty execution passed');
} finally { rmSync(root, { recursive: true, force: true }); }
