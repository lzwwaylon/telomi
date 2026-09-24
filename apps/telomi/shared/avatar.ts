/**
 * Goal avatar catalog. A Goal's avatar is a bird drawn by the avatar engine in the
 * web client: a head silhouette, an eye type and a colour. The server only assigns and
 * persists the triple. Ids are the ids of the bird parts the web client defines, so
 * this file is the single source the part tables are checked against.
 */

/** Head silhouettes: a base shape (round, tall egg, squat, pear, heart) plus feathers. The strongest cue at rail size. */
export const AVATAR_HEADS = ["tufts", "horn", "fan", "plume", "horns", "cheeks", "ruff", "longtufts", "egg", "crest"] as const;
export type AvatarHead = (typeof AVATAR_HEADS)[number];

/** Eye types, told apart by shape rather than size so they survive a bird drawn small. */
export const AVATAR_EYES = ["round", "hawk", "almond", "tall", "drop", "cat", "ring", "hawkring"] as const;
export type AvatarEye = (typeof AVATAR_EYES)[number];

/** Body colours, muted to sit on paper. Cream and ink are left out: one vanishes on the light paper, the other on the dark. */
export const AVATAR_COLORS = [
	{ id: "tawny", hex: "#B98A5E" },
	{ id: "sage", hex: "#6FB98F" },
	{ id: "sky", hex: "#6FA8DC" },
	{ id: "coral", hex: "#E08A6E" },
	{ id: "amber", hex: "#E0B04A" },
	{ id: "plum", hex: "#A88BC7" },
	{ id: "mint", hex: "#7FC8B4" },
	{ id: "rose", hex: "#D98AA8" },
	{ id: "slate", hex: "#8FA3B5" },
	{ id: "stone", hex: "#B5AE9F" },
] as const;
export type AvatarColor = (typeof AVATAR_COLORS)[number]["id"];

export interface GoalAvatar {
	head: AvatarHead;
	eye: AvatarEye;
	color: AvatarColor;
}

const HEADS = AVATAR_HEADS.length;
const EYES = AVATAR_EYES.length;
const COLORS = AVATAR_COLORS.length;
const COLOR_IDS = AVATAR_COLORS.map((color) => color.id);
/** Every head/eye/colour triple exactly once. */
const TRIPLES = HEADS * EYES * COLORS;

export function isGoalAvatar(value: unknown): value is GoalAvatar {
	if (!value || typeof value !== "object") return false;
	const record = value as Record<string, unknown>;
	return (AVATAR_HEADS as readonly unknown[]).includes(record.head)
		&& (AVATAR_EYES as readonly unknown[]).includes(record.eye)
		&& (COLOR_IDS as readonly unknown[]).includes(record.color);
}

export function avatarKey(avatar: GoalAvatar): string {
	return `${avatar.head}/${avatar.eye}/${avatar.color}`;
}

const mod = (value: number, size: number) => ((value % size) + size) % size;

/**
 * Candidate `index` walks every triple once. The head advances every step and the eye
 * and colour are rotated by it, so consecutive candidates differ in all three parts
 * and newly created Goals never look alike side by side.
 */
function candidate(index: number): GoalAvatar {
	const i = mod(index, TRIPLES);
	const h = i % HEADS;
	const a = Math.floor(i / HEADS) % EYES;
	const c = Math.floor(i / (HEADS * EYES));
	return {
		head: AVATAR_HEADS[h]!,
		eye: AVATAR_EYES[mod(a + h, EYES)]!,
		color: COLOR_IDS[mod(c + h + a, COLORS)]!,
	};
}

function candidateIndex(avatar: GoalAvatar): number {
	const h = AVATAR_HEADS.indexOf(avatar.head);
	const a = mod(AVATAR_EYES.indexOf(avatar.eye) - h, EYES);
	const c = mod(COLOR_IDS.indexOf(avatar.color) - h - a, COLORS);
	return h + a * HEADS + c * HEADS * EYES;
}

/**
 * Picks the next avatar that no listed Goal wears. Shape is what the eye separates at
 * rail size, so a head nobody uses comes first, then an eye nobody uses, then merely a
 * new triple; colour is the tie-breaker the walk itself provides. `after` continues the
 * walk past the current avatar, which is what a reroll wants.
 *
 * ponytail: once every triple is taken the walk wraps and duplicates; add a fourth
 * dimension (markings) before that happens.
 */
export function nextGoalAvatar(occupied: readonly GoalAvatar[], after?: GoalAvatar): GoalAvatar {
	const usedKeys = new Set(occupied.map(avatarKey));
	const usedHeads = new Set(occupied.map((avatar) => avatar.head));
	const usedEyes = new Set(occupied.map((avatar) => avatar.eye));
	const start = after ? candidateIndex(after) + 1 : 0;
	let newEye: GoalAvatar | undefined;
	let firstFree: GoalAvatar | undefined;
	for (let step = 0; step < TRIPLES; step += 1) {
		const next = candidate(start + step);
		if (usedKeys.has(avatarKey(next))) continue;
		if (!usedHeads.has(next.head)) return next;
		if (!usedEyes.has(next.eye)) newEye ??= next;
		firstFree ??= next;
	}
	return newEye ?? firstFree ?? candidate(start);
}
