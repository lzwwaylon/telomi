import { Fragment, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { DocumentIcon as FileText, CloseIcon as X } from "@/shared/ui/icons";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";

import type {
	ActivityAction,
	ActivityLifecycle,
	ActivityOutput,
	ActivityOutputLine,
	ActivityProjectionItem,
	ActivityStep,
	ActivityText,
	ActivityTiming,
	AgentActivity,
} from "@shared/events/activity-projection";
import type { ResearchAgentOutput } from "@shared/types";
import { ConfirmDialog } from "@/shared/ui/confirm-dialog";
import { GenericOverlay } from "@/app/overlays/GenericOverlay";
import { MarkdownOverlay } from "@/app/overlays/MarkdownOverlay";
import { uiText } from "@/app/ui-text";
import { activityText } from "@/shared/lib/activity-text";
import { ActivityRow } from "@/features/chat/TurnCard";
import { activityOutputItems, activityOutputLineItem } from "@/features/goals/activity-output-adapter";
import {
	groupActivitySteps,
	type ActivityWorker,
} from "@/features/goals/activity-step-groups";
import {
	OUTCOME_LABEL,
	activityKindLabel,
	activityState,
	activityStateLabel,
	elapsedLabel,
	lastUpdateLabel,
	quietLabel,
	type ActivityStateSource,
} from "@/features/goals/activity-timeline";
import { useArtifactsContext } from "@/features/goals/data/ArtifactsContext";
import type { ActivityItem } from "@/features/goals/data/types";
import { fetchActivityOutput } from "@/features/goals/data/useActivityProjection";
import { apiClient } from "@/shared/lib/api-client";
import { formatRelativeTime } from "@/shared/lib/format";
import { cn } from "@/shared/lib/utils";
import { Dialog, DialogContent, DialogTitle } from "@/shared/ui/dialog";
import { Spinner } from "@/shared/ui/loading-indicator";
import { LinkClickContext } from "@/shared/markdown/MarkdownView";

// The status line names the Activity Lifecycle or Activity Outcome; the glyph carries the collapsed state.
const LIFECYCLE_LABEL = {
	queued: "goalActivity.statusQueued",
	waiting: "goalActivity.stateWaiting",
	running: "goalActivity.stateRunning",
} as const satisfies Record<Exclude<ActivityLifecycle, "finished">, string>;

export function ActivityDetail({
	item,
	now,
	liveAgentOutputs,
}: {
	item: ActivityProjectionItem;
	now: number;
	liveAgentOutputs: ResearchAgentOutput[];
}) {
	const linkClick = useContext(LinkClickContext);
	const artifacts = useArtifactsContext();
	const openFile = linkClick?.onFileClick ?? artifacts?.openArtifact;
	const [runningAction, setRunningAction] = useState<string | null>(null);
	const [actionError, setActionError] = useState<string | null>(null);
	const [confirming, setConfirming] = useState<ActivityAction | null>(null);
	// Output identity survives the running Agent Activity becoming a completed execution record.
	const [replayRef, setReplayRef] = useState<string | null>(null);
	const goalId = item.scope.kind === "goal" ? item.scope.goalId : undefined;
	const openReplay = goalId ? setReplayRef : undefined;
	const replay = replayRef ? findAgentActivity(item.steps, replayRef) : undefined;
	const state = activityState(item);
	// Nothing under a finished Activity is still running, whatever a last recorded Step status says,
	// so its card stops counting exactly where the projection does.
	const live = item.lifecycle !== "finished";
	const elapsed = item.lifecycle === "running" ? elapsedLabel(item.timing, now) : "";
	const summary = activityText(item.summary);
	const results = item.resultLinks.filter((result) => result.available && (result.workspacePath || result.href));
	const runAction = async (action: ActivityAction) => {
		if (!action.enabled || !action.href || !new Set(["continue", "decision", "retry"]).has(action.kind)) return;
		// An action that declares an impact states it and waits; the dialog carries the answer back here.
		if (action.requiresConfirmation) { setConfirming(action); return; }
		await sendAction(action);
	};
	const sendAction = async (action: ActivityAction) => {
		// The dialog answers asynchronously, so the destination is checked again here rather than
		// only where the action was offered.
		if (!action.href) return;
		setRunningAction(action.actionId);
		setActionError(null);
		try {
			await apiClient.post(action.href, action.requestBody || undefined, {
				fallbackMessage: (status) => uiText("goals.goalactivitypanel.actionFailedStatus", { status }),
			});
		} catch (error) {
			setActionError(error instanceof Error ? error.message : String(error));
		} finally {
			setRunningAction(null);
		}
	};
	return (
		<div className="goal-activity-detail">
			<div className="goal-activity-detail-status">
				<i className={cn("activity-glyph", `is-${state}`)} aria-hidden />
				<span>{uiText(item.lifecycle === "finished" ? OUTCOME_LABEL[item.outcome ?? "succeeded"] : LIFECYCLE_LABEL[item.lifecycle])}</span>
				{elapsed && (
					<time className="goal-activity-detail-meta" dateTime={item.timing.startedAt ?? item.timing.createdAt}>
						{elapsed}
					</time>
				)}
				{/* Elapsed time says how long the work has run; this stays the last time it reported anything. */}
				<time className="goal-activity-detail-meta" dateTime={item.timing.updatedAt}>
					{item.lifecycle === "running"
						? quietLabel(item.timing, now) ?? lastUpdateLabel(item.timing, now)
						: formatRelativeTime(item.timing.updatedAt, undefined, now, true)}
				</time>
				<span className="goal-activity-detail-meta" aria-hidden>·</span>
				<span className="goal-activity-detail-meta">{activityKindLabel(item.kind)}</span>
			</div>
			{summary && <p className="goal-activity-detail-summary">{summary}</p>}
			{item.attention && (
				<div className="goal-activity-attention">
					<p>{activityText(item.attention.summary)}</p>
					{(item.attention.actions.length > 0 || item.attention.dismiss) && (
						<div className="goal-activity-attention-actions">
							{item.attention.actions.map((action) => action.kind === "open" && action.href ? (
								<a key={action.actionId} href={action.href}>{activityText(action.label)}</a>
							) : (
								<button
									key={action.actionId}
									type="button"
									disabled={!action.enabled || runningAction === action.actionId}
									title={!action.enabled && action.disabledReason ? activityText(action.disabledReason) : undefined}
									onClick={() => void runAction(action)}
								>
									{runningAction === action.actionId ? uiText("turnCard.processing") : activityText(action.label)}
								</button>
							))}
							{item.attention.dismiss && (
								<button
									type="button"
									className="is-quiet"
									data-testid="activity-attention-dismiss"
									disabled={runningAction !== null}
									onClick={() => void sendAction(item.attention!.dismiss!)}
								>
									{runningAction === item.attention.dismiss.actionId ? uiText("turnCard.processing") : activityText(item.attention.dismiss.label)}
								</button>
							)}
						</div>
					)}
					{actionError && <p className="goal-activity-attention-error" role="alert">{actionError}</p>}
				</div>
			)}
			{item.progress && item.lifecycle === "running" && (
				<div className="goal-activity-progress">
					<div
						role="progressbar"
						aria-valuenow={item.progress.completed}
						aria-valuemin={0}
						aria-valuemax={item.progress.total}
						aria-label={item.progress.label ? activityText(item.progress.label) : undefined}
					>
						<span style={{ width: `${Math.min(100, item.progress.total ? item.progress.completed / item.progress.total * 100 : 0)}%` }} />
					</div>
					<small>
						{item.progress.completed} / {item.progress.total}
						{item.progress.label && ` · ${activityText(item.progress.label)}`}
					</small>
				</div>
			)}
			{item.lifecycle === "running" && item.steps.length === 0 && (
				<LiveAgentStages item={item} outputs={liveAgentOutputs} />
			)}
			{groupActivitySteps(item.steps, item.recovery?.round).map((group) => (
				<section className="goal-activity-step-group" key={group.id} aria-labelledby={`activity-phase-${item.activityId}-${group.id}`}>
					<header className="goal-activity-step-group-head">
						<b id={`activity-phase-${item.activityId}-${group.id}`}>{activityText(group.label)}</b>
						<span>{uiText("goalActivity.stepCount", { count: group.steps.length })}</span>
					</header>
					{group.steps.length === 0 && <p className="goal-activity-detail-summary">{uiText("goalActivity.preparingSteps")}</p>}
					{group.entries.map((entry) => entry.kind === "worker-pool" ? (
						<ActivityWorkerPool
							key={entry.id}
							label={entry.label}
							workers={entry.workers}
							now={now}
							live={live}
							onOpen={openReplay}
						/>
					) : (
						<ActivityStepRow
							key={entry.step.stepId}
							step={entry.step}
							now={now}
							live={live}
							onOpen={openReplay}
						/>
					))}
				</section>
			))}
			{results.length > 0 && (
				<div className="goal-activity-results">
					{results.map((result) => result.workspacePath && openFile ? (
						<button key={result.workspacePath} type="button" onClick={() => openFile(result.workspacePath!)}>
							<FileText size={12} aria-hidden />{activityText(result.label)}
						</button>
					) : (
						<a key={result.href} href={result.href}>
							<FileText size={12} aria-hidden />{activityText(result.label)}
						</a>
					))}
				</div>
			)}
			{goalId && replay?.agent.outputRef && (
				<ActivityReplay
					goalId={goalId}
					outputRef={replay.agent.outputRef}
					lifecycle={replay.agent.lifecycle}
					subtitle={`${activityText(replay.step.title)} · ${replay.label}`}
					onClose={() => setReplayRef(null)}
				/>
			)}
			<ConfirmDialog
				open={confirming !== null}
				title={confirming ? activityText(confirming.label) : ""}
				description={confirming?.impact ? activityText(confirming.impact) : uiText("goals.goalactivitypanel.confirmThisChange")}
				confirmLabel={uiText("common.confirm")}
				onCancel={() => setConfirming(null)}
				onConfirm={async () => {
					const action = confirming;
					setConfirming(null);
					if (action) await sendAction(action);
				}}
				testId="activity-action-dialog"
			/>
		</div>
	);
}

interface RecordedAgent {
	agent: AgentActivity;
	name: string;
	index: number;
	label: string;
}

/** A Step's Agent Activities that have an execution record, numbered when there are several. */
function recordedAgents(step: ActivityStep): RecordedAgent[] {
	const agents = step.agentActivities.filter((agent) => agent.outputRef);
	return agents.map((agent, index) => {
		const name = agentLabel(agent.agentName);
		return { agent, name, index: index + 1, label: agents.length > 1 ? `${name} ${index + 1}` : name };
	});
}

export function findAgentActivity(
	steps: ActivityStep[],
	outputRef: string,
): RecordedAgent & { step: ActivityStep } | undefined {
	for (const step of steps) {
		const recorded = recordedAgents(step).find(({ agent }) => agent.outputRef === outputRef);
		if (recorded) return { ...recorded, step };
		const nested = findAgentActivity(step.parallelSteps, outputRef);
		if (nested) return nested;
	}
	return undefined;
}

function ActivityStepRow({
	step,
	now,
	live,
	onOpen,
}: {
	step: ActivityStep;
	now: number;
	live: boolean;
	onOpen?: (outputRef: string) => void;
}) {
	const { t, i18n } = useTranslation();
	const agents = onOpen ? recordedAgents(step) : [];
	const title = activityText(step.title);
	const summary = providerAccessSummary(step, now, i18n.resolvedLanguage ?? "en", t);
	const copy = (
		<>
			<StateGlyph item={step} />
			<span className="goal-activity-step-copy">
				<b>{title}</b>
				{summary && <small>{summary}</small>}
				{/* A Provider wait states its own elapsed and remaining time, so it does not take this one too. */}
				{!step.providerAccess && <RunningTimes item={step} now={now} live={live} />}
			</span>
		</>
	);
	if (onOpen && agents.length === 1) {
		return (
			<button
				type="button"
				className="goal-activity-step"
				aria-haspopup="dialog"
				aria-label={uiText("goals.goalactivitypanel.viewReplayForStepAgent", { step: title, agent: agents[0]!.name })}
				onClick={() => onOpen(agents[0]!.agent.outputRef!)}
			>
				{copy}
			</button>
		);
	}
	return (
		<div className="goal-activity-step">
			{copy}
			{onOpen && agents.length > 1 && (
				<span className="goal-activity-step-targets">
					{agents.map(({ agent, name, index, label }) => (
						<button
							key={agent.agentActivityId}
							type="button"
							aria-haspopup="dialog"
							aria-label={uiText("goals.goalactivitypanel.viewReplayForStepAgentIndex", { step: title, agent: name, index })}
							onClick={() => onOpen(agent.outputRef!)}
						>
							{label}
						</button>
					))}
				</span>
			)}
		</div>
	);
}

/**
 * How long a running Activity Step or Agent Activity has been going, and whether it has gone quiet.
 * Both read the panel's shared clock, so every row and worker card advances without a timer of its
 * own and without new backend data. This is its own line rather than a tail on the summary: a
 * worker card clips its summary to one line, which would cut the reading off with it.
 */
function RunningTimes({
	item,
	now,
	live,
}: {
	item: ActivityStateSource & { timing: ActivityTiming };
	now: number;
	live: boolean;
}) {
	if (!live || item.lifecycle !== "running") return null;
	const times = [elapsedLabel(item.timing, now), quietLabel(item.timing, now)].filter(Boolean).join(" · ");
	return times ? <span className="goal-activity-times">{times}</span> : null;
}

function providerAccessSummary(
	step: ActivityStep,
	now: number,
	locale: string,
	t: TFunction,
): string {
	const status = step.providerAccess;
	if (!status) return activityText(step.summary);
	if (status.kind === "recovered") return t("goalActivity.providerRecovered", { provider: providerDisplayLabel(status.providerId) });
	if (status.kind === "cooling" && step.lifecycle === "finished") return t("goalActivity.providerWaitEnded", { provider: providerDisplayLabel(status.providerId) });
	if (status.kind === "cooling") {
		const started = Date.parse(status.waitStartedAt ?? step.timing.createdAt);
		const deadline = Date.parse(status.budgetDeadlineAt ?? step.timing.updatedAt);
		const nextAttempt = Date.parse(status.nextAttemptAt ?? step.timing.updatedAt);
		return t("goalActivity.providerCooling", {
			failure: providerFailureLabel(status.failureClass, t),
			elapsed: durationLabel(Math.max(0, now - started), t),
			remaining: durationLabel(Math.max(0, deadline - now), t),
			next: new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(nextAttempt),
		});
	}
	if (status.kind === "unavailable") {
		return t("goalActivity.providerUnavailable", {
			provider: providerDisplayLabel(status.providerId),
			reason: providerReasonLabel(status.reason, t),
		});
	}
	const fallbackKey = status.fallbackOutcome === "succeeded"
		? "goalActivity.providerFallback.succeeded"
		: status.fallbackOutcome === "uncovered"
			? "goalActivity.providerFallback.uncovered"
			: "goalActivity.providerFallback.running";
	return t(fallbackKey, {
		provider: providerDisplayLabel(status.providerId),
		from: providerDisplayLabel(status.fromProviderId ?? "arxiv"),
	});
}

function durationLabel(milliseconds: number, t: TFunction): string {
	return t("goalActivity.seconds", { count: Math.ceil(milliseconds / 1_000) });
}

function providerDisplayLabel(providerId: string): string {
	if (providerId === "arxiv") return "arXiv";
	if (providerId === "huggingface") return "Hugging Face Papers";
	return providerId;
}

function providerFailureLabel(failure: string | undefined, t: TFunction): string {
	return t(failure === "rate_limit" ? "goalActivity.providerFailure.rateLimit" : "goalActivity.providerFailure.upstream");
}

function providerReasonLabel(reason: string | undefined, t: TFunction): string {
	if (reason === "retry_after_exceeds_budget") return t("goalActivity.providerReason.retryAfterExceedsBudget");
	if (reason === "budget_exhausted") return t("goalActivity.providerReason.budgetExhausted");
	return t("goalActivity.providerReason.retryExhausted");
}

function ActivityWorkerPool({
	label,
	workers,
	now,
	live,
	onOpen,
}: {
	label: ActivityText;
	workers: ActivityWorker[];
	now: number;
	live: boolean;
	onOpen?: (outputRef: string) => void;
}) {
	const [showAll, setShowAll] = useState(false);
	const states = workers.map((worker) => activityState(worker.agent));
	const count = (...wanted: string[]) => states.filter((state) => wanted.includes(state)).length;
	const active = workers.filter((_, index) => states[index] !== "succeeded" && states[index] !== "quiet");
	const completed = workers.filter((worker) => !active.includes(worker));
	const visibleIds = new Set([
		...active,
		...completed.slice(completed.length - Math.max(0, 4 - active.length)),
	].map((worker) => worker.agent.agentActivityId));
	const visible = showAll ? workers : workers.filter((worker) => visibleIds.has(worker.agent.agentActivityId));
	const hidden = workers.length - visible.length;
	const running = count("running");
	const waiting = count("waiting");
	const failed = count("failed", "attention");
	const done = completed.length;
	const counts = [
		running > 0 && uiText("goals.goalactivitypanel.countRunning", { count: running }),
		waiting > 0 && uiText("goals.goalactivitypanel.countWaiting", { count: waiting }),
		done > 0 && uiText("goals.goalactivitypanel.countCompleted", { count: done }),
		failed > 0 && uiText("goals.goalactivitypanel.countFailed", { count: failed }),
	].filter(Boolean).join(" · ");
	const poolLabel = activityText(label);
	return (
		<section className="goal-activity-worker-pool" data-testid="activity-worker-pool" aria-label={poolLabel}>
			<header className="goal-activity-worker-pool-head">
				<b>{poolLabel}</b>
				<span>{counts}</span>
			</header>
			<div className="goal-activity-worker-grid">
				{visible.map((worker) => {
					const workerTitle = activityText(worker.title);
					const content = (
						<>
							<StateGlyph item={worker.agent} />
							<span>
								<b>{workerTitle}</b>
								<small>{activityText(worker.agent.summary) || activityText(worker.summary)}</small>
								{/* Each card carries its own Agent Activity timing: one quiet Cornell Note in a
								    pool says so on its own card, whatever its siblings are doing. */}
								<RunningTimes item={worker.agent} now={now} live={live} />
							</span>
						</>
					);
					return onOpen && worker.agent.outputRef ? (
						<button
							key={worker.agent.agentActivityId}
							type="button"
							className="goal-activity-worker"
							data-testid="activity-worker-row"
							aria-haspopup="dialog"
							aria-label={uiText("goals.goalactivitypanel.viewReplayForWorker", { worker: workerTitle, agent: agentLabel(worker.agent.agentName) })}
							onClick={() => onOpen(worker.agent.outputRef!)}
						>
							{content}
						</button>
					) : (
						<div key={worker.agent.agentActivityId} className="goal-activity-worker" data-testid="activity-worker-row">
							{content}
						</div>
					);
				})}
			</div>
			{(hidden > 0 || showAll) && (
				<button
					type="button"
					className="goal-activity-worker-pool-toggle"
					aria-expanded={showAll}
					onClick={() => setShowAll((value) => !value)}
				>
					{showAll ? uiText("goals.goalactivitypanel.collapse") : uiText("goals.goalactivitypanel.viewAllCount", { count: workers.length })}
				</button>
			)}
		</section>
	);
}

function StateGlyph({ item }: { item: ActivityStateSource }) {
	const state = activityState(item);
	return (
		<span className="goal-activity-glyph-slot">
			<i className={cn("activity-glyph", `is-${state}`)} role="img" aria-label={uiText(activityStateLabel(item))} />
		</span>
	);
}

/** Loads an Agent Activity's execution record into an overlay, refreshing every 2 seconds while it runs. */
function ActivityReplay({
	goalId,
	outputRef,
	lifecycle,
	subtitle,
	onClose,
}: {
	goalId: string;
	outputRef: string;
	lifecycle: ActivityLifecycle;
	subtitle: string;
	onClose: () => void;
}) {
	const [output, setOutput] = useState<ActivityOutput | null>(null);
	const [error, setError] = useState<string | null>(null);
	useEffect(() => {
		let active = true;
		const load = async () => {
			try {
				const next = await fetchActivityOutput(goalId, outputRef);
				if (active) {
					setOutput(next);
					setError(null);
				}
			} catch (cause) {
				if (active) setError(cause instanceof Error ? cause.message : String(cause));
			}
		};
		void load();
		const refresh = lifecycle === "running" ? window.setInterval(() => void load(), 2_000) : undefined;
		return () => {
			active = false;
			if (refresh !== undefined) window.clearInterval(refresh);
		};
	}, [goalId, lifecycle, outputRef]);
	const loadLine = useCallback(
		async (ref: string) => (await fetchActivityOutput(goalId, outputRef, ref)).lines[0] ?? null,
		[goalId, outputRef],
	);
	return (
		<Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
			<DialogContent
				showCloseButton={false}
				aria-describedby={undefined}
				overlayClassName="bg-[color-mix(in_oklch,var(--foreground)_32%,transparent)]"
				className="goal-activity-replay"
				data-testid="activity-replay-overlay"
			>
				<ActivityReplayContent subtitle={subtitle} output={output} error={error} onClose={onClose} loadLine={loadLine} />
			</DialogContent>
		</Dialog>
	);
}

/**
 * The execution record overlay's content; tool calls and Agent output open their own overlays on top.
 * Lines from several Agent sessions sit under their session's header, and a truncated line loads in
 * full when its details open.
 */
export function ActivityReplayContent({
	subtitle,
	output,
	error,
	onClose,
	loadLine,
}: {
	subtitle: string;
	output: ActivityOutput | null;
	error: string | null;
	onClose: () => void;
	/** Reads one truncated line in full; without it the details overlay shows the list preview. */
	loadLine?: (ref: string) => Promise<ActivityOutputLine | null>;
}) {
	const [selected, setSelected] = useState<{ item: ActivityItem; line: ActivityOutputLine } | null>(null);
	const [full, setFull] = useState<{ ref: string; item?: ActivityItem; error?: string } | null>(null);
	const rows = useMemo(() => {
		if (!output) return [];
		const items = activityOutputItems(output);
		// Lines of a delegated child session indent under the Root that delegated to it.
		return output.lines.map((line, index) => ({ line, item: { ...items[index]!, depth: line.sectionDepth ?? 0 } }));
	}, [output]);
	const sections = useMemo(() => sectionSummaries(rows.map((row) => row.line)), [rows]);
	const models = sections.length ? [] : distinctModels(rows.map((row) => row.line));
	// Delegated child sessions start collapsed so the Root's own narrative reads as an overview.
	const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
	const collapsedRows = useMemo(() => {
		const hidden = new Set<number>();
		for (const section of sections) {
			if (section.depth === 0 || expanded.has(section.key)) continue;
			for (let index = section.start + 1; index < section.end; index += 1) hidden.add(index);
		}
		return hidden;
	}, [sections, expanded]);
	const toggle = (key: string) => setExpanded((current) => {
		const next = new Set(current);
		if (!next.delete(key)) next.add(key);
		return next;
	});
	useEffect(() => {
		const ref = selected?.line.truncated ? selected.line.ref : undefined;
		if (!ref || !loadLine) return;
		let active = true;
		loadLine(ref).then(
			(line) => {
				if (active) setFull(line ? { ref, item: activityOutputLineItem(line) } : { ref, error: uiText("goals.goalactivitypanel.fullContentUnavailable") });
			},
			(cause) => {
				if (active) setFull({ ref, error: cause instanceof Error ? cause.message : String(cause) });
			},
		);
		return () => {
			active = false;
		};
	}, [selected, loadLine]);
	const loaded = selected && full?.ref === selected.line.ref ? full : undefined;
	const detail = loaded?.item ?? selected?.item;
	// Until the full line arrives, say so instead of passing the list preview off as the whole content.
	const loadingFull = Boolean(selected?.line.truncated && loadLine && !loaded);
	return (
		<>
			<header className="goal-activity-replay-head">
				<div>
					<DialogTitle>{uiText("goals.goalactivitypanel.executionRecord")}</DialogTitle>
					<small title={subtitle}>
						{subtitle}{rows.length ? ` · ${uiText("goalActivity.items", { count: rows.length })}` : ""}
						{models.length > 0 && <> · <code className="goal-activity-replay-model">{models.join(" / ")}</code></>}
					</small>
				</div>
				<button type="button" aria-label={uiText("common.close")} onClick={onClose}>
					<X size={14} aria-hidden />
				</button>
			</header>
			<div className="goal-activity-replay-body" aria-live="polite">
				{error ? (
					<p role="alert">{error}</p>
				) : !output ? (
					<p>{uiText("goals.goalactivitypanel.loadingReplay")}</p>
				) : rows.length === 0 ? (
					<p>{uiText("goals.goalactivitypanel.replayEmpty")}</p>
				) : rows.map(({ line, item }, index) => {
					const openable = item.type === "tool" || item.type === "intermediate";
					const section = sections.find((candidate) => candidate.start === index);
					const open = section ? section.depth === 0 || expanded.has(section.key) : true;
					const header = section && (
						<>
							<span>{section.label}</span>
							{section.models.length > 0 && <code className="goal-activity-replay-model">{section.models.join(" / ")}</code>}
							{section.depth > 0 && <small>{uiText("goalActivity.items", { count: section.end - section.start })}</small>}
						</>
					);
					return (
						<Fragment key={item.id}>
							{section && section.depth > 0 ? (
								<button
									type="button"
									className="goal-activity-replay-section"
									data-depth={section.depth}
									aria-expanded={open}
									title={section.label}
									onClick={() => toggle(section.key)}
								>
									{header}
								</button>
							) : section && (
								<div className="goal-activity-replay-section" data-depth={section.depth} title={section.label}>{header}</div>
							)}
							{!collapsedRows.has(index) && open && (
								<ActivityRow
									activity={item}
									displayMode="detailed"
									onOpenDetails={openable ? () => setSelected({ item, line }) : undefined}
								/>
							)}
						</Fragment>
					);
				})}
			</div>
			{detail?.type === "tool" && (
				<GenericOverlay
					open
					onClose={() => setSelected(null)}
					toolName={detail.toolName || uiText("goals.goalactivitypanel.tool")}
					input={detail.toolInput}
					output={loadingFull ? uiText("goals.goalactivitypanel.loadingFullContent") : activityToolOutput(detail)}
					outputDetails={loadingFull ? undefined : activityToolDetails(detail)}
					error={loaded?.error ?? detail.error}
				/>
			)}
			{detail?.type === "intermediate" && (
				<MarkdownOverlay
					open
					onClose={() => setSelected(null)}
					title={uiText("goals.goalactivitypanel.agentOutput")}
					content={loadingFull ? uiText("goals.goalactivitypanel.loadingFullContent") : detail.content || ""}
					error={loaded?.error}
				/>
			)}
		</>
	);
}

/** A run of lines from one Agent session: `start` is its header row, `end` the first row after it. */
interface ReplaySection { key: string; start: number; end: number; label: string; depth: number; models: string[] }

/** One header per run of lines from the same Agent session, with its nesting depth and the models it called. */
function sectionSummaries(lines: ActivityOutputLine[]): ReplaySection[] {
	const sections: ReplaySection[] = [];
	lines.forEach((line, index) => {
		const current = sections.at(-1);
		if (current) current.end = index;
		if (!line.section) return;
		if (current && current.label === line.section && lines[index - 1]?.section === line.section) {
			current.end = index + 1;
			if (line.model && !current.models.includes(line.model)) current.models.push(line.model);
			return;
		}
		// The line ref names the session, so the same session stays expanded while a running record grows.
		const key = line.ref?.split("#")[0] || `${line.section}@${index}`;
		sections.push({ key, start: index, end: index + 1, label: line.section, depth: line.sectionDepth ?? 0, models: line.model ? [line.model] : [] });
	});
	return sections;
}

function distinctModels(lines: ActivityOutputLine[]): string[] {
	return [...new Set(lines.flatMap((line) => line.model ? [line.model] : []))];
}

function activityToolDetails(activity: ActivityItem): unknown {
	return (activity.toolResult as { details?: unknown } | undefined)?.details;
}

function activityToolOutput(activity: ActivityItem): string | undefined {
	const result = activity.toolResult as { content?: Array<{ type?: string; text?: string }> } | undefined;
	return result?.content?.filter((part) => part.type === "text").map((part) => part.text || "").join("\n");
}

function LiveAgentStages({
	item,
	outputs,
}: {
	item: ActivityProjectionItem;
	outputs: ResearchAgentOutput[];
}) {
	const running = outputs.filter((output) => output.status === "running");
	const projected = item.steps.flatMap((step) => step.agentActivities)
		.filter((agent) => agent.lifecycle === "running")
		.map((agent) => ({ role: agent.agentName, text: activityText(agent.summary) }));
	const rows = running.length
		? running.map((output) => ({ role: output.role, text: liveAgentText(output) }))
		: projected.length ? projected : [{ role: "research", text: activityText(item.summary) }];
	return (
		<div className="goal-activity-live-stages" aria-live="polite">
			{rows.map((row, index) => (
				<div key={`${row.role}:${index}`} className="goal-activity-live-stage" data-testid="live-agent-stage">
					<Spinner className="text-[9px]" />
					<b>{agentLabel(row.role)}</b>
					<span>{row.text}</span>
				</div>
			))}
		</div>
	);
}

function liveAgentText(output: ResearchAgentOutput): string {
	const text = output.text?.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean).at(-1);
	if (output.toolName) {
		const tool = uiText("goals.goalactivitypanel.usingTool", { tool: humanizeAgentName(output.toolName) });
		return text ? `${tool} · ${text}`.slice(0, 240) : tool;
	}
	if (text) return text.slice(0, 240);
	return uiText("goals.goalactivitypanel.running");
}

function agentLabel(role: string): string {
	const labels: Record<string, string> = {
		prime_search: "Prime Search",
		cornell_note: "Cornell Note",
		report_writer: "Report Writer",
		wiki_maintainer: "Wiki Maintainer",
		research: "Research",
	};
	return labels[role] ?? humanizeAgentName(role);
}

function humanizeAgentName(value: string): string {
	return value.replaceAll("_", " ").replaceAll("-", " ")
		.replace(/\b\w/gu, (letter) => letter.toUpperCase());
}
