import { formatDate as formatSharedDate } from "@/shared/lib/format";
import { useEffect, useRef, useState } from "react";
import { Check, CircleAlert, Loader2, Minus } from "lucide-react";
import { ChatIcon as MessageCircle, PlusIcon as Plus, CloseIcon as X } from "@/shared/ui/icons";

import type { TopicPlan, TopicPlanProposal, TopicPlanTopic, TopicPlanVersion } from "@/features/goals/data/useTopicPlan";
import { getTopicPlanChanges } from "@shared/topic-plan-changes";
import { ResizeHandle } from "@/app/ResizeHandle";
import { currentUiLocale } from "@/app/i18n";
import { uiText } from "@/app/ui-text";

export function TopicInspector({
	open,
	plan,
	proposal,
	activating,
	error,
	versions,
	activeRevision,
	selectedTopicId,
	discoveryEnabled,
	onSelectTopic,
	onSelectRevision,
	onConfirm,
	onDiscuss,
	onResize,
	onDiscoveryEnabledChange,
	onClose,
}: {
	open: boolean;
	plan: TopicPlan;
	proposal: TopicPlanProposal | null;
	activating: boolean;
	error: string | null;
	versions: TopicPlanVersion[];
	activeRevision: string | null;
	selectedTopicId: string | null;
	discoveryEnabled: boolean;
	onSelectTopic: (topicId: string) => void;
	onSelectRevision: (revision: string) => void;
	onConfirm: () => void;
	onDiscuss: () => void;
	onResize: (deltaPx: number) => void;
	onDiscoveryEnabledChange: (enabled: boolean) => Promise<void>;
	onClose: () => void;
}) {
	const panelRef = useRef<HTMLElement>(null);
	const topic = plan.topics.find((candidate) => candidate.id === selectedTopicId) ?? plan.topics[0];
	const version = versions.find((candidate) => candidate.revision === plan.revision);
	const pending = proposal?.candidate_plan.revision === plan.revision;
	const historical = !pending && plan.revision !== activeRevision;
	const [savingDiscovery, setSavingDiscovery] = useState(false);
	const [discoveryError, setDiscoveryError] = useState<string | null>(null);
	const toggleDiscovery = async () => {
		setSavingDiscovery(true);
		setDiscoveryError(null);
		try {
			await onDiscoveryEnabledChange(!discoveryEnabled);
		} catch (error) {
			setDiscoveryError(error instanceof Error ? error.message : String(error));
		} finally {
			setSavingDiscovery(false);
		}
	};

	useEffect(() => {
		if (!open) return;
		const frame = requestAnimationFrame(() => (panelRef.current?.querySelector<HTMLElement>("select")
			?? panelRef.current?.querySelector<HTMLElement>("button"))?.focus());
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape") onClose();
		};
		document.addEventListener("keydown", onKeyDown);
		return () => {
			cancelAnimationFrame(frame);
			document.removeEventListener("keydown", onKeyDown);
		};
	}, [onClose, open]);

	if (!open || !topic) return null;
	return <>
		<button type="button" className="topic-inspector-backdrop" aria-label={uiText("goals.topicinspector.closeTopicPlan")} onClick={onClose} />
		<aside ref={panelRef} id="topic-inspector" role="dialog" aria-modal="false" aria-labelledby="topic-inspector-title" className="topic-inspector-panel">
			<ResizeHandle side="left" onResize={onResize} label={uiText("goals.topicinspector.resizeTopicPlanSidebar")} className="topic-inspector-resize" />
			<header className="flex flex-none items-start gap-3 border-b border-[var(--line)] px-5 py-3.5">
				<div className="min-w-0 flex-1">
					<h2 id="topic-inspector-title" className="text-[22px] font-semibold leading-tight">{pending ? uiText("goals.topicinspector.topicPlanDraft") : "Topic Plan"}</h2>
					<p className="mt-1 text-[11px] text-[var(--ink-faint)]">{pending ? uiText("common.pendingConfirmation") : historical ? uiText("goals.topicinspector.viewingHistory") : uiText("goals.topicinspector.active")}</p>
				</div>
				<button type="button" onClick={onClose} aria-label={uiText("goals.topicinspector.closeTopicPlan")} className="topic-inspector-close grid h-8 w-8 flex-none place-items-center rounded-[7px] text-[var(--ink-mut)] hover:bg-[var(--paper-2)] hover:text-[var(--ink)] focus-visible:outline-2 focus-visible:outline-[var(--warm)]"><X className="h-3.5 w-3.5" aria-hidden /></button>
			</header>

			<div className="min-h-0 flex-1 overflow-y-auto px-5 pb-6 pt-3.5">
				{pending && proposal ? <PendingTopicPlan proposal={proposal} activePlan={versions.find((candidate) => candidate.revision === activeRevision)?.plan ?? null} /> : null}
				{historical ? <div className="mb-5 flex gap-2.5 border-y border-[var(--warm-line)] bg-[var(--warm-soft)] px-3 py-2.5 text-[11px] leading-5 text-[var(--ink-mut)]"><CircleAlert className="mt-0.5 h-3.5 w-3.5 flex-none text-[var(--warm-deep)]" aria-hidden /><span>{uiText("goals.topicinspector.youAreViewingAHistoricalVersionItChangesOnly")}</span></div> : null}

				{!pending ? <><div className="grid gap-4 border-b border-[var(--line)] pb-5">
					<label className="grid gap-1.5"><span className="font-mono text-[9px] font-bold uppercase tracking-[0.12em] text-[var(--ink-faint)]">{uiText("goals.topicinspector.version")}</span><select aria-label={uiText("goals.topicinspector.topicPlanVersion")} value={plan.revision} onChange={(event) => onSelectRevision(event.target.value)} className="min-h-10 w-full rounded-[6px] border border-[var(--line)] bg-[var(--paper-2)] px-3 text-[12px] font-semibold outline-none focus:border-[var(--warm)]">
						{versions.map((candidate) => <option key={candidate.revision} value={candidate.revision}>{candidate.active ? uiText("goals.topicinspector.current") : formatDate(candidate.confirmedAt)}{candidate.wikiAvailable ? " · Wiki" : ` · ${uiText("goals.topicinspector.noWiki")}`}</option>)}
					</select></label>
					{plan.topics.length > 1 ? <label className="grid gap-1.5"><span className="font-mono text-[9px] font-bold uppercase tracking-[0.12em] text-[var(--ink-faint)]">Topic</span><select aria-label="Topic" value={topic.id} onChange={(event) => onSelectTopic(event.target.value)} className="min-h-10 w-full rounded-[6px] border border-[var(--line)] bg-[var(--paper-2)] px-3 text-[12px] font-semibold outline-none focus:border-[var(--warm)]">{plan.topics.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.title}</option>)}</select></label> : null}
				</div>

				<dl className="topic-inspector-fields">
					<Field label={uiText("goals.title")}><strong>{topic.title}</strong></Field>
					<Field label={uiText("common.intent")}><p>{topic.intent}</p></Field>
					<ListField label={uiText("common.questions")} values={topic.questions} icon="check" />
					<ListField label={uiText("goals.topicinspector.include")} values={topic.include} icon="plus" />
					<ListField label={uiText("common.exclude")} values={topic.exclude} icon="minus" />
					<Field label={uiText("goals.topicinspector.discovery")}><div className="flex items-center justify-between gap-4"><span>{discoveryEnabled ? uiText("goals.topicinspector.allowCornellNoteToSubmitGoalRelatedDiscoveries") : uiText("goals.topicinspector.doNotGiveCornellNoteDiscoveryCapability")}</span><button type="button" role="switch" aria-checked={discoveryEnabled} aria-label={uiText("goals.topicinspector.discovery")} disabled={savingDiscovery} onClick={() => void toggleDiscovery()} className={`relative h-7 w-12 flex-none rounded-full transition-colors ${discoveryEnabled ? "bg-[var(--warm-deep)]" : "bg-[var(--line)]"}`}><span className={`absolute left-1 top-1 h-5 w-5 rounded-full bg-white shadow transition-transform ${discoveryEnabled ? "translate-x-5" : "translate-x-0"}`} /></button></div>{discoveryError ? <p className="mt-2 text-[11px] text-[var(--destructive-text)]" role="alert">{discoveryError}</p> : null}</Field>
				</dl>

				{version && !version.wikiAvailable ? <p className="mt-5 flex gap-2 border-t border-[var(--line)] pt-4 text-[11px] leading-5 text-[var(--ink-mut)]"><CircleAlert className="mt-0.5 h-3.5 w-3.5 flex-none text-[var(--warm-deep)]" aria-hidden />{uiText("goals.topicinspector.thisTopicPlanVersionHasNoWikiEditionTo")}</p> : null}
				</> : null}
			</div>
			<footer className="topic-inspector-footer flex flex-none flex-wrap items-center gap-3 border-t border-[var(--line)] bg-[var(--paper)] px-5 py-3">
				<div className="topic-inspector-footer-copy min-w-0">
					<p className="text-[11px] font-semibold text-[var(--ink)]">{pending ? uiText("goals.topicinspector.wantToAdjustThisDraft") : uiText("goals.topicinspector.needToChangeTheFocus")}</p>
					<p className="mt-0.5 text-[9px] leading-4 text-[var(--ink-faint)]">{uiText("goals.topicinspector.tellTheMainAgentWhichTopicsToSplitMerge")}</p>
					{error ? <p className="mt-2 text-[11px] text-[var(--destructive-text)]" role="alert">{error}</p> : null}
				</div>
				<div className="topic-inspector-footer-actions">
					<button type="button" onClick={onDiscuss} className="topic-inspector-discuss inline-flex min-h-9 flex-none items-center gap-1.5 rounded-[7px] border border-[var(--line)] bg-[var(--paper-2)] px-3 text-[10px] font-bold text-[var(--ink)] hover:border-[var(--warm-line)] focus-visible:outline-2 focus-visible:outline-[var(--warm)] focus-visible:outline-offset-2">
						<MessageCircle className="h-3.5 w-3.5 text-[var(--warm-deep)]" aria-hidden />{uiText("goals.topicinspector.discussChangesWithTheMainAgent")}
					</button>
					{pending ? <button type="button" disabled={activating} onClick={onConfirm} className="inline-flex min-h-9 flex-none items-center gap-2 rounded-[7px] bg-[var(--warm-deep)] px-3 text-[10px] font-bold text-[var(--paper)] transition-[transform,opacity] hover:-translate-y-0.5 disabled:cursor-wait disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-[var(--warm)] focus-visible:outline-offset-2">
						{activating ? <><Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />{uiText("common.confirming")}</> : uiText("goals.topicinspector.confirmAndActivate")}
					</button> : null}
				</div>
			</footer>
		</aside>
	</>;
}

function PendingTopicPlan({ proposal, activePlan }: { proposal: TopicPlanProposal; activePlan: TopicPlan | null }) {
	const changes = getTopicPlanChanges(activePlan?.topics ?? [], proposal.candidate_plan.topics);
	const groups = [
		{ topics: changes.added, label: uiText("goals.topicinspector.addedTopics", { count: changes.added.length }) },
		{ topics: changes.updated, label: uiText("goals.topicinspector.updatedTopics", { count: changes.updated.length }) },
		{ topics: changes.removed, label: uiText("goals.topicinspector.removedTopics", { count: changes.removed.length }) },
	].filter((group) => group.topics.length);
	return <section data-testid="topic-plan-pending-review" aria-labelledby="topic-plan-pending-title">
		<div className="mb-4 border-y border-[var(--warm-line)] bg-[var(--warm-soft)] px-3 py-2.5">
			<div className="flex items-center gap-2 text-[var(--warm-deep)]">
				<CircleAlert className="h-4 w-4" aria-hidden />
				<strong id="topic-plan-pending-title" className="text-[13px] font-semibold">{uiText("goals.topicinspector.draftAwaitingConfirmation")}</strong>
			</div>
			{activePlan ? <div className="mt-2 grid gap-1.5 text-[12px] leading-5 text-[var(--ink)]">
				{groups.map((group) => <p key={group.label}><strong>{group.label}</strong><span className="ml-2">{group.topics.map((topic) => topic.title).join(currentUiLocale() === "zh-CN" ? "、" : ", ")}</span></p>)}
				{changes.reordered ? <p>{uiText("goals.topicinspector.reorderedTopics")}</p> : null}
				{!groups.length && !changes.reordered ? <p>{uiText("goals.topicinspector.noTopicChanges")}</p> : null}
			</div> : <p className="mt-1.5 text-[12px] leading-5 text-[var(--ink)]">{uiText("goals.topicinspector.initialTopics", { count: proposal.candidate_plan.topics.length })}</p>}
		</div>

		<ol className="m-0 grid list-none gap-5 p-0">
			{proposal.candidate_plan.topics.map((topic, index) => <PendingTopic key={topic.id} topic={topic} index={index} />)}
		</ol>
	</section>;
}

function PendingTopic({ topic, index }: { topic: TopicPlanTopic; index: number }) {
	return <li className="relative border-t border-[var(--line)] pt-3.5 first:border-t-0 first:pt-0">
		<header className="grid grid-cols-[26px_minmax(0,1fr)] gap-2.5">
			<span className="pt-0.5 font-mono text-[9px] font-bold tracking-[0.12em] text-[var(--warm-deep)]">{String(index + 1).padStart(2, "0")}</span>
			<div>
				<h3 className="text-[15px] font-semibold leading-6 text-[var(--ink)]">{topic.title}</h3>
				<p className="mt-0.5 text-[10.5px] leading-[1.55] text-[var(--ink-mut)]">{topic.intent}</p>
			</div>
		</header>
		<dl className="ml-9 mt-2.5 grid gap-2">
			<CompactList label={uiText("common.questions")} values={topic.questions} />
			<CompactList label={uiText("goals.topicinspector.include")} values={topic.include} />
			<CompactList label={uiText("common.exclude")} values={topic.exclude} destructive />
		</dl>
	</li>;
}

function CompactList({ label, values, destructive = false }: {
	label: string;
	values: string[];
	destructive?: boolean;
}) {
	if (!values.length) return null;
	return <div className="grid grid-cols-[64px_minmax(0,1fr)] gap-2 border-t border-[var(--line-soft)] pt-2 first:border-t-0 first:pt-0">
		<dt className="font-mono text-[8px] font-bold uppercase tracking-[0.11em] text-[var(--ink-faint)]">{label}</dt>
		<dd className="m-0 text-[9.5px] leading-[1.55] text-[var(--ink)]"><ul className="m-0 grid gap-0.5 pl-3.5">{values.map((value) => <li key={value} className={destructive ? "text-[var(--destructive-text)]" : undefined}>{value}</li>)}</ul></dd>
	</div>;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
	return <div className="grid gap-2 border-b border-[var(--line-soft)] py-5"><dt className="font-mono text-[9px] font-bold uppercase tracking-[0.13em] text-[var(--ink-faint)]">{label}</dt><dd className="m-0 text-[13px] leading-6 text-[var(--ink)]">{children}</dd></div>;
}

function ListField({ label, values, icon }: { label: string; values: string[]; icon: "check" | "plus" | "minus" }) {
	if (!values.length) return null;
	return <Field label={label}><ul className="m-0 grid list-none gap-2 p-0">{values.map((value, index) => <li key={`${value}:${index}`} className="grid grid-cols-[16px_minmax(0,1fr)] gap-2.5"><span className={icon === "minus" ? "text-[var(--destructive-text)]" : "text-[var(--warm-deep)]"}>{icon === "plus" ? <Plus className="mt-1 h-3.5 w-3.5" aria-hidden /> : icon === "minus" ? <Minus className="mt-1 h-3.5 w-3.5" aria-hidden /> : <Check className="mt-1 h-3.5 w-3.5" aria-hidden />}</span><span>{value}</span></li>)}</ul></Field>;
}

function formatDate(value: string): string {
	const date = new Date(value);
	return Number.isNaN(date.getTime()) ? uiText("common.history") : formatSharedDate(date, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }, currentUiLocale());
}
