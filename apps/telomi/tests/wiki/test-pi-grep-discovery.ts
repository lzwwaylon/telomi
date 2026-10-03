import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSrtAgentSandbox } from '../../server/agent-runtime/srt-agent-sandbox.js';
import { createWikiStageWorkspace } from '../../server/wiki/wiki-stage-workspace.js';
import { createConceptReadCoverage, validatePiConceptFiles } from '../../server/wiki/pi-concept-contract.js';
import type { WikiStageInput } from '../../server/wiki/wiki-stage-contract.js';

const root = mkdtempSync(join(tmpdir(), 'wiki-pi-grep-'));
const inputRoot = join(root, 'input'), work = join(root, 'work');
mkdirSync(work);
const entryId = `entry:${'a'.repeat(24)}`;
const input: WikiStageInput = { stage: 'audit-concepts', key: 'grep-audit', language: 'en', goal: { title: 'Mechanisms', description: '' },
 entries: [{ id: entryId, revisionSha256: 'r', sourceRunId: 'run', sourceId: 'source', sourceTitle: 'Source', canonicalLocator: '',
  members: [], section: 'Mechanism', cue: 'Needle', detail: 'Evidence', anchors: [] }],
 pages: [true, false].map((previous, index) => ({ ref: `concept:${index}`, previous, role: 'member',
  page: { id: `concept:${index}`, kind: 'concept', title: `Explanation ${index}`, description: 'Mechanism', body: `## Mechanism\nNeedle mechanism [[${entryId}]].` } })),
 requiredEntries: [], requiredPages: ['concept:0', 'concept:1'], previousRelations: [], instructions: '', topics: [], sections: [] };
createWikiStageWorkspace(input, inputRoot);
const coverage = createConceptReadCoverage(input, inputRoot);
writeFileSync(join(work, 'result.json'), JSON.stringify({ reviewed_pages: ['P1', 'P2'].map(page_ref => ({ page_ref, reason: 'Overlapping explanation' })),
 conflict_groups: [{ page_refs: ['P1', 'P2'], reason: 'Same mechanism' }], discarded_refs: [] }));
const sandbox = createSrtAgentSandbox({ id: 'grep-audit', role: 'wiki.object_builder', workDirectory: work,
 readonlyMounts: [{ hostPath: join(inputRoot, 'pages'), guestPath: '/work/input/pages', access: 'read-only' }],
 activeTools: ['read', 'write', 'edit', 'grep'], network: 'deny' });
try {
 assert.deepEqual(sandbox.tools.map(tool => tool.name), ['read', 'write', 'edit', 'grep']);
 const signal = new AbortController().signal;
 const grep = sandbox.tools.find(tool => tool.name === 'grep')!;
 const found = await grep.execute('discover', { pattern: 'Needle', path: '/work/input/pages' }, signal, () => undefined);
 const matches = found.content.filter(row => row.type === 'text').map(row => row.text).join('\n');
 assert.match(matches, /P1\.md/); assert.match(matches, /P2\.md/);
 assert.throws(() => validatePiConceptFiles(input, inputRoot, work, coverage), /read every line/,
  'Search discovery must not satisfy the full-read merge requirement');
 const read = sandbox.tools.find(tool => tool.name === 'read')!;
 for (const ref of ['P1', 'P2']) {
  const parameters = { path: `/work/input/pages/${ref}.md` };
  coverage.observe(parameters, await read.execute(`read-${ref}`, parameters, signal, () => undefined));
 }
 assert.equal(validatePiConceptFiles(input, inputRoot, work, coverage).result.kind, 'concept-audit');
 const original = readFileSync(join(inputRoot, 'pages/P1.md'), 'utf8');
 await assert.rejects(sandbox.tools.find(tool => tool.name === 'write')!.execute('alter-input',
  { path: '/work/input/pages/P1.md', content: 'Changed' }, signal, () => undefined), /read-only|denied/);
 assert.equal(readFileSync(join(inputRoot, 'pages/P1.md'), 'utf8'), original);
 console.log('Wiki Pi grep discovers read-only evidence without granting full-read receipts');
} finally { await sandbox.close(); rmSync(root, { recursive: true, force: true }); }
