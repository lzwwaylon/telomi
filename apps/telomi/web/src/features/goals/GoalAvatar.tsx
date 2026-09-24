import { memo, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import type { GoalSummary } from "@shared/types";
import { BirdAvatar } from "@/features/goals/BirdAvatar";
import {
	EMOTION,
	IDLE_SIGNALS,
	goalAvatarEmotion,
	sameSignals,
	type GoalAvatarMoment,
	type GoalAvatarSignals,
} from "@/features/goals/avatar-signals";

interface GoalAvatarProps {
	goal: Pick<GoalSummary, "id" | "title" | "isStreaming" | "avatar" | "createdAt" | "lastActivityAt">;
	signals?: GoalAvatarSignals;
	isActive?: boolean;
	size: number | string;
	className?: string;
}

/** How long each moment plays before the state takes over again. */
const MOMENT_MS: Record<GoalAvatarMoment, number> = { born: 1500, started: 1200, done: 1600, cancelled: 1600 };
/** A Goal created this recently is waking up for the first time. */
const BORN_WINDOW_MS = 5_000;
/**
 * A Goal with nothing happening for this long dozes off. Longer than a working day, so a
 * Goal stays awake across the session you are in and is only found sleeping when you come
 * back the next day. Sleep closes the eyes, and eye shape is how the rail tells birds
 * apart, so a rail that sleeps within minutes costs more than it says.
 */
const ASLEEP_AFTER_MS = 12 * 60 * 60_000;

function latest(...stamps: Array<string | null | undefined>): number {
	return Math.max(0, ...stamps.filter((stamp): stamp is string => !!stamp).map((stamp) => Date.parse(stamp)));
}

/**
 * The bird's emotion is the Goal's status; selection and inactivity are not emotions, so
 * they stay on the wrapper. Only the selected bird gets effect particles, so a rail full
 * of them does not flicker.
 *
 * Moments are the transitions the projection cannot carry: work starting, work ending
 * as done or cancelled, and a Goal being created. They are read off the change between
 * two renders and shown briefly on top of the state.
 */
function GoalAvatarView({ goal, signals = IDLE_SIGNALS, isActive = false, size, className }: GoalAvatarProps) {
	const { t } = useTranslation();
	const busy = signals.running.length > 0 || goal.isStreaming || signals.attention !== null;
	const wasBusy = useRef(busy);
	const [moment, setMoment] = useState<GoalAvatarMoment | null>(() =>
		Date.now() - Date.parse(goal.createdAt) < BORN_WINDOW_MS ? "born" : null);

	useEffect(() => {
		const changed = wasBusy.current !== busy;
		wasBusy.current = busy;
		if (!changed) return;
		// Work counts as done when it ends, or when the user clears what it left waiting on them.
		const next: GoalAvatarMoment = busy ? "started" : signals.lastFinished?.outcome === "cancelled" ? "cancelled" : "done";
		setMoment(next);
	}, [busy, signals.lastFinished]);

	useEffect(() => {
		if (!moment) return;
		const timer = window.setTimeout(() => setMoment(null), MOMENT_MS[moment]);
		return () => window.clearTimeout(timer);
	}, [moment]);

	// Dozing is a function of time, so the bird re-renders once when the quiet period passes.
	const quietSince = latest(goal.lastActivityAt, signals.lastActiveAt);
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		const wakeAt = quietSince + ASLEEP_AFTER_MS;
		if (busy || wakeAt <= Date.now()) return;
		const timer = window.setTimeout(() => setNow(Date.now()), wakeAt - Date.now());
		return () => window.clearTimeout(timer);
	}, [quietSince, busy]);
	const asleep = !busy && now - quietSince >= ASLEEP_AFTER_MS;

	const emotion = goalAvatarEmotion({ signals, isStreaming: !!goal.isStreaming, moment, asleep });
	// Colour is how a Goal is recognised, so what needs the user rides on a badge beside the
	// bird instead of repainting it, and the badge covers every kind of attention rather than
	// only a failure. A broken Goal and a waiting one are told apart by the badge's shape,
	// solid against hollow, because two warm tokens sit 10 dE apart in the dark theme and a
	// tenth-size dot cannot carry that. The label repeats the split for anyone who sees
	// neither shape nor colour.
	const attentionLabel = signals.attention === "failure" ? t("goalAvatar.failed") : t("goalActivity.attention");
	// Resting reads as muted colour, so a Goal with work on it stands out in the rail. Only
	// saturation: opacity on top of it sank the bird into the dark background and cost the
	// colour that tells birds apart, and selection is already carried by the ring below.
	const dimmed = !isActive && (emotion === EMOTION.idle || emotion === EMOTION.asleep);
	return (
		<span
			className={`relative inline-flex items-center justify-center rounded-full leading-none ${className ?? ""}`.trim()}
			style={{
				width: size,
				height: size,
				filter: dimmed ? "saturate(0.78)" : undefined,
				boxShadow: isActive ? "0 0 0 3px var(--warm-soft), 0 0 0 4px var(--warm)" : undefined,
			}}
			data-testid={`goal-avatar-${goal.id}`}
		>
			<BirdAvatar look={goal.avatar} emotion={emotion} size="100%" effects={isActive} label={goal.title || goal.id} />
			{signals.attention && (
				<span
					role="img"
					aria-label={attentionLabel}
					title={attentionLabel}
					data-testid={`goal-avatar-attention-${goal.id}`}
					data-attention={signals.attention}
					className="absolute bottom-0 right-0 rounded-full pointer-events-none box-border"
					style={{
						width: "31%",
						height: "31%",
						background: signals.attention === "failure" ? "var(--attention-alert)" : "var(--paper)",
						border: signals.attention === "failure" ? undefined : "2.5px solid var(--warm-deep)",
						// The ring, not the fill, is what separates the badge from the bird. A failing coral
						// bird sits 7 dE from the alert colour, so on hue alone the badge would disappear on
						// exactly the Goals that need it; paper is far from every bird in both themes.
						boxShadow: "0 0 0 2px var(--paper)",
					}}
				/>
			)}
		</span>
	);
}

export const GoalAvatar = memo(GoalAvatarView, (previous, next) =>
	previous.goal.id === next.goal.id
	&& previous.goal.title === next.goal.title
	&& previous.goal.isStreaming === next.goal.isStreaming
	&& previous.goal.avatar === next.goal.avatar
	&& previous.goal.createdAt === next.goal.createdAt
	&& previous.goal.lastActivityAt === next.goal.lastActivityAt
	&& sameSignals(previous.signals ?? IDLE_SIGNALS, next.signals ?? IDLE_SIGNALS)
	&& previous.isActive === next.isActive
	&& previous.size === next.size
	&& previous.className === next.className,
);
