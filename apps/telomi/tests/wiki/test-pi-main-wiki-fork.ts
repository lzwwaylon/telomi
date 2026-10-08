import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { AgentSession, SessionManager } from '@earendil-works/pi-coding-agent';
import type { AssistantMessage, Message } from '@earendil-works/pi-ai';
import { freezeModelDefinitions } from '../../server/agent-runtime/model-policy.js';
import { runPiEvidenceCurationStage } from '../../server/wiki/pi-evidence-curation.js';
import type { WikiStageInput, WikiStageRequest } from '../../server/wiki/wiki-stage-contract.js';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'pi-main-wiki-fork-')));
const canonical = join(root, 'canonical');
mkdirSync(canonical);
const provider = 'main-fork-test';
const models = ['main', 'wiki'].map(id => ({ id, name: id, api: 'openai-completions', provider,
 baseUrl: 'http://127.0.0.1:1/v1', reasoning: true, input: ['text'],
 cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 4000 }));
writeFileSync(join(canonical, 'auth.json'), '{}');
writeFileSync(join(canonical, 'models.json'), JSON.stringify({ providers: { [provider]: {
 baseUrl: models[0]!.baseUrl, api: 'openai-completions', apiKey: 'not-sent', models,
} } }));
writeFileSync(join(canonical, 'models-store.json'), JSON.stringify({ [provider]: { models } }));
const env = freezeModelDefinitions({ ...process.env, PI_CODING_AGENT_DIR: canonical,
 TELOMI_WIKI_COMPILATION_MODEL: `${provider}/wiki`, TELOMI_WIKI_COMPILATION_THINKING_LEVEL: 'high',
 HINDSIGHT_URL: 'http://127.0.0.1:1', HINDSIGHT_BANK_ID: 'unused-live-bank' }, join(root, 'frozen'));
const usage = { input: 20, cacheRead: 0, cacheWrite: 0, output: 30, totalTokens: 50,
 cost: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, total: 0 } };
const assistant: AssistantMessage = { role: 'assistant', api: 'openai-completions', provider, model: 'main',
 content: [{ type: 'text', text: 'Delivered answer.' }], timestamp: Date.now(), stopReason: 'stop', usage };
const manager = SessionManager.create(root, join(root, 'main-sessions'));
manager.appendMessage({ role: 'user', content: 'Keep implementation details; do not save product marketing.', timestamp: Date.now() });
manager.appendMessage(assistant);
const messages = structuredClone(manager.buildSessionContext().messages) as Message[];
const entryId = `entry:${'a'.repeat(24)}`;
const input: WikiStageInput = { stage: 'curate-evidence', key: 'curate-evidence', language: 'en',
 goal: { title: 'Understand mechanisms', description: 'Prefer supported implementation detail' },
 entries: [{ id: entryId, revisionSha256: 'b'.repeat(64), sourceRunId: 'run', sourceId: 'source', sourceTitle: 'Source',
  canonicalLocator: 'https://example.org/source', members: [], section: 'Mechanism', cue: 'Marketing badge', detail: 'A promotional badge without a mechanism.', anchors: [] }],
 requiredEntries: [entryId], requiredPages: [], previousRelations: [], topics: [], sections: [], instructions: '',
 pages: [{ ref: 'previous', previous: true, role: 'context', page: { id: 'existing', kind: 'entity', title: 'Prior knowledge',
  description: 'Mechanism', body: '## Mechanism\nSupported mechanism.' } }],
 mainSession: { schema_version: 1, goalId: 'goal-fork', sessionId: manager.getSessionId(),
  systemPrompt: 'Main context includes global preferences. Ordinarily deliver an answer.',
  model: `${provider}/main`, thinking: 'low', messages } };
// The fork must not absorb a later turn or write anything into the original conversation.
manager.appendMessage({ role: 'user', content: 'A later unrelated conversation.', timestamp: Date.now() });
const originalSession = readFileSync(manager.getSessionFile()!, 'utf8');
const query = { mode: 'recall', intent: 'preference', query: 'Wiki admission preferences' };
const frozenResult = { content: [{ type: 'text', text: 'Maintain mechanisms; avoid marketing.' }], details: { fixture: true } };
const memoryReplay = [{ kind: 'tool' as const, name: 'search_user_memory', label: 'Search User Memory',
 description: 'Frozen lookup', arguments: query, result: frozenResult }];
const originalPrompt = AgentSession.prototype.prompt, originalFetch = globalThis.fetch;
let calls = 0, networkCalls = 0, missing = false, liveMemory = false;
globalThis.fetch = async (url, options) => {
 networkCalls++;
 if (!liveMemory) throw new Error('Replay must not call a live model or memory service');
 assert.equal(String(url), 'http://127.0.0.1:1/banks/unused-live-bank/memories/recall');
 const request = JSON.parse(String(options?.body));
 assert.deepEqual(request.tags, ['goal:goal-fork', 'scope:global']);
 assert.equal(request.tags_match, 'any_strict');
 return new Response(JSON.stringify({ results: [] }), { status: 200 });
};
AgentSession.prototype.prompt = async function(text) {
 calls++;
 assert.equal(`${this.model?.provider}/${this.model?.id}`, `${provider}/main`);
 assert.equal(this.thinkingLevel, 'low', 'selection uses captured Main settings, not Wiki compilation settings');
 assert.deepEqual(this.messages, input.mainSession!.messages);
 assert.notEqual(this.sessionId, input.mainSession!.sessionId);
 assert.match(this.systemPrompt, /Main context includes global preferences/);
 assert.match(this.systemPrompt, /replaces Main's ordinary operating flow/);
 assert.match(this.systemPrompt, /search_user_memory/);
 assert.ok(!JSON.stringify(this.messages).includes('later unrelated'));
 assert.equal(JSON.parse(text).incoming_cues[0].detail, input.entries[0]!.detail);
 assert.equal(JSON.parse(text).incoming_cues[0].canonical_locator, input.entries[0]!.canonicalLocator);
 const tools = new Map(this.agent.state.tools.map(tool => [tool.name, tool]));
 assert.deepEqual([...tools.keys()].sort(), ['edit', 'grep', 'read', 'search_user_memory', 'write']);
 const signal = new AbortController().signal;
 const memory = tools.get('search_user_memory')!;
 if (missing) {
  await assert.rejects(() => memory.execute('missing', { ...query, query: 'Uncaptured preference' }, signal), /memory capability is missing/);
 } else {
  const result = await memory.execute('recall', query, signal);
  if (liveMemory) assert.match(JSON.stringify(result.content), /No relevant long-term user memory found/);
  else assert.deepEqual(result, frozenResult);
 }
 const read = tools.get('read')!;
 assert.match(JSON.stringify((await read.execute('wiki', { path: '/work/wiki/pages/P1.md' }, signal)).content), /Supported mechanism/);
 assert.match(JSON.stringify((await read.execute('skill', { path: '/work/wiki/skills/user-memory/SKILL.md' }, signal)).content), /search_user_memory/);
 await assert.rejects(() => tools.get('write')!.execute('wiki-write', { path: '/work/wiki/pages/P1.md', content: 'mutation' }, signal), /read-only|outside writable|sandbox policy/);
 await tools.get('write')!.execute('result', { path: '/work/result.json',
  content: JSON.stringify({ decisions: [{ entry_ref: 'N1', action: 'skip', reason: 'User does not maintain marketing details.' }] }) }, signal);
 const response = { ...assistant, usage: { ...usage, input: 1, output: 1, totalTokens: 2 } };
 this.agent.state.messages.push(response); this.sessionManager.appendMessage(response);
};
try {
 const request: WikiStageRequest = { input, env, workRoot: join(root, 'fork'), memoryReplay, signal: new AbortController().signal,
  onAttemptStarted(attemptRoot) {
   const marker = JSON.parse(readFileSync(join(attemptRoot, 'runtime/main-session-fork.json'), 'utf8'));
   assert.equal(marker.initialEntryIds.length, messages.length, 'Activity learns the fork after inherited entries are marked');
  } };
 const outcome = await runPiEvidenceCurationStage(request);
 assert.deepEqual(outcome.result, { kind: 'evidence-curation', decisions: [{ entryId, action: 'skip', reason: 'User does not maintain marketing details.' }] });
 assert.equal(outcome.usage.calls, 1, 'copied Main assistant turns are not billed again');
 assert.equal(outcome.usage.inputTokens, 1);
 assert.equal(outcome.usage.outputTokens, 1);
 const checkpoint = JSON.parse(readFileSync(join(request.workRoot, 'checkpoint.json'), 'utf8'));
 const runtime = join(checkpoint.attemptRoot, 'runtime');
 const marker = JSON.parse(readFileSync(join(runtime, 'main-session-fork.json'), 'utf8'));
 assert.equal(marker.sourceSessionId, manager.getSessionId());
 assert.notEqual(marker.forkSessionId, marker.sourceSessionId);
 assert.equal(marker.initialEntryIds.length, messages.length);
 const sessionFile = outcome.sessionPaths[0]!;
 assert.equal(dirname(sessionFile), runtime);
 const receipts = readFileSync(join(runtime, 'memory-searches.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
 assert.equal(receipts.length, 1); assert.deepEqual(receipts[0].arguments, query); assert.deepEqual(receipts[0].result, frozenResult);
 const skills = JSON.parse(readFileSync(join(runtime, 'mounted-skills.json'), 'utf8'));
 assert.equal(skills.skills[0].filePath, '/work/wiki/skills/user-memory/SKILL.md');
 assert.deepEqual(await runPiEvidenceCurationStage(request), outcome);
 assert.equal(calls, 1, 'an accepted fork resumes without another model turn');
 for (const filename of ['main-session-fork.json', 'memory-searches.jsonl', 'effective-system-prompt.md']) {
  const file = join(runtime, filename), original = readFileSync(file);
  writeFileSync(file, Buffer.concat([original, Buffer.from('\n ')]));
  try { await assert.rejects(runPiEvidenceCurationStage(request), /output changed/); }
  finally { writeFileSync(file, original); }
 }
 await assert.rejects(runPiEvidenceCurationStage({ ...request, input: { ...input,
  mainSession: { ...input.mainSession!, messages: [...messages, { role: 'user', content: 'Changed preference', timestamp: Date.now() }] } } }), /contract changed/);
 missing = true;
 await assert.rejects(runPiEvidenceCurationStage({ ...request, workRoot: join(root, 'missing-memory'), memoryReplay: [] }), /memory capability is missing/);
 assert.equal(networkCalls, 0, 'Replay never falls back to live Hindsight');
 missing = false; liveMemory = true;
 await runPiEvidenceCurationStage({ ...request, workRoot: join(root, 'live-memory-adapter'), memoryReplay: undefined });
 assert.equal(networkCalls, 1, 'production memory reads use the configured Main bank and frozen Goal scope');
 assert.equal(readFileSync(manager.getSessionFile()!, 'utf8'), originalSession, 'the Main conversation remains unchanged');
 console.log('Main Wiki fork: frozen context/model, independent session, read-only Wiki, memory receipts, resume and hermetic Replay passed');
} finally {
 AgentSession.prototype.prompt = originalPrompt; globalThis.fetch = originalFetch;
 rmSync(root, { recursive: true, force: true });
}
