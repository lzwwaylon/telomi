import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freezeModelDefinitions } from '../../server/agent-runtime/model-policy.js';
import { listJsonl } from '../../server/lib/fs.js';
import { type PageTopicCompletion, PAGE_TOPIC_MODEL, runPageTopicStage } from '../../server/wiki/page-topic-stage.js';
import type { WikiStageInput, WikiStageRequest } from '../../server/wiki/wiki-stage-contract.js';
import { wikiPageSections } from '../../server/wiki/wiki-page-contract.js';

const root = mkdtempSync(join(tmpdir(), 'page-topic-stage-'));
const canonical = join(root, 'canonical');
mkdirSync(canonical);
const model = { id: 'gpt-5.6-terra', name: 'Terra', api: 'openai-codex-responses', provider: 'openai-codex', baseUrl: 'https://chatgpt.com/backend-api', reasoning: true,
 input: ['text'], cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0 }, contextWindow: 272000, maxTokens: 128000 };
writeFileSync(join(canonical, 'auth.json'), JSON.stringify({ 'openai-codex': { type: 'api_key', key: 'fake-test-key-never-sent' } }));
writeFileSync(join(canonical, 'models.json'), '{"providers":{}}');
writeFileSync(join(canonical, 'models-store.json'), JSON.stringify({ 'openai-codex': { models: [model] } }));
const env = freezeModelDefinitions({ ...process.env, PRIME_AGENT_CODING_AGENT_DIR: canonical }, join(root, 'frozen'));
const entryId = `entry:${'a'.repeat(24)}`;
const page = { id: 'entity:demo', kind: 'entity' as const, title: 'Hidden page title', description: 'Hidden description', body: `## Water\nUses drip irrigation. [[${entryId}]]\n\n## Context\nUnrelated note.` };
const input: WikiStageInput = { stage: 'page-topics', key: 'demo', language: 'en', goal: { title: 'Hidden goal', description: '' },
 pages: [{ ref: 'private-page-ref', page, previous: true, role: 'context' }], sections: wikiPageSections([page]),
 entries: [{ id: entryId, revisionSha256: 'r', sourceRunId: 'run', sourceId: 'source', sourceTitle: 'Hidden source', canonicalLocator: '', members: [], section: 'Hidden cue', cue: 'Hidden cue', detail: 'Hidden detail', anchors: [] }],
 requiredEntries: [], requiredPages: [], previousRelations: [], instructions: '',
 topics: [{ id: 'topic:water', title: 'Water use', intent: 'Water conservation', questions: [], include: ['Irrigation'], exclude: ['Electricity'] }],
};
const output = { sections: [{ section_ref: 'S1', matches: [{ topic_ref: 'T1', reason: 'The section describes water conservation.' }] }, { section_ref: 'S2', matches: [] }] };
const response = (text = JSON.stringify(output)): Awaited<ReturnType<PageTopicCompletion>> => ({ role: 'assistant', api: 'openai-codex-responses', provider: 'openai-codex', model: 'gpt-5.6-terra',
 content: [{ type: 'text', text }], stopReason: 'stop', timestamp: Date.now(),
 usage: { input: 100, cacheRead: 40, cacheWrite: 0, output: 30, totalTokens: 170, cost: { input: 0.01, cacheRead: 0.001, cacheWrite: 0, output: 0.002, total: 0.013 } } });
const request = (name: string): WikiStageRequest => ({ input, env, workRoot: join(root, name), signal: new AbortController().signal });
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
 const invalidReplies = [
  ['extra-brace', response(JSON.stringify(output) + '}'), /Unexpected.*JSON/],
  ['duplicate-topic', response(JSON.stringify({ sections: [{ ...output.sections[0], matches: [output.sections[0]!.matches[0], output.sections[0]!.matches[0]] }, output.sections[1]] })), /duplicate Topic T1/],
 ] as const;
 const repairErrors: unknown[] = [];
 for (const [name, invalid, violation] of invalidReplies) { try {
  const req = request(`repair-${name}`); let attempts = 0;
  let originalUser: unknown;
  let firstContext: Parameters<PageTopicCompletion>[1] | undefined;
  const repaired = await runPageTopicStage(req, async (resolved, context, options) => {
   assert.equal(`${resolved.provider}/${resolved.id}`, PAGE_TOPIC_MODEL);
   assert.equal(options?.reasoning, 'medium');
   assert.deepEqual(context.tools, []);
   if (++attempts === 1) { firstContext = context; originalUser = structuredClone(context.messages[0]); return invalid; }
   assert.equal(attempts, 2, 'one repair completion at most');
   assert.deepEqual(firstContext!.messages, [originalUser], 'repair must not mutate a previous completion request');
   assert.deepEqual(context.messages[0], originalUser, 'repair preserves the entire original input');
   assert.deepEqual(context.messages.map(message => message.role), ['user', 'assistant', 'user']);
   assert.deepEqual(context.messages[1]!.content, invalid.content, 'repair receives the original visible reply');
   assert.match(String(context.messages[2]!.content), violation);
   return response();
  });
  assert.equal(attempts, 2);
  assert.equal(repaired.result.kind, 'page-topics');
  assert.deepEqual(repaired.usage, { inputTokens: 280, outputTokens: 60, costUsd: 0.026, calls: 2 });
  const saved = json(join(req.workRoot, 'checkpoint.json')), runtime = join(saved.attemptRoot, 'runtime');
  assert.deepEqual(json(join(runtime, 'response-attempt-1.json')).content, invalid.content);
  assert.deepEqual(json(join(runtime, 'response-attempt-2.json')).content, response().content);
  assert.deepEqual(json(join(runtime, 'response.json')).content, response().content);
  assert.equal(json(join(runtime, 'result.json')).validationAttempt, 2);
  assert.equal(json(join(runtime, 'result.json')).responseAttempt, 2);
  const errors = readFileSync(join(runtime, 'validation-errors.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.equal(errors.length, 1); assert.match(errors[0].error, violation);
  const recorded = listJsonl(join(runtime, 'sessions')).flatMap(file => readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line))).filter(row => row.type === 'message');
  assert.deepEqual(recorded.map(row => row.message.role), ['user', 'assistant', 'user', 'assistant']);
  assert.deepEqual(recorded[1].message.content, invalid.content);
  assert.match(recorded[2].message.content, violation);
  assert.deepEqual(json(join(runtime, 'agent-context-attempt-2.json')).messages.map((message: { role: string }) => message.role), ['user', 'assistant', 'user']);
  assert.deepEqual(await runPageTopicStage(req, async () => { throw new Error('accepted repair must resume without completion'); }), repaired);
  writeFileSync(join(runtime, 'response-attempt-1.json'), '{}');
  await assert.rejects(runPageTopicStage(req, complete), /artifacts changed/);

  const exhausted = request(`invalid-twice-${name}`); let failedCalls = 0;
  await assert.rejects(runPageTopicStage(exhausted, async () => { failedCalls++; return invalid; }), violation);
  assert.equal(failedCalls, 2, 'two invalid replies fail without a third completion');
  const failed = json(join(exhausted.workRoot, 'checkpoint.json'));
  assert.equal(failed.status, 'failed'); assert.equal(failed.usage.calls, 2);
  assert.ok(!existsSync(join(failed.attemptRoot, 'work/result.json')), 'invalid replies never become empty successful matches');
  assert.match(json(join(failed.attemptRoot, 'runtime/failure.json')).error, violation);
  assert.equal(readFileSync(join(failed.attemptRoot, 'runtime/validation-errors.jsonl'), 'utf8').trim().split('\n').length, 2);
 } catch (error) { repairErrors.push({ name, error }); } }
 assert.deepEqual(repairErrors, [], 'format and duplicate-Topic failures must both recover within one repair');
 const successful = request('success');
 const outcome = await runPageTopicStage(successful, complete);
 assert.equal(calls, 1);
 assert.equal(outcome.result.kind, 'page-topics');
 assert.deepEqual(outcome.usage, { inputTokens: 140, outputTokens: 30, costUsd: 0.013, calls: 1 });
 assert.equal(outcome.sessionPaths.length, 1);
 const saved = json(join(successful.workRoot, 'checkpoint.json'));
 const runtime = join(saved.attemptRoot, 'runtime');
 assert.equal(saved.status, 'succeeded');
 const capture = json(join(runtime, 'workspace-capture.json'));
 assert.deepEqual(capture, { schemaVersion: 1, sessionId: JSON.parse(readFileSync(listJsonl(outcome.sessionPaths[0]!)[0]!, 'utf8').split('\n')[0]!).id, role: 'root',
  stage: { kind: input.stage, key: input.key }, applicability: 'not-applicable', reason: 'stateless-no-file-tools' });
 assert.equal(json(join(runtime, 'model-metadata.json')).executionMode, 'bounded-validation-completion');
 assert.equal(json(join(runtime, 'model-metadata.json')).completionLimit, 2);
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
  ['missing-usage', { ...response(), usage: { ...response().usage, input: 0, cacheRead: 0, output: 0 } }],
  ['tool-call', { ...response(), content: [{ type: 'toolCall' as const, id: 'call1', name: 'unexpected', arguments: {} }] }],
 ] as const) {
  const req = request(name);
  let attempts = 0;
  await assert.rejects(runPageTopicStage(req, async () => { attempts++; return bad; }));
  const expected = name === 'malformed' || name === 'missing-section' ? 2 : 1;
  assert.equal(attempts, expected, 'only JSON/contract validation allows one repair; Provider errors and mismatched models fail directly');
  const checkpoint = json(join(req.workRoot, 'checkpoint.json'));
  assert.equal(checkpoint.status, 'failed');
  assert.equal(checkpoint.usage.calls, expected, 'all failed responses retain their usage');
  assert.ok(existsSync(join(checkpoint.attemptRoot, 'runtime', 'response.json')));
 }
 const websocket = (): Awaited<ReturnType<PageTopicCompletion>> => ({ ...response(), content: [], stopReason: 'error', errorMessage: 'WebSocket error',
  usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, totalTokens: 0, cost: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, total: 0 } } });
 const recovered = request('empty-websocket'); let reconnects = 0;
 const reconnected = await runPageTopicStage(recovered, async (_model, context) => {
  assert.equal(context.messages.length, 1, 'transport retry repeats the original request, without a model repair prompt');
  return ++reconnects < 3 ? websocket() : response();
 });
 assert.equal(reconnects, 3); assert.equal(reconnected.usage.calls, 3); assert.equal(reconnected.usage.costUsd, 0.013);
 const recoveredCheckpoint = json(join(recovered.workRoot, 'checkpoint.json'));
 assert.ok(existsSync(join(recoveredCheckpoint.attemptRoot, 'runtime/response-attempt-1.json')));
 const recoveredMessages = listJsonl(join(recoveredCheckpoint.attemptRoot, 'runtime/sessions')).flatMap(file => readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line))).filter(row => row.type === 'message');
 assert.deepEqual(recoveredMessages.map(row => row.message.role), ['user', 'assistant', 'assistant', 'assistant']);
 const repairReconnect = request('repair-empty-websocket'); let repairCalls = 0, repairContext = '';
 const repairRecovered = await runPageTopicStage(repairReconnect, async (_model, context) => {
  if (++repairCalls === 1) return response(JSON.stringify(output) + '}');
  assert.equal(context.messages.length, 3);
  const current = JSON.stringify(context);
  if (repairCalls === 2) repairContext = current;
  else assert.equal(current, repairContext, 'empty WebSocket reconnect repeats the unchanged repair request');
  return repairCalls < 4 ? websocket() : response();
 });
 assert.equal(repairCalls, 4); assert.equal(repairRecovered.usage.calls, 4);
 assert.equal(repairRecovered.usage.costUsd, 0.026);
 let exhausted = 0;
 await assert.rejects(runPageTopicStage(request('websocket-exhausted'), async () => { exhausted++; return websocket(); }), /WebSocket error/);
 assert.equal(exhausted, 3, 'no fourth transport attempt');
 for (const [name, bad] of [
  ['websocket-partial', { ...websocket(), content: [{ type: 'text' as const, text: 'Partial output' }] }],
  ['websocket-usage', { ...websocket(), usage: response().usage }],
  ['websocket-wrong-model', { ...websocket(), model: 'another-model' }],
 ] as const) {
  let attempts = 0; await assert.rejects(runPageTopicStage(request(name), async () => { attempts++; return bad; }));
  assert.equal(attempts, 1, 'partial output, consumed tokens and model mismatches are not transport retries');
 }
 const rejected = request('transport-throw');
 let thrownCalls = 0;
 await assert.rejects(runPageTopicStage(rejected, async () => { thrownCalls++; throw new Error('Transport failed'); }), /Transport failed/);
 assert.equal(thrownCalls, 1, 'thrown Provider errors do not enter validation repair');
 assert.equal(json(join(rejected.workRoot, 'checkpoint.json')).status, 'failed');
 for (const thrown of [false, true]) {
  const req = request(`repair-provider-error-${thrown}`); let attempts = 0;
  await assert.rejects(runPageTopicStage(req, async () => {
   if (++attempts === 1) return response(JSON.stringify(output) + '}');
   if (thrown) throw new Error('Provider overloaded');
   return { ...response(), stopReason: 'error', errorMessage: 'Provider overloaded' };
  }), /Provider overloaded/);
  assert.equal(attempts, 2, 'a Provider failure during repair never causes another repair');
  const checkpoint = json(join(req.workRoot, 'checkpoint.json'));
  assert.equal(checkpoint.status, 'failed');
  assert.ok(!existsSync(join(checkpoint.attemptRoot, 'work/result.json')));
 }
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
 console.log('Page Topic bounded validation repair preserves strict contracts, frozen model identity, raw responses, usage, cancellation and resume integrity without Agent tools');
} finally { rmSync(root, { recursive: true, force: true }); }
