import assert from "node:assert/strict";
import type React from "react";
import test from "node:test";

import { sendPointerMove } from "../../web/src/shared/lib/browser-input.js";

// A streamed browser page needs hover moves to show hover states, but a pointer reports far more
// moves than the stream can show: they are coalesced to the latest one per animation frame.
test("pointer moves reach the streamed page, at most one per animation frame, hover included", () => {
	const frames: Array<() => void> = [];
	const originalRaf = globalThis.requestAnimationFrame;
	globalThis.requestAnimationFrame = ((callback: () => void) => frames.push(callback)) as typeof requestAnimationFrame;
	try {
		const canvas = { getBoundingClientRect: () => ({ left: 0, top: 0, width: 440, height: 320 }) } as HTMLCanvasElement;
		const move = (clientX: number, buttons = 0) => ({
			currentTarget: canvas, clientX, clientY: 10, buttons, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false,
		}) as unknown as React.PointerEvent<HTMLCanvasElement>;
		const sent: Array<Record<string, unknown>> = [];
		const send = (message: Record<string, unknown>) => sent.push(message);
		const viewport = { width: 880, height: 640 };

		for (const x of [1, 2, 3]) sendPointerMove(move(x), send, viewport);
		assert.equal(frames.length, 1, "one frame is scheduled for a burst of moves");
		assert.equal(sent.length, 0);
		frames.shift()!();
		assert.deepEqual(sent, [{ type: "input_mouse", eventType: "mouseMoved", x: 6, y: 20, button: "none", clickCount: 0, modifiers: 0 }]);

		sendPointerMove(move(100, 1), send, viewport);
		frames.shift()!();
		assert.equal(sent[1]?.button, "left", "a drag carries its button");
		assert.equal(frames.length, 0);
	} finally {
		globalThis.requestAnimationFrame = originalRaf;
	}
});
