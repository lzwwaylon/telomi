import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { PodcastTranscriptSection } from "@shared/types";
import { usePlayer } from "@/features/media/player/PlayerContext";
import { bounded } from "@/features/media/player/state";
import { formatClockDuration } from "@/shared/lib/format";

export const clock = (time: number) => time <= 0 ? "0:00" : formatClockDuration(time, { fallback: "0:00" });

export function PlayerTimeline({ chapters = [] }: { chapters?: PodcastTranscriptSection[] }) {
	const { t } = useTranslation();
	const { state, seekTo, currentTime, acquirePlaybackPause } = usePlayer();
	const fill = useRef<HTMLDivElement>(null), handle = useRef<HTMLSpanElement>(null), input = useRef<HTMLInputElement>(null);
	const elapsed = useRef<HTMLSpanElement>(null), remaining = useRef<HTMLSpanElement>(null);
	const drag = useRef<{ start: number; preview: number; release: () => void } | null>(null);
	const [tip, setTip] = useState<{ ratio: number; time: number } | null>(null);
	const [dragging, setDragging] = useState(false);
	const total = state.duration;
	const paint = (time: number) => {
		const value = bounded(time, 0, total || Infinity), ratio = total ? value / total : 0;
		if (fill.current) fill.current.style.width = `${ratio * 100}%`;
		if (handle.current) handle.current.style.left = `${ratio * 100}%`;
		if (input.current) { input.current.value = String(value); input.current.setAttribute("aria-valuetext", t("player.timeValue", { time: clock(value), duration: clock(total) })); }
		if (elapsed.current) elapsed.current.textContent = clock(value);
		if (remaining.current) remaining.current.textContent = state.ended && !drag.current ? t("player.finished") : total ? t("player.remaining", { time: clock((total - value) / state.speed) }) : "--:--";
	};
	useEffect(() => {
		let frame = 0;
		const update = () => { paint(drag.current?.preview ?? currentTime()); frame = requestAnimationFrame(update); };
		paint(drag.current?.preview ?? state.position);
		if (state.isPlaying && !state.buffering) frame = requestAnimationFrame(update);
		return () => cancelAnimationFrame(frame);
	}, [state.position, state.duration, state.isPlaying, state.speed, state.ended, state.buffering, currentTime, t]);
	useEffect(() => () => { drag.current?.release(); drag.current = null; }, []);
	const end = (cancel = false) => {
		const gesture = drag.current;
		if (!gesture) return;
		drag.current = null;
		seekTo(cancel ? gesture.start : gesture.preview);
		gesture.release(); setDragging(false); setTip(null);
	};
	useEffect(() => {
		const cancel = () => end(true);
		window.addEventListener("blur", cancel);
		return () => window.removeEventListener("blur", cancel);
	}, [seekTo]);
	const pointerTime = (event: React.PointerEvent<HTMLInputElement>) => {
		const rect = event.currentTarget.getBoundingClientRect();
		const ratio = bounded((event.clientX - rect.left) / rect.width, 0, 1);
		return { ratio, time: ratio * total };
	};
	return <div className="player-progress">
		<div className="player-timeline" data-dragging={dragging || undefined}>
			<div className="player-track"><div className="player-buffer" style={{ width: `${total ? bounded(state.bufferedEnd / total, 0, 1) * 100 : 0}%` }} /><div className="player-fill" ref={fill} />{chapters.slice(1).map(chapter => <i key={chapter.id} className="player-tick" style={{ left: `${total ? chapter.startSec / total * 100 : 0}%` }} />)}</div>
			<input ref={input} type="range" className="player-seek" aria-label={t("player.progress")} min={0} max={total || 1} step={0.1} defaultValue={state.position} disabled={!total || state.error}
				onPointerDown={event => { if (event.button !== 0) return; const next = pointerTime(event); drag.current = { start: currentTime(), preview: next.time, release: acquirePlaybackPause() }; event.currentTarget.setPointerCapture(event.pointerId); setDragging(true); setTip(next); paint(next.time); }}
				onPointerMove={event => { const next = pointerTime(event); setTip(next); if (drag.current) { drag.current.preview = next.time; paint(next.time); } }}
				onChange={event => { const value = Number(event.target.value); if (drag.current) drag.current.preview = value; else seekTo(value); paint(value); }}
				onPointerUp={() => end()} onPointerCancel={() => end(true)} onLostPointerCapture={() => end(true)} onPointerLeave={() => { if (!drag.current) setTip(null); }} onBlur={() => setTip(null)}
				onKeyDown={event => { const delta = event.shiftKey ? 1 : 5; const next = event.key === "ArrowLeft" || event.key === "ArrowDown" ? currentTime() - delta : event.key === "ArrowRight" || event.key === "ArrowUp" ? currentTime() + delta : event.key === "Home" ? 0 : event.key === "End" ? total : null; if (next !== null) { event.preventDefault(); seekTo(next); } }} />
			<span className="player-handle" ref={handle} />
			{tip && total > 0 && <div className="player-seek-tip" aria-hidden style={{ left: `clamp(min(110px, 50%), ${tip.ratio * 100}%, max(50%, calc(100% - 110px)))` }}><strong>{clock(tip.time)}</strong><small>{chapters.find(chapter => tip.time >= chapter.startSec && tip.time < chapter.endSec)?.title}</small></div>}
		</div>
		<div className="player-times"><span ref={elapsed}>{clock(state.position)}</span><span ref={remaining} /></div>
	</div>;
}
