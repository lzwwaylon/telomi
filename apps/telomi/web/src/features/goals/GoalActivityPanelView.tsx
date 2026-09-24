import { useEffect, useId, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { Loader2 } from "lucide-react";
import { ArrowLeftIcon as ArrowLeft } from "@/shared/ui/icons";
import { useTranslation } from "react-i18next";

import type { ActivityProjection, ActivityProjectionItem } from "@shared/events/activity-projection";
import type { ResearchAgentOutput } from "@shared/types";
import type { BackendConnectionStatus } from "@/features/goals/data/types";
import {
	activityStateLabel,
	activityTimeline,
	type ActivityFilter,
	type ActivityState,
	type TimelineAnnotation,
} from "@/features/goals/activity-timeline";
import { useNow } from "@/shared/hooks/useNow";
import { ActivityDetail } from "@/features/goals/GoalActivityDetail";
import { activityText } from "@/shared/lib/activity-text";
import { cn } from "@/shared/lib/utils";

export function GoalActivityPanelView({
	projection,
	connection,
	error,
	loading,
	loadingMore,
	onLoadMore,
	liveAgentOutputs,
	selectedActivityId,
	onSelectActivity,
}: {
	projection: ActivityProjection | null;
	connection: BackendConnectionStatus;
	error: string | null;
	loading: boolean;
	loadingMore: boolean;
	onLoadMore: () => void;
	liveAgentOutputs: Map<string, ResearchAgentOutput[]>;
	selectedActivityId: string | null;
	onSelectActivity: (activityId: string | null) => void;
}) {
	const { t, i18n } = useTranslation();
	const [filter, setFilter] = useState<ActivityFilter>("all");
	const origin = useRef<{ row: HTMLElement; restoreScroll: () => void } | null>(null);
	const panel = useRef<HTMLElement>(null);
	const backButton = useRef<HTMLButtonElement>(null);
	const connected = connection === "connected";
	const liveActivities = connected ? projection?.liveActivities ?? [] : [];
	const historyItems = projection?.history.items ?? [];
	// A disconnect hides stale live rows from the list but keeps an open detail pane under the banner.
	const selected = selectedActivityId
		? [...projection?.liveActivities ?? [], ...historyItems].find((item) => item.activityId === selectedActivityId)
		: undefined;
	// One clock for the whole panel: every elapsed label in it advances without any new backend data,
	// and no row or worker keeps a timer of its own.
	const ticking = selected?.steps.some((step) => step.providerAccess?.kind === "cooling")
		|| liveActivities.some((item) => item.lifecycle === "running")
		|| selected?.lifecycle === "running";
	const now = useNow(ticking ? 1_000 : 30_000);
	const entries = activityTimeline(liveActivities, historyItems, {
		filter,
		now,
		locale: i18n.resolvedLanguage ?? "en",
	});
	const banner = error ? (
		<div className="goal-activity-error" role="alert">{error}</div>
	) : connection === "disconnected" ? (
		<div className="goal-activity-error" role="alert">{t("goalActivity.disconnectedDescription")}</div>
	) : null;
	const attention = connected ? projection?.summary.attention ?? 0 : 0;
	const running = connected ? projection?.summary.running ?? 0 : 0;

	const open = (activityId: string, row: HTMLElement) => {
		origin.current = { row, restoreScroll: rememberScroll(row) };
		onSelectActivity(activityId);
	};
	const back = () => {
		const opened = origin.current;
		origin.current = null;
		// Restore once the list is back in flow, so its host can scroll that far again.
		flushSync(() => onSelectActivity(null));
		opened?.restoreScroll();
		opened?.row.focus({ preventScroll: true });
	};

	useEffect(() => {
		if (!selectedActivityId) return;
		backButton.current?.focus({ preventScroll: true });
		// Escape stays with the page's other widgets unless focus is in the panel or was dropped
		// to the page, as happens when an action button disables itself.
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key !== "Escape" || event.defaultPrevented) return;
			if (event.target !== document.body && !panel.current?.contains(event.target as Node)) return;
			event.preventDefault();
			back();
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [selectedActivityId]);

	return (
		<section
			ref={panel}
			className={cn("goal-activity-panel", selectedActivityId && "is-pushed")}
			data-testid="goal-activity-panel"
			aria-labelledby="goal-activity-title"
		>
			<div className="goal-activity-view is-list" aria-hidden={selectedActivityId ? true : undefined}>
				<header className="goal-activity-head">
					<h3 id="goal-activity-title">Activity</h3>
					{(attention > 0 || running > 0) && (
						<div className="goal-activity-counts">
							{attention > 0 && (
								<span className="is-attention">▲ {t("goalActivity.attentionCount", { count: attention })}</span>
							)}
							{running > 0 && (
								<span className="is-running">● {t("goalActivity.runningCount", { count: running })}</span>
							)}
						</div>
					)}
				</header>

				{banner}

				<div className="goal-activity-filters" role="group" aria-label={t("goalActivity.filter")}>
					{([
						["all", t("goalActivity.all")],
						["attention", t("goalActivity.attention")],
						["research", t("goalActivity.research")],
						["wiki", "Wiki"],
						["system", t("goalActivity.system")],
					] as Array<[ActivityFilter, string]>).map(([id, label]) => (
						<button
							key={id}
							type="button"
							className={cn(filter === id && "is-active")}
							aria-pressed={filter === id}
							onClick={() => setFilter(id)}
						>
							{label}
						</button>
					))}
				</div>

				{entries.length > 0 ? (
					<div className="goal-activity-timeline">
						{entries.map((entry, index) => entry.kind === "divider" ? (
							<div key={`divider:${index}`} className="goal-activity-divider" data-testid="activity-timeline-divider">
								<span>{entry.label}</span>
							</div>
						) : (
							<ActivityRowButton
								key={entry.item.activityId}
								item={entry.item}
								state={entry.state}
								onOpen={open}
								annotation={entry.annotation}
								timeLabel={entry.timeLabel}
							/>
						))}
					</div>
				) : (
					<div className="goal-activity-empty">
						{loading ? t("goalActivity.loading") : filter === "all" ? t("goalActivity.empty") : t("goalActivity.noMatch")}
					</div>
				)}
				{projection?.history.nextCursor && (
					<button
						type="button"
						className="goal-activity-load-more"
						onClick={onLoadMore}
						disabled={loadingMore}
					>
						{loadingMore ? <Loader2 size={12} className="spin" /> : null}
						{t("goalActivity.loadMore")}
					</button>
				)}
			</div>

			{selectedActivityId && (
				<div className="goal-activity-view is-detail" data-testid="activity-detail">
					<header className="goal-activity-detail-head">
						<button ref={backButton} type="button" data-testid="activity-detail-back" onClick={back}>
							<ArrowLeft size={13} aria-hidden />
							{t("goalActivity.back")}
						</button>
						{selected && <ActivityTitle key={selected.activityId} title={activityText(selected.title)} />}
					</header>
					{banner}
					{selected ? (
						<ActivityDetail item={selected} now={now} liveAgentOutputs={liveAgentOutputs.get(researchRunId(selected)) ?? []} />
					) : (
						<div className="goal-activity-empty">{t("goalActivity.detailMissing")}</div>
					)}
				</div>
			)}
		</section>
	);
}

function ActivityRowButton({
	item,
	state,
	annotation,
	timeLabel,
	onOpen,
}: {
	item: ActivityProjectionItem;
	state: ActivityState;
	annotation: TimelineAnnotation;
	timeLabel: string;
	onOpen: (activityId: string, row: HTMLElement) => void;
}) {
	const { t } = useTranslation();
	const title = activityText(item.title);
	return (
		<button
			type="button"
			className={cn("goal-activity-row", `is-${state}`)}
			data-testid="activity-row"
			onClick={(event) => onOpen(item.activityId, event.currentTarget)}
		>
			<span className="goal-activity-dot">
				<i className={cn("activity-glyph", `is-${state}`)} role="img" aria-label={t(activityStateLabel(item))} />
			</span>
			<span className="goal-activity-row-title" title={title}>{title}</span>
			<Annotation annotation={annotation} />
			{/* A running row times its own start; every other row times its last update. */}
			<time
				className="goal-activity-row-time"
				dateTime={item.lifecycle === "running" ? item.timing.startedAt ?? item.timing.createdAt : item.timing.updatedAt}
			>
				{timeLabel}
			</time>
		</button>
	);
}

function ActivityTitle({ title }: { title: string }) {
	const { t } = useTranslation();
	const [expanded, setExpanded] = useState(false);
	const id = useId();
	const characters = Array.from(title);
	const long = characters.length > 60;
	return (
		<div className="goal-activity-detail-title">
			<h3 id={id}>{long && !expanded ? `${characters.slice(0, 60).join("")}…` : title}</h3>
			{long && (
				<button type="button" aria-expanded={expanded} aria-controls={id} onClick={() => setExpanded(!expanded)}>
					{t(expanded ? "goals.goalactivitypanel.collapse" : "goals.goalactivitypanel.expandTitle")}
				</button>
			)}
		</div>
	);
}

function Annotation({ annotation }: { annotation: TimelineAnnotation }) {
	const { t } = useTranslation();
	if (!annotation) return null;
	if (annotation.kind === "progress") {
		return <span className="goal-activity-annotation is-progress">{`${annotation.completed}/${annotation.total}`}</span>;
	}
	if (annotation.kind === "actions") {
		return <span className="goal-activity-annotation is-actions">{t("goalActivity.actionCount", { count: annotation.count })}</span>;
	}
	return <span className="goal-activity-annotation is-label">{annotation.text}</span>;
}

function researchRunId(item: ActivityProjectionItem): string {
	return item.sourceRef.startsWith("research:") ? item.sourceRef.slice("research:".length) : "";
}

// The panel grows with its content, so the list scrolls inside whichever host holds the panel.
function rememberScroll(node: HTMLElement): () => void {
	const positions: Array<[Element, number]> = [];
	for (let element = node.parentElement; element; element = element.parentElement) {
		positions.push([element, element.scrollTop]);
	}
	return () => {
		for (const [element, top] of positions) element.scrollTop = top;
	};
}
