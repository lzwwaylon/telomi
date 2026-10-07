/** Native auth metadata only. This test never prompts a model or contacts a Provider. */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Match the production scope before importing modules that capture canonical connection paths.
const root = mkdtempSync(join(tmpdir(), 'wiki-anonymous-connection-'));
const canonical = join(root, '.pi', 'agent');
mkdirSync(canonical, { recursive: true });
process.env.PI_CODING_AGENT_DIR = canonical;
process.env.TELOMI_DATA_DIR = root;
const provider = 'wiki-anonymous-fixture';
writeFileSync(join(canonical, 'models.json'), JSON.stringify({ providers: { [provider]: {
 baseUrl: 'http://127.0.0.1:1/v1', api: 'openai-completions',
 models: [{ id: 'local', name: 'Anonymous local model', reasoning: true }],
} } }));
writeFileSync(join(canonical, 'auth.json'), '{}');
const originalFetch = globalThis.fetch;
let networkCalls = 0;
globalThis.fetch = async () => { networkCalls++; throw new Error('Native auth regression must never make a network request'); };
try {
 const { ModelRuntime } = await import('@earendil-works/pi-coding-agent');
 const { refreshConnectionRuntime } = await import('../../server/providers/custom-models.js');
 const { freezeModelDefinitions } = await import('../../server/agent-runtime/model-policy.js');
 const { createWikiModelRuntime } = await import('../../server/wiki/wiki-pi-runtime.js');
 const { writeStoredCredential } = await import('../../server/accounts/stored-credentials.js');
 const { markProviderCredentialDeleted } = await import('../../server/config/credential-tombstones.js');
 const native = await ModelRuntime.create({ authPath: join(canonical, 'auth.json'), modelsPath: join(canonical, 'models.json'), allowModelNetwork: false });
 assert.equal(native.hasConfiguredAuth(provider), false, 'a raw no-key declaration requires the product anonymous auth adapter');
 // Native registration fires refresh without awaiting it. Force that pass to finish
 // after the caller's refresh, so publication ordering never depends on filesystem timing.
 const originalRefresh = native.refresh;
 let releaseRegistration!: () => void, registrationStarted!: () => void;
 const registration = new Promise<void>(resolve => { releaseRegistration = resolve; });
 const started = new Promise<void>(resolve => { registrationStarted = resolve; });
 let refreshCalls = 0;
 const controlledRefresh: typeof native.refresh = options => {
  const call = ++refreshCalls;
  if (call === 1) return Promise.resolve({ aborted: false, errors: new Map() });
  if (call === 2) {
   registrationStarted();
   return registration.then(() => originalRefresh.call(native, options));
  }
  return originalRefresh.call(native, options);
 };
 native.refresh = controlledRefresh;
 const refreshing = refreshConnectionRuntime(native);
 try {
  await started;
  assert.equal(refreshCalls, 2, 'the final refresh cannot race the pending native registration pass');
 } finally { releaseRegistration(); }
 await refreshing;
 assert.equal(native.refresh, controlledRefresh, 'refresh registration restores the caller public method');
 native.refresh = originalRefresh;
 assert.equal(native.hasConfiguredAuth(provider), true, 'refresh returns only after native anonymous availability is published');
 assert.equal((await native.getAuth(provider))?.auth.apiKey, 'unused');

 const env = freezeModelDefinitions({ ...process.env, TELOMI_WIKI_COMPILATION_MODEL: `${provider}/local`,
  TELOMI_WIKI_COMPILATION_THINKING_LEVEL: 'high' }, join(root, 'frozen'));
 const signal = new AbortController().signal;
 const wiki = await createWikiModelRuntime(env, signal);
 assert.equal(wiki.modelRuntime.hasConfiguredAuth(provider), true, 'Wiki initialization uses native anonymous auth without bypassing its guard');
 assert.equal((await wiki.modelRuntime.getAuth(wiki.model))?.auth.apiKey, 'unused', 'fresh Wiki request runtimes register the same anonymous connection');
 const direct = await wiki.modelRegistry.getApiKeyAndHeaders(wiki.model);
 assert.equal(direct.ok, true);
 if (direct.ok) assert.equal(direct.apiKey, 'unused', 'direct Topic classification shares native anonymous auth');

 writeStoredCredential(join(canonical, 'auth.json'), provider, { type: 'api_key', key: 'managed-test-key-never-sent' });
 assert.equal((await wiki.modelRuntime.getAuth(wiki.model))?.auth.apiKey, 'managed-test-key-never-sent', 'fresh requests prioritize an existing managed credential');
 writeStoredCredential(join(canonical, 'auth.json'), provider, { type: 'api_key', key: '' });
 assert.notEqual((await wiki.modelRuntime.getAuth(wiki.model))?.auth.apiKey, 'unused', 'an unusable managed credential cannot silently become anonymous');
 writeStoredCredential(join(canonical, 'auth.json'), provider, null);
 markProviderCredentialDeleted(provider);
 await assert.rejects(wiki.modelRuntime.getAuth(wiki.model), /credential was deleted/, 'an active Wiki cannot become anonymous after credential deletion');
 await assert.rejects(createWikiModelRuntime(env, signal), /credential was deleted/, 'new Wiki runtimes also respect credential deletion');
 await refreshConnectionRuntime(native);
 assert.equal(native.hasConfiguredAuth(provider), false, 'shared native anonymous registration respects deletion tombstones');
 assert.equal(await native.getAuth(provider), undefined);
 assert.equal(networkCalls, 0);
 console.log('Wiki native anonymous auth: initial availability, fresh credentials, direct classification, managed credential priority and deletion passed');
} finally { globalThis.fetch = originalFetch; rmSync(root, { recursive: true, force: true }); }
