import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freezeModelDefinitions } from '../../server/agent-runtime/model-policy.js';
import { listJsonl } from '../../server/lib/fs.js';
import { type PageTopicCompletion, PAGE_TOPIC_MODEL, runPageTopicStage } from '../../server/wiki/page-topic-stage.js';
import type { NoteFirstInput, NoteFirstStageRequest } from '../../server/wiki/note-first-contract.js';
import { objectFirstSections } from '../../server/wiki/object-first-contract.js';

const root = mkdtempSync(join(tmpdir(), 'page-topic-stage-'));
const canonical = join(root, 'canonical');
mkdirSync(canonical);
const model = { id: 'gpt-6-luna', name: 'Luna', api: 'openai-codex-responses', provider: 'openai-codex', baseUrl: 'https://chatgpt.com/backend-api', reasoning: true,
 input: ['text'], cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0 }, contextWindow: 272000, maxTokens: 128000 };
writeFileSync(join(canonical, 'auth.json'), JSON.stringify({ 'openai-codex': { type: 'api_key', key: 'fake-test-key-never-sent' } }));
writeFileSync(join(canonical, 'models.json'), '{"providers":{}}');
writeFileSync(join(canonical, 'models-store.json'), JSON.stringify({ 'openai-codex': { models: [model] } }));
const env = freezeModelDefinitions({ ...process.env, PRIME_AGENT_CODING_AGENT_DIR: canonical }, join(root, 'frozen'));
const entryId = `entry:${'a'.repeat(24)}`;
const page = { id: 'entity:demo', kind: 'entity' as const, title: 'Hidden page title', description: 'Hidden description', body: `## Water\nUses drip irrigation. [[${entryId}]]\n\n## Context\nUnrelated note.` };
const input: NoteFirstInput = { stage: 'page-topics', key: 'demo', language: 'en', goal: { title: 'Hidden goal', description: '' },
 pages: [{ ref: 'private-page-ref', page, previous: true, role: 'context' }], sections: objectFirstSections([page]),
 entries: [{ id: entryId, revisionSha256: 'r', sourceRunId: 'run', sourceId: 'source', sourceTitle: 'Hidden source', canonicalLocator: '', members: [], section: 'Hidden cue', cue: 'Hidden cue', detail: 'Hidden detail', anchors: [] }],
 requiredEntries: [], requiredPages: [], previousRelations: [], instructions: '',
 topics: [{ id: 'topic:water', title: 'Water use', intent: 'Water conservation', questions: [], include: ['Irrigation'], exclude: ['Electricity'] }],
};
const output = { sections: [{ section_ref: 'S1', matches: [{ topic_ref: 'T1', reason: 'The section describes water conservation.' }] }, { section_ref: 'S2', matches: [] }] };
const response = (text = JSON.stringify(output)): Awaited<ReturnType<PageTopicCompletion>> => ({ role: 'assistant', api: 'openai-codex-responses', provider: 'openai-codex', model: 'gpt-6-luna',
 content: [{ type: 'text', text }], stopReason: 'stop', timestamp: Date.now(),
 usage: { input: 100, cacheRead: 40, cacheWrite: 0, output: 30, totalTokens: 170, cost: { input: 0.01, cacheRead: 0.001, cacheWrite: 0, output: 0.002, total: 0.013 } } });
const request = (name: string): NoteFirstStageRequest => ({ input, env, workRoot: join(root, name), signal: new AbortController().signal });
const json = (file: string) => JSON.parse(readFileSync(file, 'utf8'));
let calls = 0;
const complete: PageTopicCompletion = async (resolved, context, options) => {
 calls++;
 assert.equal(`${resolved.provider}/${resolved.id}`, PAGE_TOPIC_MODEL);
 assert.equal(options?.reasoning, 'medium');
 assert.equal(options?.apiKey, 'fake-test-key-never-sent');
 assert.deepEqual(context.tools, []);
 assert.equal(context.messages.length, 1);
 assert.ok(context.systemPrompt && !context.systemPrompt.includes('coding assistant'));
 assert.ok(!JSON.stringify(context).includes('Hidden') && !JSON.stringify(context).includes(entryId));
 assert.doesNotMatch(JSON.stringify(context), /\[\[(?:entry:|N\d)/u);
 await options?.onResponse?.({ status: 429, headers: {} }, resolved);
 await options?.onResponse?.({ status: 200, headers: {} }, resolved);
 return response();
};
try {
 const successful = request('success');
 const outcome = await runPageTopicStage(successful, complete);
 assert.equal(calls, 1);
 assert.equal(outcome.result.kind, 'page-topics');
 assert.deepEqual(outcome.usage, { inputTokens: 140, outputTokens: 30, costUsd: 0.013, calls: 1 });
 assert.equal(outcome.sessionPaths.length, 1);
 const saved = json(join(successful.workRoot, 'checkpoint.json'));
 const runtime = join(saved.attemptRoot, 'runtime');
 assert.equal(saved.status, 'succeeded');
 assert.equal(json(join(runtime, 'model-metadata.json')).executionMode, 'single-completion');
 assert.equal(json(join(runtime, 'result.json')).actualModel, PAGE_TOPIC_MODEL);
 assert.deepEqual(json(join(runtime, 'tool-definitions.json')), []);
 assert.deepEqual(json(join(runtime, 'mounted-skills.json')), { skills: [], diagnostics: [] });
 assert.deepEqual(readFileSync(join(runtime, 'transport.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line).status), [429, 200]);
 const messages = listJsonl(join(runtime, 'sessions')).flatMap(file => readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line))).filter(row => row.type === 'message');
 assert.deepEqual(messages.map(row => row.message.role), ['user', 'assistant']);
 assert.deepEqual(messages[1].message.usage, response().usage);
 assert.ok(!existsSync(join(runtime, 'kernel-launches.jsonl')));
 assert.ok(!existsSync(join(runtime, 'agent', 'auth.json')) && !existsSync(join(runtime, 'agent', 'models.json')));
 assert.deepEqual(await runPageTopicStage(successful, complete), outcome);
 assert.equal(calls, 1, 'successful resume must not call the model');
 await assert.rejects(runPageTopicStage({ ...successful, input: { ...input, language: 'zh-CN' } }, complete), /contract changed/);
 writeFileSync(join(runtime, 'accepted-result.json'), '{}');
 await assert.rejects(runPageTopicStage(successful, complete), /artifacts changed/);
 for (const [name, bad] of [
  ['malformed', response('not JSON')],
  ['missing-section', response(JSON.stringify({ sections: [output.sections[0]] }))],
  ['wrong-model', { ...response(), model: 'another-model' }],
  ['provider-error', { ...response(), stopReason: 'error' as const, errorMessage: 'Provider refused' }],
  ['truncated', { ...response(), stopReason: 'length' as const }],
 ] as const) {
  const req = request(name);
  let attempts = 0;
  await assert.rejects(runPageTopicStage(req, async () => { attempts++; return bad; }));
  assert.equal(attempts, 1, 'no model repair conversation or fallback');
  const checkpoint = json(join(req.workRoot, 'checkpoint.json'));
  assert.equal(checkpoint.status, 'failed');
  assert.equal(checkpoint.usage.calls, 1, 'failed responses retain their usage');
  assert.ok(existsSync(join(checkpoint.attemptRoot, 'runtime', 'response.json')));
 }
 const rejected = request('transport-throw');
 await assert.rejects(runPageTopicStage(rejected, async () => { throw new Error('Transport failed'); }), /Transport failed/);
 assert.equal(json(join(rejected.workRoot, 'checkpoint.json')).status, 'failed');
 const controller = new AbortController();
 const cancelled = { ...request('cancelled'), signal: controller.signal };
 await assert.rejects(runPageTopicStage(cancelled, async (_model, _context, options) => {
  assert.equal(options?.signal, controller.signal);
  controller.abort();
  return { ...response(), stopReason: 'aborted' };
 }));
 assert.equal(json(join(cancelled.workRoot, 'checkpoint.json')).status, 'cancelled');
 assert.equal(json(join(cancelled.workRoot, 'checkpoint.json')).usage.calls, 1);
 const aborted = request('pre-aborted');
 const abort = new AbortController();
 abort.abort();
 await assert.rejects(runPageTopicStage({ ...aborted, signal: abort.signal }, complete));
 assert.ok(!existsSync(aborted.workRoot));
 console.log('Page Topic single completion preserves frozen model identity, trace, usage, cancellation, validation and resume integrity without Agent tools');
} finally { rmSync(root, { recursive: true, force: true }); }
