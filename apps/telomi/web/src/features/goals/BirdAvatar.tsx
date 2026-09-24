import { useEffect, useMemo, useRef } from "react";

import type { GoalAvatar as GoalAvatarLook } from "@shared/avatar";

export interface BirdAvatarProps {
	look: GoalAvatarLook;
	/** Emotion id, see `avatar-signals.ts`. */
	emotion: string;
	size: number | string;
	/**
	 * Draws one settled frame and never animates. Users who asked for reduced motion
	 * still get the right pose.
	 */
	still?: boolean;
	/** Effects particles and zzz are for the bot in focus; a rail full of them would flicker. */
	effects?: boolean;
	className?: string;
	label?: string;
}

function prefersReducedMotion(): boolean {
	return typeof window !== "undefined"
		&& typeof window.matchMedia === "function"
		&& window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * A bird from the avatar engine as a React component. The engine owns the SVG it
 * mounts into the host element; this component only creates it in the browser, feeds it
 * emotion changes and tears it down. On the server and in tests the host renders empty,
 * carrying the look and emotion as data attributes.
 */
export function BirdAvatar({ look, emotion, size, still = false, effects = false, className, label }: BirdAvatarProps) {
	const host = useRef<HTMLDivElement>(null);
	const mate = useRef<{ setEmotion(id: string): void; destroy(): void } | null>(null);
	// The engine loads asynchronously; without this a change that lands first would be lost.
	const wanted = useRef(emotion);
	const frozen = still || prefersReducedMotion();
	const box = useMemo(() => ({ width: size, height: size }), [size]);

	useEffect(() => {
		const element = host.current;
		if (!element) return;
		let cancelled = false;
		// The engine is browser-only, so it stays out of the server bundle and loads once, on first use.
		void import("./avatar-engine").then(({ birdCharacterId, createMate }) => {
			if (cancelled) return;
			mate.current = createMate(element, {
				character: birdCharacterId(look),
				// The emotion as of now, not as of the render that started the import.
				emotion: wanted.current,
				eyeScale: 1.4,
				autostart: !frozen,
				lite: !effects,
			});
			// The host is the image; the engine's SVG must not announce its own name and zzz letters.
			element.querySelector("svg")?.setAttribute("aria-hidden", "true");
		});
		return () => {
			cancelled = true;
			mate.current?.destroy();
			mate.current = null;
			element.replaceChildren();
		};
		// The emotion is fed through setEmotion below; recreating the bot for it would drop the transition.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [look.head, look.eye, look.color, frozen, effects]);

	useEffect(() => {
		wanted.current = emotion;
		mate.current?.setEmotion(emotion);
	}, [emotion]);

	return (
		<div
			ref={host}
			className={className}
			style={box}
			role="img"
			aria-label={label}
			data-avatar-head={look.head}
			data-avatar-eye={look.eye}
			data-avatar-emotion={emotion}
		/>
	);
}
