export interface PodcastTrack {
	id: string;
	url: string;
	title: string;
	artist?: string;
	artworkUrl?: string;
	description?: string;
	durationSec?: number;
	goalId?: string;
	artifactName?: string;
	transcriptUrl?: string;
}

export interface PlayerState {
	activeTrack: PodcastTrack | null;
	isPlaying: boolean;
	position: number;
	duration: number;
	bufferedEnd: number;
	speed: number;
	volume: number;
	muted: boolean;
	buffering: boolean;
	expanded: boolean;
	ended: boolean;
	error: boolean;
	revision: number;
	sleepAt: number | "end" | null;
}

export const initialState: PlayerState = {
	activeTrack: null, isPlaying: false, position: 0, duration: 0, bufferedEnd: 0,
	speed: 1, volume: 1, muted: false, buffering: false, expanded: false,
	ended: false, error: false, revision: 0, sleepAt: null,
};

export const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3];
export function bounded(value: number, min: number, max: number, fallback = min): number {
	return Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback;
}


/** Resume only the exact published media version. */
export function sameMediaSource(previous: string, next: string): boolean {
	try {
		const before = new URL(previous, "https://localhost"), after = new URL(next, "https://localhost");
		return before.href === after.href;
	} catch { return previous === next; }
}

export type Action =
	| { type: "load"; track: PodcastTrack; playOnReady: boolean; resumePosition?: number }
	| { type: "play" | "pause" | "toggle" | "stop" | "ended" | "error" | "retry" }
	| { type: "setTime"; position: number }
	| { type: "setDuration"; duration: number }
	| { type: "setBuffered"; end: number }
	| { type: "setSpeed"; speed: number }
	| { type: "setVolume"; volume: number }
	| { type: "setMuted"; muted: boolean }
	| { type: "setBuffering"; buffering: boolean }
	| { type: "setExpanded"; expanded: boolean }
	| { type: "setSleep"; until: PlayerState["sleepAt"] };

export function playerReducer(state: PlayerState, action: Action): PlayerState {
	switch (action.type) {
		case "load": {
			const same = state.activeTrack?.id === action.track.id && sameMediaSource(state.activeTrack.url, action.track.url);
			const duration = bounded(action.track.durationSec ?? (same ? state.duration : 0), 0, Infinity);
			return { ...state, activeTrack: action.track, isPlaying: action.playOnReady,
				position: bounded(action.resumePosition ?? (same ? state.position : 0), 0, duration || Infinity),
				duration, bufferedEnd: same ? state.bufferedEnd : 0, ended: false, error: false,
				buffering: !same, sleepAt: same ? state.sleepAt : null };
		}
		case "play": return state.activeTrack ? { ...state, isPlaying: true, ended: false } : state;
		case "pause": return { ...state, isPlaying: false, buffering: false };
		case "toggle": return state.activeTrack ? { ...state, isPlaying: !state.isPlaying, ended: false } : state;
		case "setTime": return { ...state, position: bounded(action.position, 0, state.duration || Infinity), ended: false };
		case "setDuration": return { ...state, duration: bounded(action.duration, 0, Infinity) };
		case "setBuffered": return { ...state, bufferedEnd: bounded(action.end, 0, state.duration || Infinity) };
		case "setSpeed": return { ...state, speed: bounded(action.speed, .5, 3, 1) };
		case "setVolume": return { ...state, volume: bounded(action.volume, 0, 1), muted: false };
		case "setMuted": return { ...state, muted: action.muted };
		case "setBuffering": return { ...state, buffering: action.buffering };
		case "setExpanded": return { ...state, expanded: Boolean(state.activeTrack && action.expanded) };
		case "setSleep": return { ...state, sleepAt: action.until };
		case "ended": return { ...state, position: state.duration, ended: true, isPlaying: false, buffering: false, sleepAt: null };
		case "error": return { ...state, error: true, isPlaying: false, buffering: false };
		case "retry": return { ...state, error: false, buffering: true, isPlaying: true, revision: state.revision + 1 };
		case "stop": return { ...initialState, speed: state.speed, volume: state.volume, muted: state.muted };
	}
}

export interface PlaybackHistory { [id: string]: { url: string; position: number; ended: boolean } }
export interface SavedPlayer { state: PlayerState; history: PlaybackHistory }

function record(value: unknown): Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function mediaUrl(value: unknown): value is string {
	if (typeof value !== "string" || !value.trim()) return false;
	try { return ["http:", "https:", "blob:"].includes(new URL(value, "https://localhost").protocol); } catch { return false; }
}
function readTrack(value: unknown): PodcastTrack | null {
	const t = record(value);
	if (typeof t.id !== "string" || !t.id || typeof t.title !== "string" || !mediaUrl(t.url)) return null;
	return { id: t.id, title: t.title, url: t.url,
		...Object.fromEntries(["artist", "description", "goalId", "artifactName"].flatMap(k => typeof t[k] === "string" ? [[k, t[k]]] : [])),
		...(mediaUrl(t.artworkUrl) ? { artworkUrl: t.artworkUrl } : {}),
		...(mediaUrl(t.transcriptUrl) ? { transcriptUrl: t.transcriptUrl } : {}),
		...(typeof t.durationSec === "number" ? { durationSec: bounded(t.durationSec, 0, Infinity) } : {}),
	};
}

/** Restore current snapshots without autoplay or an expanded overlay. */
export function restorePlayer(raw: string | null): SavedPlayer {
	let saved: Record<string, unknown> = {};
	try { saved = record(JSON.parse(raw ?? "null")); } catch { /* Corrupt storage starts a fresh player. */ }
	const source = record(saved.state);
	if (!("activeTrack" in source)) return { state: { ...initialState }, history: {} };
	const track = readTrack(source.activeTrack);
	const state = { ...initialState, activeTrack: track,
		position: track ? bounded(Number(source.position), 0, Infinity) : 0,
		duration: track?.durationSec ?? 0,
		speed: bounded(Number(source.speed), .5, 3, 1), volume: bounded(Number(source.volume), 0, 1, 1),
		muted: source.muted === true, ended: source.ended === true && !!track,
	};
	const history: PlaybackHistory = {};
	for (const [id, value] of Object.entries(record(saved.history)).slice(-30)) {
		const entry = record(value);
		if (mediaUrl(entry.url)) history[id] = { url: entry.url, position: bounded(Number(entry.position), 0, Infinity), ended: entry.ended === true };
	}
	return { state, history };
}
