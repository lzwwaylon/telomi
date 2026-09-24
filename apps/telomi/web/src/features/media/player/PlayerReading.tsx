import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Crosshair } from "lucide-react";
import { PlayIcon as Play } from "@/shared/ui/icons";
import { apiClient } from "@/shared/lib/api-client";
import type { PodcastTranscriptResponse } from "@shared/types";
import type { PodcastTrack } from "@/features/media/player/state";
import { usePlayer } from "@/features/media/player/PlayerContext";
import { formatClockDuration } from "@/shared/lib/format";

export function usePlayerTranscript(track: PodcastTrack | null) {
	const key = `${track?.id}:${track?.url}:${track?.transcriptUrl}`;
	const [attempt, setAttempt] = useState(0);
	const [result, setResult] = useState<{ key: string; data: PodcastTranscriptResponse | null; loading: boolean; error: boolean }>({ key: "", data: null, loading: false, error: false });
	useEffect(() => {
		const controller = new AbortController();
		setResult({ key, data: null, loading: !!track, error: false });
		void (async () => {
			try {
				const url = track?.transcriptUrl;
				const data = url ? await apiClient.get<PodcastTranscriptResponse>(url, { signal: controller.signal }) : null;
				if (data && (!Array.isArray(data.sections) || !Array.isArray(data.blocks))) throw new Error("Invalid transcript");
				if (!controller.signal.aborted) setResult({ key, data, loading: false, error: false });
			} catch {
				if (!controller.signal.aborted) setResult({ key, data: null, loading: false, error: true });
			}
		})();
		return () => controller.abort();
	}, [key, track?.id, track?.url, track?.transcriptUrl, attempt]);
	return { ...(result.key === key ? result : { data: null, loading: !!track, error: false }), retry: () => setAttempt(value => value + 1) };
}

export function PlayerReading({ transcript, tab }: {
	transcript: ReturnType<typeof usePlayerTranscript>;
	tab: "transcript" | "chapters";
}) {
	const { t } = useTranslation();
	const { state, seekTo, resume } = usePlayer();
	const reader = useRef<HTMLDivElement>(null);
	const [follow, setFollow] = useState(true);
	const data = transcript.data;
	const current = data?.blocks.find(block => state.position >= block.startSec && state.position < block.endSec)?.id;
	const chapter = data?.sections.find(section => state.position >= section.startSec && state.position < section.endSec)?.id;
	const seek = (position: number) => { seekTo(position); resume(); setFollow(true); };
	const scrollCurrent = () => {
		const root = reader.current;
		const active = root?.querySelector<HTMLElement>('[aria-current="true"]');
		if (root && active) root.scrollTop += active.getBoundingClientRect().top - root.getBoundingClientRect().top - 16;
	};
	useEffect(() => { if (follow) scrollCurrent(); }, [current, chapter, tab, follow, data]);
	// Keep long transcript paragraphs out of the media clock's update path.
	const paragraphs = useMemo(() => data?.blocks.map(block => (
		<article key={block.id} className="player-transcript-block" aria-current={current === block.id ? "true" : undefined}>
			<div className="player-block-head"><button type="button" onClick={() => seek(block.startSec)} aria-label={t("player.playFrom", { time: formatClockDuration(block.startSec) })}><Play size={12} aria-hidden />{formatClockDuration(block.startSec)}</button>{current === block.id && <span>{t("player.currentParagraph")}</span>}</div>
			{block.text.split(/\n\n+/).map((text, index) => <p key={index}>{text}</p>)}
		</article>
	)), [data, current, seekTo, resume, t]);
	return <section className="player-reading" aria-label={t(tab === "transcript" ? "player.transcript" : "player.chapters")}>
		<div className="player-reading-head"><h2>{t(tab === "transcript" ? "player.transcript" : "player.chapters")}</h2>{tab === "transcript" && data && <button className="player-follow" type="button" aria-pressed={follow} onClick={() => { setFollow(!follow); if (!follow) scrollCurrent(); }}><Crosshair size={16} aria-hidden />{t(follow ? "player.follow" : "player.returnCurrent")}</button>}</div>
		<div className="player-reader" ref={reader} tabIndex={0} onWheel={() => setFollow(false)} onTouchMove={() => setFollow(false)} onKeyDown={event => { if (["ArrowDown", "ArrowUp", "PageDown", "PageUp", "Home", "End"].includes(event.key)) setFollow(false); }}>
			{transcript.loading ? <p className="player-empty" role="status">{t("player.loadingTranscript")}</p> : transcript.error ? <div className="player-empty" role="alert"><p>{t("player.transcriptError")}</p><button type="button" className="player-pill" onClick={transcript.retry}>{t("player.retry")}</button></div> : !data ? <p className="player-empty">{t("player.noTranscript")}</p> : tab === "transcript" ? paragraphs : data.sections.map((section, index) => <button type="button" key={section.id} className="player-chapter" aria-current={chapter === section.id ? "true" : undefined} onClick={() => seek(section.startSec)}><span className="player-chapter-number">{String(index + 1).padStart(2, "0")}</span><span><strong>{section.title}</strong><small>{formatClockDuration(section.startSec)} - {formatClockDuration(section.endSec)}</small></span><Play size={16} aria-hidden /></button>)}
		</div>
	</section>;
}
