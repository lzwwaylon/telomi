import { apiClient } from "@/shared/lib/api-client";
import { ConfirmDialog } from "@/shared/ui/confirm-dialog";
import { formatDate } from "@/shared/lib/format";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Check, Loader2 } from "lucide-react";
import { ArchiveIcon as Archive, PencilIcon as Pencil, PauseIcon as Pause, PlayIcon as Play, CloseIcon as X, RunIcon, ReviewIcon, DocumentIcon as FileText, CalendarIcon } from "@/shared/ui/icons";

import { useArtifactsContext } from "@/features/goals/data/ArtifactsContext";
import { useNow } from "@/shared/hooks/useNow";
import { subscribeGoalEvents } from "@/shared/lib/goalsEventsStream";
import { refreshOnReconnect } from "@/shared/lib/sharedEventSource";
import { cn } from "@/shared/lib/utils";
import { useTranslation } from "react-i18next";
import { currentUiLocale } from "@/app/i18n";
import { uiText } from "@/app/ui-text";

type ScheduleStatus = "active" | "paused" | "archived";
type RunStatus =
	| "scheduled"
	| "running"
	| "published"
	| "skipped_no_source_increment"
	| "skipped_no_qualifying_evidence"
	| "failed"
	| "cancelled";

interface ScheduleRun {
	id: string;
	status: RunStatus;
	scheduledFor: string;
	reportPath?: string;
	error?: string;
	startedAt?: string;
	finishedAt?: string;
	discoveredSources: number;
	incrementalSources: number;
	retainedEvidence: number;
}

type ReviewStatus = "no_change" | "proposed" | "failed";
type ProposalStatus =
	| "proposed"
	| "confirmed_as_is"
	| "confirmed_with_edits"
	| "rejected"
	| "superseded";

interface ScheduleReview {
	id: string;
	status: ReviewStatus;
	reason?: string;
	finishedAt: string;
}

interface ScheduleProposal {
	id: string;
	status: ProposalStatus;
	summary: string;
	previousMonitoringScope: string;
	previousReportContext: string;
	monitoringScope: string;
	reportContext: string;
	createdAt: string;
	rejectionReason?: string;
}

interface Schedule {
	id: string;
	title: string;
	monitoringScope: string;
	cron: string;
	timeZone: string;
	status: ScheduleStatus;
	coveredThrough: string;
	nextRunAt?: string;
	lastReviewedAt: string;
	lastReview?: ScheduleReview;
	openProposal?: ScheduleProposal;
	runs: ScheduleRun[];
}

interface ScheduleReviewHistory {
	reviews: ScheduleReview[];
	proposals: ScheduleProposal[];
}

type ScheduleFrequency = "minutes" | "hourly" | "daily" | "weekdays" | "weekly" | "monthly" | "custom";

interface SchedulePlan {
	frequency: ScheduleFrequency;
	time: string;
	minuteInterval: number;
	hourMinute: number;
	weekday: number;
	monthDay: number;
	customCron: string;
}

interface ProposalDraft {
	monitoringScope: string;
	reportContext: string;
	reason: string;
}

const EMPTY_PROPOSAL_DRAFT: ProposalDraft = { monitoringScope: "", reportContext: "", reason: "" };

interface ScheduleDraft {
	title: string;
	monitoringScope: string;
	timeZone: string;
	schedulePlan: SchedulePlan;
}

const WEEKDAYS = [
	{ value: 1, label: "common.monday" },
	{ value: 2, label: "common.tuesday" },
	{ value: 3, label: "common.wednesday" },
	{ value: 4, label: "common.thursday" },
	{ value: 5, label: "common.friday" },
	{ value: 6, label: "common.saturday" },
	{ value: 0, label: "common.sunday" },
] as const;

const DEFAULT_SCHEDULE_PLAN: SchedulePlan = {
	frequency: "daily",
	time: "09:00",
	minuteInterval: 10,
	hourMinute: 0,
	weekday: 1,
	monthDay: 1,
	customCron: "",
};

function pad2(value: number): string {
	return String(value).padStart(2, "0");
}

export function parseCronSchedule(schedule: string): SchedulePlan {
	const custom = { ...DEFAULT_SCHEDULE_PLAN, frequency: "custom" as const, customCron: schedule };
	const parts = schedule.trim().split(/\s+/);
	if (parts.length !== 5) return custom;
	const [minuteRaw, hourRaw, dayRaw, monthRaw, weekdayRaw] = parts;

	const minuteInterval = /^\*\/([1-9]|[1-5]\d)$/.exec(minuteRaw);
	if (minuteInterval && hourRaw === "*" && dayRaw === "*" && monthRaw === "*" && weekdayRaw === "*") {
		return { ...DEFAULT_SCHEDULE_PLAN, frequency: "minutes", minuteInterval: Number(minuteInterval[1]) };
	}

	const minute = Number(minuteRaw);
	if (Number.isInteger(minute) && minute >= 0 && minute <= 59 && hourRaw === "*"
		&& dayRaw === "*" && monthRaw === "*" && weekdayRaw === "*") {
		return { ...DEFAULT_SCHEDULE_PLAN, frequency: "hourly", hourMinute: minute };
	}

	const hour = Number(hourRaw);
	if (!Number.isInteger(hour) || !Number.isInteger(minute)
		|| hour < 0 || hour > 23 || minute < 0 || minute > 59 || monthRaw !== "*") return custom;
	const time = `${pad2(hour)}:${pad2(minute)}`;
	if (dayRaw === "*" && weekdayRaw === "*") {
		return { ...DEFAULT_SCHEDULE_PLAN, frequency: "daily", time };
	}
	if (dayRaw === "*" && weekdayRaw === "1-5") {
		return { ...DEFAULT_SCHEDULE_PLAN, frequency: "weekdays", time };
	}
	const weekday = Number(weekdayRaw);
	if (dayRaw === "*" && Number.isInteger(weekday) && weekday >= 0 && weekday <= 6) {
		return { ...DEFAULT_SCHEDULE_PLAN, frequency: "weekly", time, weekday };
	}
	const monthDay = Number(dayRaw);
	if (weekdayRaw === "*" && Number.isInteger(monthDay) && monthDay >= 1 && monthDay <= 31) {
		return { ...DEFAULT_SCHEDULE_PLAN, frequency: "monthly", time, monthDay };
	}
	return custom;
}

export function schedulePlanToCron(plan: SchedulePlan): string {
	if (plan.frequency === "minutes") return `*/${plan.minuteInterval} * * * *`;
	if (plan.frequency === "hourly") return `${plan.hourMinute} * * * *`;
	if (plan.frequency === "custom") return plan.customCron.trim();
	const [hour, minute] = plan.time.split(":");
	if (plan.frequency === "weekdays") return `${Number(minute)} ${Number(hour)} * * 1-5`;
	if (plan.frequency === "weekly") return `${Number(minute)} ${Number(hour)} * * ${plan.weekday}`;
	if (plan.frequency === "monthly") return `${Number(minute)} ${Number(hour)} ${plan.monthDay} * *`;
	return `${Number(minute)} ${Number(hour)} * * *`;
}

/** Human-readable cadence for the card; the raw cron stays in the tooltip. */
export function describeCron(cron: string): string {
	const plan = parseCronSchedule(cron);
	if (plan.frequency === "custom") return cron;
	if (plan.frequency === "minutes") return uiText("goals.goalresearchschedulepanel.everyMinutes", { count: plan.minuteInterval });
	if (plan.frequency === "hourly") return uiText("goals.goalresearchschedulepanel.hourlyAt", { minute: pad2(plan.hourMinute) });
	if (plan.frequency === "daily") return uiText("goals.goalresearchschedulepanel.dailyAt", { time: plan.time });
	if (plan.frequency === "weekdays") return uiText("goals.goalresearchschedulepanel.weekdaysAt", { time: plan.time });
	if (plan.frequency === "weekly") {
		const weekday = WEEKDAYS.find((day) => day.value === plan.weekday)?.label ?? "common.monday";
		return uiText("goals.goalresearchschedulepanel.weeklyAt", { weekday: uiText(weekday), time: plan.time });
	}
	return uiText("goals.goalresearchschedulepanel.monthlyAt", { day: plan.monthDay, time: plan.time });
}

/**
 * What the card says about the next occurrence. The Runtime only starts an occurrence when the
 * Goal has no other Run, so a due time in the past means "waiting", never "missed".
 */
export function nextRunText(schedule: Pick<Schedule, "nextRunAt" | "runs">, now = Date.now()): string {
	const active = schedule.runs.find((run) => run.status === "scheduled" || run.status === "running");
	if (active?.status === "running") {
		return uiText("goals.goalresearchschedulepanel.runningSince", { time: formatTime(active.startedAt ?? active.scheduledFor) });
	}
	if (active) return uiText("goals.goalresearchschedulepanel.queued");
	if (!schedule.nextRunAt) return `${uiText("goals.goalresearchschedulepanel.next")} ${formatTime(undefined)}`;
	if (Date.parse(schedule.nextRunAt) <= now) return uiText("goals.goalresearchschedulepanel.dueWaiting");
	return `${uiText("goals.goalresearchschedulepanel.next")} ${formatTime(schedule.nextRunAt)}`;
}

export function lastFinishedRun(runs: readonly ScheduleRun[]): ScheduleRun | undefined {
	return runs.find((run) => run.status !== "scheduled" && run.status !== "running");
}

export function runStatusText(status: RunStatus): string {
	if (status === "published") return uiText("goals.goalresearchschedulepanel.runPublished");
	if (status === "skipped_no_source_increment") return uiText("goals.goalresearchschedulepanel.runSkippedNoSources");
	if (status === "skipped_no_qualifying_evidence") return uiText("goals.goalresearchschedulepanel.runSkippedNoEvidence");
	if (status === "failed") return uiText("goals.goalresearchschedulepanel.runFailed");
	if (status === "cancelled") return uiText("goals.goalresearchschedulepanel.runCancelled");
	return uiText("schedule.active");
}

export function GoalResearchSchedulePanel({ goalId }: { goalId: string }) {
	const { t } = useTranslation();
	const artifacts = useArtifactsContext();
	const [schedules, setSchedules] = useState<Schedule[]>([]);
	// A due time passes without any server event, so the card re-evaluates "due" on its own.
	const now = useNow();
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState<string | null>(null);
	const [editing, setEditing] = useState<string | null>(null);
	const [expandedScope, setExpandedScope] = useState<string | null>(null);
	const [reviewHistoryOf, setReviewHistoryOf] = useState<string | null>(null);
	const [reviewHistory, setReviewHistory] = useState<ScheduleReviewHistory | null>(null);
	const [proposalDraft, setProposalDraft] = useState<ProposalDraft>(EMPTY_PROPOSAL_DRAFT);
	const [draft, setDraft] = useState<ScheduleDraft>({
		title: "",
		monitoringScope: "",
		timeZone: "",
		schedulePlan: DEFAULT_SCHEDULE_PLAN,
	});

	const refresh = useCallback(async (silent = false) => {
		if (!silent) setLoading(true);
		try {
			const body = await apiClient.get<{ schedules?: Schedule[] }>(`/api/goals/${encodeURIComponent(goalId)}/research/schedules`);
			setSchedules(body.schedules ?? []);
			setError(null);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			if (!silent) setLoading(false);
		}
	}, [goalId]);

	const loadReviewHistory = useCallback(async (scheduleId: string) => {
		try {
			setReviewHistory(await apiClient.get<ScheduleReviewHistory>(
				`/api/goals/${encodeURIComponent(goalId)}/research/schedules/${encodeURIComponent(scheduleId)}/reviews`,
			));
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		}
	}, [goalId]);

	const toggleReviewHistory = useCallback((schedule: Schedule) => {
		if (reviewHistoryOf === schedule.id) {
			setReviewHistoryOf(null);
			setReviewHistory(null);
			return;
		}
		setReviewHistoryOf(schedule.id);
		setReviewHistory(null);
		void loadReviewHistory(schedule.id);
	}, [loadReviewHistory, reviewHistoryOf]);

	/**
	 * Confirming or rejecting is deterministic on the server: it overwrites the Schedule's two
	 * parameters or records the rejection, and never touches cadence, time zone or title.
	 */
	const resolveProposal = useCallback(async (
		schedule: Schedule,
		action: "confirm" | "reject",
	) => {
		const proposal = schedule.openProposal;
		if (!proposal) return;
		setBusy(`${proposal.id}:${action}`);
		try {
			await apiClient.post(
				`/api/goals/${encodeURIComponent(goalId)}/research/schedules/${encodeURIComponent(schedule.id)}/proposals/${encodeURIComponent(proposal.id)}/${action}`,
				action === "confirm"
					? {
						monitoringScope: proposalDraft.monitoringScope,
						reportContext: proposalDraft.reportContext,
					}
					: proposalDraft.reason.trim()
						? { reason: proposalDraft.reason.trim() }
						: {},
			);
			await refresh(true);
			await loadReviewHistory(schedule.id);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setBusy(null);
		}
	}, [goalId, loadReviewHistory, proposalDraft, refresh]);

	// Seed the editable text from whichever Proposal is open, and start over when a newer
	// Proposal supersedes it. Keyed on the Proposal, so a background refresh never discards edits.
	const openProposal = schedules.find((schedule) => schedule.id === reviewHistoryOf)?.openProposal;
	const openProposalId = openProposal?.id;
	useEffect(() => {
		setProposalDraft(openProposal
			? { monitoringScope: openProposal.monitoringScope, reportContext: openProposal.reportContext, reason: "" }
			: EMPTY_PROPOSAL_DRAFT);
		// eslint-disable-next-line react-hooks/exhaustive-deps -- a refresh returns an equal Proposal as a new object
	}, [openProposalId]);

	useEffect(() => {
		void refresh();
		return subscribeGoalEvents(goalId, (event) => {
			if (event.type !== "research/schedules:changed") return;
			void refresh(true);
			if (reviewHistoryOf) void loadReviewHistory(reviewHistoryOf);
		}, refreshOnReconnect(() => void refresh(true)));
	}, [goalId, loadReviewHistory, refresh, reviewHistoryOf]);

	const hasActiveRun = useMemo(
		() => schedules.some((schedule) =>
			schedule.runs.some((run) => run.status === "scheduled" || run.status === "running")),
		[schedules],
	);
	// Archiving cannot be undone, so the schedule waits here until the user confirms it.
	const [archiving, setArchiving] = useState<Schedule | null>(null);
	const act = useCallback(async (
		schedule: Schedule,
		action: "pause" | "resume" | "run-now" | "archive",
	) => {
		setBusy(`${schedule.id}:${action}`);
		try {
			await apiClient.post(`/api/goals/${encodeURIComponent(goalId)}/research/schedules/${encodeURIComponent(schedule.id)}/${action}`);
			await refresh(true);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setBusy(null);
		}
	}, [goalId, refresh]);

	const beginEdit = (schedule: Schedule) => {
		setEditing(schedule.id);
		setDraft({
			title: schedule.title,
			monitoringScope: schedule.monitoringScope,
			timeZone: schedule.timeZone,
			schedulePlan: parseCronSchedule(schedule.cron),
		});
	};
	const updateSchedulePlan = (patch: Partial<SchedulePlan>) => {
		setDraft((value) => ({
			...value,
			schedulePlan: { ...value.schedulePlan, ...patch },
		}));
	};

	const saveEdit = useCallback(async (schedule: Schedule) => {
		setBusy(`${schedule.id}:update`);
		try {
			await apiClient.patch(`/api/goals/${encodeURIComponent(goalId)}/research/schedules/${encodeURIComponent(schedule.id)}`, {
				title: draft.title,
				monitoringScope: draft.monitoringScope,
				cron: schedulePlanToCron(draft.schedulePlan),
				timeZone: draft.timeZone,
			});
			setEditing(null);
			await refresh(true);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setBusy(null);
		}
	}, [draft, goalId, refresh]);

	const activeCount = schedules.filter((schedule) => schedule.status === "active").length;
	return (
		<aside
			className="schedule-control-panel research-schedule-panel"
			data-testid="goal-research-schedule-panel"
			aria-label={t("schedule.title")}
		>
			<div className="schedule-control-head">
				<div>
					<div className="schedule-control-kicker">{uiText("goals.goalresearchschedulepanel.researchSchedule")}</div>
					<h3>{t("schedule.title")}</h3>
				</div>
				{loading && <Loader2 size={14} className="spin schedule-control-loading" aria-label={t("schedule.loading")} />}
			</div>
			<div className="schedule-control-counts" aria-label={t("schedule.summary")}>
				<span><b>{activeCount}</b> {t("schedule.enabled")}</span>
				<span><b>{schedules.length}</b> {t("schedule.plans")}</span>
				<span>{hasActiveRun ? t("schedule.active") : t("schedule.ready")}</span>
			</div>
			{error && <div className="schedule-control-error">{error}</div>}
			{schedules.length === 0 && !loading ? (
				<div className="schedule-control-empty">{t("schedule.empty")}</div>
			) : (
				<ul className="schedule-task-list">
					{schedules.map((schedule) => {
						const activeRun = schedule.runs.find((run) =>
							run.status === "scheduled" || run.status === "running");
						const lastRun = lastFinishedRun(schedule.runs);
						return (
							<li
								key={schedule.id}
								className={cn(
									"schedule-task-row research-schedule-row",
									activeRun && "is-running",
									schedule.status !== "active" && "is-paused",
								)}
							>
								<div className="schedule-task-main">
									<div className="schedule-task-titleline">
										<b title={schedule.title}>{schedule.title}</b>
										<span className={cn("schedule-task-status", schedule.status)}>
											{scheduleStatusText(schedule.status)}
										</span>
										{schedule.openProposal && (
											<span className="schedule-task-status proposal" data-testid="schedule-open-proposal">
												<ReviewIcon size={14} aria-hidden />
												{uiText("goals.goalresearchschedulepanel.proposalOpen")}
											</span>
										)}
									</div>
									<div className="schedule-task-meta">
										<span title={schedule.cron}><CalendarIcon size={14} aria-hidden />{describeCron(schedule.cron)}</span>
										<span>{schedule.timeZone}</span>
										<span className={activeRun ? "is-live" : undefined} data-testid="schedule-next-run">
											{nextRunText(schedule, now)}
										</span>
									</div>
									<div className="schedule-task-sub">
										<span
											className={cn("schedule-task-scope", expandedScope === schedule.id && "is-expanded")}
											role="button"
											tabIndex={0}
											aria-expanded={expandedScope === schedule.id}
											title={uiText(expandedScope === schedule.id ? "goals.goalresearchschedulepanel.scopeCollapse" : "goals.goalresearchschedulepanel.scopeExpand")}
											onClick={() => setExpandedScope((current) => current === schedule.id ? null : schedule.id)}
											onKeyDown={(event) => {
												if (event.key !== "Enter" && event.key !== " ") return;
												event.preventDefault();
												setExpandedScope((current) => current === schedule.id ? null : schedule.id);
											}}
										>
											{schedule.monitoringScope}
										</span>
						<span>{uiText("goals.goalresearchschedulepanel.coveredThrough")} {formatTime(schedule.coveredThrough)}</span>
									</div>
									<div className="schedule-task-meta" data-testid="schedule-last-run">
										{lastRun ? (
											<>
												<span title={lastRun.error}>
													{uiText("goals.goalresearchschedulepanel.lastRun")}{" "}
													{formatTime(lastRun.finishedAt ?? lastRun.scheduledFor)} · {runStatusText(lastRun.status)}
												</span>
												{lastRun.reportPath && artifacts && (
													<button
														type="button"
														className="schedule-link-btn"
														onClick={() => artifacts.openArtifact(lastRun.reportPath!)}
													>
														<FileText size={14} aria-hidden />
														{uiText("goals.goalresearchschedulepanel.openReport")}
													</button>
												)}
											</>
										) : (
											<span>{uiText("goals.goalresearchschedulepanel.noRunsYet")}</span>
										)}
									</div>
									<div className="schedule-task-meta">
										<span>
											{uiText("goals.goalresearchschedulepanel.lastReviewed")}{" "}
											{schedule.lastReview
												? `${formatTime(schedule.lastReview.finishedAt)} · ${reviewStatusText(schedule.lastReview.status)}`
												: uiText("goals.goalresearchschedulepanel.neverReviewed")}
										</span>
										<button
											type="button"
											className="schedule-link-btn"
											onClick={() => toggleReviewHistory(schedule)}
										>
											{uiText(schedule.openProposal
												? "goals.goalresearchschedulepanel.reviewProposal"
												: "goals.goalresearchschedulepanel.reviewHistory")}
										</button>
									</div>
								</div>
								{schedule.status !== "archived" && (
									<div className="schedule-task-actions">
										<button
											type="button"
											className="schedule-icon-btn"
											onClick={() => beginEdit(schedule)}
											disabled={busy !== null}
							title={uiText("common.edit")}
							aria-label={uiText("goals.goalresearchschedulepanel.editTitle", { title: schedule.title })}
										>
											<Pencil size={16} aria-hidden />
										</button>
										<button
											type="button"
											className="schedule-icon-btn"
											onClick={() => void act(schedule, "run-now")}
											disabled={Boolean(activeRun) || busy !== null}
							title={uiText(activeRun ? "goals.goalresearchschedulepanel.runNowBlocked" : "goals.goalresearchschedulepanel.runNow")}
							aria-label={uiText("goals.goalresearchschedulepanel.runTitleNow", { title: schedule.title })}
										>
											{busy === `${schedule.id}:run-now`
												? <Loader2 size={16} className="spin" aria-hidden />
												: <RunIcon size={16} aria-hidden />}
										</button>
									{/* Pairs with the state it returns to, 已暂停 back to 已启用, so it reads resume rather
										than start: the button beside it is the one that runs an occurrence now. The copy is
										this panel's own; borrowing the audio player's would tie two modules to one string. */}
										<button
											type="button"
											className="schedule-icon-btn"
											onClick={() => void act(
												schedule,
												schedule.status === "active" ? "pause" : "resume",
											)}
											disabled={busy !== null}
											title={uiText(schedule.status === "active"
												? "goals.goalresearchschedulepanel.pause"
												: "goals.goalresearchschedulepanel.resume")}
											aria-label={uiText(schedule.status === "active"
												? "goals.goalresearchschedulepanel.pauseTitle"
												: "goals.goalresearchschedulepanel.resumeTitle", { title: schedule.title })}
										>
											{schedule.status === "active" ? <Pause size={16} aria-hidden /> : <Play size={16} aria-hidden />}
										</button>
										<button
											type="button"
											className="schedule-icon-btn danger"
											onClick={() => setArchiving(schedule)}
											disabled={Boolean(activeRun) || busy !== null}
							title={uiText("goals.goalresearchschedulepanel.archive")}
							aria-label={uiText("goals.goalresearchschedulepanel.archiveTitle.37cb8fb", { title: schedule.title })}
										>
											<Archive size={16} aria-hidden />
										</button>
									</div>
								)}
								{reviewHistoryOf === schedule.id && (
									<div className="research-schedule-reviews">
										{schedule.openProposal && (
											<div className="research-schedule-proposal" data-testid="schedule-proposal">
												<p className="research-schedule-proposal-summary">
													{schedule.openProposal.summary}
												</p>
												<ProposalField
													id={`${schedule.id}-proposal-monitoring-scope`}
													label={uiText("goals.goalresearchschedulepanel.monitoringScope")}
													before={schedule.openProposal.previousMonitoringScope}
													value={proposalDraft.monitoringScope}
													onChange={(monitoringScope) => setProposalDraft((draft) => ({ ...draft, monitoringScope }))}
												/>
												<ProposalField
													id={`${schedule.id}-proposal-report-context`}
													label={uiText("goals.goalresearchschedulepanel.reportContext")}
													before={schedule.openProposal.previousReportContext}
													value={proposalDraft.reportContext}
													onChange={(reportContext) => setProposalDraft((draft) => ({ ...draft, reportContext }))}
												/>
												<div className="research-schedule-proposal-actions">
													<input
														id={`${schedule.id}-proposal-reason`}
														value={proposalDraft.reason}
														onChange={(event) => setProposalDraft((draft) => ({ ...draft, reason: event.target.value }))}
														placeholder={uiText("goals.goalresearchschedulepanel.proposalReason")}
														aria-label={uiText("goals.goalresearchschedulepanel.proposalReason")}
													/>
													<button
														type="button"
														onClick={() => void resolveProposal(schedule, "reject")}
														disabled={busy !== null}
													>
														{busy === `${schedule.openProposal.id}:reject`
															? <Loader2 size={13} className="spin" />
															: <X size={13} />}
														{uiText("goals.goalresearchschedulepanel.proposalRejectAction")}
													</button>
													<button
														type="button"
														className="is-primary"
														onClick={() => void resolveProposal(schedule, "confirm")}
														disabled={busy !== null
															|| !proposalDraft.monitoringScope.trim()
															|| !proposalDraft.reportContext.trim()}
													>
														{busy === `${schedule.openProposal.id}:confirm`
															? <Loader2 size={13} className="spin" />
															: <Check size={13} />}
														{uiText("goals.goalresearchschedulepanel.proposalConfirmAction")}
													</button>
												</div>
											</div>
										)}
										{!reviewHistory ? (
											<div className="schedule-control-empty">{t("schedule.loading")}</div>
										) : reviewHistory.reviews.length === 0 ? (
											<div className="schedule-control-empty">
												{uiText("goals.goalresearchschedulepanel.neverReviewed")}
											</div>
										) : (
											<ul className="research-schedule-review-list">
												{reviewHistory.reviews.map((review) => (
													<li key={review.id}>
														<span>{formatTime(review.finishedAt)}</span>
														<b>{reviewStatusText(review.status)}</b>
														{review.reason && <span title={review.reason}>{review.reason}</span>}
													</li>
												))}
											</ul>
										)}
										{reviewHistory && reviewHistory.proposals.length > 0 && (
											<ul className="research-schedule-review-list">
												{reviewHistory.proposals.map((proposal) => (
													<li key={proposal.id}>
														<span>{formatTime(proposal.createdAt)}</span>
														<b>{proposalStatusText(proposal.status)}</b>
														<span title={`${proposal.monitoringScope}\n\n${proposal.reportContext}`}>
															{proposal.summary}
														</span>
													</li>
												))}
											</ul>
										)}
									</div>
								)}
								{editing === schedule.id && (
									<form
										className="research-schedule-edit"
										onSubmit={(event) => {
											event.preventDefault();
											void saveEdit(schedule);
										}}
									>
										<label htmlFor={`${schedule.id}-monitoring-scope`}>
							<span>{uiText("goals.goalresearchschedulepanel.monitoringScope")}</span>
											<textarea
												id={`${schedule.id}-monitoring-scope`}
												name="monitoringScope"
												value={draft.monitoringScope}
												onChange={(event) => setDraft((value) => ({
													...value,
													monitoringScope: event.target.value,
												}))}
												rows={4}
												required
											/>
										</label>
										<fieldset className="research-schedule-plan">
							<legend>{uiText("goals.goalresearchschedulepanel.schedule")}</legend>
											<div className="research-schedule-sentence">
												<select
													id={`${schedule.id}-frequency`}
													name="frequency"
													className="research-schedule-mode"
													value={draft.schedulePlan.frequency}
													onChange={(event) => updateSchedulePlan({
														frequency: event.target.value as ScheduleFrequency,
													})}
									aria-label={uiText("goals.goalresearchschedulepanel.frequency")}
												>
									<option value="minutes">{uiText("goals.goalresearchschedulepanel.every")}</option>
									<option value="hourly">{uiText("goals.goalresearchschedulepanel.hourly")}</option>
									<option value="daily">{uiText("goals.goalresearchschedulepanel.daily")}</option>
									<option value="weekdays">{uiText("goals.goalresearchschedulepanel.weekdays")}</option>
									<option value="weekly">{uiText("goals.goalresearchschedulepanel.weekly")}</option>
									<option value="monthly">{uiText("goals.goalresearchschedulepanel.monthly")}</option>
									<option value="custom">{uiText("goals.goalresearchschedulepanel.custom")}</option>
												</select>
												{draft.schedulePlan.frequency === "minutes" && (
													<>
														<input
															id={`${schedule.id}-minute-interval`}
															name="minuteInterval"
															className="research-schedule-number"
															type="number"
															min={1}
															max={59}
															value={draft.schedulePlan.minuteInterval}
															onChange={(event) => updateSchedulePlan({ minuteInterval: Number(event.target.value) })}
											aria-label={uiText("goals.goalresearchschedulepanel.minuteInterval")}
															required
														/>
										<span>{uiText("goals.goalresearchschedulepanel.minutes")}</span>
													</>
												)}
												{draft.schedulePlan.frequency === "hourly" && (
													<>
										<span>{uiText("goals.goalresearchschedulepanel.atMinute")}</span>
														<input
															id={`${schedule.id}-hour-minute`}
															name="hourMinute"
															className="research-schedule-number"
															type="number"
															min={0}
															max={59}
															value={draft.schedulePlan.hourMinute}
															onChange={(event) => updateSchedulePlan({ hourMinute: Number(event.target.value) })}
											aria-label={uiText("goals.goalresearchschedulepanel.minuteOfTheHour")}
															required
														/>
										<span>{uiText("goals.goalresearchschedulepanel.minutes")}</span>
													</>
												)}
												{draft.schedulePlan.frequency === "weekly" && (
													<select
														id={`${schedule.id}-weekday`}
														name="weekday"
														className="research-schedule-weekday"
														value={draft.schedulePlan.weekday}
														onChange={(event) => updateSchedulePlan({ weekday: Number(event.target.value) })}
										aria-label={uiText("goals.goalresearchschedulepanel.runWeekday")}
													>
														{WEEKDAYS.map((day) => (
											<option key={day.value} value={day.value}>{uiText(day.label)}</option>
														))}
													</select>
												)}
												{draft.schedulePlan.frequency === "monthly" && (
													<>
														<input
															id={`${schedule.id}-month-day`}
															name="monthDay"
															className="research-schedule-number"
															type="number"
															min={1}
															max={31}
															value={draft.schedulePlan.monthDay}
															onChange={(event) => updateSchedulePlan({ monthDay: Number(event.target.value) })}
											aria-label={uiText("goals.goalresearchschedulepanel.dayOfMonth")}
															required
														/>
										<span>{uiText("goals.goalresearchschedulepanel.day")}</span>
													</>
												)}
												{!["minutes", "hourly", "custom"].includes(draft.schedulePlan.frequency) && (
													<input
														id={`${schedule.id}-time`}
														name="time"
														className="research-schedule-time"
														type="time"
														value={draft.schedulePlan.time}
														onChange={(event) => updateSchedulePlan({ time: event.target.value })}
										aria-label={uiText("goals.goalresearchschedulepanel.runTime")}
														required
													/>
												)}
												{draft.schedulePlan.frequency === "custom" && (
													<input
														id={`${schedule.id}-cron`}
														name="cron"
														className="research-schedule-cron"
														value={draft.schedulePlan.customCron}
														onChange={(event) => updateSchedulePlan({ customCron: event.target.value })}
														placeholder="0 9 * * *"
										aria-label={uiText("goals.goalresearchschedulepanel.cronExpression")}
														required
													/>
												)}
											</div>
										</fieldset>
										<details className="research-schedule-advanced">
							<summary>{uiText("goals.goalresearchschedulepanel.nameAndTimeZone")}</summary>
											<div>
												<label htmlFor={`${schedule.id}-title`}>
									<span>{uiText("goals.goalresearchschedulepanel.name")}</span>
													<input
														id={`${schedule.id}-title`}
														name="title"
														value={draft.title}
														onChange={(event) => setDraft((value) => ({ ...value, title: event.target.value }))}
														required
													/>
												</label>
												<label htmlFor={`${schedule.id}-timezone`}>
									<span>{uiText("goals.goalresearchschedulepanel.timeZone")}</span>
													<input
														id={`${schedule.id}-timezone`}
														name="timeZone"
														value={draft.timeZone}
														onChange={(event) => setDraft((value) => ({ ...value, timeZone: event.target.value }))}
														required
													/>
												</label>
											</div>
										</details>
										<div>
											<button type="button" onClick={() => setEditing(null)}>
								<X size={13} />{uiText("goals.goalresearchschedulepanel.discardChanges")}
											</button>
											<button type="submit" disabled={busy !== null}>
												{busy === `${schedule.id}:update`
													? <Loader2 size={13} className="spin" />
													: <Check size={13} />}
								{uiText("goals.goalresearchschedulepanel.saveSchedule")}
											</button>
										</div>
									</form>
								)}
							</li>
						);
					})}
				</ul>
			)}
			<ConfirmDialog
				open={archiving !== null}
				title={uiText("goals.goalresearchschedulepanel.archiveTitle")}
				description={uiText("goals.goalresearchschedulepanel.archiveDescription", { title: archiving?.title ?? "" })}
				confirmLabel={uiText("goals.goalresearchschedulepanel.archive")}
				destructive
				onCancel={() => setArchiving(null)}
				onConfirm={async () => {
					const schedule = archiving;
					setArchiving(null);
					if (schedule) await act(schedule, "archive");
				}}
				testId="schedule-archive-dialog"
			/>
		</aside>
	);
}

/** One parameter of a Proposal: what it is now, and the proposed text the user may edit. */
function ProposalField({ id, label, before, value, onChange }: {
	id: string;
	label: string;
	before: string;
	value: string;
	onChange: (value: string) => void;
}) {
	const changed = before.trim() !== value.trim();
	return (
		<details className="research-schedule-proposal-field">
			<summary>
				<span>{label}</span>
				<b>{uiText(changed
					? "goals.goalresearchschedulepanel.proposalChanged"
					: "goals.goalresearchschedulepanel.proposalUnchanged")}</b>
			</summary>
			<div className="research-schedule-diff">
				<span>{uiText("goals.goalresearchschedulepanel.proposalBefore")}</span>
				<p>{before}</p>
				<label htmlFor={id}>{uiText("goals.goalresearchschedulepanel.proposalAfter")}</label>
				<textarea
					id={id}
					value={value}
					onChange={(event) => onChange(event.target.value)}
					rows={4}
				/>
			</div>
		</details>
	);
}

function reviewStatusText(status: ReviewStatus): string {
	if (status === "no_change") return uiText("goals.goalresearchschedulepanel.reviewNoChange");
	if (status === "proposed") return uiText("goals.goalresearchschedulepanel.reviewProposed");
	return uiText("goals.goalresearchschedulepanel.reviewFailed");
}

function proposalStatusText(status: ProposalStatus): string {
	if (status === "proposed") return uiText("goals.goalresearchschedulepanel.proposalOpen");
	if (status === "confirmed_as_is") return uiText("goals.goalresearchschedulepanel.proposalConfirmed");
	if (status === "confirmed_with_edits") return uiText("goals.goalresearchschedulepanel.proposalConfirmedWithEdits");
	if (status === "rejected") return uiText("goals.goalresearchschedulepanel.proposalRejected");
	return uiText("goals.goalresearchschedulepanel.proposalSuperseded");
}

function scheduleStatusText(status: ScheduleStatus): string {
	return status === "active" ? uiText("goals.goalresearchschedulepanel.enabled") : status === "paused" ? uiText("goals.goalresearchschedulepanel.paused") : uiText("goals.goalresearchschedulepanel.archived");
}

function formatTime(value?: string): string {
	if (!value) return uiText("goals.goalresearchschedulepanel.notScheduled");
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return value;
	return formatDate(date, {
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
	}, currentUiLocale());
}
