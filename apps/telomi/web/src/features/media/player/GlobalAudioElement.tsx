import { useEffect, useRef } from "react";
import { usePlayer } from "@/features/media/player/PlayerContext";
import { apiUrl } from "@/shared/lib/api";
import { bounded } from "@/features/media/player/state";

/** One media element for every artifact and both player presentations. */
export function GlobalAudioElement() {
	const player = usePlayer();
	const { state, _dispatch: dispatch, _registerAudioCommand: register } = player;
	const audio = useRef<HTMLAudioElement>(null);
	const latest = useRef(player);
	latest.current = player;
	const generation = useRef(0);
	const loading = useRef(false);
	const pendingPosition = useRef<number | null>(null);

	useEffect(() => {
		const seek = (position: number) => {
			const el = audio.current;
			if (!el || !latest.current.state.activeTrack) return;
			if (!Number.isFinite(el.duration)) { pendingPosition.current = position; return; }
			el.currentTime = bounded(position, 0, el.duration);
		};
		register({ seekTo: seek, skipBy: delta => seek((audio.current?.currentTime ?? 0) + delta), currentTime: () => audio.current?.currentTime ?? 0 });
		return () => register(null);
	}, [register]);

	useEffect(() => {
		const el = audio.current!;
		generation.current += 1;
		loading.current = true;
		pendingPosition.current = latest.current.state.position;
		if (state.activeTrack) {
			el.src = apiUrl(state.activeTrack.url);
			dispatch({ type: "setBuffering", buffering: true });
		} else el.removeAttribute("src");
		el.load();
		el.volume = latest.current.state.volume;
		el.muted = latest.current.state.muted;
		el.playbackRate = latest.current.state.speed;
		return () => { generation.current += 1; };
	}, [state.activeTrack?.url, state.activeTrack?.id, state.revision, dispatch]);

	useEffect(() => {
		const el = audio.current!;
		const current = generation.current;
		if (state.isPlaying && state.activeTrack) {
			void el.play().catch((error: unknown) => {
				if (current !== generation.current || !latest.current.state.isPlaying) return;
				if (error instanceof DOMException && error.name === "AbortError") return;
				dispatch({ type: "error" });
			});
		} else el.pause();
	}, [state.isPlaying, state.activeTrack?.url, state.activeTrack?.id, state.revision, dispatch]);
	useEffect(() => { audio.current!.volume = state.volume; audio.current!.muted = state.muted; }, [state.volume, state.muted]);
	useEffect(() => { audio.current!.playbackRate = state.speed; }, [state.speed]);

	useEffect(() => {
		if (!("mediaSession" in navigator)) return;
		const ms = navigator.mediaSession;
		const track = state.activeTrack;
		ms.metadata = track ? new MediaMetadata({ title: track.title, artist: track.artist ?? "", album: "Telomi" }) : null;
		if (!track) { ms.setPositionState?.(); return; }
		const actions: Array<[MediaSessionAction, MediaSessionActionHandler]> = [
			["play", () => latest.current.resume()], ["pause", () => latest.current.pause()],
			["seekbackward", event => latest.current.skipBy(-(event.seekOffset ?? 15))],
			["seekforward", event => latest.current.skipBy(event.seekOffset ?? 30)],
			["seekto", event => { if (typeof event.seekTime === "number") latest.current.seekTo(event.seekTime); }],
			["stop", () => latest.current.stop()],
		];
		for (const [action, handler] of actions) { try { ms.setActionHandler(action, handler); } catch { /* Optional platform actions. */ } }
		return () => { for (const [action] of actions) { try { ms.setActionHandler(action, null); } catch { /* Optional platform actions. */ } } };
	}, [state.activeTrack]);
	useEffect(() => {
		if (!("mediaSession" in navigator)) return;
		navigator.mediaSession.playbackState = state.activeTrack ? state.isPlaying ? "playing" : "paused" : "none";
		if (state.duration > 0) {
			try { navigator.mediaSession.setPositionState?.({ duration: state.duration, playbackRate: state.speed, position: bounded(state.position, 0, state.duration) }); } catch { /* Browser may not expose a seekable timeline. */ }
		}
	}, [state.activeTrack, state.isPlaying, state.position, state.duration, state.speed]);

	useEffect(() => {
		const onKey = (event: KeyboardEvent) => {
			if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
			const target = event.target;
			if (target instanceof Element && target.closest('input,textarea,select,button,a,[contenteditable]:not([contenteditable="false"]),[role="button"],[role="slider"],[role="tab"],[role="menuitem"],[role="combobox"]')) return;
			const p = latest.current;
			if (!p.state.activeTrack) return;
			const actions: Record<string, () => void> = {
				" ": p.toggle, k: p.toggle, j: () => p.skipBy(-15), ArrowLeft: () => p.skipBy(-15),
				l: () => p.skipBy(30), ArrowRight: () => p.skipBy(30),
				m: () => p.setMuted(!(p.state.muted || p.state.volume === 0)),
			};
			const action = actions[event.key] ?? actions[event.key.toLowerCase()];
			if (action) { event.preventDefault(); action(); }
		};
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
	}, []);

	const time = () => {
		const el = audio.current!;
		if (!latest.current.state.activeTrack || loading.current) return;
		if (!el.ended) dispatch({ type: "setTime", position: el.currentTime });
	};
	const duration = () => {
		if (latest.current.state.activeTrack && Number.isFinite(audio.current!.duration)) dispatch({ type: "setDuration", duration: audio.current!.duration });
	};
	return <audio ref={audio} preload="metadata" hidden data-testid="global-audio"
		onLoadedMetadata={() => {
			loading.current = false;
			dispatch({ type: "setBuffering", buffering: false });
			duration();
			const el = audio.current!;
			if (pendingPosition.current !== null && Number.isFinite(el.duration)) el.currentTime = bounded(pendingPosition.current, 0, el.duration);
			pendingPosition.current = null;
		}}
		onDurationChange={duration} onTimeUpdate={time} onSeeked={time}
		onProgress={() => {
			const el = audio.current!;
			let end = 0;
			for (let i = 0; i < el.buffered.length; i++) if (el.currentTime >= el.buffered.start(i) && el.currentTime <= el.buffered.end(i)) end = el.buffered.end(i);
			dispatch({ type: "setBuffered", end });
		}}
		onEnded={() => dispatch({ type: "ended" })}
		onPlay={() => { if (!loading.current) dispatch({ type: "play" }); }}
		onPause={() => { if (!loading.current && !audio.current!.ended) dispatch({ type: "pause" }); }}
		onWaiting={() => { if (latest.current.state.isPlaying) dispatch({ type: "setBuffering", buffering: true }); }}
		onCanPlay={() => dispatch({ type: "setBuffering", buffering: false })}
		onPlaying={() => dispatch({ type: "setBuffering", buffering: false })}
		onError={() => { if (latest.current.state.activeTrack) { loading.current = false; dispatch({ type: "error" }); } }} />;
}
