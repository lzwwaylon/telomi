import type { Request, Response } from "express";

const MAX_PENDING_BYTES = 8 * 1024 * 1024;

export interface SseConnection {
	send: (payload: unknown, id?: string | number) => boolean;
	close: () => void;
	onClose: (listener: () => void) => void;
}

export function openSse(
	req: Request,
	res: Response,
	options: { heartbeatMs?: number } = {},
): SseConnection {
	res.set({
		"Content-Type": "text/event-stream",
		"Cache-Control": "no-cache, no-transform",
		Connection: "keep-alive",
		"X-Accel-Buffering": "no",
	});
	res.flushHeaders?.();
	let closed = false;
	let backpressured = false;
	let pendingBytes = 0;
	const pendingFrames: string[] = [];
	const listeners = new Set<() => void>();
	const close = () => {
		if (closed) return;
		closed = true;
		clearInterval(heartbeat);
		res.off("drain", flushPending);
		pendingFrames.length = 0;
		pendingBytes = 0;
		for (const listener of listeners) {
			try { listener(); } catch { /* cleanup listeners are isolated */ }
		}
		listeners.clear();
		if (!res.writableEnded) res.end();
	};
	function flushPending(): void {
		if (closed) return;
		if (res.writableEnded) {
			close();
			return;
		}
		backpressured = false;
		while (pendingFrames.length > 0) {
			const frame = pendingFrames.shift()!;
			pendingBytes -= Buffer.byteLength(frame);
			try {
				if (!res.write(frame)) {
					backpressured = true;
					return;
				}
			} catch {
				close();
				return;
			}
		}
	}
	const write = (frame: string) => {
		if (closed || res.writableEnded) return false;
		if (backpressured) {
			const frameBytes = Buffer.byteLength(frame);
			if (pendingBytes + frameBytes > MAX_PENDING_BYTES) {
				close();
				return false;
			}
			pendingFrames.push(frame);
			pendingBytes += frameBytes;
			return true;
		}
		try {
			backpressured = !res.write(frame);
		} catch {
			close();
			return false;
		}
		return true;
	};
	const heartbeatMs = options.heartbeatMs ?? 15_000;
	const heartbeat = setInterval(() => write(`: ping ${Date.now()}\n\n`), heartbeatMs);
	heartbeat.unref?.();
	res.on("drain", flushPending);
	req.once("close", close);
	res.once("error", close);
	return {
		send: (payload, id) => write(`${id === undefined ? "" : `id: ${id}\n`}data: ${JSON.stringify(payload)}\n\n`),
		close,
		onClose: (listener) => {
			if (closed) listener();
			else listeners.add(listener);
		},
	};
}
