/** What the Memory page shows: each Memory Episode with the Memory Facts extracted from it. */

export type MemoryEpisodeSource = "message" | "schedule_proposal" | "other";

/**
 * `waiting`: the turn is still running; retention follows the reply.
 * `failed`: not accepted yet and nothing is running; the next turn retries it.
 * `retained`: accepted; `facts` may be empty when nothing lasting was said.
 */
export type MemoryEpisodeStatus = "waiting" | "failed" | "retained";

export interface MemoryFactView {
	id: string;
	text: string;
	invalidated: boolean;
	/** Set once the user edited the text. */
	editedAt?: string;
}

/** A Research Schedule Proposal the user rejected, read from the Schedule itself. */
export interface RejectedScheduleProposalView {
	scheduleTitle: string;
	summary: string;
	/** Absent when the user gave no reason. */
	reason?: string;
}

export interface MemoryEpisodeView {
	documentId: string;
	source: MemoryEpisodeSource;
	/**
	 * What the user said. Empty for a rejected Schedule Proposal: its retained text is extraction
	 * input written by Telomi, not the user's words.
	 */
	text: string;
	/** Shown instead of `text`; absent when the Schedule is gone, for example with its deleted Goal. */
	scheduleProposal?: RejectedScheduleProposalView;
	occurredAt: string;
	/** The Goal it came from; absent once that Goal was deleted. */
	goalId?: string;
	goalTitle?: string;
	global: boolean;
	status: MemoryEpisodeStatus;
	facts: MemoryFactView[];
}

export interface UserMemoryResponse {
	/** This Goal's Episodes that are not global, newest first. */
	goal: MemoryEpisodeView[];
	/** Global Episodes from every Goal, newest first. */
	global: MemoryEpisodeView[];
}

/** 503 body while User Memory is restarting or not configured. */
export const USER_MEMORY_UNAVAILABLE = "user_memory_unavailable";
