import { formatRelativeUnit, formatDate, formatRelativeTime } from "@/shared/lib/format";
import { Fragment, useMemo } from "react";
import { useNow } from "@/shared/hooks/useNow";
import { GoalDiscoveryInbox } from "@/features/goals/GoalDiscoveryInbox";
import { useGoalArtifactFiles, type ArtifactFileMeta } from "@/features/goals/data/useGoalArtifactFiles";
import { MediaCard, type MediaCardData } from "@/features/goals/MediaCard";
import { reportCoverUrl } from "@/features/goals/cover";
import { useTranslation } from "react-i18next";
import { uiText } from "@/app/ui-text";

interface GoalProductsColumnProps {
	goalId: string;
}

type DayBucket = "today" | "yesterday" | "earlier";

interface BucketGroup {
	day: DayBucket;
	label: string;
	files: ArtifactFileMeta[];
}

function startOfDay(ms: number): number {
	const d = new Date(ms);
	d.setHours(0, 0, 0, 0);
	return d.getTime();
}

function bucketize(files: ArtifactFileMeta[], locale: string, earlierLabel: string, now: number): BucketGroup[] {
	const today0 = startOfDay(now);
	const yesterday0 = today0 - 86_400_000;
	const buckets: Record<DayBucket, ArtifactFileMeta[]> = { today: [], yesterday: [], earlier: [] };
	for (const f of files) {
		if (f.mtimeMs >= today0) buckets.today.push(f);
		else if (f.mtimeMs >= yesterday0) buckets.yesterday.push(f);
		else buckets.earlier.push(f);
	}
	const yLabel = formatDate(yesterday0, { month: "short", day: "numeric" }, locale);
	const result: BucketGroup[] = [];
	if (buckets.today.length) result.push({ day: "today", label: formatRelativeUnit(0, "day", locale), files: buckets.today });
	if (buckets.yesterday.length) result.push({ day: "yesterday", label: `${formatRelativeUnit(-1, "day", locale)} · ${yLabel}`, files: buckets.yesterday });
	if (buckets.earlier.length) result.push({ day: "earlier", label: earlierLabel, files: buckets.earlier });
	return result;
}

function basenameNoExt(name: string): string {
	const base = name.split("/").pop() ?? name;
	const dot = base.lastIndexOf(".");
	return dot > 0 ? base.slice(0, dot) : base;
}


function isMarkdown(name: string): boolean {
	const ext = name.split(".").pop()?.toLowerCase() ?? "";
	return ext === "md" || ext === "markdown";
}

function mediaCardDataFromFile(file: ArtifactFileMeta, goalId: string, locale: string, now: number): MediaCardData {
	const cardId = file.cardId || basenameNoExt(file.name);
	const title = file.title || cardId;
	return {
		id: cardId,
		artifactName: file.name,
		title,
		lede: file.summary || file.name,
		heroUrl: reportCoverUrl(goalId, title, file.cover),
		updatedLabel: formatRelativeTime(file.mtimeMs, locale, now),
	};
}

/**
 * 三栏中列。telomi.html `.col-mid` 排版:day-tag → MediaCard 的纵向叠层。
 * 数据源:GET /api/goals/:id/artifacts/list (5s 轮询),只取 .md / .markdown 文件;
 * 其它产物 (mp3 / pdf / svg / podcast) 由专用 overlay / 工具区入口展示,不在中列出现。
 */
export function GoalProductsColumn({ goalId }: GoalProductsColumnProps) {
	const { t, i18n } = useTranslation();
	const locale = i18n.resolvedLanguage ?? "en";
	const { files, loading, error } = useGoalArtifactFiles(goalId);
	const now = useNow();

	const groups = useMemo(() => {
		const mds = files.filter((f) => isMarkdown(f.name) && f.product !== false);
		mds.sort((a, b) => b.mtimeMs - a.mtimeMs);
		return bucketize(mds, locale, t("goal.earlier"), now);
	}, [files, locale, now, t]);

	const empty = groups.length === 0;

	return (
		<div className="col-mid" data-testid="goal-products-column">
			<GoalDiscoveryInbox goalId={goalId} />
			{error ? (
				<div className="text-[12.5px] text-[var(--ink-faint)] py-4">{t("goal.productsLoadError", { error })}</div>
			) : empty ? (
				<div className="goal-products-empty" role="status">
					<div>
							<div className="goal-products-empty-kicker">{uiText("common.artifacts")}</div>
						<h2>{loading ? t("goal.productsLoading") : t("goal.productsEmpty")}</h2>
						<p>
							{loading
								? t("goal.productsLoadingDescription")
								: t("goal.productsEmptyDescription")}
						</p>
					</div>
				</div>
			) : (
				groups.map((group) => (
					<Fragment key={group.day}>
						<div className="day-tag">{group.label}</div>
						{group.files.map((f) => (
							<MediaCard
								key={`art:${f.name}`}
								goalId={goalId}
								data={mediaCardDataFromFile(f, goalId, locale, now)}
							/>
						))}
					</Fragment>
				))
			)}
		</div>
	);
}
