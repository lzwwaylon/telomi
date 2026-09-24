import type { ActivityText } from "./activity-text.js";

export type { ActivityMessage, ActivityMessageKey, ActivityText } from "./activity-text.js";

export type ActivityLifecycle = "queued" | "running" | "waiting" | "finished";

export type ActivityOutcome =
	| "succeeded"
	| "partial"
	| "no-change"
	| "skipped"
	| "cancelled"
	| "failed";

export type ActivityKind =
	| "research"
	| "scheduled-research"
	| "wiki-update"
	| "topic-plan"
	| "podcast"
	| "signal-evaluation";

export interface ActivityTiming {
	createdAt: string;
	queuedAt?: string;
	startedAt?: string;
	waitingSince?: string;
	finishedAt?: string;
	updatedAt: string;
	durationMs?: number;
}

export interface ActivityAction {
	actionId: string;
	kind: "decision" | "credential" | "input" | "retry" | "cancel" | "continue" | "open";
	label: ActivityText;
	impact?: ActivityText;
	enabled: boolean;
	disabledReason?: ActivityText;
	requiresConfirmation: boolean;
	href?: string;
	requestBody?: Record<string, unknown>;
}

export interface ActivityWaiting {
	kind: "decision" | "credential" | "input" | "external";
	reason: ActivityText;
	waitingSince: string;
	stepId?: string;
	actions: ActivityAction[];
}

export interface ActivityAttention {
	kind: "decision" | "credential" | "input" | "failure";
	summary: ActivityText;
	actions: ActivityAction[];
}

export interface ActivityProgress {
	completed: number;
	total: number;
	label?: ActivityText;
}

export interface ActivityResultLink {
	kind: "report" | "artifact" | "download" | "failure";
	label: ActivityText;
	href?: string;
	workspacePath?: string;
	available: boolean;
	unavailableReason?: ActivityText;
	primary: boolean;
}

export interface ActivityAttempt {
	attemptId: string;
	number: number;
	lifecycle: ActivityLifecycle;
	outcome?: ActivityOutcome;
	timing: ActivityTiming;
	outputRef?: string;
}

export interface AgentActivity {
	agentActivityId: string;
	agentName: string;
	providerId?: string;
	summary: ActivityText;
	lifecycle: ActivityLifecycle;
	outcome?: ActivityOutcome;
	timing: ActivityTiming;
	outputRef?: string;
	attempts: ActivityAttempt[];
}

export interface ActivityStep {
	stepId: string;
	title: ActivityText;
	summary: ActivityText;
	lifecycle: ActivityLifecycle;
	outcome?: ActivityOutcome;
	timing: ActivityTiming;
	round?: number;
	/** Research execution separated by explicit Run resume events, independent of Agent attempts. */
	executionRound?: number;
	dependsOnStepIds: string[];
	parallelSteps: ActivityStep[];
	agentActivities: AgentActivity[];
	providerAccess?: {
		kind: "cooling" | "recovered" | "unavailable" | "fallback";
		providerId: string;
		failureClass?: string;
		waitStartedAt?: string;
		budgetDeadlineAt?: string;
		nextAttemptAt?: string;
		reason?: string;
		fromProviderId?: string;
		fallbackOutcome?: "running" | "succeeded" | "uncovered";
	};
}

export type ActivityScope =
	| { kind: "goal"; goalId: string }
	| { kind: "system" };

export type ActivityTrigger =
	| { kind: "manual" }
	| { kind: "schedule"; scheduleId: string }
	| { kind: "agent"; agentName: string }
	| { kind: "system" };

export interface ActivityRecovery {
	reason: ActivityText;
	recoveredAt: string;
	stepId?: string;
	round: number;
}

export interface ActivityProjectionItem {
	activityId: string;
	kind: ActivityKind;
	scope: ActivityScope;
	trigger: ActivityTrigger;
	parentActivityId?: string;
	relation?: "continuation" | "rerun";
	title: ActivityText;
	summary: ActivityText;
	lifecycle: ActivityLifecycle;
	outcome?: ActivityOutcome;
	attention?: ActivityAttention;
	waiting?: ActivityWaiting;
	progress?: ActivityProgress;
	timing: ActivityTiming;
	recovery?: ActivityRecovery;
	resultLinks: ActivityResultLink[];
	steps: ActivityStep[];
	sourceRef: string;
}

export interface ActivitySourceFreshness {
	source: ActivityKind;
	observedAt: string;
	sourceRevision: string;
	freshness: "fresh" | "stale" | "unavailable";
	message?: string;
}

export interface ActivityProjectionSummary {
	attention: number;
	running: number;
	queued: number;
	waiting: number;
}

export interface ActivityProjection {
	schemaVersion: 2;
	revision: string;
	generatedAt: string;
	scope: ActivityScope;
	freshness: ActivitySourceFreshness[];
	summary: ActivityProjectionSummary;
	liveActivities: ActivityProjectionItem[];
	history: {
		items: ActivityProjectionItem[];
		nextCursor?: string;
	};
}

export interface GlobalActivityProjectionSummary {
	schemaVersion: 2;
	revision: string;
	generatedAt: string;
	summary: ActivityProjectionSummary;
	activities: ActivityProjectionItem[];
	goals: Array<{
		goalId: string;
		summary: ActivityProjectionSummary;
		attentionSummary?: ActivityText;
	}>;
	system: ActivityProjectionSummary;
}

export interface ActivityOutputLine {
	sequence: number;
	/** Stable identity within its output, even while earlier sections keep growing; reads the line in full. */
	ref?: string;
	at?: string;
	kind: "status" | "text" | "tool" | "thinking" | "tool-input" | "tool-output";
	text: string;
	/** Agent session this line came from when one execution spans several, such as a Prime Search Root and its children. */
	section?: string;
	/** Nesting of this line's session under the execution's Root: 0 for the Root, 1 for a child it delegated to. */
	sectionDepth?: number;
	/** Model that produced this line, as the Agent session recorded it. */
	model?: string;
	/** A list payload shortened this line's text, tool input or tool output; read it by `ref` for the full content. */
	truncated?: boolean;
	toolCallId?: string;
	toolName?: string;
	toolInput?: Record<string, unknown>;
	toolOutput?: string;
	/** Structured result the tool reported beside its text output, with credentials redacted. */
	toolDetails?: unknown;
	isError?: boolean;
}

export interface ActivityOutput {
	outputRef: string;
	lifecycle: ActivityLifecycle;
	outcome?: ActivityOutcome;
	lines: ActivityOutputLine[];
	nextCursor?: string;
}
