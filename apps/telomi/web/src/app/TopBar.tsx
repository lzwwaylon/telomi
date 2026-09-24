import { useEffect, useRef, useState } from "react";
import { BookIcon as BookOpenText, TopicPlanIcon as ListTree, SearchIcon as Search, SettingsIcon, ArrowLeftIcon as ArrowLeft } from "@/shared/ui/icons";
import { PulseBand } from "@/features/home/PulseBand";
import { ActivityDropdown } from "@/features/home/ActivityDropdown";
import { NotificationBell } from "@/features/home/NotificationBell";
import { BrowserHub } from "@/features/goals/BrowserMonitor";
import { cn } from "@/shared/lib/utils";
import type { GoalSnapshot, GoalSummary } from "@shared/types";
import type { BackendConnectionStatus } from "@/features/goals/data/types";
import type { GlobalActivityProjectionSummary } from "@shared/events/activity-projection";
import type { TopicPlan, TopicPlanProposal } from "@/features/goals/data/useTopicPlan";
import { useTranslation } from "react-i18next";
import type { SettingsSection } from "@/features/settings/settings-sections";

export interface TopBarProps {
	route: "home" | "goal" | "chat" | "wiki";
	goals: GoalSummary[];
	selectedGoal: GoalSummary | null;
	snapshot: GoalSnapshot | null;
	activitySummary?: GlobalActivityProjectionSummary | null;
	backendConnection: BackendConnectionStatus;
	topicPlan: TopicPlan | null;
	topicProposal: TopicPlanProposal | null;
	topicOpen: boolean;
	onGoHome: () => void;
	onOpenPalette: () => void;
	onOpenSettings: (section?: SettingsSection) => void;
	onOpenWiki?: () => void;
	onTopicOpenChange: (open: boolean) => void;
	onSelectGoal: (goalId: string) => void;
	onLeaveChat?: () => void;
}

export function TopBar({
	route,
	goals,
	selectedGoal,
	snapshot,
	activitySummary = null,
	backendConnection,
	topicPlan,
	topicProposal,
	topicOpen,
	onGoHome,
	onOpenPalette,
	onOpenSettings,
	onOpenWiki,
	onTopicOpenChange,
	onSelectGoal,
	onLeaveChat,
}: TopBarProps) {
	const { t } = useTranslation();
	const [activityOpen, setActivityOpen] = useState(false);
	const pulseWrapRef = useRef<HTMLDivElement>(null);
	const focusGoalId = route === "goal" || route === "chat" || route === "wiki" ? selectedGoal?.id ?? null : null;
	const pulseRoute = route === "wiki" ? "goal" : route;
	const topicGenerating = Boolean(selectedGoal && !topicPlan && (
		selectedGoal.fresh || selectedGoal.isStreaming || snapshot?.isStreaming
	));
	const openActivity = () => {
		const onlyGoal = activitySummary?.goals.length === 1 ? activitySummary.goals[0] : null;
		if (onlyGoal && onlyGoal.goalId === focusGoalId && route === "goal") {
			document.querySelector('[data-testid="goal-activity-panel"]')?.scrollIntoView({
				behavior: "smooth",
				block: "start",
			});
			return;
		}
		setActivityOpen((open) => !open);
	};

	useEffect(() => {
		if (!activityOpen) return;
		const onPointerDown = (event: PointerEvent) => {
			const target = event.target;
			if (target instanceof Node && pulseWrapRef.current?.contains(target)) return;
			setActivityOpen(false);
		};
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape") setActivityOpen(false);
		};
		document.addEventListener("pointerdown", onPointerDown);
		document.addEventListener("keydown", onKeyDown);
		return () => {
			document.removeEventListener("pointerdown", onPointerDown);
			document.removeEventListener("keydown", onKeyDown);
		};
	}, [activityOpen]);

	useEffect(() => onTopicOpenChange(false), [onTopicOpenChange, selectedGoal?.id]);
	useEffect(() => {
		if (!topicProposal) return;
		const openProposal = () => {
			if (window.location.hash === "#topic-plan-proposal") onTopicOpenChange(true);
		};
		openProposal();
		window.addEventListener("hashchange", openProposal);
		return () => window.removeEventListener("hashchange", openProposal);
	}, [onTopicOpenChange, route, selectedGoal?.id, topicProposal]);

	return (
		<header className="app-topbar" aria-label={t("topbar.navigation")}>
			<div
				className="mr-4 flex flex-none items-center gap-2"
				style={route === "chat" ? undefined : { minWidth: "calc(var(--rail-w) - 20px)" }}
			>
				{(route === "chat" || route === "wiki") && selectedGoal && onLeaveChat && (
					<button
						type="button"
						onClick={onLeaveChat}
						aria-label={route === "wiki" ? t("topbar.backFromWiki") : t("topbar.backToGoal")}
						title={route === "wiki" ? t("topbar.backFromWiki") : t("topbar.backToGoal")}
						data-testid="topbar-back-goal"
						className="inline-flex h-8 w-8 items-center justify-center rounded-[8px] text-[var(--ink-mut)] transition-[background-color,color,transform] duration-150 hover:-translate-x-0.5 hover:bg-[var(--paper-2)] hover:text-[var(--ink)] focus-visible:outline-2 focus-visible:outline-[var(--ring)] focus-visible:outline-offset-2"
					>
						<ArrowLeft className="h-4 w-4" aria-hidden />
					</button>
				)}
				{route !== "chat" && route !== "wiki" && (
					<button
						type="button"
						onClick={onGoHome}
						aria-label={t("topbar.home")}
						title={t("topbar.home")}
						className="flex items-center gap-2 cursor-pointer whitespace-nowrap"
					>
						<span
							aria-hidden="true"
							className="h-[28px] w-[28px] shrink-0 bg-[var(--ink)]"
							style={{
								mask: "url('/telomi-logo.svg') center / contain no-repeat",
								WebkitMask: "url('/telomi-logo.svg') center / contain no-repeat",
							}}
						/>
						<span
							className="font-medium text-[16px] tracking-[-0.01em] text-[var(--ink)]"
							style={{ fontFamily: "var(--f-serif)" }}
						>
							Telomi
						</span>
					</button>
				)}
			</div>

			<div className="topbar-pulse-wrap" ref={pulseWrapRef}>
				<PulseBand
					route={pulseRoute}
					goals={goals}
					selectedGoal={selectedGoal}
					snapshot={snapshot}
					activitySummary={activitySummary}
					backendConnection={backendConnection}
					onOpenActivity={openActivity}
				/>
				{activityOpen && (
					<ActivityDropdown
						summary={activitySummary}
						goals={goals}
						onSelectGoal={(goalId) => {
							setActivityOpen(false);
							onSelectGoal(goalId);
							window.setTimeout(() => {
								document.querySelector('[data-testid="goal-activity-panel"]')?.scrollIntoView({
									behavior: "smooth",
									block: "start",
								});
							}, 0);
						}}
					/>
				)}
			</div>

			<div className="flex items-center gap-1 ml-4 flex-none">
				<BrowserHub goals={goals} goalId={focusGoalId} />
				{selectedGoal ? (
					<TopBtn
						label={topicGenerating ? t("topbar.topicGenerating") : topicProposal ? t("topbar.topicPending") : topicPlan ? "Topic Plan" : t("topbar.topicMissing")}
						onClick={topicPlan ? () => onTopicOpenChange(!topicOpen) : undefined}
						expanded={topicOpen}
						attention={Boolean(topicProposal)}
						busy={topicGenerating}
						disabled={!topicPlan}
						testid="topbar-topic"
					>
						<ListTree className="h-4 w-4" aria-hidden />
					</TopBtn>
				) : null}
				{selectedGoal && onOpenWiki && (
					<TopBtn label={t("topbar.wiki")} onClick={onOpenWiki} active={route === "wiki"} testid="topbar-wiki">
						<BookOpenText className="h-4 w-4" aria-hidden />
					</TopBtn>
				)}
				<NotificationBell
					onOpenSettings={onOpenSettings}
				/>
				<TopBtn label={t("topbar.search")} onClick={onOpenPalette} testid="topbar-palette">
					<Search className="h-4 w-4" aria-hidden />
				</TopBtn>
				<TopBtn label={t("common.settings")} onClick={() => onOpenSettings()} testid="topbar-settings">
					<SettingsIcon className="h-4 w-4" aria-hidden />
				</TopBtn>
			</div>
		</header>
	);
}

function TopBtn({
	children,
	label,
	onClick,
	active,
	expanded,
	attention,
	busy,
	disabled,
	testid,
}: {
	children: React.ReactNode;
	label: string;
	onClick?: () => void;
	active?: boolean;
	expanded?: boolean;
	attention?: boolean;
	busy?: boolean;
	disabled?: boolean;
	testid?: string;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			title={label}
			aria-label={label}
			aria-current={active ? "page" : undefined}
			aria-expanded={expanded}
			aria-controls={expanded ? "topic-inspector" : undefined}
			aria-busy={busy || undefined}
			disabled={disabled}
			data-testid={testid}
			className={cn(
				"relative flex items-center justify-center w-8 h-8 rounded-[8px]",
				"text-[var(--ink-mut)] transition-[background-color,color] duration-150",
				!disabled && "cursor-pointer hover:bg-[var(--paper-2)] hover:text-[var(--ink)]",
				disabled && (busy ? "cursor-wait text-[var(--warm-deep)]" : "cursor-default text-[var(--ink-faint)]"),
				(active || expanded) && "bg-[var(--paper-2)] text-[var(--ink)]",
				attention && "bg-[var(--warm-soft)] text-[var(--warm-deep)] hover:bg-[var(--warm-soft)]",
			)}
		>
			{children}
			{busy ? <span
				className="topic-plan-generating-ring pointer-events-none absolute inset-[5px] animate-spin rounded-full border border-[var(--warm-line)] border-t-[var(--warm)] motion-reduce:animate-none"
				aria-hidden
			/> : null}
			{attention ? <span
				className="absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full border-2 border-[var(--paper)] bg-[var(--destructive-text)]"
				aria-hidden
			>
				<span className="absolute inset-[-3px] rounded-full bg-[var(--destructive-text)] opacity-30 animate-ping motion-reduce:hidden" />
			</span> : null}
		</button>
	);
}
