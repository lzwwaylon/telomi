import type { ResearchModelUsage } from '../agent-runtime/model-usage.js';
import type { GoalTopicPlan, WikiGoalContext } from './contracts.js';
import type { WikiPageContent, WikiPagesResult, WikiPageSection } from './wiki-page-contract.js';
import type { WikiNoteEntry } from './wiki-edition.js';

export type WikiStageKind = 'objects' | 'merge-objects' | 'plan-concepts' | 'concepts' | 'audit-concepts' | 'merge-concepts' | 'plan-topics' | 'topic' | 'page-topics';
export interface WikiStagePageInput {
 ref: string;
 page: WikiPageContent;
 previous: boolean;
 role: 'member' | 'context';
}
export interface WikiStageRelation { from: string; to: string; label: string; entryIds: string[] }
export interface WikiStageInput {
 stage: WikiStageKind;
 key: string;
 language: string;
 goal: WikiGoalContext;
 entries: WikiNoteEntry[];
 pages: WikiStagePageInput[];
 requiredEntries: string[];
 requiredPages: string[];
 topics: GoalTopicPlan['topics'];
 sections: WikiPageSection[];
 instructions: string;
 previousRelations: WikiStageRelation[];
 conceptTask?: { question: string; scope: string; targetRef: string | null };
 unplacedEntries?: Array<{ entryId: string; reason: string }>;
}
export interface WikiStageConceptJob { pageRefs: string[]; question: string; scope: string; targetRef: string | null }
export type WikiStageResult =
 | { kind: 'object-target-plan'; jobs: Array<{ action: 'update' | 'new' | 'retain'; targetRef: string | null; pageRefs: string[]; reason: string }> }
 | { kind: 'object-target-pages'; value: WikiPagesResult; facts: Array<{ sourceRef: string; sourceHeading: string; claim: string; entryIds: string[]; destinationHeading: string }> }
 | { kind: 'pages'; value: WikiPagesResult; consideredPages: Array<{ pageRef: string; reason: string }> }
 | { kind: 'concept-plan'; jobs: WikiStageConceptJob[]; objectOnly: Array<{ pageRef: string; comparedWith: string[]; reason: string }> }
 | { kind: 'concept-audit'; reviewedPages: Array<{ pageRef: string; reason: string }>; conflictGroups: Array<{ pageRefs: string[]; reason: string }>; discardedRefs: Array<{ ref: string; reason: string }> }
 | { kind: 'topic-plan'; jobs: Array<{ topicId: string; instructions: string }> }
 | { kind: 'page-topics'; sections: Array<{ sectionRef: string; matches: Array<{ topicId: string; reason: string }> }> }
 | { kind: 'topic'; topicId: string; matches: Array<{ sectionRef: string; reason: string }>; gaps: string[] };
export interface WikiStageOutcome { result: WikiStageResult; usage: ResearchModelUsage; sessionPaths: string[] }
export interface WikiStageRequest { input: WikiStageInput; workRoot: string; env: NodeJS.ProcessEnv; signal: AbortSignal; onAttemptStarted?: (attemptRoot: string) => void }
