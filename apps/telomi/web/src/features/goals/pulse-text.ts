import { useMemo } from "react";
import type { GoalSnapshot, GoalSummary } from "@shared/types";
import { useTranslation } from "react-i18next";
import { uiText } from "@/app/ui-text";
import { readableErrorText } from "@/shared/lib/activity-text";

/**
 * The Goal Module's answer to "what is this goal's agent doing right now".
 *
 * Every surface that shows a goal's live status reads it from here, so the
 * priority chain, the fallback texts and the dot stay identical across them
 * (per the design intent: "上层的顶部都应该是 activity").
 *
 * Primary display priority (highest first):
 *   1. snapshot.errorMessage      → foreground, "error" tone
 *   2. stopState === "stopping" or statusMessage → foreground, "muted" tone
 *   3. active foreground run      → pulseLine (or a stable running fallback)
 *   4. inactive pulseLine fallback (or goal.pulseLine) → "normal" tone
 *   5. "暂无活动" placeholder      → "muted" tone
 */

export type PulseTone = "normal" | "muted" | "error";
export type PulseDot = "live" | "idle" | "error";
export type GoalPulseSource = "error" | "status" | "foreground" | "placeholder";

export interface GoalPulseSlot {
	text: string;
	tone: PulseTone;
	active: boolean;
}

export interface GoalPulseText {
	/** Final display text after walking the priority chain. */
	text: string;
	/** Visual tone — caller picks colors. */
	tone: PulseTone;
	/** Status indicator dot. */
	dot: PulseDot;
	/** Why the primary text was selected. */
	source: GoalPulseSource;
	/** Foreground runner status, independent from scheduled/background work. */
	foregroundSlot: GoalPulseSlot | null;
	/** True iff the text fell all the way through to the "暂无活动" placeholder. */
	isPlaceholder: boolean;
}

function pickPulseLine(
	snapshot: GoalSnapshot | null,
	selectedGoal: GoalSummary | null,
): string | null {
	const fromSnapshot = snapshot?.pulseLine?.trim();
	if (fromSnapshot) return fromSnapshot;
	const fromSummary = selectedGoal?.pulseLine?.trim();
	if (fromSummary) return fromSummary;
	return null;
}

export function useGoalPulseText(
	snapshot: GoalSnapshot | null,
	selectedGoal: GoalSummary | null,
): GoalPulseText {
	const { t } = useTranslation();
	return useMemo(
		() => resolveGoalPulseText(snapshot, selectedGoal),
		[snapshot, selectedGoal, t],
	);
}

export function resolveGoalPulseText(
	snapshot: GoalSnapshot | null,
	selectedGoal: GoalSummary | null,
): GoalPulseText {
	const isStreaming = snapshot?.isStreaming === true;
	const stopState = snapshot?.stopState ?? "idle";
	const errorMessage = snapshot?.errorMessage?.trim() || null;
	const statusMessage = snapshot?.statusMessage?.trim() || null;
	const pulseLine = pickPulseLine(snapshot, selectedGoal);
	let text: string;
	let tone: PulseTone;
	let source: GoalPulseSource;
	let foregroundSlot: GoalPulseSlot | null = null;
	let isPlaceholder = false;
	if (errorMessage) {
		text = readableErrorText(errorMessage);
		tone = "error";
		source = "error";
		foregroundSlot = { text, tone, active: isStreaming };
	} else if (stopState === "stopping" || statusMessage) {
		text = statusMessage ?? uiText("activity.stopping");
		tone = "muted";
		source = "status";
		foregroundSlot = { text, tone, active: isStreaming || stopState === "stopping" };
	} else if (isStreaming) {
		text = pulseLine ?? uiText("activity.working");
		tone = "normal";
		source = "foreground";
		foregroundSlot = { text, tone, active: true };
	} else if (pulseLine) {
		text = pulseLine;
		tone = "normal";
		source = "foreground";
		foregroundSlot = { text, tone, active: false };
	} else {
		text = uiText("activity.none");
		tone = "muted";
		source = "placeholder";
		isPlaceholder = true;
	}

	const dot: PulseDot = errorMessage
		? "error"
		: isStreaming
			? "live"
			: "idle";

	return {
		text,
		tone,
		dot,
		source,
		foregroundSlot,
		isPlaceholder,
	};
}
