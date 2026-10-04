import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionManager as PrimeSessionManager } from 'prime-agent';
import { createRlmChildLogicalWorkspaceSnapshotter } from '../../server/agent-runtime/logical-workspace-snapshot.js';
import { AgentSession } from '@earendil-works/pi-coding-agent';
import { freezeModelDefinitions } from '../../server/agent-runtime/model-policy.js';
import { runPiFileStage } from '../../server/wiki/pi-file-stage.js';
import type { WikiStageInput } from '../../server/wiki/wiki-stage-contract.js';

const root = mkdtempSync(join(tmpdir(), 'wiki-first-turn-'));
const canonical = join(root, 'canonical');
mkdirSync(canonical);
const model = { id: 'gpt-6-luna', name: 'Luna', api: 'openai-codex-responses', provider: 'openai-codex', baseUrl: 'https://chatgpt.com/backend-api', reasoning: true,
 input: ['text'], cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0 }, contextWindow: 272000, maxTokens: 128000 };
writeFileSync(join(canonical, 'auth.json'), JSON.stringify({ 'openai-codex': { type: 'api_key', key: 'fake-test-key-never-sent' } }));
writeFileSync(join(canonical, 'models.json'), JSON.stringify({ providers: { 'openai-codex': { models: [model] } } }));
writeFileSync(join(canonical, 'models-store.json'), JSON.stringify({ 'openai-codex': { models: [model] } }));
const env = freezeModelDefinitions({ ...process.env, PRIME_AGENT_CODING_AGENT_DIR: canonical }, join(root, 'frozen'));
const input: WikiStageInput = { stage: 'objects', key: 'same-stage-key', language: 'en', goal: { title: 'Fixture', description: '' },
 entries: [], pages: [], requiredEntries: [], requiredPages: [], topics: [], sections: [], previousRelations: [], instructions: '' };
const fs = createRequire(import.meta.url)('node:fs') as typeof import('node:fs');
const originalWrite = fs.writeFileSync;
const originalPrompt = AgentSession.prototype.prompt;
let promptCalls = 0;
AgentSession.prototype.prompt = async () => { promptCalls++; throw new Error('Test must never call the model'); };
try {
 const childWork = join(root, 'native-child-work'); mkdirSync(childWork);
 writeFileSync(join(childWork, 'input.bin'), 'before child turn');
 mkdirSync(join(childWork, '.prime-kernel')); writeFileSync(join(childWork, '.prime-kernel', 'ipc'), 'private runtime state');
 const childSession = PrimeSessionManager.create(childWork, join(root, 'native-child-sessions'));
 const childCaptures = join(root, 'child-captures');
 const captureChild = createRlmChildLogicalWorkspaceSnapshotter(() => ({ guestCwd: childWork,
  mounts: [{ hostPath: childWork, guestPath: childWork, access: 'read-write', shadowPaths: ['/.prime-kernel'] }],
  sessionId: childSession.getSessionId(), sessionRole: 'child', stage: { kind: 'topic', key: 'same-stage-key' },
  captureMoment: 'before-first-agent-turn', excludedMounts: [{ guestPath: join(childWork, '.prime-kernel'), access: 'read-write', reason: 'runtime-state' }],
 }), childCaptures, 'child');
 captureChild({ type: 'rlm_child_update', child: { id: 'sub-one', status: 'queued' } });
 assert.equal(existsSync(join(childCaptures, 'child', 'sub-one.json')), false);
 captureChild({ type: 'rlm_child_update', child: { id: 'sub-one', status: 'running' } });
 const childMetadata = JSON.parse(readFileSync(join(childCaptures, 'child', 'sub-one.json'), 'utf8'));
 assert.equal(childMetadata.sessionId, childSession.getSessionId()); assert.equal(childMetadata.role, 'child');
 assert.equal(childMetadata.excludedMounts[0].reason, 'runtime-state');
 const firstUser = { role: 'user' as const, content: 'Frozen task', timestamp: Date.now() };
 childSession.appendMessage(firstUser); childSession.flushNow();
 assert.ok(Date.parse(childMetadata.capturedAt) <= firstUser.timestamp);
 writeFileSync(join(childWork, 'input.bin'), 'after child turn');
 captureChild({ type: 'rlm_child_update', child: { id: 'sub-one', status: 'running' } });
 assert.equal(readFileSync(join(childCaptures, 'child', 'sub-one', childWork.slice(1), 'input.bin'), 'utf8'), 'before child turn');
 assert.equal(existsSync(join(childCaptures, 'child', 'sub-one', childWork.slice(1), '.prime-kernel')), false);
 const sessionIds: string[] = [];
 for (const attempt of ['first', 'retry']) {
  const controller = new AbortController();
  let captured = false;
  fs.writeFileSync = ((path: Parameters<typeof originalWrite>[0], ...args: any[]) => {
   (originalWrite as any)(path, ...args);
   if (String(path).endsWith('/logical-workspaces/root.json')) {
    const metadata = JSON.parse(readFileSync(String(path), 'utf8'));
    const tree = String(path).slice(0, -5);
    assert.equal(metadata.guestCwd, '/work');
    assert.equal(metadata.role, 'root');
    assert.deepEqual(metadata.stage, { kind: input.stage, key: input.key });
    assert.equal(metadata.captureMoment, 'before-first-agent-turn');
    assert.match(metadata.sessionId, /^[a-f0-9-]{36}$/u);
    assert.ok(metadata.excludedMounts.every((mount: any) => mount.reason === 'runtime-library'));
    assert.equal(readFileSync(join(tree, 'input', 'asset.bin'), 'utf8'), 'initial business bytes');
    assert.equal(readFileSync(join(tree, 'input', '.business-state'), 'utf8'), 'initial hidden state');
    assert.equal(existsSync(join(tree, 'input', 'outside-link')), false, 'symlinks do not expose host state');
    assert.equal(existsSync(join(tree, 'work', 'result.json')), false, 'first-turn capture excludes later output');
    assert.equal(existsSync(join(tree, 'work', '.env')), false);
    assert.equal(existsSync(join(tree, 'work', '.git')), false);
    assert.equal(existsSync(join(tree, 'runtime')), false, 'runtime libraries and credentials are not copied');
    sessionIds.push(metadata.sessionId); captured = true;
    controller.abort();
   }
  }) as typeof originalWrite;
  syncBuiltinESMExports();
  let failure = "";
  await assert.rejects(runPiFileStage({ input, env, workRoot: join(root, attempt), signal: controller.signal, onAttemptStarted(path) {
   symlinkSync(join(canonical, 'auth.json'), join(path, 'input', 'outside-link'));
   writeFileSync(join(path, 'work', '.env'), 'credential');
   mkdirSync(join(path, 'work', '.git'));
   writeFileSync(join(path, 'work', '.git', 'config'), 'private git config');
  } }, {
   modelId: 'openai-codex/gpt-6-luna', promptVariant: 'objects-pi', user: 'Fixture task', executionMode: 'fixture', role: 'wiki.object_builder', codeFiles: [],
   prepare(path) {
    writeFileSync(join(path, 'asset.bin'), 'initial business bytes');
    writeFileSync(join(path, '.business-state'), 'initial hidden state');
   },
   readonlyMounts(path) { return [{ hostPath: path, guestPath: '/input', access: 'read-only' }]; },
   validate() { throw new Error('No model turn should reach validation'); },
  }), error => { failure = String(error); return true; });
  assert.equal(captured, true, `stage failure: ${failure}; ` + 'actual Pi stage captures its Workspace before invoking the model');
  assert.equal(promptCalls, 0);
  const checkpoint = JSON.parse(readFileSync(join(root, attempt, 'checkpoint.json'), 'utf8'));
  assert.deepEqual(JSON.parse(readFileSync(join(checkpoint.attemptRoot, 'runtime', 'mounted-skills.json'), 'utf8')), { skills: [], diagnostics: [] });
 }
 assert.notEqual(sessionIds[0], sessionIds[1], 'retries of the same stage key retain distinct native Session identities');
} finally {
 fs.writeFileSync = originalWrite; syncBuiltinESMExports();
 AgentSession.prototype.prompt = originalPrompt;
 rmSync(root, { recursive: true, force: true });
}
console.log('Wiki first-turn Workspace capture preserves native Session ownership and initial business inputs without a model call');
