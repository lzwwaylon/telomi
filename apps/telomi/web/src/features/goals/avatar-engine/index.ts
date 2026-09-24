import type { GoalAvatar } from "@shared/avatar";
import { birdCharacter, characterId } from "./birds";
import { createView } from "./draw";
import { blend, moodOf, posture, type Bird, type Mood, type Pose } from "./moods";

/**
 * The door to the Goal avatar engine: register a bird, mount it in a host element, and
 * feed it emotions. Everything below is an ordinary browser module tree, loaded by
 * `BirdAvatar.tsx` through a dynamic import, so nothing here touches the server bundle.
 */

export interface Mate {
	setEmotion(id: string): void;
	destroy(): void;
}

interface CreateOptions {
	character: string;
	emotion: string;
	/** Eye enlargement; below 80px the eyes need about 1.4 to stay readable. */
	eyeScale?: number;
	/** false renders one settled frame and never animates. */
	autostart?: boolean;
	/** Drops effect particles and zzz; what a bird at the edge of attention gets. */
	lite?: boolean;
}

const birds = new Map<string, Bird>();

/** Registers the avatar's bird on first use; the engine caches its head path per character. */
export function birdCharacterId(avatar: GoalAvatar): string {
	const id = characterId(avatar);
	if (!birds.has(id)) birds.set(id, birdCharacter(avatar));
	return id;
}

/** How long an emotion change takes to cross over. Matches the fill transition in draw.ts. */
const BLEND_MS = 260;
const BLINK_MS = 140;

export function createMate(host: HTMLElement, options: CreateOptions): Mate {
	const bird = birds.get(options.character);
	if (!bird) throw new Error(`avatar character ${options.character} was not registered`);
	const still = options.autostart === false;
	const view = createView(host, bird, options.eyeScale ?? 1, options.lite === true);
	// Birds standing in a rail must not blink in chorus, so each one keeps its own rhythm.
	const blinkEvery = 2600 + Math.random() * 2200;
	const blinkFrom = Math.random() * blinkEvery;

	let mood: Mood = moodOf(bird, options.emotion);
	let emotion = options.emotion;
	let started = now();
	let from: Pose | null = null;
	let last: Pose = posture(mood, 0, still);
	let frame = 0;

	function draw(time: number): void {
		const elapsed = time - started;
		let pose = posture(mood, elapsed, still);
		if (from) {
			const ratio = elapsed / BLEND_MS;
			if (ratio >= 1) from = null;
			else pose = blend(from, pose, ratio);
		}
		last = pose;
		if (mood.blink && !still) {
			const since = (time + blinkFrom) % blinkEvery;
			// One brief close on the mate's own clock; a mood that already narrows the eyes keeps its own lid.
			if (since < BLINK_MS) pose = { ...pose, lid: Math.max(pose.lid, Math.sin((since / BLINK_MS) * Math.PI)) };
		}
		view.apply(mood, pose, elapsed);
	}

	function loop(time: number): void {
		draw(time);
		frame = requestAnimationFrame(loop);
	}

	draw(started);
	if (!still) frame = requestAnimationFrame(loop);

	return {
		setEmotion(id) {
			if (id === emotion) return;
			emotion = id;
			mood = moodOf(bird, id);
			// Cross over from wherever the bird stands, so a change never snaps or rebuilds the SVG.
			from = still ? null : last;
			started = now();
			if (still) draw(started);
		},
		destroy() {
			cancelAnimationFrame(frame);
			view.destroy();
		},
	};
}

function now(): number {
	return typeof performance === "undefined" ? Date.now() : performance.now();
}
