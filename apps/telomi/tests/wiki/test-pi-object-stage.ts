import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acceptPiObjectFiles, piObjectUserContext, validatePiObjectFiles } from '../../server/wiki/pi-object-stage.js';
import { createSrtAgentSandbox } from '../../server/agent-runtime/srt-agent-sandbox.js';
import { renderAgentPrompt } from '../../server/agent-runtime/prompt-registry.js';
import type { NoteFirstInput } from '../../server/wiki/note-first-contract.js';

const root = mkdtempSync(join(tmpdir(), 'pi-object-files-'));
const inputRoot = join(root, 'input'), work = join(root, 'work');
mkdirSync(inputRoot); mkdirSync(join(work, 'pages'), { recursive: true });
const a = `entry:${'a'.repeat(24)}`, b = `entry:${'b'.repeat(24)}`;
const entries = [a, b].map((id, index) => ({ id, revisionSha256: 'r', sourceRunId: 'run', sourceId: 'source', sourceTitle: 'Source', canonicalLocator: '', members: [],
 section: 'Methods', sectionSummary: 'Conditions', cue: `Cue ${index}`, detail: `Detail ${index}`, anchors: [] }));
const input: NoteFirstInput = { stage: 'objects', key: 'objects/demo', language: 'en', goal: { title: 'Study methods', description: '' }, entries,
 pages: [], requiredEntries: [a, b], requiredPages: [], previousRelations: [], instructions: '', topics: [], sections: [] };
const page = join(work, 'pages/O1.md'), manifest = join(work, 'result.json');
try {
 const piSystem = renderAgentPrompt('wiki', 'note-first', 'system', {}, 'objects-pi').content;
 assert.match(piSystem, /First identify the research subject or subjects/);
 assert.match(piSystem, /Use the write tool to create one file per object/);
 const user = piObjectUserContext(input, inputRoot);
 assert.deepEqual(Object.keys(JSON.parse(user)), ['output_language', 'goal', 'entries']);
 assert.ok(!user.includes('Create research object pages'));
 writeFileSync(page, '---\ntitle: "Method A"\ndescription: "A method with conditions"\n---\n\n## Mechanism\nEvidence [[N1]].\n');
 writeFileSync(manifest, JSON.stringify({ pages: [{ file: 'pages/O1.md' }], deferred_entries: [] }));
 assert.throws(() => validatePiObjectFiles(input, inputRoot, work), /silently dropped; missing: \[N2\]/);
 writeFileSync(page, '---\ntitle: "Method A"\ndescription: "A method with conditions"\n---\n\n## Mechanism\nEvidence [[N1]] and [[N2]].\n');
 assert.equal(validatePiObjectFiles(input, inputRoot, work).kind, 'pages');
 writeFileSync(page, '---\ntitle: "Method A"\n---\n\n## Mechanism\nEvidence [[N1]] and [[N2]].\n');
 assert.throws(() => validatePiObjectFiles(input, inputRoot, work), /frontmatter.*description/);
 writeFileSync(manifest, '{"pages":[');
 assert.throws(() => validatePiObjectFiles(input, inputRoot, work), /output\.result\.json:.*JSON/);
 const prompts: string[] = [], rejected: string[] = [];
 const repaired = await acceptPiObjectFiles(async (text, repair) => {
  prompts.push(text);
  if (repair) writeFileSync(manifest, JSON.stringify({ pages: [{ file: 'pages/O1.md' }], deferred_entries: [] }));
 }, () => {
  if (prompts.length === 2) writeFileSync(page, '---\ntitle: "Method A"\ndescription: "A method with conditions"\n---\n\n## Mechanism\nEvidence [[N1]] and [[N2]].\n');
  return validatePiObjectFiles(input, inputRoot, work);
 }, 'Build the pages', (_turn, error) => rejected.push(error));
 assert.equal(repaired.kind, 'pages');
 assert.equal(prompts.length, 2);
 assert.match(rejected[0]!, /output\.result\.json/);
 assert.ok(prompts[1]!.includes(rejected[0]!));
 const sandbox = createSrtAgentSandbox({ id: 'pi-object-test', role: 'wiki.object_builder', workDirectory: work,
  readonlyMounts: [], activeTools: ['read', 'write', 'edit'], network: 'deny' });
 assert.deepEqual(sandbox.tools.map(tool => tool.name), ['read', 'write', 'edit']);
 await sandbox.close();
 console.log('Pi object files preserve field-specific validation feedback');
} finally { rmSync(root, { recursive: true, force: true }); }
