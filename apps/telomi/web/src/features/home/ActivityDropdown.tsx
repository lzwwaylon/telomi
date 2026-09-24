import { AlertCircle, ChevronRight, Clock3 } from "lucide-react";
import { PlayIcon as Play } from "@/shared/ui/icons";

import type { GlobalActivityProjectionSummary } from "@shared/events/activity-projection";
import type { GoalSummary } from "@shared/types";
import { uiText } from "@/app/ui-text";
import { activityText } from "@/shared/lib/activity-text";

export function ActivityDropdown({
	summary,
	goals,
	onSelectGoal,
}: {
	summary: GlobalActivityProjectionSummary | null;
	goals: GoalSummary[];
	onSelectGoal: (goalId: string) => void;
}) {
	const byId = new Map(goals.map((goal) => [goal.id, goal]));
	return (
		<div
			className="activity-popover activity-summary-popover"
			role="dialog"
			aria-label={uiText("home.activitydropdown.globalLiveActivity")}
			data-testid="activity-dropdown"
		>
			<header className="activity-popover-head">
				<div>
					<h2>{uiText("goalActivity.live")}</h2>
					<p>{uiText("home.activitydropdown.selectAGoalToViewItsFullActivityHistory")}</p>
				</div>
				<span>{uiText("home.activitydropdown.countGoals", { count: summary?.goals.length ?? 0 })}</span>
			</header>
			{!summary || summary.goals.length === 0 ? (
				<div className="activity-popover-empty">{uiText("home.activitydropdown.noActivityIsCurrentlyRunningOrNeedsAttention")}</div>
			) : (
				<div className="activity-popover-list">
					{summary.goals.map((item) => (
						<button
							key={item.goalId}
							type="button"
							className="activity-popover-row"
							onClick={() => onSelectGoal(item.goalId)}
						>
							<span className="activity-popover-kind">
								{item.summary.attention > 0
									? <AlertCircle className="h-4 w-4" aria-hidden />
									: item.summary.running > 0
										? <Play className="h-4 w-4" aria-hidden />
										: <Clock3 className="h-4 w-4" aria-hidden />}
							</span>
							<span className="activity-popover-main">
								<span className="activity-popover-topline">
									<b>{byId.get(item.goalId)?.title || item.goalId}</b>
								</span>
								<span className="activity-popover-action">
									{item.attentionSummary ? activityText(item.attentionSummary) : summaryText(item.summary)}
								</span>
							</span>
							<span className="activity-popover-status">
								{item.summary.attention > 0 && <span>{uiText("home.activitydropdown.countNeedAttention", { count: item.summary.attention })}</span>}
								{item.summary.running > 0 && <span>{uiText("home.activitydropdown.countRunning", { count: item.summary.running })}</span>}
								<ChevronRight className="h-4 w-4" aria-hidden />
							</span>
						</button>
					))}
				</div>
			)}
		</div>
	);
}

function summaryText(summary: GlobalActivityProjectionSummary["summary"]): string {
	const parts = [];
	if (summary.running) parts.push(uiText("common.countRunning", { count: summary.running }));
	if (summary.waiting) parts.push(uiText("home.activitydropdown.countWaiting", { count: summary.waiting }));
	if (summary.queued) parts.push(uiText("home.activitydropdown.countQueued", { count: summary.queued }));
	return parts.join(" · ") || uiText("home.activitydropdown.noLiveActivity");
}
