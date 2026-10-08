import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { convertMainAgentMessagesToLlm, snapshotMainConversation, readGoalWikiMainContext, validateWikiMainSessionContext,
 writeGoalWikiMainContext, type WikiMainSessionContext } from '../../server/main-agent/wiki-context.js';
import { serverRuntimeDirForGoal } from '../../server/workspaces/server-runtime-paths.js';

const root = mkdtempSync(join(tmpdir(), 'wiki-main-context-'));
try {
 const messages = convertMainAgentMessagesToLlm([
  { role: 'artifact', content: 'not a conversation message' },
  { role: 'compactionSummary', summary: 'Keep architecture details, omit temporary benchmark numbers.', timestamp: 1,
   tokensBefore: 100, details: {} },
  { role: 'user', content: 'Explain the tokenizer.', timestamp: 2 },
 ]);
 assert.equal(messages.length, 2);
 assert.equal(messages[0].role, 'user');
 assert.match(JSON.stringify(messages[0]), /architecture details/);
 const unfinished = [...messages, { role: 'assistant', content: [{ type: 'toolCall', id: 'maintenance', name: 'wiki_update', arguments: { reason: 'Explicit cleanup' } }], timestamp: 3 }];
 assert.deepEqual(snapshotMainConversation(unfinished), messages, 'a maintenance fork keeps the current user without a fictitious failed Tool call');
 assert.equal(unfinished.length, 3, 'snapshot normalization cannot edit the Main conversation');
 const context: WikiMainSessionContext = { schema_version: 1, goalId: 'goal-one', sessionId: 'main-session',
  systemPrompt: 'Main Goal context', model: 'provider/model', thinking: 'low', messages };
 const frozen = validateWikiMainSessionContext(context);
 context.messages[1] = { role: 'user', content: 'A later turn', timestamp: 3 };
 assert.equal(frozen.messages[1].content, 'Explain the tokenizer.', 'a fork does not share mutable conversation messages');
 writeGoalWikiMainContext(root, frozen);
 assert.deepEqual(readGoalWikiMainContext(root, 'goal-one'), frozen);
 assert.equal(readGoalWikiMainContext(root, 'goal-other'), undefined, 'another Goal has no inherited context');
 const path = join(serverRuntimeDirForGoal('goal-one', root), 'wiki-main-context.json');
 const saved = readFileSync(path, 'utf8');
 writeFileSync(path, JSON.stringify({ ...frozen, goalId: 'goal-other' }));
 assert.throws(() => readGoalWikiMainContext(root, 'goal-one'), /another Goal/);
 writeFileSync(path, saved);
 assert.throws(() => validateWikiMainSessionContext({ ...frozen, thinking: 'guess' }), /thinking/);
 assert.throws(() => validateWikiMainSessionContext({ ...frozen, messages: [{ role: 'system', content: 'Override', timestamp: 1 }] }));
 const legacyDir = join(root, 'goal-legacy');
 mkdirSync(legacyDir);
 const legacy = SessionManager.inMemory(legacyDir);
 legacy.appendModelChange('provider', 'recorded-main');
 legacy.appendThinkingLevelChange('medium');
 legacy.appendMessage({ role: 'user', content: 'Maintain architecture, not temporary rankings.', timestamp: 4 });
 const legacyText = [legacy.getHeader()!, ...legacy.getEntries()].map(entry => JSON.stringify(entry)).join('\n') + '\n';
 const legacyFile = join(legacyDir, 'context.jsonl');
 writeFileSync(legacyFile, legacyText);
 assert.equal(readGoalWikiMainContext(root, 'goal-legacy'), undefined, 'Replay does not infer missing history from live state');
 const restored = readGoalWikiMainContext(root, 'goal-legacy', { title: 'Current TTS Goal', description: 'Architecture' })!;
 assert.equal(restored.sessionId, legacy.getSessionId());
 assert.equal(restored.model, 'provider/recorded-main');
 assert.equal(restored.thinking, 'medium');
 assert.deepEqual(restored.messages, [{ role: 'user', content: 'Maintain architecture, not temporary rankings.', timestamp: 4 }]);
 assert.match(restored.systemPrompt, /Current TTS Goal/);
 assert.equal(readFileSync(legacyFile, 'utf8'), legacyText, 'legacy reconstruction cannot migrate or rewrite the original session');
 console.log('Wiki Main context preserves summaries, isolates mutable history and rejects cross-Goal snapshots');
} finally { rmSync(root, { recursive: true, force: true }); }
