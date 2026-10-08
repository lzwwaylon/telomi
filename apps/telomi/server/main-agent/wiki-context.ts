import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Message } from '@earendil-works/pi-ai';
import { Type } from '@sinclair/typebox';
import { convertToLlm, parseSessionEntries, SessionManager } from '@earendil-works/pi-coding-agent';
import { convertAttachmentMessageToLlm } from './attachment-utils.js';
import type { UserMessageWithAttachmentsPayload } from '../../shared/types.js';
import { isThinkingLevel, type ThinkingLevel } from '../agent-runtime/model-config/resolve.js';
import { validateJsonSchema } from '../agent-runtime/structured-output.js';
import { writeJsonAtomic } from '../lib/fs.js';
import { serverRuntimeDirForGoal } from '../workspaces/server-runtime-paths.js';
import { RunArtifactStore } from '../agent-runtime/artifact-store.js';
import { buildMainAgentPrompt } from './system-prompts.js';
import type { WikiGoalContext } from '../wiki/contracts.js';

export interface WikiMainSessionContext {
 schema_version: 1;
 goalId: string;
 sessionId: string;
 systemPrompt: string;
 model: string;
 thinking: ThinkingLevel;
 messages: Message[];
}

export const WikiMainSessionContextSchema = Type.Object({
 schema_version: Type.Literal(1),
 goalId: Type.String({ minLength: 1 }),
 sessionId: Type.String({ minLength: 1 }),
 systemPrompt: Type.String({ pattern: '\\S' }),
 model: Type.String({ pattern: '^[^/]+/.+$' }),
 thinking: Type.String(),
 messages: Type.Array(Type.Object({
  role: Type.Union([Type.Literal('user'), Type.Literal('assistant'), Type.Literal('toolResult')]),
  content: Type.Union([Type.String(), Type.Array(Type.Unknown())]),
  timestamp: Type.Number(),
 }, { additionalProperties: true })),
}, { additionalProperties: false });

export function validateWikiMainSessionContext(value: unknown): WikiMainSessionContext {
 validateJsonSchema(WikiMainSessionContextSchema, value);
 const context = value as WikiMainSessionContext;
 if (!isThinkingLevel(context.thinking)) throw new Error('Invalid Main branch thinking level');
 return structuredClone(context);
}

/** Preserve Pi's effective context, including summaries and attachment messages. */
export function convertMainAgentMessagesToLlm(messages: any[]) {
 return convertToLlm(messages.filter(message => message.role !== 'artifact').map(message =>
  message.role === 'user-with-attachments'
   ? convertAttachmentMessageToLlm(message as UserMessageWithAttachmentsPayload) : message));
}

/** A maintenance Tool can fork before its own reply exists; do not invent a failed Tool result. */
export function snapshotMainConversation(messages: any[]): Message[] {
 const copied = convertMainAgentMessagesToLlm(messages);
 let index = copied.length - 1;
 while (index >= 0 && copied[index]?.role !== 'assistant') index--;
 const assistant = copied[index];
 if (assistant?.role === 'assistant') {
  const completed = new Set(copied.slice(index + 1).flatMap(message => message.role === 'toolResult' ? [message.toolCallId] : []));
  if (assistant.content.some(block => block.type === 'toolCall' && !completed.has(block.id))) return structuredClone(copied.slice(0, index));
 }
 return structuredClone(copied);
}

export function writeGoalWikiMainContext(workspaceDir: string, context: WikiMainSessionContext): void {
 const value = validateWikiMainSessionContext(context);
 writeJsonAtomic(join(serverRuntimeDirForGoal(value.goalId, workspaceDir), 'wiki-main-context.json'), value);
}

export function readGoalWikiMainContext(workspaceDir: string, goalId: string, goal?: WikiGoalContext): WikiMainSessionContext | undefined {
 const path = join(serverRuntimeDirForGoal(goalId, workspaceDir), 'wiki-main-context.json');
 if (existsSync(path)) {
  const context = validateWikiMainSessionContext(JSON.parse(readFileSync(path, 'utf8')));
  if (context.goalId !== goalId) throw new Error('Main branch context belongs to another Goal');
  return context;
 }
 const goalDir = join(workspaceDir, goalId);
 if (!goal || !existsSync(join(goalDir, 'context.jsonl'))) return undefined;
 // Opening a persistent SDK session may migrate its file; reconstruct legacy context only in memory.
 const source = new RunArtifactStore(goalDir).describeFile('context.jsonl');
 const manager = SessionManager.inMemory(goalDir, undefined, parseSessionEntries(readFileSync(source.absolutePath, 'utf8')));
 const loaded = manager.buildSessionContext();
 if (!loaded.model || !loaded.messages.length) return undefined;
 return validateWikiMainSessionContext({ schema_version: 1, goalId, sessionId: manager.getSessionId(),
  systemPrompt: buildMainAgentPrompt(workspaceDir, goalId, goal.title, goal.description, goal.language ?? 'auto'),
  model: `${loaded.model.provider}/${loaded.model.modelId}`, thinking: loaded.thinkingLevel,
  messages: snapshotMainConversation(loaded.messages) });
}
