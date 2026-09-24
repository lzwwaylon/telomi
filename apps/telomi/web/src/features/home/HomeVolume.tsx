import { apiClient } from "@/shared/lib/api-client";
import { formatDate } from "@/shared/lib/format";
import { useEffect, useMemo, useState } from "react";
import type { ArtifactFeedItem, ArtifactFeedResponse } from "@shared/types";
import { subscribeGoalsEvents } from "@/shared/lib/goalsEventsStream";
import { coverColor } from "@/features/home/coverColor";
import { useTranslation } from "react-i18next";
import { artifactKindLabel } from "@/shared/artifact-preview/artifact-type";
import { Button } from "@/shared/ui/button";

interface HomeVolumeProps {
	onOpenArtifact: (goalId: string, name: string) => void;
}

function stripExt(name: string): string {
	const base = name.split("/").pop() || name;
	const dot = base.lastIndexOf(".");
	return dot > 0 ? base.slice(0, dot) : base;
}

// 1KB ≈ 350 字,300 字/分 —— 与旧产物卡同口径的粗估,只为给个量感。
function readingMinutes(size: number): number {
	const words = (size / 1024) * 350;
	return Math.max(1, Math.round(words / 300));
}

export function HomeVolume({ onOpenArtifact }: HomeVolumeProps) {
	const { t, i18n } = useTranslation();
	const [items, setItems] = useState<ArtifactFeedItem[]>([]);
	const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
	const [retry, setRetry] = useState(0);

	useEffect(() => {
		let controller: AbortController | undefined;
		const load = async () => {
			controller?.abort();
			controller = new AbortController();
			const { signal } = controller;
			try {
				const data = await apiClient.get<ArtifactFeedResponse>("/api/artifacts/recent", { signal });
				if (signal.aborted) return;
				if (!Array.isArray(data.items)) throw new Error("Invalid artifact feed");
				const list = [...data.items];
				list.sort((a, b) => new Date(b.modifiedAt).getTime() - new Date(a.modifiedAt).getTime());
				setItems(list);
				setStatus("ready");
			} catch {
				if (!signal.aborted) setStatus("error");
			}
		};
		setStatus("loading");
		void load();
		const unsubscribe = subscribeGoalsEvents((event) => {
			if (event.type === "goal:run-completed"
				|| (event.type === "research-run:changed" && event.status === "settled")
				|| (event.type === "media-product:status" && event.status === "done")) void load();
		}, (connected) => {
			if (connected) void load();
		});
		return () => {
			controller?.abort();
			unsubscribe();
		};
	}, [retry]);

	const goalCount = useMemo(() => new Set(items.map((i) => i.goalId)).size, [items]);

	const error = status === "error" ? (
		<div role="alert" data-testid="home-volume-error">
			<p>{t("home.loadError")}</p>
			<Button variant="outline" className="mt-3" aria-label={t("home.retry")} onClick={() => setRetry((value) => value + 1)}>
				{t("home.retry")}
			</Button>
		</div>
	) : null;

	if (items.length === 0) {
		return (
			<section className="harvest-empty" aria-busy={status === "loading"} data-testid={status === "ready" ? "home-volume-empty" : "home-volume-status"}>
				<div className="quiet">
					{error ?? (status === "loading" ? <p role="status">{t("home.emptyLoading")}</p> : <>
						<div className="eyebrow">{t("home.emptyEyebrow")}</div>
						<p>{t("home.emptyDescription")}</p>
						<small>{t("home.emptyLoaded")}</small>
					</>)}
				</div>
			</section>
		);
	}

	return (
		<section className="volume" aria-busy={status === "loading"} data-testid="home-volume">
			<div className="vhead">
				<h3>{t("home.volume")}</h3>
				<div className="vmeta">
					{t("home.volumeMeta", { goals: goalCount, items: items.length })}
				</div>
				{error}
			</div>
			<ul className="contrib">
				{items.map((item) => (
					<li
						key={`${item.goalId}:${item.name}`}
						onClick={() => onOpenArtifact(item.goalId, item.name)}
						onKeyDown={(e) => {
							if (e.key === "Enter" || e.key === " ") {
								e.preventDefault();
								onOpenArtifact(item.goalId, item.name);
							}
						}}
						role="button"
						tabIndex={0}
						data-testid={`contrib-${item.goalId}`}
					>
						<span className="gd" style={{ "--cover": coverColor(item.goalId) } as React.CSSProperties} />
						<span className="c-main">
							<div className="c-title">{item.title || stripExt(item.name)}</div>
							<div className="c-from">
								「<b>{item.goalTitle || t("home.untitled")}</b>」· {artifactKindLabel(item.name)}
								{" · "}<time dateTime={item.modifiedAt}>{formatDate(new Date(item.modifiedAt), { dateStyle: "medium" }, i18n.resolvedLanguage ?? "en")}</time>
							</div>
						</span>
						<span className="c-side">{t("home.readingTime", { minutes: readingMinutes(item.size) })}</span>
					</li>
				))}
			</ul>
		</section>
	);
}
