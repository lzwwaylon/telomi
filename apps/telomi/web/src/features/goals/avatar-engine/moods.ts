import type { EyeShape, HeadShape } from "./shapes";

/**
 * What each emotion looks like, and the character record it is applied to. The birds have
 * no mouth, so every mood here is spent on the eyes, the body colour and how the head
 * moves; `avatar-signals.ts` maps a Goal's state onto these ids.
 */

/** The character record `birds.ts` builds, as the engine reads it. */
export interface Bird {
	id: string;
	body: HeadShape;
	face: { x: number; y: number; sx: number; sy: number; eye: number };
	palette: {
		body: string;
		eye: string;
		eyeHighlight: string;
		zzz: string;
		outline: { color: string; width: number };
		states: Record<string, string>;
	};
	eyeStyle: EyeShape;
	/** Per-bird tuning, merged over the mood below. */
	emotions?: Record<string, Partial<Mood>>;
}

export interface Mood {
	/** Which `palette.states` colour the body takes. */
	state: string;
	/** 0 open, 1 shut. */
	lid: number;
	/** Eye size multiplier; above 1 is wide-eyed. */
	open: number;
	/** Bows the eyes up (content) or, negative, down (unwell). */
	arch: number;
	/** Head tilt in degrees. */
	tilt: number;
	/** Resting gaze as a fraction of the full offset; negative y looks up. */
	gaze: [number, number];
	/** How far the gaze wanders around that rest. */
	scan: [number, number];
	/** Vertical and horizontal motion of the whole head, in viewBox units. */
	bob: number;
	sway: number;
	/** Milliseconds per cycle of bob, sway and scan. */
	beat: number;
	blink: boolean;
	/** A moment: the motion decays into the pose once instead of looping. See `GoalAvatar.tsx`. */
	once: boolean;
	/** Entry swell, 0 to 1. */
	pop: number;
	/** How far the bird settles down as the moment plays out. */
	drop: number;
	/** How shut the eyes start a moment. */
	shut: number;
	/** Stardust particles; 0 draws none. */
	sparkle: number;
	zzz: boolean;
}

const RESTING: Mood = {
	state: "base", lid: 0, open: 1, arch: 0, tilt: 0, gaze: [0, 0], scan: [0, 0],
	bob: 0, sway: 0, beat: 2400, blink: true, once: false, pop: 0, drop: 0, shut: 0,
	sparkle: 0, zzz: false,
};

/**
 * The thirteen emotions. Sine is the only wave here: it dwells at the extremes, so a slow
 * one reads as a bird looking somewhere and staying there rather than as a wobble.
 */
export const MOODS: Record<string, Partial<Mood>> = {
	// at rest the bird only glances about; a rail of birds doing little tricks is noise
	idle: { scan: [0.55, 0.1], beat: 5200 },
	// eyes shut and arched, breathing slowly, with zzz unless the effects are off
	asleep: { state: "dim", lid: 1, arch: 0.5, bob: 1.4, beat: 3400, blink: false, zzz: true },
	// looking off and turning it over, no orbiting dots: nothing that small survives the rail
	thinking: { lid: 0.18, gaze: [0.45, -0.3], scan: [0.35, 0.2], beat: 2400, tilt: 5, sway: 0.9 },
	// narrowed eyes sweeping over the work, quickly
	researching: { lid: 0.32, scan: [0.85, 0.12], beat: 1050, bob: 0.8, sparkle: 1 },
	// eyes turning upward as if leafing through memory: mostly up, back down briefly
	"updating-wiki": { lid: 0.12, gaze: [0, -0.4], scan: [0.12, 0.45], beat: 1100 },
	// the head nods to a beat and the eyes ride with it
	recording: { lid: 0.12, bob: 3.4, beat: 620, gaze: [0, 0.1] },
	// unwell rather than alarming: the badge carries the alarm, this only droops and sways
	failed: { state: "alert", lid: 0.42, arch: -0.45, gaze: [0, 0.25], sway: 2, beat: 3000 },
	// wide eyes plus a bounce, the one thing that still reads at 32px
	"waiting-for-user": { open: 1.2, bob: 2.4, beat: 900 },
	// half shut and drifting: queued, or waiting on the outside world
	"waiting-outside": { state: "soft", lid: 0.52, scan: [0.7, 0.35], beat: 3600, sway: 1 },
	// first waking: the eyes open, the body swells once
	born: { once: true, shut: 1, pop: 1, open: 1.1, bob: 2, beat: 700, sparkle: 2 },
	// work picked up: wide eyes and a head tilt, deliberately not a smile, which reads as done
	started: { once: true, open: 1.22, tilt: 12, pop: 0.7 },
	// finished: arched eyes, a hop that settles, stardust
	done: { once: true, state: "blush", lid: 0.58, arch: 0.95, pop: 0.8, bob: 4, beat: 520, sparkle: 3 },
	// stopped: colour drains, the gaze drops and the bird sinks
	cancelled: { once: true, state: "off", lid: 0.55, arch: -0.25, gaze: [0, 0.5], tilt: -6, drop: 4 },
};

export function moodOf(bird: Bird, emotion: string): Mood {
	return { ...RESTING, ...(MOODS[emotion] ?? MOODS.idle), ...bird.emotions?.[emotion] };
}

/** Everything a frame needs, as numbers, so two of them can be blended on an emotion change. */
export interface Pose {
	x: number; y: number; tilt: number; scale: number;
	lid: number; open: number; arch: number;
	gazeX: number; gazeY: number;
}

/** How long a moment's motion takes to settle into its pose. */
const SETTLE_MS = 520;

/**
 * The pose at `elapsed` milliseconds into the emotion. `still` is the settled frame and
 * never moves, which is what a reader who asked for reduced motion gets.
 */
export function posture(mood: Mood, elapsed: number, still: boolean): Pose {
	const left = mood.once && !still ? Math.exp(-elapsed / SETTLE_MS) : 0;
	const swing = mood.once ? left : still ? 0 : 1;
	const phase = (elapsed / mood.beat) * Math.PI * 2;
	const wave = Math.sin(phase);
	// a moment hops upward rather than oscillating through its own resting height
	const rise = mood.once ? -Math.abs(wave) : wave;
	return {
		x: mood.sway * wave * swing,
		y: mood.bob * rise * swing + mood.drop * (1 - left),
		tilt: mood.tilt,
		scale: 1 + mood.pop * 0.06 * left,
		lid: Math.min(1, mood.lid + mood.shut * left),
		open: mood.open,
		arch: mood.arch,
		gazeX: mood.gaze[0] + mood.scan[0] * wave * swing,
		// the vertical sweep runs at its own rate, so a wandering gaze is not a diagonal shuttle
		gazeY: mood.gaze[1] + mood.scan[1] * Math.sin(phase * 0.61 + 0.9) * swing,
	};
}

export function blend(from: Pose, to: Pose, ratio: number): Pose {
	const k = ratio * ratio * (3 - 2 * ratio);
	const at = (a: number, b: number) => a + (b - a) * k;
	return {
		x: at(from.x, to.x), y: at(from.y, to.y), tilt: at(from.tilt, to.tilt), scale: at(from.scale, to.scale),
		lid: at(from.lid, to.lid), open: at(from.open, to.open), arch: at(from.arch, to.arch),
		gazeX: at(from.gazeX, to.gazeX), gazeY: at(from.gazeY, to.gazeY),
	};
}
