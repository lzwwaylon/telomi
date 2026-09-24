import { AVATAR_COLORS, type AvatarColor, type AvatarEye, type AvatarHead, type GoalAvatar } from "@shared/avatar";
import type { Bird } from "./moods";
import type { Bump, EyeShape, HeadShape } from "./shapes";

/**
 * The bird parts, as pure data the engine registers. Every bird is drawn the same way:
 * a flat head in the Goal's colour with a slightly darker outline of the same hue, and
 * no beak. What tells birds apart is the head silhouette, the eye shape and the colour,
 * in that order of strength; a new part is one more entry in a table here.
 *
 * Only types come from the engine, so a Node test can read the catalog without a DOM
 * while the shapes below are still checked against what the engine actually draws.
 */

const PAPER = "#F8F4ED";
const INK = "#1A1A1A";
const DARK = "#1A1612";

const EAR_TUFTS: Bump[] = [{ at: -128, amp: 0.22, width: 26, sharp: 1.4 }, { at: -52, amp: 0.22, width: 26, sharp: 1.4 }];
const FAN: Bump[] = [{ at: -118, amp: 0.20, width: 18, sharp: 1.3 }, { at: -90, amp: 0.30, width: 18, sharp: 1.3 }, { at: -62, amp: 0.24, width: 18, sharp: 1.3 }];
const CHEEKS: Bump[] = [{ at: -8, amp: 0.16, width: 22, sharp: 1.2 }, { at: 188, amp: 0.16, width: 22, sharp: 1.2 }];

/** Head silhouettes; angles are screen degrees (-90 is straight up). */
export const HEADS: Record<AvatarHead, HeadShape> = {
	tufts: { r: 0.96, taper: 0.16, flat: 0.14, bumps: EAR_TUFTS },
	horn: { r: 0.9, taper: 0.3, flat: 0.05, sx: 0.86, sy: 1.06, bumps: [{ at: -90, amp: 0.34, width: 13, sharp: 1.5 }] },
	fan: { r: 0.92, taper: 0.1, flat: 0.25, sx: 1.08, sy: 0.86, bumps: FAN },
	plume: { r: 0.9, taper: 0.28, pear: 0.12, flat: 0.2, bumps: [{ at: -70, amp: 0.30, width: 22, sharp: 1.2 }, { at: -96, amp: 0.10, width: 16 }] },
	horns: { r: 0.94, taper: -0.06, flat: 0.1, pear: -0.12, bumps: [{ at: -106, amp: 0.26, width: 13, sharp: 1.4 }, { at: -74, amp: 0.26, width: 13, sharp: 1.4 }] },
	cheeks: { r: 0.94, taper: 0.12, flat: 0.14, bumps: CHEEKS },
	// The ruff's three feathers have to overlap. Narrow ones leave the outline back at the
	// base radius between them, and the notches read as drips rather than as a ruff.
	ruff: { r: 0.92, taper: 0.12, flat: 0.05, sx: 1.06, sy: 0.9, bumps: [{ at: 60, amp: 0.10, width: 24, sharp: 1.2 }, { at: 90, amp: 0.12, width: 24, sharp: 1.2 }, { at: 120, amp: 0.10, width: 24, sharp: 1.2 }] },
	longtufts: { r: 0.92, taper: -0.04, pear: -0.14, flat: 0.1, bumps: [{ at: -135, amp: 0.36, width: 20, sharp: 1.6 }, { at: -45, amp: 0.36, width: 20, sharp: 1.6 }] },
	egg: { r: 0.92, taper: 0.34, pear: 0.1, flat: 0.2, bumps: [] },
	crest: { r: 0.9, taper: 0.1, flat: 0.2, sx: 1.08, sy: 0.88, bumps: [...CHEEKS, ...FAN] },
};

/** The engine's layered eyeball: paper socket, ink iris, sized to the lens. */
const pupil = (w: number, h: number) => ({
	pupil: { irisR: Math.min(w, h) * 0.32, pupilR: Math.min(w, h) * 0.16, irisColor: INK, socket: PAPER, highlights: [{ dx: -3, dy: -3.5, r: 2.4 }] },
});

/**
 * Eye boxes: distance from the face midline, vertical centre, then the engine's lens
 * shaping (taper for pointed ends, bend for an arch, slope for outer-high or outer-low,
 * shift for a bottom-heavy lens, tilt for the whole eye). Shapes are what set them
 * apart, not sizes, so they still read on a bird drawn small.
 */
export const EYES: Record<AvatarEye, EyeShape> = {
	round: { dx: 31, cy: 104, w: 32, h: 33, taper: 0.28 },
	// The hawk's slant is its cue, not its size. Drawn as wide as the round eye it took over
	// the face and read as angry on a bird that was only idling.
	hawk: { dx: 30, cy: 103, w: 27, h: 18, taper: 0.7, slope: -0.32, shift: 0.3 },
	almond: { dx: 31, cy: 102, w: 30, h: 16, taper: 0.9, bend: 0.14 },
	tall: { dx: 27, cy: 102, w: 15, h: 34, taper: 0.35 },
	drop: { dx: 29, cy: 104, w: 22, h: 32, taper: 1.3, shift: 0.6 },
	cat: { dx: 31, cy: 102, w: 30, h: 18, taper: 1, tilt: 16 },
	ring: { dx: 31, cy: 104, w: 32, h: 32, taper: 0.3, ...pupil(32, 32) },
	hawkring: { dx: 30, cy: 103, w: 29, h: 18, taper: 0.7, slope: -0.32, shift: 0.3, ...pupil(29, 18) },
};

/* ---- colour helpers ---- */

function rgb(hex: string): [number, number, number] {
	const n = parseInt(hex.slice(1), 16);
	return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function hex(channels: readonly number[]): string {
	return `#${channels.map((c) => Math.round(Math.max(0, Math.min(255, c))).toString(16).padStart(2, "0")).join("")}`;
}
/** Mixes `color` towards `target` by `amount` (0 = unchanged, 1 = target). */
export function mix(color: string, target: string, amount: number): string {
	const a = rgb(color);
	const b = rgb(target);
	return hex(a.map((c, i) => c + (b[i]! - c) * amount));
}

export function characterId(avatar: GoalAvatar): string {
	return `${avatar.head}-${avatar.eye}-${avatar.color}`;
}

export function colorHex(color: AvatarColor): string {
	return AVATAR_COLORS.find((entry) => entry.id === color)?.hex ?? "#B5AE9F";
}

/** The engine's character record for one avatar. */
export function birdCharacter(avatar: GoalAvatar): Bird {
	const body = colorHex(avatar.color);
	return {
		id: characterId(avatar),
		body: HEADS[avatar.head],
		face: { x: 0, y: 2, sx: 1, sy: 1, eye: 1 },
		palette: {
			body,
			eye: INK,
			eyeHighlight: PAPER,
			zzz: "#A89E91",
			// flat like paper: the engine draws no gloss, sphere shading or ground shadow at
			// all, and a same-hue outline gives the edge instead
			outline: { color: mix(body, DARK, 0.45), width: 2 },
			states: {
				base: body,
				dim: mix(body, DARK, 0.22),
				soft: mix(body, PAPER, 0.18),
				blush: mix(body, "#E8A88A", 0.35),
				/**
				 * Warms the bird's own hue instead of replacing it. An absolute red here made every
				 * failing bird identical, so a rail with two broken Goals could not say which two,
				 * and colours near that red (coral is dE 26 away) read as broken at rest. The alarm
				 * is the badge on the avatar; this only has to look unwell.
				 */
				alert: mix(body, "#C96A4A", 0.35),
				off: mix(body, "#A3A3A3", 0.5),
			},
		},
		eyeStyle: { tilt: 0, bend: 0, highlight: { dx: 4, dy: -7, r: 3.2 }, ...EYES[avatar.eye] },
		/* Per-emotion tuning for a mouthless bird at rail size, see avatar-signals.ts for the mapping. */
		emotions: {
			// the bird needs the user: at 28-46px a bounce carries further than any change of gaze
			"waiting-for-user": { bob: 3.2 },
			// a broken Goal only has to look unwell; the alarm is the badge beside the bird
			failed: { sway: 1.2 },
		},
	};
}
