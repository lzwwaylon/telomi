import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, MoreHorizontal, List, Loader2, RotateCcw, RotateCw, Timer, Volume2, VolumeX } from "lucide-react";
import { BookIcon as BookOpen, DownloadIcon as Download, PauseIcon as Pause, PlayIcon as Play, CloseIcon as X } from "@/shared/ui/icons";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/shared/ui/dropdown-menu";
import { Dialog, DialogContent, DialogTitle } from "@/shared/ui/dialog";
import { Popover, PopoverContent, PopoverTrigger } from "@/shared/ui/popover";
import { usePlayer } from "@/features/media/player/PlayerContext";
import { useGoalArtifactFiles } from "@/features/goals/data/useGoalArtifactFiles";
import { reportCoverUrl } from "@/features/goals/cover";
import { SPEEDS } from "@/features/media/player/state";
import { PlayerTimeline, clock } from "@/features/media/player/PlayerTimeline";
import { PlayerReading, usePlayerTranscript } from "@/features/media/player/PlayerReading";
import "@/features/media/player/player.css";

function PlayerCover({ compact = false }: { compact?: boolean }) {
	const { state } = usePlayer();
	const track = state.activeTrack!;
	const { files } = useGoalArtifactFiles(!track.artworkUrl ? track.goalId ?? null : null);
	const artwork = track.artworkUrl ?? reportCoverUrl(track.goalId ?? "", track.title, files.find(file => file.name === track.artifactName)?.cover);
	const [failedUrl, setFailedUrl] = useState<string | null>(null);
	const source = artwork !== failedUrl ? artwork : reportCoverUrl("", track.title);
	return <div className={compact ? "player-cover-small" : "player-cover"} aria-hidden="true"><img src={source} alt="" onError={() => setFailedUrl(source)} /></div>;
}

function PlaybackSpeed() {
	const { t } = useTranslation();
	const { state, setSpeed } = usePlayer();
	const [open, setOpen] = useState(false);
	return <Popover open={open} onOpenChange={setOpen}><PopoverTrigger asChild><button type="button" className="player-speed" aria-label={t("player.speedValue", { speed: state.speed })}>{state.speed}×</button></PopoverTrigger><PopoverContent className="player-menu" side="top" collisionPadding={16}><h2>{t("player.speed")}</h2><div className="player-speeds">{SPEEDS.map(speed => <button type="button" key={speed} aria-pressed={speed === state.speed} onClick={() => { setSpeed(speed); setOpen(false); }}>{speed}×</button>)}</div><p>{t("player.preservePitch")}</p></PopoverContent></Popover>;
}

function SleepTimer() {
	const { t } = useTranslation();
	const { state, setSleep } = usePlayer();
	const [open, setOpen] = useState(false);
	const [now, setNow] = useState(Date.now);
	useEffect(() => {
		if (typeof state.sleepAt !== "number") return;
		const id = window.setInterval(() => setNow(Date.now()), 1000);
		return () => window.clearInterval(id);
	}, [state.sleepAt]);
	const left = typeof state.sleepAt === "number" ? Math.max(0, Math.ceil((state.sleepAt - now) / 60000)) : null;
	return <Popover open={open} onOpenChange={setOpen}><PopoverTrigger asChild><button type="button" className="player-timer player-icon" aria-label={t("player.sleep")} data-active={!!state.sleepAt || undefined}><Timer size={20} />{left !== null && <small>{left}</small>}</button></PopoverTrigger><PopoverContent className="player-menu" side="top" collisionPadding={16}><h2>{t("player.sleep")}</h2><div className="player-sleep-options">{[0, 5, 15, 30, -1].map(minutes => <button type="button" key={minutes} aria-pressed={minutes === 0 ? !state.sleepAt : minutes === -1 ? state.sleepAt === "end" : left === minutes} onClick={() => { setSleep(minutes === 0 ? null : minutes === -1 ? "end" : Date.now() + minutes * 60000); setNow(Date.now()); setOpen(false); }}>{minutes === 0 ? t("player.sleepOff") : minutes === -1 ? t("player.sleepEnd") : t("player.sleepMinutes", { minutes })}</button>)}</div><p>{t("player.sleepHint")}</p></PopoverContent></Popover>;
}

function Volume() {
	const { t } = useTranslation();
	const { state, setMuted, setVolume } = usePlayer();
	const silent = state.muted || state.volume === 0;
	return <div className="player-volume"><button type="button" className="player-icon" aria-label={t(silent ? "player.unmute" : "player.mute")} title={t(silent ? "player.unmute" : "player.mute")} onClick={() => setMuted(!silent)}>{silent ? <VolumeX size={20} /> : <Volume2 size={20} />}</button><input type="range" min={0} max={1} step={.01} value={silent ? 0 : state.volume} onChange={event => setVolume(Number(event.target.value))} aria-label={t("player.volume")} /></div>;
}

function Transport() {
	const { t } = useTranslation();
	const { state, toggle, skipBy } = usePlayer();
	return <div className="player-transport">
		<button type="button" className="player-icon player-skip" disabled={!state.duration || state.error} onClick={() => skipBy(-15)} aria-label={t("player.back")}><RotateCcw size={28} aria-hidden /><span aria-hidden>15</span></button>
		<button type="button" className="player-icon player-play" onClick={toggle} aria-label={t(state.isPlaying ? "media.pause" : state.ended ? "player.replay" : "media.play")} aria-busy={state.buffering || undefined}>
			{state.buffering ? <Loader2 className="player-spin" size={26} aria-hidden /> : state.isPlaying ? <Pause size={26} aria-hidden /> : <Play size={26} aria-hidden />}
		</button>
		<button type="button" className="player-icon player-skip" disabled={!state.duration || state.error} onClick={() => skipBy(30)} aria-label={t("player.forward")}><RotateCw size={28} aria-hidden /><span aria-hidden>30</span></button>
	</div>;
}

function PlaybackError() {
	const { t } = useTranslation();
	const { state, retry } = usePlayer();
	return state.error ? <div className="player-error" role="alert"><span>{t("player.loadError")}</span><button type="button" onClick={retry}>{t("player.retry")}</button></div> : null;
}

function ExpandedPlayer({ transcript, onOpenSource }: {
	transcript: ReturnType<typeof usePlayerTranscript>;
	onOpenSource: (goalId: string, filename: string) => void;
}) {
	const { t } = useTranslation();
	const { state, setExpanded, stop } = usePlayer();
	const [tab, setTab] = useState<"transcript" | "chapters" | null>(null);
	const track = state.activeTrack!;
	const chapter = transcript.data?.sections.find(section => state.position >= section.startSec && state.position < section.endSec);
	const toggleTab = (next: "transcript" | "chapters") => setTab(value => value === next ? null : next);
	return <>
		<div className="player-full-header">
			<span className="player-brand"><span className="player-logo" aria-hidden />Telomi</span>
			<div className="player-header-actions">
				<button type="button" className="player-pill" data-testid="player-collapse" onClick={() => setExpanded(false)}><ChevronDown size={18} aria-hidden />{t("player.collapse")}</button>
				<DropdownMenu><DropdownMenuTrigger asChild><button type="button" className="player-icon" aria-label={t("player.more")} title={t("player.more")}><MoreHorizontal size={22} aria-hidden /></button></DropdownMenuTrigger>
					<DropdownMenuContent className="player-actions-menu" align="end" sideOffset={8} collisionPadding={16}>
						{track.goalId && track.artifactName && <DropdownMenuItem onSelect={() => { setExpanded(false); onOpenSource(track.goalId!, track.artifactName!); }}><BookOpen aria-hidden />{t("player.openReport")}</DropdownMenuItem>}
						<DropdownMenuItem asChild><a href={track.url} download={track.goalId ? "podcast.mp3" : track.title}><Download aria-hidden />{t("player.download")}</a></DropdownMenuItem>
						<DropdownMenuSeparator />
						<DropdownMenuItem onSelect={stop}><X aria-hidden />{t("player.stop")}</DropdownMenuItem>
					</DropdownMenuContent>
				</DropdownMenu>
			</div>
		</div>
		<div className="player-full-body" data-reading={tab !== null || undefined}>
			<section className="player-listening">
				<div className="player-artwork"><PlayerCover key={track.id} /></div>
				<div className="player-description"><DialogTitle className="player-title">{track.title}</DialogTitle><p className="player-meta">{(track.goalId ? t("media.podcast") : track.artist ?? t("player.audio"))} · {state.duration ? clock(state.duration) : "--:--"}</p>{track.description && <p className="player-lede">{track.description}</p>}</div>
				<div className="player-full-controls">
					<div className="player-status" role="status"><span className="player-pulse" aria-hidden><i /><i /><i /></span>{t(state.error ? "player.failed" : state.buffering ? "player.buffering" : state.ended ? "player.finished" : state.isPlaying ? "player.playing" : "player.paused")}</div>
					<PlaybackError /><PlayerTimeline chapters={transcript.data?.sections} />
					<div className="player-control-row"><PlaybackSpeed /><Transport /><SleepTimer /></div>
					<div className="player-secondary"><div className="player-reading-actions"><button type="button" className="player-pill" aria-expanded={tab === "transcript"} onClick={() => toggleTab("transcript")}><BookOpen size={17} aria-hidden />{t("player.transcript")}</button><button type="button" className="player-pill" aria-expanded={tab === "chapters"} onClick={() => toggleTab("chapters")}><List size={17} aria-hidden />{t("player.chapters")}</button></div><Volume /></div>
					{chapter && <button type="button" className="player-current-chapter" onClick={() => toggleTab("chapters")}><span>{transcript.data!.sections.indexOf(chapter) + 1} / {transcript.data!.sections.length}</span><span>{chapter.title}</span></button>}
				</div>
			</section>
			{tab && <PlayerReading transcript={transcript} tab={tab} />}
		</div>
	</>;
}

export function GlobalPlayer({ onOpenSource }: { onOpenSource: (goalId: string, filename: string) => void }) {
	const { t } = useTranslation();
	const { state, setExpanded, stop } = usePlayer();
	const transcript = usePlayerTranscript(state.activeTrack);
	const returnFocus = useRef<HTMLElement | null>(null);
	const track = state.activeTrack;
	useEffect(() => {
		const bar = document.querySelector<HTMLElement>(".global-player-bar");
		if (!bar) return;
		const update = () => document.documentElement.style.setProperty("--player-bar-height", `${bar.getBoundingClientRect().height}px`);
		update();
		const observer = new ResizeObserver(update);
		observer.observe(bar);
		return () => observer.disconnect();
	}, [state.expanded, track?.id]);
	if (!track) return null;
	return <div className="global-player" data-playing={state.isPlaying || undefined} data-expanded={state.expanded || undefined}>
		{!state.expanded && <div className="global-player-bar" data-testid="global-player-bar">
			<div className="player-bar-content"><PlaybackError /><button type="button" className="player-mini-track" data-testid="player-expand" onClick={() => setExpanded(true)} aria-label={t("player.expandTitle", { title: track.title })}><PlayerCover key={track.id} compact /><span><strong>{track.title}</strong><small>{state.error ? t("player.failed") : state.ended ? t("player.finished") : (track.goalId ? t("media.podcast") : track.artist ?? t("player.audio"))}</small></span></button><Transport /><PlayerTimeline chapters={transcript.data?.sections} /><PlaybackSpeed /><button type="button" className="player-icon player-close" data-testid="player-close" onClick={stop} aria-label={t("player.stop")} title={t("player.stop")}><X size={20} aria-hidden /></button></div>
		</div>}
		<Dialog open={state.expanded} onOpenChange={setExpanded}><DialogContent className="player-fullscreen" overlayClassName="player-dialog-overlay" showCloseButton={false} aria-describedby={undefined} onOpenAutoFocus={() => { returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; }} onCloseAutoFocus={event => { event.preventDefault(); requestAnimationFrame(() => {
				const previous = returnFocus.current;
				const target = previous?.isConnected && previous !== document.body ? previous : document.querySelector<HTMLButtonElement>('[data-testid="player-expand"]');
				target?.focus({ preventScroll: true });
			}); }}>
			<div className="player-fullscreen-inner" data-playing={state.isPlaying || undefined}><ExpandedPlayer key={track.id + track.url} transcript={transcript} onOpenSource={onOpenSource} /></div>
		</DialogContent></Dialog>
	</div>;
}
