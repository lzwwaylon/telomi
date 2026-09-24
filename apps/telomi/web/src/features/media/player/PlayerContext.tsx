import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef, type ReactNode } from "react";
import { PlaybackPauseFocusManager } from "@/features/media/player/PlaybackPauseFocusManager";
import { bounded, initialState, playerReducer, restorePlayer, sameMediaSource, type Action, type PlayerState, type PodcastTrack } from "@/features/media/player/state";
export type { PlayerState, PodcastTrack } from "@/features/media/player/state";

export interface AudioCommandHandler {
	seekTo: (position: number) => void;
	skipBy: (delta: number) => void;
	currentTime: () => number;
}
export interface PlayerControls {
	state: PlayerState;
	play: (track: PodcastTrack, opts?: { autoplay?: boolean; startAt?: number }) => void;
	resume: () => void; pause: () => void; toggle: () => void;
	seekTo: (position: number) => void; skipBy: (delta: number) => void;
	setSpeed: (speed: number) => void; setVolume: (volume: number) => void; setMuted: (muted: boolean) => void;
	stop: () => void; retry: () => void;
	setExpanded: (expanded: boolean) => void;
	setSleep: (until: PlayerState["sleepAt"]) => void;
	acquirePlaybackPause: () => () => void;
	currentTime: () => number;
	_registerAudioCommand: (handler: AudioCommandHandler | null) => void;
	_dispatch: React.Dispatch<Action>;
}
const PlayerContext = createContext<PlayerControls | null>(null);
type PlaybackStatus = Omit<PlayerControls, "state"> & { state: Pick<PlayerState, "activeTrack" | "isPlaying" | "error" | "ended"> };
const PlaybackStatusContext = createContext<PlaybackStatus | null>(null);
const STORAGE_KEY = "telomi:player:v2";

export function PlayerProvider({ children }: { children: ReactNode }) {
	const saved = useMemo(() => {
		try { return restorePlayer(window.localStorage.getItem(STORAGE_KEY)); }
		catch { return { state: initialState, history: {} }; }
	}, []);
	const [state, dispatch] = useReducer(playerReducer, saved.state);
	const latest = useRef(state);
	latest.current = state;
	const history = useRef(saved.history);
	const command = useRef<AudioCommandHandler | null>(null);
	const lastVolume = useRef(state.volume || 1);
	const focus = useMemo(() => new PlaybackPauseFocusManager({
		getActiveTrackId: () => latest.current.activeTrack?.id ?? null,
		isPlaying: () => latest.current.isPlaying,
		pause: () => { latest.current = { ...latest.current, isPlaying: false }; dispatch({ type: "pause" }); },
		resume: () => { latest.current = { ...latest.current, isPlaying: true }; dispatch({ type: "play" }); },
	}), []);
	const remember = useCallback(() => {
		const s = latest.current;
		if (s.activeTrack) {
			delete history.current[s.activeTrack.id];
			history.current[s.activeTrack.id] = { url: s.activeTrack.url, position: s.position, ended: s.ended };
			history.current = Object.fromEntries(Object.entries(history.current).slice(-30));
		}
	}, []);
	const persist = useCallback(() => {
		remember();
		try {
			window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ state: latest.current, history: history.current }));
		} catch { /* Playback remains available when storage is disabled or full. */ }
	}, [remember]);
	useEffect(() => {
		const timer = window.setInterval(persist, 1000);
		window.addEventListener("pagehide", persist);
		return () => { window.clearInterval(timer); window.removeEventListener("pagehide", persist); persist(); };
	}, [persist]);
	useEffect(persist, [state.activeTrack, state.isPlaying, state.speed, state.volume, state.muted, state.ended, persist]);

	const play = useCallback((track: PodcastTrack, opts?: { autoplay?: boolean; startAt?: number }) => {
		focus.noteUserPlaybackIntent();
		remember();
		const current = latest.current;
		const same = current.activeTrack?.id === track.id && sameMediaSource(current.activeTrack.url, track.url);
		const previous = history.current[track.id];
		const position = opts?.startAt ?? (same && !current.ended ? current.position : previous && sameMediaSource(previous.url, track.url) && !previous.ended ? previous.position : 0);
		if (same) command.current?.seekTo(position);
		dispatch({ type: "load", track, playOnReady: opts?.autoplay !== false, resumePosition: position });
		if (same && current.error && opts?.autoplay !== false) dispatch({ type: "retry" });
	}, [focus, remember]);
	const seekTo = useCallback((position: number) => {
		const next = bounded(position, 0, latest.current.duration || Infinity);
		command.current?.seekTo(next);
		dispatch({ type: "setTime", position: next });
	}, []);
	const resume = useCallback(() => {
		focus.noteUserPlaybackIntent();
		if (latest.current.ended) seekTo(0);
		latest.current = { ...latest.current, isPlaying: true };
		dispatch({ type: latest.current.error ? "retry" : "play" });
	}, [focus, seekTo]);
	const pause = useCallback(() => {
		focus.noteUserPlaybackIntent();
		latest.current = { ...latest.current, isPlaying: false };
		dispatch({ type: "pause" });
	}, [focus]);
	const toggle = useCallback(() => latest.current.isPlaying ? pause() : resume(), [pause, resume]);
	const stop = useCallback(() => { focus.noteUserPlaybackIntent(); remember(); dispatch({ type: "stop" }); }, [focus, remember]);
	const setVolume = useCallback((volume: number) => {
		if (volume > 0) lastVolume.current = bounded(volume, 0, 1);
		dispatch({ type: "setVolume", volume });
	}, []);
	const setMuted = useCallback((muted: boolean) => {
		if (!muted && latest.current.volume === 0) dispatch({ type: "setVolume", volume: lastVolume.current });
		dispatch({ type: "setMuted", muted });
	}, []);
	const skipBy = useCallback((delta: number) => command.current?.skipBy(delta), []);
	const setSpeed = useCallback((speed: number) => dispatch({ type: "setSpeed", speed }), []);
	const setExpanded = useCallback((expanded: boolean) => dispatch({ type: "setExpanded", expanded }), []);
	const retry = useCallback(() => { focus.noteUserPlaybackIntent(); dispatch({ type: "retry" }); }, [focus]);
	const setSleep = useCallback((until: PlayerState["sleepAt"]) => dispatch({ type: "setSleep", until }), []);
	const acquirePlaybackPause = useCallback(() => focus.acquirePause(), [focus]);
	const _registerAudioCommand = useCallback((handler: AudioCommandHandler | null) => { command.current = handler; }, []);
	const currentTime = useCallback(() => command.current?.currentTime() ?? latest.current.position, []);
	useEffect(() => {
		if (typeof state.sleepAt !== "number") return;
		const deadline = state.sleepAt;
		const check = () => { if (Date.now() >= deadline) { pause(); setSleep(null); } };
		check();
		const timer = window.setInterval(check, 1000);
		document.addEventListener("visibilitychange", check);
		return () => { window.clearInterval(timer); document.removeEventListener("visibilitychange", check); };
	}, [state.sleepAt, pause, setSleep]);
	const controls = useMemo(() => ({ play, resume, pause, toggle, seekTo, skipBy, setSpeed, setVolume,
		setMuted, stop, retry, setExpanded, setSleep, acquirePlaybackPause, currentTime, _registerAudioCommand, _dispatch: dispatch }),
		[play, resume, pause, toggle, seekTo, skipBy, setSpeed, setVolume, setMuted, stop, retry, setExpanded, setSleep, acquirePlaybackPause, currentTime, _registerAudioCommand]);
	const value = useMemo(() => ({ ...controls, state }), [controls, state]);
	const status = useMemo(() => ({ ...controls, state: { activeTrack: state.activeTrack, isPlaying: state.isPlaying, error: state.error, ended: state.ended } }), [controls, state.activeTrack, state.isPlaying, state.error, state.ended]);
	return <PlayerContext.Provider value={value}><PlaybackStatusContext.Provider value={status}>{children}</PlaybackStatusContext.Provider></PlayerContext.Provider>;
}
export function usePlayer(): PlayerControls {
	const context = useContext(PlayerContext);
	if (!context) throw new Error("usePlayer must be used inside PlayerProvider");
	return context;
}

/** Cards and composers do not subscribe to the playback clock. */
export function usePlaybackStatus(): PlaybackStatus {
	const context = useContext(PlaybackStatusContext);
	if (!context) throw new Error("usePlaybackStatus must be used inside PlayerProvider");
	return context;
}
