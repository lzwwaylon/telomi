import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
	MoreHorizontal,
	PanelLeftClose,
	PanelLeftOpen,
	RefreshCcw,
	Trash2,
} from "lucide-react";
import { HomeIcon, PencilIcon as Pencil, PlusIcon as Plus } from "@/shared/ui/icons";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/shared/ui/dropdown-menu";
import type { GoalSummary } from "@shared/types";
import { cn } from "@/shared/lib/utils";
import { useRailPinned } from "@/shared/lib/use-rail-pinned";
import { GoalAvatar } from "@/features/goals/GoalAvatar";
import { goalAvatarSignals, type GoalAvatarSignals } from "@/features/goals/avatar-signals";
import type { GlobalActivityProjectionSummary } from "@shared/events/activity-projection";
import { useTranslation } from "react-i18next";

export interface GoalRailProps {
	goals: GoalSummary[];
	route: "home" | "goal" | "chat";
	selected: string | null;
	onGoHome: () => void;
	onSelect: (id: string) => void;
	onCreateGoal: () => void;
	onRequestEdit: (goal: GoalSummary) => void;
	onRequestDelete: (goal: GoalSummary) => void;
	onRerollAvatar: (goal: GoalSummary) => void;
	activitySummary?: GlobalActivityProjectionSummary | null;
}

const COLLAPSE_DELAY_MS = 160;

export function GoalRail({
	goals,
	route,
	selected,
	onGoHome,
	onSelect,
	onCreateGoal,
	onRequestEdit,
	onRequestDelete,
	onRerollAvatar,
	activitySummary,
}: GoalRailProps) {
	const { t } = useTranslation();
	const [hovered, setHovered] = useState(false);
	const [openMenuId, setOpenMenuId] = useState<string | null>(null);
	const [pinned, setPinned] = useRailPinned();
	const closeTimer = useRef<number | null>(null);

	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "b") {
				e.preventDefault();
				setPinned((p) => !p);
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [setPinned]);

	const expanded = pinned || hovered || openMenuId !== null;
	const avatarSignals = useMemo(() => new Map(
		goals.map((goal) => [goal.id, goalAvatarSignals(activitySummary?.activities ?? [], goal.id)]),
	), [activitySummary, goals]);

	const handleEnter = useCallback(() => {
		if (closeTimer.current !== null) {
			window.clearTimeout(closeTimer.current);
			closeTimer.current = null;
		}
		setHovered(true);
	}, []);

	const handleLeave = useCallback(() => {
		if (closeTimer.current !== null) return;
		closeTimer.current = window.setTimeout(() => {
			closeTimer.current = null;
			setHovered(false);
		}, COLLAPSE_DELAY_MS);
	}, []);

	useEffect(() => {
		return () => {
			if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
		};
	}, []);

	const handleMenuOpenChange = useCallback((id: string, next: boolean) => {
		setOpenMenuId((cur) => {
			if (next) return id;
			return cur === id ? null : cur;
		});
	}, []);

	return (
		<nav
			className={cn("app-rail", expanded && "is-open")}
			data-pinned={pinned ? "true" : undefined}
			aria-label={t("goals.navigation")}
			onMouseEnter={handleEnter}
			onMouseLeave={handleLeave}
			onFocusCapture={handleEnter}
			onBlurCapture={handleLeave}
		>
			<RailIconRow
				expanded={expanded}
				active={route === "home"}
				label={t("goals.home")}
				onClick={onGoHome}
				testid="rail-home"
				icon={<HomeIcon className="h-[18px] w-[18px]" aria-hidden />}
			/>
			<Divider expanded={expanded} />

			{goals.map((g) => (
				<RailGoalRow
					key={g.id}
					goal={g}
					expanded={expanded}
					active={route === "goal" && selected === g.id}
					signals={avatarSignals.get(g.id)}
					menuOpen={openMenuId === g.id}
					onMenuOpenChange={(next) => handleMenuOpenChange(g.id, next)}
					onSelect={() => onSelect(g.id)}
					onRequestEdit={() => onRequestEdit(g)}
					onRequestDelete={() => onRequestDelete(g)}
					onRerollAvatar={() => onRerollAvatar(g)}
				/>
			))}

			<Divider expanded={expanded} />

			<RailIconRow
				expanded={expanded}
				label={t("goals.newAction")}
				onClick={onCreateGoal}
				testid="rail-newgoal"
				icon={<Plus className="h-4 w-4" aria-hidden />}
			/>

			<div className="mt-auto w-full flex flex-col items-center">
				<Divider expanded={expanded} />
				<RailPinRow
					expanded={expanded}
					pinned={pinned}
					onToggle={() => setPinned((p) => !p)}
				/>
			</div>
		</nav>
	);
}

interface RailPinRowProps {
	expanded: boolean;
	pinned: boolean;
	onToggle: () => void;
}

function RailPinRow({ expanded, pinned, onToggle }: RailPinRowProps) {
	const { t } = useTranslation();
	const label = pinned ? t("goals.collapseSidebar") : t("goals.pinSidebar");
	const Icon = pinned ? PanelLeftClose : PanelLeftOpen;
	return (
		<button
			type="button"
			onClick={onToggle}
			title={!expanded ? label : undefined}
			aria-label={label}
			aria-pressed={pinned}
			data-testid="goal-rail-pin-toggle"
			className={cn(
				"relative h-11 box-border flex items-center cursor-pointer overflow-hidden",
				"transition-[width,background-color,color,padding,border-radius] duration-200",
				"text-[var(--ink-mut)]",
				expanded
					? "w-full px-2 gap-2 rounded-[10px] hover:bg-[var(--paper-2)] hover:text-[var(--ink)]"
					: "w-11 justify-center rounded-[12px] hover:bg-[var(--paper)] hover:text-[var(--ink)] hover:rounded-[14px]",
				pinned && expanded && "text-[var(--ink)]",
			)}
		>
			<span
				className={cn(
					"shrink-0 inline-flex items-center justify-center",
					expanded ? "w-[18px] h-[18px]" : "w-11 h-11",
				)}
			>
				<Icon className="h-[18px] w-[18px]" aria-hidden />
			</span>
			<span
				className={cn(
					"text-[13px] font-medium truncate min-w-0 transition-opacity duration-200",
					expanded ? "opacity-100 delay-75" : "opacity-0 w-0",
				)}
			>
				{label}
			</span>
		</button>
	);
}

function Divider({ expanded }: { expanded: boolean }) {
	return (
		<div
			aria-hidden
			className={cn(
				"h-px my-1.5 bg-[var(--line)] transition-[width] duration-200",
				expanded ? "w-full" : "w-[26px]",
			)}
		/>
	);
}

interface RailIconRowProps {
	expanded: boolean;
	active?: boolean;
	label: string;
	onClick: () => void;
	testid?: string;
	icon: React.ReactNode;
}

function RailIconRow({ expanded, active, label, onClick, testid, icon }: RailIconRowProps) {
	return (
		<button
			type="button"
			onClick={onClick}
			title={!expanded ? label : undefined}
			aria-label={label}
			aria-current={active ? "page" : undefined}
			data-testid={testid}
			className={cn(
				"relative h-11 box-border flex items-center cursor-pointer overflow-hidden",
				"transition-[width,background-color,color,padding,border-radius] duration-200",
				"text-[var(--ink-mut)]",
				expanded
					? "w-full px-2 gap-2 rounded-[10px] hover:bg-[var(--paper-2)] hover:text-[var(--ink)]"
					: "w-11 justify-center rounded-[12px] hover:bg-[var(--paper)] hover:text-[var(--ink)] hover:rounded-[14px]",
				active && expanded && "bg-[var(--paper-2)] text-[var(--ink)]",
				active && !expanded &&
					"bg-[var(--paper)] text-[var(--ink)] shadow-[0_1px_0_rgba(26,26,26,0.06),0_6px_14px_-8px_rgba(26,26,26,0.14)]",
			)}
		>
			<span
				className={cn(
					"shrink-0 inline-flex items-center justify-center",
					expanded ? "w-[18px] h-[18px]" : "w-11 h-11",
				)}
			>
				{icon}
			</span>
			<span
				className={cn(
					"text-[13px] font-medium truncate min-w-0 transition-opacity duration-200",
					expanded ? "opacity-100 delay-75" : "opacity-0 w-0",
				)}
			>
				{label}
			</span>
		</button>
	);
}

interface RailGoalRowProps {
	goal: GoalSummary;
	expanded: boolean;
	active: boolean;
	signals?: GoalAvatarSignals;
	menuOpen: boolean;
	onMenuOpenChange: (next: boolean) => void;
	onSelect: () => void;
	onRequestEdit: () => void;
	onRequestDelete: () => void;
	onRerollAvatar: () => void;
}

function RailGoalRow({
	goal,
	expanded,
	active,
	signals,
	menuOpen,
	onMenuOpenChange,
	onSelect,
	onRequestEdit,
	onRequestDelete,
	onRerollAvatar,
}: RailGoalRowProps) {
	const { t } = useTranslation();
	const title = goal.title || goal.id;

	return (
		<div
			className={cn(
				"relative h-11 box-border flex items-center overflow-hidden",
				"transition-[width,background-color,padding,border-radius] duration-200",
				expanded
					? "w-full px-2 gap-1 rounded-[10px]"
					: "w-11 justify-center rounded-[12px]",
				expanded && active && "bg-[var(--paper-2)]",
				expanded && !active && "hover:bg-[var(--paper-2)]",
				!expanded && active &&
					"bg-[var(--paper)] shadow-[0_1px_0_rgba(26,26,26,0.06),0_6px_14px_-8px_rgba(26,26,26,0.14)]",
				!expanded && "hover:bg-[var(--paper)] hover:rounded-[14px] transition-[background-color,border-radius] duration-150",
			)}
		>
			<button
				type="button"
				onClick={onSelect}
				title={!expanded ? title : undefined}
				aria-label={title}
				aria-current={active ? "page" : undefined}
				data-testid={`rail-goal-${goal.id}`}
				className={cn(
					"flex items-center cursor-pointer min-w-0 text-left",
					expanded ? "flex-1 h-full gap-2" : "w-11 h-11 justify-center",
				)}
			>
				<GoalAvatar
					goal={goal}
					isActive={active}
					signals={signals}
					size="clamp(28px, 4vh, 36px)"
					className="shrink-0"
				/>
				<span
					className={cn(
						"text-[13px] font-medium text-[var(--ink)] truncate min-w-0 transition-opacity duration-200",
						expanded ? "opacity-100 delay-75" : "opacity-0 w-0",
					)}
				>
					{title}
				</span>
			</button>
			{expanded && (
				<DropdownMenu open={menuOpen} onOpenChange={onMenuOpenChange}>
					<DropdownMenuTrigger asChild>
						<button
							type="button"
							aria-label={t("goals.moreActions", { title })}
							onClick={(e) => e.stopPropagation()}
							className={cn(
								"shrink-0 inline-flex items-center justify-center h-7 w-7 rounded-[6px]",
								"text-[var(--ink-mut)] cursor-pointer transition-colors",
								"hover:bg-[var(--paper)] hover:text-[var(--ink)]",
								"data-[state=open]:bg-[var(--paper)] data-[state=open]:text-[var(--ink)]",
								"opacity-0 transition-opacity duration-200",
								expanded && "opacity-100 delay-75",
							)}
							data-testid={`goal-rail-more-${goal.id}`}
						>
							<MoreHorizontal className="h-3.5 w-3.5" aria-hidden />
						</button>
					</DropdownMenuTrigger>
					<DropdownMenuContent
						align="end"
						side="bottom"
						sideOffset={6}
						className="min-w-[140px]"
					>
						<DropdownMenuItem
							onSelect={() => onRerollAvatar()}
							data-testid={`goal-rail-reroll-avatar-${goal.id}`}
						>
							<RefreshCcw aria-hidden />
							<span>{t("goals.rerollAvatar")}</span>
						</DropdownMenuItem>
						<DropdownMenuItem
							onSelect={() => onRequestEdit()}
							data-testid={`goal-rail-edit-${goal.id}`}
						>
							<Pencil aria-hidden />
							<span>{t("common.edit")}</span>
						</DropdownMenuItem>
						<DropdownMenuItem
							variant="destructive"
							onSelect={() => onRequestDelete()}
							data-testid={`goal-rail-delete-${goal.id}`}
						>
							<Trash2 aria-hidden />
							<span>{t("common.delete")}</span>
						</DropdownMenuItem>
					</DropdownMenuContent>
				</DropdownMenu>
			)}
		</div>
	);
}
