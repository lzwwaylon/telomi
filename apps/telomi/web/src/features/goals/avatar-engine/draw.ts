import { mix } from "./birds";
import type { Bird, Mood, Pose } from "./moods";
import { CENTRE, GAZE, frameFor, headPath, lensPath, type Dot } from "./shapes";

/**
 * The SVG one bird lives in, and how a pose is written onto it. Everything that can be
 * built once is built once: only transforms, the two eye paths and the effect dots are
 * touched per frame, so a rail of birds costs attribute writes rather than DOM churn.
 */

const NS = "http://www.w3.org/2000/svg";
const RAD = Math.PI / 180;
/** A head never changes shape, and a rail shows several birds cut from the same catalog. */
const HEAD_CACHE = new Map<string, string>();

function node<K extends keyof SVGElementTagNameMap>(name: K, attrs: Record<string, string | number> = {}): SVGElementTagNameMap[K] {
	const element = document.createElementNS(NS, name);
	for (const [key, value] of Object.entries(attrs)) element.setAttribute(key, String(value));
	return element;
}

function dotNode(dot: Dot, size: number, fill: string): SVGCircleElement {
	return node("circle", { cx: dot.dx * size, cy: dot.dy * size, r: dot.r * size, fill });
}

interface Eye {
	group: SVGGElement;
	lens: SVGPathElement;
	/** Present on the layered eyeballs; it carries the gaze instead of the whole eye. */
	iris: SVGGElement | null;
	shine: SVGCircleElement | null;
}

/** Clip paths need document-unique ids, and a page can show any number of birds. */
let eyeCount = 0;

function buildEye(bird: Bird, size: number): Eye {
	const style = bird.eyeStyle;
	const id = `avatar-eye-${eyeCount += 1}`;
	const group = node("g");
	const lens = node("path", style.pupil
		? { id, fill: style.pupil.socket, stroke: bird.palette.outline.color, "stroke-width": 1.8, "stroke-linejoin": "round" }
		: { id, fill: bird.palette.eye });
	// Whatever sits on the eye is clipped to the lens itself: a narrow or half-shut eye would
	// otherwise leave its catchlight floating on the bird's forehead.
	const clip = node("clipPath", { id: `${id}-clip` });
	clip.append(node("use", { href: `#${id}` }));
	const inner = node("g", { "clip-path": `url(#${id}-clip)` });
	group.append(clip, lens, inner);
	let iris: SVGGElement | null = null;
	let shine: SVGCircleElement | null = null;
	if (style.pupil) {
		iris = node("g");
		iris.append(node("circle", { r: style.pupil.irisR * size, fill: style.pupil.irisColor }));
		iris.append(node("circle", { r: style.pupil.pupilR * size, fill: mix(style.pupil.irisColor, "#000000", 0.5) }));
		for (const dot of style.pupil.highlights ?? []) iris.append(dotNode(dot, size, bird.palette.eyeHighlight));
		inner.append(iris);
	} else if (style.highlight) {
		shine = dotNode(style.highlight, size, bird.palette.eyeHighlight);
		inner.append(shine);
	}
	return { group, lens, iris, shine };
}

export interface View {
	apply(mood: Mood, pose: Pose, clock: number): void;
	destroy(): void;
}

/**
 * `eyeScale` enlarges the eyes, which is what keeps them readable below 80px; `lite` drops
 * the effect particles and the zzz letters for birds at the edge of attention.
 */
export function createView(host: HTMLElement, bird: Bird, eyeScale: number, lite: boolean): View {
	const size = eyeScale * bird.face.eye;
	let path = HEAD_CACHE.get(bird.id);
	if (!path) HEAD_CACHE.set(bird.id, path = headPath(bird.body));
	const svg = node("svg", { viewBox: frameFor(path), width: "100%", height: "100%" });
	svg.style.display = "block";
	svg.style.pointerEvents = "none";

	const head = node("path", {
		d: path,
		stroke: bird.palette.outline.color,
		"stroke-width": bird.palette.outline.width,
		"stroke-linejoin": "round",
	});
	// The body colour is the one thing CSS can carry on its own across an emotion change.
	head.style.transition = "fill 260ms ease";

	const face = node("g", {
		transform: `translate(${bird.face.x} ${bird.face.y}) scale(${bird.face.sx} ${bird.face.sy})`,
	});
	const eyes = [buildEye(bird, size), buildEye(bird, size)];
	face.append(eyes[0]!.group, eyes[1]!.group);

	const body = node("g");
	body.append(head, face);
	const fx = node("g");
	svg.append(body, fx);
	host.replaceChildren(svg);

	let lensKey = "";
	let fill = "";
	let effect = "";
	let motes: SVGElement[] = [];

	function paintEyes(pose: Pose): void {
		const style = bird.eyeStyle;
		const key = `${pose.open.toFixed(2)}:${pose.lid.toFixed(2)}:${pose.arch.toFixed(2)}`;
		if (key !== lensKey) {
			lensKey = key;
			const shape = lensPath(style, size * pose.open, pose.lid, pose.arch);
			for (const eye of eyes) eye.lens.setAttribute("d", shape);
		}
		// A layered eyeball shows where it looks with its iris, so the socket barely moves.
		const pull = style.pupil ? 0.3 : 1;
		const shrink = Math.max(0, 1 - pose.lid * 1.7);
		for (const [index, eye] of eyes.entries()) {
			const side = index === 0 ? 1 : -1;
			const x = CENTRE + side * style.dx + pose.gazeX * GAZE.x * pull;
			eye.group.setAttribute("transform", `translate(${x} ${style.cy + pose.gazeY * GAZE.y * pull}) scale(${side} 1) rotate(${style.tilt ?? 0})`);
			if (eye.iris) {
				eye.iris.setAttribute("transform", `translate(${side * pose.gazeX * GAZE.x * 0.7} ${pose.gazeY * GAZE.y * 0.7}) scale(${shrink.toFixed(3)})`);
				eye.iris.setAttribute("opacity", shrink < 0.3 ? "0" : "1");
			}
			// A paper dot floating on a shut eye reads as an open one.
			eye.shine?.setAttribute("opacity", pose.lid > 0.7 ? "0" : "1");
		}
	}

	function paintEffect(mood: Mood, clock: number): void {
		const count = Math.min(6, mood.sparkle * 2);
		const want = lite ? "" : mood.zzz ? "zzz" : count > 0 ? `dust${count}` : "";
		if (want !== effect) {
			effect = want;
			motes = want === "zzz"
				? [0, 1, 2].map(() => {
					const letter = node("text", {
						fill: bird.palette.zzz, "font-weight": 700, "text-anchor": "middle",
						"font-family": "ui-sans-serif, system-ui, sans-serif",
					});
					letter.textContent = "z";
					return letter as SVGElement;
				})
				: want
					? Array.from({ length: count }, () => node("circle", { fill: bird.palette.states.base ?? bird.palette.body }) as SVGElement)
					: [];
			fx.replaceChildren(...motes);
		}
		for (const [index, item] of motes.entries()) {
			// Each mote runs the same rise on its own offset, so the group never pulses in step.
			const life = (clock / (effect === "zzz" ? 2400 : 1600) + index / motes.length) % 1;
			const fade = Math.sin(Math.PI * life);
			item.setAttribute("opacity", (fade * 0.9).toFixed(2));
			if (effect === "zzz") {
				item.setAttribute("x", String(176 + life * 34));
				item.setAttribute("y", String(72 - life * 54));
				item.setAttribute("font-size", String(15 + life * 15));
			} else {
				const angle = (-165 + index * (150 / Math.max(1, motes.length - 1))) * RAD;
				const reach = 98 + life * 20;
				item.setAttribute("cx", (CENTRE + Math.cos(angle) * reach).toFixed(1));
				item.setAttribute("cy", (CENTRE + Math.sin(angle) * reach - life * 14).toFixed(1));
				item.setAttribute("r", (2.2 + 1.8 * fade).toFixed(1));
			}
		}
	}

	return {
		apply(mood, pose, clock) {
			body.setAttribute(
				"transform",
				`translate(${pose.x.toFixed(2)} ${pose.y.toFixed(2)}) translate(${CENTRE} ${CENTRE})`
				// Turning and swelling about the head's own centre keeps every pose inside the frame.
				+ ` rotate(${pose.tilt.toFixed(2)}) scale(${pose.scale.toFixed(3)}) translate(${-CENTRE} ${-CENTRE})`,
			);
			const next = bird.palette.states[mood.state] ?? bird.palette.body;
			if (next !== fill) head.setAttribute("fill", fill = next);
			paintEyes(pose);
			paintEffect(mood, clock);
		},
		destroy() {
			svg.remove();
		},
	};
}
