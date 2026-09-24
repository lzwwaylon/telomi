import type { GoalSnapshot, GoalSummary } from "@shared/types";
import { GoalAvatar } from "@/features/goals/GoalAvatar";
import { useTranslation } from "react-i18next";
import type { GoalAvatarSignals } from "@/features/goals/avatar-signals";

interface GoalHeaderProps {
	goalId: string;
	goal?: GoalSummary | null;
	snapshot?: GoalSnapshot | null;
	onGoHome?: () => void;
	onTalkOrigin?: () => void;
	avatarSignals?: GoalAvatarSignals;
}

/**
 * Goal pane 顶部:身份入口 + 标题。右侧心智/调度信息放在主体辅助栏。
 */
export function GoalHeader({
	goal,
	snapshot,
	onTalkOrigin,
	avatarSignals,
}: GoalHeaderProps) {
	const { t } = useTranslation();
	const title = goal?.title ?? snapshot?.title ?? t("goal.loading");

	return (
		<div className="goal-h" data-testid="goal-header">
			<div className="goal-h-l">
				<div className="flex min-w-0 items-center gap-3">
					{goal && (
						<button
							type="button"
							onClick={onTalkOrigin}
							aria-label={t("goal.openDeeptalk")}
							title="deeptalk"
							className="flex-none rounded-full cursor-pointer transition-transform duration-150 hover:-translate-y-0.5 focus-visible:outline-2 focus-visible:outline-[var(--ring)] focus-visible:outline-offset-2"
							data-testid="goal-header-deeptalk-avatar"
						>
							<GoalAvatar goal={goal} isActive signals={avatarSignals} size={46} />
						</button>
					)}
					<h1
						className="min-w-0 truncate text-[28px] font-medium tracking-[-0.01em] text-[var(--ink)] leading-[1.15]"
						style={{ fontFamily: "var(--f-serif)" }}
						data-testid="goal-header-title"
					>
						{title}
					</h1>
				</div>
			</div>
		</div>
	);
}
