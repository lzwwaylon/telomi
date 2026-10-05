import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { completeRegistryModel } from '../agent-runtime/pi-ai.js';
import { createPrimeModelRegistry, PRIME_CREDENTIAL_SOURCE_ENV, primeAgentDir, primeAgentModulePath, primeModelDefinitions, removeStagedPrimeCredentials, stagePrimeAgentDirectory } from '../agent-runtime/prime-agent-paths.js';
import { renderAgentPrompt } from '../agent-runtime/prompt-registry.js';
import { scrubResearchModelError } from '../agent-runtime/models/error-classifier.js';
import { listJsonl, writeJsonAtomic } from '../lib/fs.js';
import { hashJson, sha256 } from '../lib/hash.js';
import type { WikiStageOutcome, WikiStageRequest } from './wiki-stage-contract.js';
import { wikiStageTraceUsage, readWikiStageOutput } from './wiki-stage.js';
import { createPageTopicTask } from './page-topic-contract.js';

export type PageTopicCompletion = (...args: Parameters<typeof completeRegistryModel>) => Promise<
 Extract<Parameters<import('prime-agent').SessionManager['appendMessage']>[0], { role: 'assistant' }>
>;

export const PAGE_TOPIC_MODEL = 'openai-codex/gpt-5.6-terra';
export const PAGE_TOPIC_THINKING = 'medium';
const thinking = PAGE_TOPIC_THINKING;
const executionMode = 'single-completion';
const transportAttemptLimit = 3;
const transportRetryPolicy = 'native-sdk-and-empty-websocket';

/** One classification request with bounded empty WebSocket reconnects. The optional transport is the deterministic test seam. */
export async function runPageTopicStage(request: WikiStageRequest, completeOverride?: PageTopicCompletion): Promise<WikiStageOutcome> {
 request.signal.throwIfAborted();
 const task = createPageTopicTask(request.input);
 const prompt = renderAgentPrompt('wiki', 'wiki-compilation', 'system', {}, 'page-topics');
 const definitions = primeModelDefinitions(request.env);
 const primePath = primeAgentModulePath(request.env);
 const aiPath = createRequire(primePath).resolve.paths('@earendil-works/pi-ai')
  ?.map(directory => join(directory, '@earendil-works/pi-ai/dist/index.js')).find(existsSync);
 if (!aiPath) throw new Error('Prime native model SDK is missing');
 const identity = hashJson({ input: request.input, system: prompt.content, user: task.userContext,
  registration: prompt.configSha256, model: PAGE_TOPIC_MODEL, thinking, definitions, executionMode,
  code: ['page-topic-stage.ts', 'page-topic-contract.ts'].map(file => sha256(readFileSync(fileURLToPath(new URL(file, import.meta.url))))),
  sdk: [primePath, aiPath].map(file => sha256(readFileSync(file))) });
 const checkpoint = join(request.workRoot, 'checkpoint.json');
 if (existsSync(checkpoint)) {
  const saved = JSON.parse(readWikiStageOutput(checkpoint).toString('utf8'));
  if (saved.identity !== identity) throw new Error('Page Topic input or execution contract changed across resume');
  if (saved.status === 'succeeded') {
   for (const [file, digest] of Object.entries(saved.artifacts)) {
    if (sha256(readWikiStageOutput(join(saved.attemptRoot, file))) !== digest) throw new Error('Accepted Page Topic artifacts changed');
   }
   if (hashJson(saved.outcome) !== saved.outcomeHash) throw new Error('Accepted Page Topic outcome changed');
   const raw = JSON.parse(readWikiStageOutput(join(saved.attemptRoot, 'work/result.json')).toString('utf8'));
   if (hashJson({ kind: 'page-topics', sections: task.validate(raw) }) !== hashJson(saved.outcome.result)) throw new Error('Accepted Page Topic result changed');
   request.onAttemptStarted?.(saved.attemptRoot);
   return saved.outcome as WikiStageOutcome;
  }
 }
 mkdirSync(request.workRoot, { recursive: true });
 const attemptRoot = realpathSync(mkdtempSync(join(request.workRoot, 'attempt-')));
 const runtime = join(attemptRoot, 'runtime');
 const work = join(attemptRoot, 'work');
 const sessions = join(runtime, 'sessions');
 for (const directory of [runtime, work, sessions]) mkdirSync(directory, { recursive: true });
 const agentDirectory = join(runtime, 'agent');
 writeJsonAtomic(join(runtime, 'input.json'), request.input);
 writeJsonAtomic(join(runtime, 'agent-context.json'), { user: task.userContext, executionMode });
 writeJsonAtomic(join(runtime, 'tool-definitions.json'), []);
 writeJsonAtomic(join(runtime, 'mounted-skills.json'), { skills: [], diagnostics: [] });
 writeFileSync(join(runtime, 'effective-system-prompt.md'), prompt.content);
 writeFileSync(join(runtime, 'user-prompt.md'), task.userContext);
 writeJsonAtomic(checkpoint, { identity, status: 'running', attemptRoot });
 request.onAttemptStarted?.(attemptRoot);
 try {
  stagePrimeAgentDirectory(agentDirectory, request.env);
  const prime: typeof import('prime-agent') = await import(primePath);
  const { modelRegistry } = createPrimeModelRegistry(prime, agentDirectory, {
   ...request.env, [PRIME_CREDENTIAL_SOURCE_ENV]: primeAgentDir(request.env),
  });
  const [provider, modelId] = PAGE_TOPIC_MODEL.split('/');
  const model = modelRegistry.find(provider!, modelId!);
  if (!model) throw new Error(`Unknown Page Topic model ${PAGE_TOPIC_MODEL}`);
  const session = prime.SessionManager.create(work, sessions);
  session.appendModelChange(model.provider, model.id);
  session.appendThinkingLevelChange(thinking);
  session.appendCustomEntry('execution', { executionMode, tools: [], completionLimit: 1, transportRetryPolicy, transportAttemptLimit });
  writeJsonAtomic(join(runtime, 'workspace-capture.json'), { schemaVersion: 1, sessionId: session.getSessionId(),
   role: 'root', stage: { kind: request.input.stage, key: request.input.key },
   applicability: 'not-applicable', reason: 'stateless-no-file-tools' });
  const user = { role: 'user' as const, content: task.userContext, timestamp: Date.now() };
  session.appendMessage(user);
  session.flushNow();
  writeJsonAtomic(join(runtime, 'model-metadata.json'), { id: model.id, provider: model.provider, api: model.api,
   baseUrl: model.baseUrl, cost: model.cost, thinking, executionMode, requestedModel: PAGE_TOPIC_MODEL, transportRetryPolicy, transportAttemptLimit });
  request.signal.throwIfAborted();
  const auth = await modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok) throw new Error(auth.error);
  request.signal.throwIfAborted();
  const complete: PageTopicCompletion = completeOverride ?? (await import(aiPath)).completeSimple;
  const responseFiles: string[] = [];
  let response: Awaited<ReturnType<PageTopicCompletion>>;
  for (let attempt = 1; ; attempt++) {
   request.signal.throwIfAborted();
   response = await complete(model, { systemPrompt: prompt.content, messages: [user], tools: [] }, {
    apiKey: auth.apiKey, headers: auth.headers, signal: request.signal, reasoning: thinking,
    sessionId: session.getSessionId(),
    onResponse: response => {
     // HTTP statuses expose native retries without persisting credential-bearing headers.
     appendFileSync(join(runtime, 'transport.jsonl'), `${JSON.stringify({ timestamp: Date.now(), status: response.status })}\n`);
    },
   });
   session.appendMessage(response);
   session.flushNow();
   const responseFile = `runtime/response-attempt-${attempt}.json`;
   writeJsonAtomic(join(attemptRoot, responseFile), response); responseFiles.push(responseFile);
   writeJsonAtomic(join(runtime, 'response.json'), response);
   const emptyWebSocketFailure = `${response.provider}/${response.model}` === PAGE_TOPIC_MODEL
    && response.stopReason === 'error' && response.errorMessage === 'WebSocket error'
    && response.usage.input + response.usage.cacheRead + response.usage.cacheWrite + response.usage.output === 0
    && response.content.every(block => block.type === 'text' ? !block.text : block.type === 'thinking' ? !block.thinking : false);
   if (!emptyWebSocketFailure || attempt >= transportAttemptLimit) break;
  }

  writeJsonAtomic(join(runtime, 'result.json'), { executionMode, requestedModel: PAGE_TOPIC_MODEL,
   actualModel: `${response.provider}/${response.model}`, stopReason: response.stopReason, usage: response.usage });
  request.signal.throwIfAborted();
  if (`${response.provider}/${response.model}` !== PAGE_TOPIC_MODEL) throw new Error('Page Topic completion returned a different model');
  if (response.stopReason !== 'stop') throw new Error(`model '${PAGE_TOPIC_MODEL}' failed: ${response.errorMessage || response.stopReason}`);
  if (response.content.some(block => block.type === 'toolCall')) throw new Error('Page Topic completion must not call tools');
  if (!(response.usage.input + response.usage.cacheRead + response.usage.cacheWrite > 0) || !(response.usage.output > 0)) throw new Error('Page Topic completion is missing token usage');
  const text = response.content.filter(block => block.type === 'text').map(block => block.text).join('\n').trim();
  const raw = JSON.parse(text);
  const result: WikiStageOutcome['result'] = { kind: 'page-topics', sections: task.validate(raw) };
  writeJsonAtomic(join(work, 'result.json'), raw);
  writeJsonAtomic(join(runtime, 'accepted-result.json'), result);
  const outcome: WikiStageOutcome = { result, usage: wikiStageTraceUsage(request.workRoot), sessionPaths: sessionPaths(request.workRoot) };
  const artifacts = Object.fromEntries(['work/result.json', 'runtime/input.json', 'runtime/accepted-result.json', 'runtime/response.json',
   'runtime/effective-system-prompt.md', 'runtime/agent-context.json', 'runtime/model-metadata.json', 'runtime/workspace-capture.json',
   ...responseFiles, ...listJsonl(sessions).map(file => file.slice(attemptRoot.length + 1))].map(file => [file, sha256(readWikiStageOutput(join(attemptRoot, file)))]));
  writeJsonAtomic(checkpoint, { identity, status: 'succeeded', attemptRoot, artifacts, outcomeHash: hashJson(outcome), outcome });
  return outcome;
 } catch (error) {
  const message = scrubResearchModelError(error);
  const usage = wikiStageTraceUsage(request.workRoot);
  const paths = sessionPaths(request.workRoot);
  writeJsonAtomic(join(runtime, 'failure.json'), { executionMode, error: message, cancelled: request.signal.aborted });
  writeJsonAtomic(checkpoint, { identity, status: request.signal.aborted ? 'cancelled' : 'failed', attemptRoot, error: message, usage, sessionPaths: paths });
  throw Object.assign(new Error(message), { usage, sessionPaths: paths });
 } finally { removeStagedPrimeCredentials(agentDirectory); }
}

function sessionPaths(root: string): string[] {
 return [...new Set(listJsonl(root).filter(path => path.includes('/sessions/')).map(path => path.slice(0, path.indexOf('/sessions/') + '/sessions'.length)))];
}
