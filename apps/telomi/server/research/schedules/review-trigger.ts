import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { ResearchSchedule } from "./types.js";

/** A Research Schedule is reviewed again once more than this much time has passed since its last Review. */
export const RESEARCH_SCHEDULE_REVIEW_INTERVAL_MS = 7 * 24 * 60 * 60_000;

/** ... or once more than this many new user messages have arrived in the Goal since its last Review. */
export const RESEARCH_SCHEDULE_REVIEW_USER_MESSAGES = 10;

/**
 * Whether Runtime owes this Research Schedule a Review. Deterministic on purpose: a timestamp
 * and a counter, so Reviews are predictable and testable without a model. Paused and archived
 * Schedules are never reviewed.
 */
export function isResearchScheduleReviewDue(
	schedule: ResearchSchedule,
	userMessageCount: number,
	now = new Date(),
): boolean {
	if (schedule.status !== "active") return false;
	const elapsedMs = now.getTime() - Date.parse(schedule.lastReviewedAt);
	// An unreadable timestamp is treated as due: the Review that follows writes a usable one.
	if (Number.isNaN(elapsedMs) || elapsedMs > RESEARCH_SCHEDULE_REVIEW_INTERVAL_MS) return true;
	const newMessages = userMessageCount - schedule.lastReviewedUserMessageCount;
	return newMessages > RESEARCH_SCHEDULE_REVIEW_USER_MESSAGES;
}

/**
 * User messages the Goal transcript holds. This is the Review trigger's activity cursor: it only
 * ever grows, and a Review records the value it saw so the next one counts from there.
 *
 * Counting is by role, so the few Runtime-injected prompts that are persisted as user messages
 * (Goal created and updated events) count as conversation. They are rare enough that the trigger
 * stays honest; distinguishing them would need a marker on the message itself.
 */
export function countGoalUserMessages(goalDir: string): number {
	const path = join(goalDir, "context.jsonl");
	if (!existsSync(path)) return 0;
	let count = 0;
	for (const line of readFileSync(path, "utf-8").split("\n")) {
		if (!line.trim()) continue;
		// The transcript is appended while the Main Agent runs, so its last line can be half
		// written. An unreadable line is not counted; it counts on a later tick once complete.
		let entry: { type?: unknown; message?: { role?: unknown } };
		try {
			entry = JSON.parse(line) as typeof entry;
		} catch {
			continue;
		}
		if (entry.type !== "message") continue;
		const role = entry.message?.role;
		if (role === "user" || role === "user-with-attachments") count += 1;
	}
	return count;
}
