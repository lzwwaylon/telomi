import type React from "react";

/**
 * The user's mouse and keyboard on a streamed browser page, as the Browser Session observation
 * stream and the source login stream both accept them: `input_mouse` and `input_keyboard` messages
 * in CSS pixels of the streamed page.
 */
export type Viewport = { width: number; height: number };

type Send = (message: Record<string, unknown>) => void;

/** A streamed frame, base64 as the stream sends it, as a bitmap ready to draw. */
export async function decodeFrame(data: string, mimeType: string): Promise<ImageBitmap> {
	const binary = atob(data);
	const bytes = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
	return createImageBitmap(new Blob([bytes], { type: mimeType }));
}

export function sendMouse(
	event: React.PointerEvent<HTMLCanvasElement>,
	eventType: "mousePressed" | "mouseReleased" | "mouseMoved",
	send: Send,
	viewport: Viewport,
): void {
	event.preventDefault();
	event.currentTarget.focus();
	if (eventType === "mousePressed") event.currentTarget.setPointerCapture(event.pointerId);
	const point = canvasPoint(event.currentTarget, event.clientX, event.clientY, viewport);
	send({
		type: "input_mouse",
		eventType,
		...point,
		button: event.button === 1 ? "middle" : event.button === 2 ? "right" : "left",
		clickCount: eventType === "mousePressed" ? 1 : 0,
		modifiers: modifiers(event),
	});
}

export function sendWheel(
	event: React.WheelEvent<HTMLCanvasElement>,
	send: Send,
	viewport: Viewport,
): void {
	event.preventDefault();
	send({
		type: "input_mouse",
		eventType: "mouseWheel",
		...canvasPoint(event.currentTarget, event.clientX, event.clientY, viewport),
		button: "none",
		clickCount: 0,
		deltaX: event.deltaX,
		deltaY: event.deltaY,
		modifiers: modifiers(event),
	});
}

export function sendKey(
	event: React.KeyboardEvent<HTMLCanvasElement>,
	eventType: "keyDown" | "keyUp",
	send: Send,
): void {
	event.preventDefault();
	event.stopPropagation();
	send({
		type: "input_keyboard",
		eventType,
		key: event.key,
		code: event.code,
		...(eventType === "keyDown" && event.key.length === 1 ? { text: event.key } : {}),
		windowsVirtualKeyCode: event.keyCode,
		modifiers: modifiers(event),
	});
}

/** Map a pointer position on the scaled canvas to CSS pixels of the Agent page. */
export function canvasPoint(canvas: HTMLCanvasElement, clientX: number, clientY: number, viewport: Viewport): { x: number; y: number } {
	const rect = canvas.getBoundingClientRect();
	return {
		x: Math.round((clientX - rect.left) * viewport.width / rect.width),
		y: Math.round((clientY - rect.top) * viewport.height / rect.height),
	};
}

export function modifiers(event: { altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }): number {
	return (event.altKey ? 1 : 0) | (event.ctrlKey ? 2 : 0) | (event.metaKey ? 4 : 0) | (event.shiftKey ? 8 : 0);
}
