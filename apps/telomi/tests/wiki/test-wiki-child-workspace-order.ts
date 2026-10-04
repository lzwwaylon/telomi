import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as prime from 'prime-agent';
import { createPrimeModelRegistry, PRIME_CREDENTIAL_SOURCE_ENV } from '../../server/agent-runtime/prime-agent-paths.js';
import { createRlmChildLogicalWorkspaceSnapshotter } from '../../server/agent-runtime/logical-workspace-snapshot.js';

// Exercise the native SDK's publication and running event, stopping at the model
// entry point. This is a Runtime integration test, with no Provider/model calls.
const root = realpathSync(mkdtempSync(join(tmpdir(), 'wiki-native-child-order-')));
const work = join(root, 'work'), input = join(root, 'input'), canonical = join(root, 'agent'), captures = join(root, 'runtime', 'logical-workspaces');
for (const path of [work, input, canonical]) mkdirSync(path, { recursive: true });
writeFileSync(join(work, 'initial.bin'), 'before child model turn');
writeFileSync(join(input, 'readonly.bin'), 'frozen business input');
mkdirSync(join(work, '.prime-kernel')); writeFileSync(join(work, '.prime-kernel', 'ipc'), 'private runtime state');
writeFileSync(join(canonical, 'auth.json'), '{}');
writeFileSync(join(canonical, 'models.json'), JSON.stringify({ providers: { 'workspace-test': {
 baseUrl: 'http://127.0.0.1:1/v1', api: 'openai-completions', apiKey: 'unused-deterministic-key',
 models: [{ id: 'metadata-only', name: 'Metadata only', reasoning: false, input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 4096, maxTokens: 1024 }],
} } }));
const originalPrompt = prime.AgentSession.prototype.promptAndWait;
let parent: prime.AgentSession | undefined;
let childModelEntries = 0, networkCalls = 0;
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { networkCalls++; throw new Error('Runtime fixture must never perform a network request'); };
const capturedChildren = new Map<string, string>();
try {
 const { authStorage, modelRegistry } = createPrimeModelRegistry(prime, canonical, { ...process.env, [PRIME_CREDENTIAL_SOURCE_ENV]: canonical });
 const model = modelRegistry.find('workspace-test', 'metadata-only'); assert.ok(model);
 const settingsManager = prime.SettingsManager.inMemory();
 const loader = new prime.DefaultResourceLoader({ cwd: work, agentDir: canonical, settingsManager,
  systemPrompt: 'Runtime fixture', noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
 await loader.reload();
 ({ session: parent } = await prime.createAgentSession({ cwd: work, agentDir: canonical, authStorage, modelRegistry, model, thinkingLevel: 'off',
  scopedModels: [{ model, thinkingLevel: 'off' }], settingsManager, resourceLoader: loader, sessionManager: prime.SessionManager.create(work, join(root, 'sessions')),
  tools: [], rlmMaxDepth: 1, prewarmIpythonKernel: false, executionMode: 'print', telemetryDisabled: true, autonomous: { enabled: false } }));
 parent.agent.streamFn = () => { throw new Error('Parent terminal-notice continuation is outside this Runtime fixture'); };
 const nativeParent = parent;
 const capture = createRlmChildLogicalWorkspaceSnapshotter(childId => {
  const child = nativeParent.getRlmChildSession(childId);
  assert.ok(child, 'running event publishes the actual native child before capture');
  assert.notEqual(child.sessionId, nativeParent.sessionId);
  capturedChildren.set(child.sessionId, childId);
  return { guestCwd: work, mounts: [
   { hostPath: work, guestPath: work, access: 'read-write', shadowPaths: ['/.prime-kernel'] },
   { hostPath: input, guestPath: input, access: 'read-only' },
  ], sessionId: child.sessionId, sessionRole: 'child', stage: { kind: 'objects', key: 'fixture' }, captureMoment: 'before-first-agent-turn',
  excludedMounts: [{ guestPath: join(work, '.prime-kernel'), access: 'read-write', reason: 'runtime-state' }] };
 }, captures, 'child');
 nativeParent.subscribe(event => capture(event));
 prime.AgentSession.prototype.promptAndWait = async function(_text, options) {
  assert.notEqual(this, nativeParent); childModelEntries++;
  const childId = capturedChildren.get(this.sessionId); assert.ok(childId, 'capture ran before the child model entry point');
  const destination = join(captures, 'child', childId), metadataPath = `${destination}.json`;
  assert.ok(existsSync(metadataPath));
  const metadata = JSON.parse(readFileSync(metadataPath, 'utf8'));
  assert.equal(metadata.sessionId, this.sessionId); assert.equal(metadata.role, 'child');
  assert.equal(metadata.guestCwd, work); assert.deepEqual(metadata.mounts, [{ guestPath: work, access: 'read-write' }, { guestPath: input, access: 'read-only' }]);
  assert.ok(Date.parse(metadata.capturedAt) <= Date.now());
  assert.equal(readFileSync(join(destination, work.slice(1), 'initial.bin'), 'utf8'), 'before child model turn');
  assert.equal(readFileSync(join(destination, input.slice(1), 'readonly.bin'), 'utf8'), 'frozen business input');
  assert.equal(existsSync(join(destination, work.slice(1), '.prime-kernel')), false);
  assert.equal(existsSync(join(destination, canonical.slice(1))), false, 'native credentials are outside business mounts');
  const task = options?.customMessage; assert.ok(task && task.customType === 'agent_message');
  assert.ok(Date.parse(metadata.capturedAt) <= task.timestamp, 'running capture precedes creation of this child own spawn task');
  this.sessionManager.appendCustomMessageEntry(task.customType, task.content, task.display, task.details); this.sessionManager.flushNow();
  const header = JSON.parse(readFileSync(this.sessionFile!, 'utf8').split('\n')[0]!); assert.equal(header.id, metadata.sessionId); assert.equal(header.cwd, metadata.guestCwd);
  writeFileSync(join(work, 'initial.bin'), 'after child model entry');
 };
 const handle = await nativeParent.runRlmChild('Inspect frozen business input', { name: 'workspace-fixture', thinking: 'off' });
 await nativeParent.waitForRlmQuiescence();
 assert.equal(childModelEntries, 1); assert.equal(networkCalls, 0);
 const metadataPath = join(captures, 'child', `${handle.rlm_child_id}.json`);
 const metadata = JSON.parse(readFileSync(metadataPath, 'utf8'));
 const captured = join(captures, 'child', handle.rlm_child_id, work.slice(1), 'initial.bin');
 assert.equal(readFileSync(captured, 'utf8'), 'before child model turn');
 assert.equal(capturedChildren.get(metadata.sessionId), handle.rlm_child_id);
} finally {
 prime.AgentSession.prototype.promptAndWait = originalPrompt;
 parent?.dispose(); globalThis.fetch = originalFetch; rmSync(root, { recursive: true, force: true });
}
console.log('Native SDK child publication, own UUID, first-model ordering and business guest mounts passed without a model call');
