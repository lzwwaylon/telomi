/**
 * Path maths for one bird, in the units `birds.ts` encodes: a 240 viewBox with the head
 * centred at 120 and a base radius of 104. Pure functions only, so the shapes can be
 * checked in Node without a DOM and a head can be built once per character.
 */

export const VIEW = 240;
export const CENTRE = 120;
const BASE_R = 104;

/** How far a full gaze moves an eye. A bird drawn at 32px has about 6px of eye, so this is small. */
export const GAZE = { x: 5, y: 4.5 };

export interface Bump { at: number; amp: number; width: number; sharp?: number }

export interface HeadShape {
	r: number;
	/** Narrows the crown (egg) or, negative, widens it (heart). */
	taper?: number;
	/** Seats the head on a flat base. */
	flat?: number;
	/** Widens the jaw (pear) or, negative, narrows it (heart). */
	pear?: number;
	sx?: number;
	sy?: number;
	bumps: Bump[];
}

export interface Dot { dx: number; dy: number; r: number }

export interface EyeShape {
	dx: number; cy: number; w: number; h: number;
	taper?: number; bend?: number; slope?: number; shift?: number; tilt?: number;
	highlight?: Dot;
	pupil?: { irisR: number; pupilR: number; irisColor: string; socket: string; highlights?: Dot[] };
}

const RAD = Math.PI / 180;
const round = (value: number) => Math.round(value * 10) / 10;

/** How far the feathers at `deg` push the outline out; 1 where no feather reaches. */
function feathers(deg: number, bumps: readonly Bump[]): number {
	let out = 1;
	for (const bump of bumps) {
		const away = Math.abs(((deg - bump.at + 540) % 360) - 180);
		if (away >= bump.width) continue;
		// cos falls to zero at the feather's edge, so a bump never creases the outline
		out += bump.amp * Math.cos((away / bump.width) * (Math.PI / 2)) ** (2 * (bump.sharp ?? 1));
	}
	return out;
}

/** Widest turn onto the seat, in viewBox units; a shallow seat gets a proportionally smaller one. */
const TURN = 8;

/**
 * Seats the head without cutting it. A plain `Math.min` leaves a corner on each side where
 * the head meets its base, and at 32px that reads as a bird sliced off rather than sitting.
 * This rounds the two turns and leaves the base between them flat, so the seat still reads
 * as a seat. `depth` is how far the unseated shape would have reached past the base, and
 * the turn never takes all of it, or there would be no flat left to turn onto.
 */
function settle(y: number, seat: number, depth: number): number {
	const turn = Math.min(TURN, depth * 0.8);
	const away = Math.abs(y - seat);
	if (turn <= 0 || away >= turn) return Math.min(y, seat);
	return Math.min(y, seat) - (turn - away) ** 2 / (4 * turn);
}

/**
 * The head silhouette as one closed path, sampled every two degrees: at the sizes we draw
 * (28px to 46px) the facets sit far below a pixel and the maths stays readable. Feathers
 * multiply the already seated base shape, so a flat seat stays flat between them while a
 * ruff still hangs below it.
 */
export function headPath(head: HeadShape): string {
	const { r, taper = 0, pear = 0, flat = 0, sx = 1, sy = 1, bumps } = head;
	const radius = BASE_R * r;
	const seat = radius * sy * (1 - flat);
	const depth = radius * sy - seat;
	const points: string[] = [];
	for (let deg = -180; deg < 180; deg += 2) {
		const ux = Math.cos(deg * RAD);
		const uy = Math.sin(deg * RAD);
		const wide = 1 - taper * Math.max(0, -uy) + pear * Math.max(0, uy);
		// A tapered crown also sits a little lower, so a horn or a crest still crests the head
		// and a tall head keeps its feathers inside the frame.
		const lift = 1 - taper * 0.5 * Math.max(0, -uy);
		const grow = feathers(deg, bumps);
		const x = ux * wide * sx * radius * grow;
		const y = settle(uy * lift * sy * radius, seat, depth) * grow;
		points.push(`${round(CENTRE + x)} ${round(CENTRE + y)}`);
	}
	return `M${points.join("L")}Z`;
}

/**
 * One eye lens in eye-local coordinates, where +x points away from the face; the caller
 * mirrors the left eye, so slope and tilt lean outward on both sides. `lid` shuts the eye
 * from the top and `arch` bows it up (content) or down (unwell).
 */
export function lensPath(eye: EyeShape, size: number, lid: number, arch: number): string {
	const half = (eye.w / 2) * size;
	const full = (eye.h / 2) * size;
	// A shut eye still has to read as a line: 3.4 units is about a pixel at 32px.
	const tall = Math.max(full * (1 - lid), 3.4);
	const fall = (full - tall) * 0.55;
	const point = 1 + (eye.taper ?? 0);
	const shift = eye.shift ?? 0;
	const bow = (eye.bend ?? 0) + arch;
	const slope = eye.slope ?? 0;
	const points: string[] = [];
	for (let step = 0; step < 48; step += 1) {
		const t = (step / 48) * Math.PI * 2;
		const ct = Math.cos(t);
		const st = Math.sin(t);
		// the exponent pinches the ends to a point; shift keeps the height but hangs the mass low
		let y = tall * Math.sign(st) * Math.abs(st) ** point;
		y *= y > 0 ? 1 + shift : 1 - shift;
		points.push(`${round(half * ct)} ${round(y + slope * tall * ct - bow * tall * (1 - ct * ct) + fall)}`);
	}
	return `M${points.join("L")}Z`;
}

/** Room kept around the silhouette for the bob and the entry swell. */
const MARGIN = 12;

/**
 * The viewBox a head needs. A crest or a horn reaches past the 240 box the catalog is
 * written in, so the frame opens up around the centre instead of clipping the one feather
 * that tells that bird apart; birds that fit keep the plain 240 and their full size.
 */
export function frameFor(path: string): string {
	let reach = VIEW / 2;
	for (const pair of path.slice(1, -1).split("L")) {
		const [x = CENTRE, y = CENTRE] = pair.split(" ").map(Number);
		reach = Math.max(reach, Math.abs(x - CENTRE) + MARGIN, Math.abs(y - CENTRE) + MARGIN);
	}
	return `${round(CENTRE - reach)} ${round(CENTRE - reach)} ${round(reach * 2)} ${round(reach * 2)}`;
}
