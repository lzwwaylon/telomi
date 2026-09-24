import { GoalHeader } from "@/features/goals/GoalHeader";
import { GoalProductsColumn } from "@/features/goals/GoalProductsColumn";
import { GoalResearchSchedulePanel } from "@/features/goals/GoalResearchSchedulePanel";
import { GoalActivityPanel } from "@/features/goals/GoalActivityPanel";
import type { GoalSnapshot, GoalSummary } from "@shared/types";
import { useTranslation } from "react-i18next";
import type { GoalAvatarSignals } from "@/features/goals/avatar-signals";

interface GoalWorkspaceProps {
	goalId: string;
	goal?: GoalSummary | null;
	snapshot?: GoalSnapshot | null;
	onGoHome?: () => void;
	onTalkOrigin?: () => void;
	avatarSignals?: GoalAvatarSignals;
}

export function GoalWorkspace({
	goalId,
	goal,
	snapshot,
	onGoHome,
	onTalkOrigin,
	avatarSignals,
}: GoalWorkspaceProps) {
	const { t } = useTranslation();
	return (
		<section className="pane goal" data-testid="goal-workspace">
			<div className="goal-wrap">
				<GoalHeader
					goalId={goalId}
					goal={goal}
					snapshot={snapshot}
					onGoHome={onGoHome}
					onTalkOrigin={onTalkOrigin}
					avatarSignals={avatarSignals}
				/>
				<div className="v2-grid goal-products-with-control">
					<GoalProductsColumn goalId={goalId} />
					<aside className="goal-side-stack goal-activity-side" aria-label={t("goal.activityAside")}>
						<GoalResearchSchedulePanel goalId={goalId} />
						<GoalActivityPanel goalId={goalId} snapshot={snapshot} />
					</aside>
				</div>
			</div>
		</section>
	);
}
