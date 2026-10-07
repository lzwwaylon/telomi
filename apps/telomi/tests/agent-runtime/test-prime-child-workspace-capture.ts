import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionManager as PrimeSessionManager } from 'prime-agent';
import { createRlmChildLogicalWorkspaceSnapshotter } from '../../server/agent-runtime/logical-workspace-snapshot.js';

const root = mkdtempSync(join(tmpdir(), 'prime-child-capture-'));
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
 // Native SDK subscriber errors are swallowed. A later running event must not
 // relabel changed business files as evidence from before the first turn.
 const missingInput = join(root, 'temporarily-unavailable');
 let failedCaptureAttempts = 0;
 const captureFailure = createRlmChildLogicalWorkspaceSnapshotter(() => {
  failedCaptureAttempts++;
  return { guestCwd: '/work', mounts: [{ hostPath: missingInput, guestPath: '/input', access: 'read-only' }],
   sessionId: childSession.getSessionId(), sessionRole: 'child', captureMoment: 'before-first-agent-turn' };
 }, childCaptures, 'child');
 const running = { type: 'rlm_child_update', child: { id: 'sub-failed', status: 'running' } };
 // Match the native SDK emitter's subscriber exception boundary.
 try { captureFailure(running); } catch {}
 mkdirSync(missingInput); writeFileSync(join(missingInput, 'late.bin'), 'after first model entry');
 captureFailure(running);
 assert.equal(failedCaptureAttempts, 1, 'the initial capture attempt is terminal even when it fails');
 assert.equal(existsSync(join(childCaptures, 'child', 'sub-failed.json')), false);
 assert.equal(existsSync(join(childCaptures, 'child', 'sub-failed')), false, 'partial evidence is removed');
 const captureError = JSON.parse(readFileSync(join(childCaptures, 'child', 'sub-failed.failed.json'), 'utf8'));
 assert.equal(captureError.status, 'failed'); assert.equal(captureError.childId, 'sub-failed');
 assert.equal(captureError.reason, 'initial-workspace-capture-failed');
 console.log('Prime child capture preserves initial business files, Session ownership and failed-capture evidence');
} finally { rmSync(root, { recursive: true, force: true }); }
