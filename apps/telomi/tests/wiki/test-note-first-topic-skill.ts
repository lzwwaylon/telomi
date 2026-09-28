import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createStageWorkspace } from '../../server/wiki/note-first-topic-skill.js';
import { createNoteFirstWorkspace } from '../../server/wiki/note-first-workspace.js';
import { spawnPrimeWorker } from '../../server/agent-runtime/prime-worker.js';
import { createPrimeModelRegistry, createPrimeSettingsManager } from '../../server/agent-runtime/prime-agent-paths.js';
import { objectFirstSections, type ObjectFirstPage } from '../../server/wiki/object-first-contract.js';
import type { NoteFirstInput } from '../../server/wiki/note-first-contract.js';

if (process.env.CUE_CHECK_WORKER === '1') await kernel(); else await main();

async function main() {
 const root = realpathSync(mkdtempSync(join(process.env.TELOMI_TEST_WORKSPACE_PARENT ?? tmpdir(), 'wiki-topic-skill-')));
 try {
  const id = `entry:${'a'.repeat(24)}`;
  const object: ObjectFirstPage = { id: 'entity:method', kind: 'entity', title: 'Method', description: 'Training conditions', body: `## Conditions\nFull training conditions and the method limitation. [[${id}]]` };
  const concept: ObjectFirstPage = { id: 'concept:tradeoff', kind: 'concept', title: 'Tradeoff', description: 'Explains conditions', body: `## Scope\nTraining cost depends on these conditions. [[${id}]]` };
  const input: NoteFirstInput = { stage: 'topic', key: 'topic-test', language: 'en', goal: { title: 'Methods', description: 'Research' },
   entries: [{ id, revisionSha256: 'e'.repeat(64), sourceRunId: 'r', sourceId: 'source', sourceTitle: 'Note', canonicalLocator: 'https://example.test', members: [], section: 'Conditions', cue: 'Training', detail: 'Complete source detail', anchors: [] }],
   pages: [object, concept].map(page => ({ ref: page.id, page, previous: false, role: 'context' })), requiredEntries: [], requiredPages: [],
   topics: [{ id: 'topic-id', title: 'Conditions', intent: 'Understand limitations', questions: [], include: [], exclude: [] }], sections: objectFirstSections([object, concept]), instructions: 'Inspect conditions',
   previousRelations: [{ from: object.id, to: concept.id, label: 'illustrates', entryIds: [id] }] };
  const workspace = createStageWorkspace(input, join(root, 'input'));
  assert.ok(workspace.skillRoot);
  assert.deepEqual(workspace.receipts(), { pages: [], sections: [], entries: [] });
  assert.equal(workspace.overviews.P1!.relations[0]!.direction, 'outgoing');
  assert.equal(workspace.overviews.P2!.relations[0]!.direction, 'incoming');
  assert.equal(workspace.overviews.P2!.relations[0]!.from, 'P1');
  assert.ok(!workspace.userContext.includes(object.id));
  assert.ok(!workspace.userContext.includes('Complete source detail'));
  for (const [ref, overview] of Object.entries(workspace.overviews)) {
   assert.deepEqual(JSON.parse(readFileSync(join(root, 'input/indexes', `${ref}.json`), 'utf8')), overview);
   assert.ok(!JSON.stringify(overview).includes('[[N'));
  }
  workspace.observe('metadata', JSON.stringify(workspace.overviews));
  assert.deepEqual(workspace.receipts().sections, []);
  for (const kind of ['entity', 'concept', 'none'] as const) {
   const subset = { ...input, pages: input.pages.filter(row => row.page.kind === kind), sections: [] };
   const only = createStageWorkspace(subset, join(root, kind));
   assert.equal(Object.keys(only.overviews).length, subset.pages.length);
   assert.ok(Object.values(only.overviews).every(page => !page.relations.length));
   assert.deepEqual(only.receipts().sections, []);
   if (subset.pages.length) {
    const body = JSON.parse(readFileSync(join(only.skillRoot!, 'dataset.json'), 'utf8')).reads.S1;
    only.observe('complete', body);
    assert.deepEqual(only.receipts().sections, ['S1'], 'Computed sections support receipts even when input sections are omitted');
   }
  }
  const empty = createNoteFirstWorkspace({ ...input, previousRelations: [] }, join(root, 'no-relations'));
  assert.ok(Object.values(empty.overviews).every(page => !page.relations.length));
  assert.throws(() => createNoteFirstWorkspace({ ...input, previousRelations: [{ ...input.previousRelations[0]!, entryIds: ['missing'] }] }, join(root, 'invalid')), /unknown previous relation evidence/);
  const py = spawnSync('python3', ['-c', `import json, wiki
out={r:wiki.overview(r) for r in wiki._data()['overviews']}
for r in out:
 changed=wiki.overview(r); changed['sections'].clear()
 assert wiki.overview(r)==out[r]
for r in ['P0','S1','N1','../P1.json',None,[],{}]:
 try: wiki.overview(r)
 except ValueError: pass
 else: raise AssertionError('bad ref accepted')
print(json.dumps(out))`], { env: { ...process.env, PYTHONPATH: join(workspace.skillRoot, 'src'), PYTHONDONTWRITEBYTECODE: '1' }, encoding: 'utf8' });
  assert.equal(py.status, 0, py.stderr); assert.deepEqual(JSON.parse(py.stdout), workspace.overviews);
  const runtime = join(root, 'runtime'), work = join(root, 'work'), inputRoot = join(root, 'srt-input');
  for (const path of [runtime, work, inputRoot]) mkdirSync(path, { recursive: true });
  writeFileSync(join(runtime, 'input.json'), JSON.stringify(input));
  writeFileSync(join(runtime, 'sentinel.txt'), 'private runtime synthetic sentinel');
  const auth = join(runtime, 'empty-auth'); mkdirSync(auth);
  for (const name of ['auth.json', 'settings.json']) writeFileSync(join(auth, name), '{}\n');
  writeFileSync(join(auth, 'models.json'), '{"providers":{}}\n');
  // Main Agent supplies Goal settings, not process.env; the launcher must still find its Node interpreter.
  await spawnPrimeWorker({ name: 'Wiki Topic Skill deterministic check', worker: fileURLToPath(import.meta.url), agentRoot: work, runtimeRoot: runtime, readonlyRoots: [inputRoot],
   env: { PRIME_AGENT_CODING_AGENT_DIR: auth }, signal: new AbortController().signal,
   extraEnv: { CUE_CHECK_WORKER: '1', CUE_CHECK_RUNTIME: runtime, CUE_CHECK_WORK: work, CUE_CHECK_INPUT: inputRoot } });
  const result = JSON.parse(readFileSync(join(runtime, 'check.json'), 'utf8'));
  assert.equal(result.passed, true); assert.equal(result.modelCalls, 0);
  console.log('Wiki Topic Skill: metadata, bidirectional indexes, native Python, full-read gates and SRT permissions passed');
 } finally { rmSync(root, { recursive: true, force: true }); }
}

async function kernel() {
 const runtime = process.env.CUE_CHECK_RUNTIME!, work = process.env.CUE_CHECK_WORK!, inputRoot = process.env.CUE_CHECK_INPUT!;
 const workspace = createStageWorkspace(JSON.parse(readFileSync(join(runtime, 'input.json'), 'utf8')), inputRoot);
 assert.ok(workspace.skillRoot); process.env.PYTHONPATH = join(workspace.skillRoot, 'src');
 const prime = await import(process.env.PRIME_AGENT_MODULE_PATH!);
 const agentDir = process.env.PRIME_AGENT_CODING_AGENT_DIR!;
 const {authStorage, modelRegistry} = createPrimeModelRegistry(prime, agentDir);
 const settingsManager = createPrimeSettingsManager(prime.SettingsManager, work, agentDir);
 const skills = prime.loadSkillsFromDir({dir: workspace.skillRoot, source: 'project'});
 assert.equal(skills.diagnostics.length, 0); assert.equal(skills.skills.length, 1); assert.equal(skills.skills[0].kind, 'python');
 const loader = new prime.DefaultResourceLoader({cwd: work, agentDir, settingsManager, noExtensions: true, noSkills: true, bundledSkillsDir: null,
  noPromptTemplates: true, noThemes: true, noContextFiles: true, skillsOverride: () => skills, appendSystemPrompt: ['Deterministic Cue Topic Skill test. No model calls.']});
 await loader.reload();
 const {session} = await prime.createAgentSession({cwd: work, agentDir, authStorage, modelRegistry, settingsManager, resourceLoader: loader,
  sessionManager: prime.SessionManager.inMemory(work), model: modelRegistry.getAll()[0], thinkingLevel: 'off',
  tools: ['ipython', 'submit_note_first'], customTools: [{name: 'submit_note_first', label: 'Validate', description: 'Deterministic output validation',
   parameters: {type: 'object', properties: {}, additionalProperties: false}, executionMode: 'sequential',
   async execute() {try {workspace.validate(JSON.parse(readFileSync(join(work, 'result.json'), 'utf8')), work); return {content: [{type: 'text', text: 'validated'}], details: {}};}
    catch (error) {return {content: [{type: 'text', text: String(error)}], details: {}, isError: true};}}}],
  rlmMaxDepth: 1, prewarmIpythonKernel: false, executionMode: 'print', telemetryDisabled: true, autonomous: {enabled: false}});
 const cell = async (id: string, code: string) => {
  const tool = session.getToolDefinition('ipython'); assert.ok(tool);
  const result = await tool.execute(id, {code}, new AbortController().signal, undefined, undefined);
  appendFileSync(join(runtime, 'cells.jsonl'), JSON.stringify({id, code, result}) + '\n');
  assert.equal(result.isError, false, JSON.stringify(result)); assert.equal(result.details.status, 'ok', JSON.stringify(result));
  const visible = result.content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n');
  workspace.observe(id, visible); return visible;
 };
 try {
  assert.deepEqual([...session.getActiveToolNames()].sort(), ['ipython', 'submit_note_first']);
  assert.equal(loader.getSkills().skills.length, 1);
  assert.equal(workspace.receipts().sections.length, 0);
  const pageRef = Object.keys(workspace.overviews).find(ref => workspace.overviews[ref].relations.length)!;
  const expectedOverview = workspace.overviews[pageRef];
  assert.doesNotMatch(await cell('skill-import', 'print(repr(wiki))'), /unavailable/, 'Native Skill must import successfully');
  await cell('overview', `import json\nmetadata = wiki.overview(${JSON.stringify(pageRef)})\nassert metadata == json.loads(${JSON.stringify(JSON.stringify(expectedOverview))})\nprint(json.dumps(metadata, ensure_ascii=False))`);
  assert.equal(workspace.receipts().sections.length, 0, 'Overview metadata is not complete-section delivery');
  await cell('overview-invalid', `for ref in ['S1', 'N1', 'P0', '../input/indexes/P1.json', None, []]:\n try:\n  wiki.overview(ref)\n except ValueError:\n  pass\n else:\n  raise AssertionError('invalid overview reference accepted')`);
  await cell('search-assign', `import json\nhits = wiki.search('conditions')\nchosen = hits['matches'][0]['section_ref']\nstate = {'value': 41}`);
  {
   const requests = [{terms: ['conditions', 'training'], mode: 'any' as const, limit: 1},
    {terms: ['conditions', 'training'], mode: 'all' as const}, {query: 'conditions', scope: 'body' as const, offset: 1, limit: 2}];
   const expected = requests.map(request => JSON.parse((workspace as ReturnType<typeof createStageWorkspace>).search(request)));
   await cell('search-options', `requests = json.loads(${JSON.stringify(JSON.stringify(requests))})\nexpected = json.loads(${JSON.stringify(JSON.stringify(expected))})\nassert [wiki.search(**request) for request in requests] == expected`);
   assert.equal(workspace.receipts().sections.length, 0, 'Search results are not complete-section delivery');
  }
  await cell('read-assign', `body = wiki.read(chosen)\nstate['value'] += 1\nassert state['value'] == 42\nassert len(body) > 0`);
  assert.equal(workspace.receipts().sections.length, 0, 'Assignment is not delivery');
  const metadata = await cell('metadata', `print(json.dumps({'chosen': chosen, 'state': state['value']}))`);
  assert.equal(workspace.receipts().sections.length, 0, 'Metadata is not delivery');
  const chosen = JSON.parse(metadata.trim()).chosen;
  const output = {topic_ref: 'T1', matches: [{section_ref: chosen, reason: 'Section inspected'}], gaps: []};
  writeFileSync(join(work, 'result.json'), JSON.stringify(output));
  const submit = session.getToolDefinition('submit_note_first'); assert.ok(submit);
  const rejected = await submit.execute('pre-read', {}, new AbortController().signal, undefined, undefined);
  assert.equal(rejected.isError, true, 'Unseen section must be rejected');
  await cell('print-body', 'print(body)');
  assert.ok(workspace.receipts().sections.includes(chosen));
  const accepted = await submit.execute('post-read', {}, new AbortController().signal, undefined, undefined);
  assert.ok(!accepted.isError, 'The same session can repair missing read receipts');
  await cell('cue-capability', `assert not any(k.startswith('N') for k in wiki._data()['reads'])\ntry:\n wiki.read('N1')\nexcept ValueError:\n pass\nelse:\n raise AssertionError('standalone N read allowed')\nfrom pathlib import Path\nassert not Path(${JSON.stringify(join(inputRoot, 'evidence'))}).exists()\nassert not Path(${JSON.stringify(join(inputRoot, 'evidence.md'))}).exists()`);
  await cell('permissions', `from pathlib import Path\nimport errno\nfor target in [${JSON.stringify(join(inputRoot, 'index.md'))}, wiki.__file__]:\n original = Path(target).read_bytes()\n try:\n  Path(target).write_bytes(b'mutation')\n except OSError as error:\n  assert error.errno in (errno.EPERM, errno.EACCES, errno.EROFS)\n else:\n  raise AssertionError('input or Skill writable')\n assert Path(target).read_bytes() == original\ntry:\n Path(${JSON.stringify(join(runtime, 'sentinel.txt'))}).read_text()\nexcept OSError as error:\n assert error.errno in (errno.EPERM, errno.EACCES)\nelse:\n raise AssertionError('private runtime readable')`);
  assert.equal(session.messages.filter((m: any) => m.role === 'assistant').length, 0);
  const result = {passed: true, modelCalls: 0, persistentVariables: true, overviewApi: true, overviewHasNoReceipts: true, visibleSectionGate: true, repairInSameSession: true,
   readonlyInputAndSkill: true, privateRuntimeDenied: true, activeTools: session.getActiveToolNames(),
   skillNames: loader.getSkills().skills.map((s: any) => s.name), receipts: workspace.receipts(), observations: workspace.observations()};
  writeFileSync(join(runtime, 'check.json'), JSON.stringify(result, null, 2) + '\n');
  writeFileSync(join(runtime, 'result.json'), JSON.stringify({usage: {input_tokens: 0, output_tokens: 0, cost_usd: 0, model_calls: 0}, ...result}));
 } finally {await session.disposeAsync({kernelSnapshot: false});}
}
