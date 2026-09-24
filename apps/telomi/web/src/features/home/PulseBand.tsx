import { useEffect, useMemo, useRef, useState } from "react";
import { ActivityIcon as Activity } from "@/shared/ui/icons";
import type { GoalSnapshot, GoalSummary, TodayRollup } from "@shared/types";
import type { BackendConnectionStatus } from "@/features/goals/data/types";
import { useTodayRollup } from "@/features/goals/data/useTodayRollup";
import { stripMarkdownForPill } from "@shared/strip-markdown";
import { useGoalPulseText } from "@/features/goals/pulse-text";
import type { GlobalActivityProjectionSummary } from "@shared/events/activity-projection";
import { useTranslation } from "react-i18next";
import { uiText } from "@/app/ui-text";
import { readableErrorText } from "@/shared/lib/activity-text";

export type PulseBandRoute = "home" | "goal" | "chat";

export interface PulseBandProps {
	route: PulseBandRoute;
	goals: GoalSummary[];
	selectedGoal: GoalSummary | null;
	snapshot: GoalSnapshot | null;
	onOpenActivity?: () => void;
	activitySummary?: GlobalActivityProjectionSummary | null;
	backendConnection?: BackendConnectionStatus;
}

// telomi.html .pulse-band — pill, 36px tall, paper-2 bg, line-soft border.
const SHELL_BASE =
	"pulse-band flex h-9 w-full max-w-[520px] flex-none items-center gap-3.5 overflow-hidden rounded-full border px-3.5 mx-auto min-w-0 " +
	"bg-[var(--paper-2)] transition-[opacity,border-color] duration-200";
const SHELL_NORMAL = `${SHELL_BASE} border-[var(--line-soft)]`;
const SHELL_ERROR = `${SHELL_BASE} border-[var(--warm-line)]`;
const DOT_BASE = "flex-none w-[7px] h-[7px] rounded-full transition-colors duration-200";
const DOT_LIVE = `${DOT_BASE} bg-[var(--warm)] [animation:paper-breathe_2.4s_ease-in-out_infinite]`;
const DOT_IDLE = `${DOT_BASE} bg-[var(--ink-ghost)]`;
const DOT_ERROR = `${DOT_BASE} bg-[var(--warm-deep)]`;

export function PulseBand(props: PulseBandProps) {
	const { t } = useTranslation();
	const {
		route,
		goals,
		selectedGoal,
		snapshot,
		activitySummary,
		onOpenActivity,
		backendConnection = "connected",
	} = props;

	if (backendConnection !== "connected") {
		const disconnected = backendConnection === "disconnected";
		return (
			<div
				className={disconnected ? SHELL_ERROR : SHELL_NORMAL}
				data-testid="pulse-band-backend-status"
				role="status"
				aria-live="polite"
			>
				<span className={disconnected ? DOT_ERROR : DOT_IDLE} aria-hidden />
				<span className="text-[12px] text-[var(--ink-mut)] flex-1 min-w-0 truncate">
					{disconnected ? t("activity.liveStatusPaused") : t("activity.connecting")}
				</span>
				<Activity className="h-4 w-4 flex-none text-[var(--ink-faint)]" aria-hidden />
			</div>
		);
	}
	if (activitySummary) {
		const totalActive = activitySummary.summary.running
			+ activitySummary.summary.waiting
			+ activitySummary.summary.queued;
		return (
			<button
				type="button"
				className={`${activitySummary.summary.attention > 0 ? SHELL_ERROR : SHELL_NORMAL} pulse-band-button`}
				data-testid="pulse-band-activity"
				title={t("activity.viewLive")}
				onClick={onOpenActivity}
			>
				<span className={totalActive > 0 ? DOT_LIVE : DOT_IDLE} aria-hidden />
				<span className="min-w-0 flex-1 truncate whitespace-nowrap text-[12px] text-[var(--ink-mut)] min-[640px]:flex-none">
					{activitySummary.summary.attention > 0
						? t("activity.attention", { count: activitySummary.summary.attention })
						: totalActive > 0 ? t("activity.active", { count: totalActive }) : t("activity.ready")}
				</span>
				<div className="hidden min-w-0 flex-1 gap-3 overflow-hidden min-[640px]:flex">
					<Stat n={activitySummary.summary.running} unit={t("activity.running")} />
					<Stat n={activitySummary.summary.waiting + activitySummary.summary.queued} unit={t("activity.waiting")} />
				</div>
				<Activity className="h-4 w-4 flex-none text-[var(--ink-faint)]" aria-hidden />
			</button>
		);
	}

	if (route === "home") {
		return <HomePulseBand goals={goals} onOpenActivity={onOpenActivity} />;
	}

	return (
		<GoalPulseBand
			snapshot={snapshot}
			selectedGoal={selectedGoal}
			onOpenActivity={onOpenActivity}
		/>
	);
}

interface HomeAggregate {
	liveCount: number;
	productsToday: number;
}

function useHomeAggregate(goals: GoalSummary[], rollup: TodayRollup): HomeAggregate {
	const liveFromGoals = useMemo(
		() => goals.filter((goal) => goal.fresh).length,
		[goals],
	);
	return {
		liveCount: rollup.liveGoals || liveFromGoals,
		productsToday: rollup.productsToday,
	};
}

const PULSE_DURATION_MS = 1700;

/**
 * 跟踪每个 goal 的 lastActivityAt;跳变时返回的 set 里临时含该 goal id,
 * PULSE_DURATION_MS 后自动移除。用于 avatar 短暂光晕。
 */
function useDeliveredGoals(goals: GoalSummary[]): Set<string> {
	const prevRef = useRef<Record<string, string>>({});
	const initialized = useRef(false);
	const [pulsed, setPulsed] = useState<Set<string>>(() => new Set());

	useEffect(() => {
		const prev = prevRef.current;
		const next: Record<string, string> = {};
		const justDelivered: string[] = [];
		for (const g of goals) {
			next[g.id] = g.lastActivityAt;
			if (initialized.current && prev[g.id] && prev[g.id] !== g.lastActivityAt) {
				justDelivered.push(g.id);
			}
		}
		prevRef.current = next;
		initialized.current = true;
		if (justDelivered.length === 0) return;
		setPulsed((cur) => {
			const merged = new Set(cur);
			for (const id of justDelivered) merged.add(id);
			return merged;
		});
		const id = window.setTimeout(() => {
			setPulsed((cur) => {
				if (cur.size === 0) return cur;
				const updated = new Set(cur);
				for (const goalId of justDelivered) updated.delete(goalId);
				return updated;
			});
		}, PULSE_DURATION_MS);
		return () => window.clearTimeout(id);
	}, [goals]);

	return pulsed;
}

function HomePulseBand({ goals, onOpenActivity }: { goals: GoalSummary[]; onOpenActivity?: () => void }) {
	const { t } = useTranslation();
	const rollup = useTodayRollup(goals);
	const { liveCount, productsToday } = useHomeAggregate(goals, rollup);
	const deliveredIds = useDeliveredGoals(goals);

	const dotClass = productsToday > 0 ? DOT_LIVE : DOT_IDLE;

	return (
		<button
			type="button"
			className={`${SHELL_NORMAL} pulse-band-button`}
			data-testid="pulse-band-home"
		title={t("activity.openCenter")}
			onClick={onOpenActivity}
		>
			<span className={dotClass} aria-hidden />
			<span className="text-[12px] text-[var(--ink-mut)] flex-none whitespace-nowrap">
				{t("activity.agents", { count: liveCount })}
			</span>
			<div className="flex gap-3 flex-1 min-w-0 overflow-hidden">
				<Stat n={productsToday} unit={t("activity.products")} />
			</div>
			<div className="avs">
				{goals.slice(0, 4).map((g, i) => (
					<Avatar
						key={g.id}
						fresh={g.fresh}
						lead={i === 0}
						delivered={deliveredIds.has(g.id)}
					/>
				))}
				{Array.from({ length: Math.max(0, 7 - Math.min(goals.length, 4)) }).map((_, i) => (
					<Avatar key={`dim-${i}`} dim />
				))}
			</div>
		</button>
	);
}

/**
 * 整数 count-up:第一次 mount 直接显示 target,之后 target 变化时 240ms easeOut 滚到新值。
 * StrictMode 安全:from 取自 valueRef(实时跟随 state)而非可变的 lastTargetRef,
 * 避免 dev 二次 mount 时 from===target 误判 bail。
 */
function useCountUp(target: number, durationMs = 240): number {
	const [value, setValue] = useState(target);
	const valueRef = useRef(target);
	valueRef.current = value;

	useEffect(() => {
		const from = valueRef.current;
		if (target === from) return;
		let cancelled = false;
		let raf = 0;
		const start = performance.now();
		const tick = (now: number) => {
			if (cancelled) return;
			const t = Math.min(1, (now - start) / durationMs);
			const eased = 1 - Math.pow(1 - t, 3);
			setValue(Math.round(from + (target - from) * eased));
			if (t < 1) raf = requestAnimationFrame(tick);
		};
		raf = requestAnimationFrame(tick);
		return () => {
			cancelled = true;
			cancelAnimationFrame(raf);
		};
	}, [target, durationMs]);

	return value;
}

function Stat({ n, unit }: { n: number; unit: string }) {
	const display = useCountUp(n);
	const prevRef = useRef(n);
	const initialized = useRef(false);
	const [delta, setDelta] = useState<{ value: number; key: number } | null>(null);

	useEffect(() => {
		const prev = prevRef.current;
		prevRef.current = n;
		if (!initialized.current) {
			initialized.current = true;
			return;
		}
		if (n > prev) {
			setDelta({ value: n - prev, key: Date.now() });
			const id = window.setTimeout(() => setDelta(null), 1300);
			return () => window.clearTimeout(id);
		}
	}, [n]);

	return (
		<span className="relative text-[11.5px] text-[var(--ink-mut)] whitespace-nowrap">
			<b className="font-mono font-medium text-[var(--ink)] mr-[3px]">{display}</b>
			{unit}
			{delta && (
				<span
					key={delta.key}
					aria-hidden
					className="absolute -top-3 left-0 text-[10px] font-mono font-medium text-[var(--warm)] pointer-events-none"
					style={{ animation: "delivery-rise 1200ms ease-out forwards" }}
				>
					+{delta.value}
				</span>
			)}
		</span>
	);
}

function Avatar({
	fresh,
	lead,
	dim,
	delivered,
}: {
	fresh?: boolean;
	lead?: boolean;
	dim?: boolean;
	delivered?: boolean;
}) {
	return (
		<span
			aria-hidden
			className={[
				"av",
				lead ? "lead" : "",
				fresh && !dim ? "live" : "",
				dim ? "dim" : "",
			].filter(Boolean).join(" ")}
			style={
				delivered && !dim
					? { animation: "delivery-glow 1600ms ease-out", borderRadius: "50%" }
					: undefined
			}
		/>
	);
}

function buildActivityTooltip(
	activityText: string,
	snapshot: GoalSnapshot | null,
): string {
	const lines: string[] = [];
	lines.push(activityText);

	const pending = snapshot?.pendingToolCalls ?? [];
	if (pending.length > 0) {
		lines.push(uiText("home.pulseband.pendingCountItemsMore", {
			count: pending.length,
			items: pending.slice(0, 4).join(", "),
			more: pending.length > 4 ? "…" : "",
		}));
	}

	if (snapshot?.errorMessage) {
		lines.push(uiText("home.pulseband.errorError", { error: readableErrorText(snapshot.errorMessage) }));
	}

	return lines.join("\n");
}

function GoalPulseBand({
	snapshot,
	selectedGoal,
	onOpenActivity,
}: {
	snapshot: GoalSnapshot | null;
	selectedGoal: GoalSummary | null;
	onOpenActivity?: () => void;
}) {
	const pulse = useGoalPulseText(snapshot, selectedGoal);
	const activityText = pulse.text;
	const { tone: activityTone, dot } = pulse;

	const dotClass = dot === "error" ? DOT_ERROR : dot === "live" ? DOT_LIVE : DOT_IDLE;
	const shellClass = dot === "error" ? SHELL_ERROR : SHELL_NORMAL;
	const activityColor =
		activityTone === "error"
			? "text-[var(--warm-deep)]"
			: activityTone === "muted"
				? "text-[var(--ink-mut)]"
				: "text-[var(--ink)]";

	// Pill is single-line + ellipsis-truncated. Agent markdown (`code`, **bold**, `- `
	// list markers, newlines) leaks visually — strip syntax for display, keep raw in title.
	const activityDisplay = stripMarkdownForPill(activityText);
	const tooltip = buildActivityTooltip(
		activityDisplay,
		snapshot,
	);

	return (
		<button
			type="button"
			className={`${shellClass} pulse-band-button`}
			data-testid="pulse-band-goal"
			title={tooltip}
			onClick={onOpenActivity}
		>
			<span className={dotClass} aria-hidden />
			<span
				className={`text-[12.5px] flex-1 min-w-0 overflow-hidden text-ellipsis whitespace-nowrap ${activityColor}`}
			>
				{activityDisplay}
			</span>
		</button>
	);
}
