import type { ResearchModelUsage } from '../agent-runtime/model-usage.js';
import type { GoalTopicPlan, WikiGoalContext } from './contracts.js';
import type { ObjectFirstPage, ObjectFirstPagesResult, ObjectFirstSection } from './object-first-contract.js';
import type { ObjectFirstEntry } from './object-first-edition.js';

export type NoteFirstStage = 'objects' | 'merge-objects' | 'plan-concepts' | 'concepts' | 'audit-concepts' | 'merge-concepts' | 'plan-topics' | 'topic' | 'page-topics';
export interface NoteFirstPageInput {
 ref: string;
 page: ObjectFirstPage;
 previous: boolean;
 role: 'member' | 'context';
}
export interface NoteFirstRelation { from: string; to: string; label: string; entryIds: string[] }
export interface NoteFirstInput {
 stage: NoteFirstStage;
 key: string;
 language: string;
 goal: WikiGoalContext;
 entries: ObjectFirstEntry[];
 pages: NoteFirstPageInput[];
 requiredEntries: string[];
 requiredPages: string[];
 topics: GoalTopicPlan['topics'];
 sections: ObjectFirstSection[];
 instructions: string;
 previousRelations: NoteFirstRelation[];
 conceptTask?: { question: string; scope: string; targetRef: string | null };
 unplacedEntries?: Array<{ entryId: string; reason: string }>;
}
export interface NoteFirstConceptJob { pageRefs: string[]; question: string; scope: string; targetRef: string | null }
export type NoteFirstResult =
 | { kind: 'object-target-plan'; jobs: Array<{ action: 'update' | 'new' | 'retain'; targetRef: string | null; pageRefs: string[]; reason: string }> }
 | { kind: 'object-target-pages'; value: ObjectFirstPagesResult; facts: Array<{ sourceRef: string; sourceHeading: string; claim: string; entryIds: string[]; destinationHeading: string }> }
 | { kind: 'pages'; value: ObjectFirstPagesResult; consideredPages: Array<{ pageRef: string; reason: string }> }
 | { kind: 'concept-plan'; jobs: NoteFirstConceptJob[]; objectOnly: Array<{ pageRef: string; comparedWith: string[]; reason: string }> }
 | { kind: 'concept-audit'; reviewedPages: Array<{ pageRef: string; reason: string }>; conflictGroups: Array<{ pageRefs: string[]; reason: string }>; discardedRefs: Array<{ ref: string; reason: string }> }
 | { kind: 'topic-plan'; jobs: Array<{ topicId: string; instructions: string }> }
 | { kind: 'page-topics'; sections: Array<{ sectionRef: string; matches: Array<{ topicId: string; reason: string }> }> }
 | { kind: 'topic'; topicId: string; matches: Array<{ sectionRef: string; reason: string }>; gaps: string[] };
export interface NoteFirstOutcome { result: NoteFirstResult; usage: ResearchModelUsage; sessionPaths: string[] }
export interface NoteFirstStageRequest { input: NoteFirstInput; workRoot: string; env: NodeJS.ProcessEnv; signal: AbortSignal; onAttemptStarted?: (attemptRoot: string) => void }
