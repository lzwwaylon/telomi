import type { SourceState } from "../sources.js";
import type { ProviderAccountsState, GoalListEvent, GoalSnapshot, GoalSummary } from "../types.js";

export type AppEvent =
	| { type: "snapshot"; goals: GoalSummary[]; accounts: Record<string, ProviderAccountsState> }
	| Exclude<GoalListEvent, { type: "snapshot" }>
	| { type: "account:changed"; scope: "global"; provider: string; state: ProviderAccountsState }
	| { type: "activity-projection:changed"; goalId: string }
	| { type: "goal:run-started"; goalId: string; messageCount: number; timestamp: string }
	| { type: "goal:run-completed"; goalId: string; messageCount: number; timestamp: string; errorMessage?: string }
	| { type: "goal-session:snapshot"; goalId: string; state: GoalSnapshot }
	| { type: "research/schedules:changed"; goalId: string; scheduleId?: string; reason: string; ts: string }
	| { type: "research-run:changed"; goalId: string; runId: string; status: "resuming" | "settled"; ts: string }
	| { type: "source-status:changed"; sourceId: string; state: SourceState; previous: SourceState | null; ts: string }
	| { type: "capability-alerts:changed"; ts: string }
	| {
			type: "wiki-update:changed";
			goalId: string;
			runId: string;
			status: "queued" | "running" | "interrupted" | "succeeded" | "partial" | "failed" | "cancelled";
			ts: string;
		}
	| { type: "topic-plan:changed"; goalId: string; proposalId: string; status: "proposed" | "activated" | "reframed" | "failed"; ts: string }
	| { type: "discovery:changed"; goalId: string; candidateId: string; status: "open" | "closed"; ts: string }
	| {
			type: "media-product:status";
			goalId: string;
			cardId: string;
			status: "idle" | "running" | "done" | "failed";
			jobId?: string;
			error?: string;
			bytes?: number;
			durationSec?: number;
			generatedAt?: string;
			mediaUrl?: string;
			extra?: Record<string, unknown>;
			progress?: string;
			ts: string;
		};
