import type { GoalSummary } from "@shared/types";
import type { ActivityProjectionItem } from "@shared/events/activity-projection";
import { ActivityWall } from "@/features/home/ActivityWall";
import { HomeVolume } from "@/features/home/HomeVolume";
import type { BackendConnectionStatus } from "@/features/goals/data/types";
import { useTranslation } from "react-i18next";

interface HomePageProps {
	goals: GoalSummary[];
	activities: ActivityProjectionItem[];
	backendConnection: BackendConnectionStatus;
	onSelectGoal: (id: string) => void;
	onOpenArtifact: (goalId: string, name: string) => void;
}

export function HomePage({
	goals,
	activities,
	backendConnection,
	onSelectGoal,
	onOpenArtifact,
}: HomePageProps) {
	const { t } = useTranslation();
	return (
		<section className="pane home">
			<div className="home-wrap">
				<h1 className="sr-only">{t("home.title")}</h1>

				<HomeVolume onOpenArtifact={onOpenArtifact} />

				<ActivityWall
					goals={goals}
					activities={activities}
					backendConnection={backendConnection}
					onSelectGoal={onSelectGoal}
				/>
			</div>
		</section>
	);
}
