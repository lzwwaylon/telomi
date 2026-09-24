import { formatRelativeTime } from "@/shared/lib/format";
import { useNow } from "@/shared/hooks/useNow";
import { useMemo } from "react";
import type { GoalSummary } from "@shared/types";
import type { BackendConnectionStatus } from "@/features/goals/data/types";
import type { ActivityProjectionItem } from "@shared/events/activity-projection";
import { coverColor } from "@/features/home/coverColor";
import { useTranslation } from "react-i18next";
import { stripMarkdownForPill } from "@shared/strip-markdown";
import { activityText } from "@/shared/lib/activity-text";

interface ActivityWallProps {
	goals: GoalSummary[];
	activities: ActivityProjectionItem[];
	backendConnection?: BackendConnectionStatus;
	onSelectGoal: (id: string) => void;
}

interface TileData {
	goal: GoalSummary;
	running: boolean;
	dormant: boolean;
	doing: string;
	conversation: string;
	stat: string;
	tail: string[];
	weight: number;
}

const MAX_AGENT_TILES = 6;

function shortRelative(ms: number, locale: string, now: number): string {
	return ms > 0 ? formatRelativeTime(ms, locale, now) : "";
}

function dedupConsecutive(actions: string[]): string[] {
	const out: string[] = [];
	for (const a of actions) {
		if (a && a !== out[out.length - 1]) out.push(a);
	}
	return out;
}

function oneLine(value: string | undefined): string {
	return (value ?? "").replace(/\s+/g, " ").trim();
}

/** Fixed chrome resolves against the current `uiLocale` here, so a tile never keeps a stale label. */
function activityLine(value: ActivityProjectionItem["summary"]): string {
	return oneLine(activityText(value));
}

function goalId(item: ActivityProjectionItem): string | null {
	return item.scope.kind === "goal" ? item.scope.goalId : null;
}

function updatedAt(item: ActivityProjectionItem): number {
	return Date.parse(item.timing.updatedAt) || 0;
}

function compactAction(item: ActivityProjectionItem): string {
	return activityLine(item.summary) || activityLine(item.title);
}

function isUsefulHistory(item: ActivityProjectionItem): boolean {
	return item.lifecycle === "finished";
}

export function ActivityWall({
	goals,
	activities,
	backendConnection = "connected",
	onSelectGoal,
}: ActivityWallProps) {
	const { t, i18n } = useTranslation();
	const now = useNow();
	const titleById = useMemo(() => {
		const m = new Map<string, string>();
		for (const g of goals) m.set(g.id, g.title || t("home.untitled"));
		return m;
	}, [goals, t]);

	const tiles = useMemo<TileData[]>(() => {
		const byGoal = new Map<string, ActivityProjectionItem[]>();
		for (const a of activities) {
			const id = goalId(a);
			if (!id) continue;
			const arr = byGoal.get(id);
			if (arr) arr.push(a);
			else byGoal.set(id, [a]);
		}
		const built = goals.map((goal): TileData => {
			const acts = byGoal.get(goal.id) ?? [];
			const runningActs = acts.filter((a) => a.lifecycle === "running");
			const running = runningActs.length > 0;
			const usefulActs = acts.filter(isUsefulHistory);
			const primaryAct = running ? runningActs[0] : acts.find((a) => a.lifecycle !== "finished") ?? usefulActs[0];
			const restActs = running
				? usefulActs
				: usefulActs.filter((a) => a.activityId !== primaryAct?.activityId);
			const lastTs = primaryAct ? updatedAt(primaryAct) : acts[0] ? updatedAt(acts[0]) : Date.parse(goal.lastActivityAt);
			const dormant = !running && acts.length === 0;

			const doing = (primaryAct ? compactAction(primaryAct) : "") ||
				(goal.fresh ? t("activity.justActive") : t("activity.sleeping"));
			const conversation = stripMarkdownForPill(goal.pulseLine?.trim() || goal.preview);

			const stat = running ? t("activity.running") : dormant ? t("activity.idle") : shortRelative(lastTs, i18n.resolvedLanguage ?? "en", now) || t("activity.idle");

			const tail = dedupConsecutive(restActs.map(compactAction)).filter((line) => line !== doing).slice(0, 5);

			const weight = (running ? 2 : 0) + (goal.fresh ? 1 : 0);
			return { goal, running, dormant, doing, conversation, stat, tail, weight };
		});

		built.sort((a, b) => {
			if (b.weight !== a.weight) return b.weight - a.weight;
			const ta = Date.parse(a.goal.lastActivityAt) || 0;
			const tb = Date.parse(b.goal.lastActivityAt) || 0;
			return tb - ta;
		});
		return built.slice(0, MAX_AGENT_TILES);
	}, [goals, activities, i18n.resolvedLanguage, t, now]);

	const runningCount = useMemo(() => {
		return new Set(activities.filter((a) => a.lifecycle === "running").map(goalId).filter(Boolean)).size;
	}, [activities]);
	// 宽屏稀疏态(≤2 agent):瓦片做成宽幅头条,见 theme.css .wall-grid.sparse(仅 ≥901px 生效)
	const sparse = tiles.length > 0 && tiles.length <= 2;

	const ticker = useMemo(() => {
		const live = activities.filter((a) => a.lifecycle === "running").slice(0, 3);
		if (live.length === 0) return null;
		return live.map((a) => ({
			id: a.activityId,
			name: titleById.get(goalId(a) ?? "") ?? activityLine(a.title),
			action: compactAction(a),
		}));
	}, [activities, titleById, i18n.resolvedLanguage]);

	if (backendConnection !== "connected") {
		return (
			<section className="wall" data-testid="activity-wall-disconnected">
				<div className="wall-head">{t("activity.title")}</div>
				<div className="wall-empty" role="status">
					{backendConnection === "disconnected"
						? t("activity.backendDisconnected")
						: t("activity.backendConnecting")}
				</div>
			</section>
		);
	}

	if (goals.length === 0) {
		return (
			<section className="wall" data-testid="activity-wall-empty">
				<div className="wall-head">{t("activity.title")}</div>
				<div className="wall-empty">{t("activity.empty")}</div>
			</section>
		);
	}

	return (
		<section className="wall" data-testid="activity-wall">
			<div className="wall-head">
				{t("activity.title")}
				<span className="wall-count tabular-nums">{t("activity.runningGoalsCount", { count: runningCount })}</span>
			</div>

			{ticker && (
				<div className="ticker" data-testid="wall-ticker">
					<span className="pulse" aria-hidden />
					<span className="now-label">{t("activity.now")}</span>
					<span className="stream">
						{ticker.map((t, i) => (
							<span key={t.id}>
								{i > 0 && <span className="sep"> · </span>}「<b>{t.name}</b>」{t.action}
							</span>
						))}
					</span>
				</div>
			)}

			<div className={`wall-grid${sparse ? " sparse" : ""}`}>
				{tiles.map((t) => {
					const sizeClass = t.running ? "c2r2" : "c1r2";
					const cover = coverColor(t.goal.id);
					return (
						<article
							key={t.goal.id}
							className={`tile ${sizeClass}${t.dormant ? " idle" : ""}${sparse ? " lead" : ""}`}
							style={{ "--cover": cover } as React.CSSProperties}
							role="button"
							tabIndex={0}
							onClick={() => onSelectGoal(t.goal.id)}
							onKeyDown={(e) => {
								if (e.key === "Enter" || e.key === " ") {
									e.preventDefault();
									onSelectGoal(t.goal.id);
								}
							}}
							data-testid={`tile-${t.goal.id}`}
							data-running={t.running ? "" : undefined}
						>
							<div className="t-head">
								<span className="gd" aria-hidden />
								<span className="t-name">{t.goal.title || i18n.t("home.untitled")}</span>
								<span className={`t-stat${t.running ? " running" : ""}`}>{t.stat}</span>
							</div>

							<div className={`t-doing${t.dormant ? " idle" : ""}`}>{t.doing}</div>
							{t.conversation && <div className="t-conversation">{i18n.t("activity.recentConversation", { text: t.conversation })}</div>}

							{t.tail.length > 0 && (
								<div className="tail">
									{t.tail.map((line, i) => (
										<div className="tail-line" key={`${i}:${line}`}>
											{line}
										</div>
									))}
								</div>
							)}

						</article>
					);
				})}
			</div>
		</section>
	);
}
