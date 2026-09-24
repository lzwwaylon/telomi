import type { Server as HttpServer } from "node:http";
import type { Duplex } from "node:stream";

import { Router } from "express";
import WebSocket, { WebSocketServer, type RawData } from "ws";

import type { BrowserSessionRegistry } from "./session-registry.js";
import { toErrorMessage } from "../../lib/values.js";

const STREAM_PATH = /^\/api\/goals\/([^/]+)\/browser-sessions\/([^/]+)\/stream$/u;
const SESSION_ID = /^[A-Za-z0-9_-]{1,80}$/u;
const MAX_STREAM_MESSAGE_BYTES = 8 * 1024 * 1024;

export function createBrowserObservationRouter(
	registry: BrowserSessionRegistry,
	goalExists: (goalId: string) => boolean,
): Router {
	const router = Router();
	router.get("/api/browser-sessions", async (_request, response) => {
		response.json({ sessions: await registry.describeActive() });
	});
	router.get("/api/goals/:goalId/browser-sessions", async (request, response) => {
		if (!goalExists(request.params.goalId)) return void response.status(404).json({ error: "Unknown goal" });
		response.json({ sessions: await registry.describeAll(request.params.goalId) });
	});
	return router;
}

export function attachBrowserObservationServer(
	httpServer: HttpServer,
	registry: BrowserSessionRegistry,
	goalExists: (goalId: string) => boolean,
): { close(): void } {
	const webSocketServer = new WebSocketServer({
		noServer: true,
		maxPayload: MAX_STREAM_MESSAGE_BYTES,
		perMessageDeflate: false,
	});
	const controllers = new Map<string, WebSocket>();
	const onUpgrade = (request: import("node:http").IncomingMessage, socket: Duplex, head: Buffer) => {
		const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
		const match = url.pathname.match(STREAM_PATH);
		if (!match) return;
		let goalId: string;
		let sessionId: string;
		try {
			goalId = decodeURIComponent(match[1]!);
			sessionId = decodeURIComponent(match[2]!);
		} catch {
			rejectUpgrade(socket, 400, "Invalid Browser Session path");
			return;
		}
		if (!goalExists(goalId)) return rejectUpgrade(socket, 404, "Unknown goal");
		if (!SESSION_ID.test(sessionId)) return rejectUpgrade(socket, 400, "Invalid Browser Session id");
		const port = registry.streamPort(goalId, sessionId);
		if (!port) return rejectUpgrade(socket, 409, "Browser Session stream is not ready");
		webSocketServer.handleUpgrade(request, socket, head, (client) => {
			proxyBrowserStream(client, registry, controllers, goalId, sessionId, port);
		});
	};
	httpServer.on("upgrade", onUpgrade);
	return {
		close: () => {
			httpServer.off("upgrade", onUpgrade);
			for (const client of webSocketServer.clients) client.close(1001, "server shutdown");
			webSocketServer.close();
		},
	};
}

function proxyBrowserStream(
	client: WebSocket,
	registry: BrowserSessionRegistry,
	controllers: Map<string, WebSocket>,
	goalId: string,
	sessionId: string,
	port: number,
): void {
	const controlKey = `${goalId}\0${sessionId}`;
	let closed = false;
	const upstream = new WebSocket(`ws://127.0.0.1:${port}/?pacing=ack&maxFps=30`, {
		origin: "http://127.0.0.1",
		maxPayload: MAX_STREAM_MESSAGE_BYTES,
		perMessageDeflate: false,
	});
	upstream.once("open", () => {
		void registry.screenshotSession(goalId, sessionId).then((png) => {
			if (!png || client.readyState !== WebSocket.OPEN) return;
			client.send(JSON.stringify({
				type: "frame",
				seq: 0,
				data: png.toString("base64"),
				mimeType: "image/png",
				source: "snapshot",
				metadata: { timestamp: Date.now() },
			}));
		}).catch(() => undefined);
	});
	upstream.on("message", (data, isBinary) => {
		if (isBinary || client.readyState !== WebSocket.OPEN) return;
		const message = sanitizeServerMessage(data);
		if (message) client.send(JSON.stringify(message));
	});
	client.on("message", async (data, isBinary) => {
		if (isBinary) return;
		const value = parseObject(data);
		if (value?.type === "control" && (value.control === "agent" || value.control === "user")) {
			try {
				if (value.control === "user") {
					const current = controllers.get(controlKey);
					if (current && current !== client) throw new Error("Browser Session is already controlled in another window");
					controllers.set(controlKey, client);
					await registry.setControl(goalId, sessionId, "user");
					if (closed) {
						controllers.delete(controlKey);
						await registry.setControl(goalId, sessionId, "agent");
						return;
					}
				} else {
					if (controllers.get(controlKey) !== client) throw new Error("This window does not own Browser control");
					controllers.delete(controlKey);
					await registry.setControl(goalId, sessionId, "agent");
				}
				if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify({ type: "control", control: value.control }));
			} catch (error) {
				if (controllers.get(controlKey) === client && value.control === "user") controllers.delete(controlKey);
				if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify({
					type: "control_error",
					message: toErrorMessage(error),
				}));
			}
			return;
		}
		if (upstream.readyState !== WebSocket.OPEN) return;
		const ownsControl = controllers.get(controlKey) === client && registry.canAcceptUserInput(goalId, sessionId);
		const message = sanitizeClientMessage(data, ownsControl);
		if (message) upstream.send(JSON.stringify(message));
	});
	upstream.once("error", () => client.close(1011, "Browser stream unavailable"));
	upstream.once("close", () => client.close(1001, "Browser Session ended"));
	client.once("close", () => {
		closed = true;
		upstream.close();
		if (controllers.get(controlKey) === client) {
			controllers.delete(controlKey);
			void registry.setControl(goalId, sessionId, "agent").catch(() => undefined);
		}
	});
}

function sanitizeServerMessage(data: RawData): Record<string, unknown> | undefined {
	const value = parseObject(data);
	if (!value || typeof value.type !== "string") return undefined;
	switch (value.type) {
		case "frame":
			return typeof value.data === "string" && Number.isSafeInteger(value.seq)
				? {
					type: "frame", seq: value.seq, data: value.data,
					mimeType: "image/jpeg", source: "stream",
					metadata: sanitizeFrameMetadata(value.metadata),
				}
				: undefined;
		case "status":
			return {
				type: "status",
				connected: value.connected === true,
				screencasting: value.screencasting === true,
				viewportWidth: boundedNumber(value.viewportWidth, 1, 10_000, 1280),
				viewportHeight: boundedNumber(value.viewportHeight, 1, 10_000, 720),
			};
		case "url":
			return typeof value.url === "string" ? { type: "url", url: sanitizeUrl(value.url) } : undefined;
		case "tabs":
			return Array.isArray(value.tabs) ? {
				type: "tabs",
				tabs: value.tabs.slice(0, 32).flatMap((tab) => sanitizeTab(tab)),
			} : undefined;
		case "command":
			// Every CLI invocation first announces a `launch`; it is bootstrapping, not an Agent action.
			return typeof value.action === "string" && value.action !== "launch" && typeof value.id === "string" ? {
				type: "command",
				action: value.action.slice(0, 80),
				id: value.id.slice(0, 120),
				timestamp: boundedNumber(value.timestamp, 0, Number.MAX_SAFE_INTEGER, Date.now()),
			} : undefined;
		case "result":
			return typeof value.action === "string" && value.action !== "launch" && typeof value.id === "string" ? {
				type: "result",
				action: value.action.slice(0, 80),
				id: value.id.slice(0, 120),
				// agent-browser 0.34 reports `success: false` on every streamed result; a failed
				// command is the one whose `data` is null.
				success: value.success === true || (value.data !== null && value.data !== undefined),
				durationMs: boundedNumber(value.duration_ms, 0, 86_400_000, 0),
				timestamp: boundedNumber(value.timestamp, 0, Number.MAX_SAFE_INTEGER, Date.now()),
			} : undefined;
		default:
			return undefined;
	}
}

export function sanitizeClientMessage(data: RawData, acceptsInput: boolean): Record<string, unknown> | undefined {
	const value = parseObject(data);
	if (!value || typeof value.type !== "string") return undefined;
	if (value.type === "ack" && Number.isSafeInteger(value.seq) && Number(value.seq) >= 0) {
		return { type: "ack", seq: value.seq };
	}
	if (value.type === "config") {
		return {
			type: "config",
			pacing: "ack",
			maxFps: boundedNumber(value.maxFps, 1, 30, 30),
		};
	}
	if (!acceptsInput) return undefined;
	if (value.type === "input_mouse" && typeof value.eventType === "string") {
		const eventType = new Set(["mouseMoved", "mousePressed", "mouseReleased", "mouseWheel"]).has(value.eventType)
			? value.eventType
			: undefined;
		if (!eventType) return undefined;
		return {
			type: "input_mouse",
			eventType,
			x: boundedNumber(value.x, 0, 10_000, 0),
			y: boundedNumber(value.y, 0, 10_000, 0),
			button: new Set(["none", "left", "middle", "right"]).has(String(value.button)) ? value.button : "none",
			clickCount: boundedNumber(value.clickCount, 0, 3, 0),
			deltaX: boundedNumber(value.deltaX, -10_000, 10_000, 0),
			deltaY: boundedNumber(value.deltaY, -10_000, 10_000, 0),
			modifiers: boundedNumber(value.modifiers, 0, 15, 0),
		};
	}
	if (value.type === "input_keyboard" && typeof value.eventType === "string") {
		const eventType = new Set(["keyDown", "keyUp", "char"]).has(value.eventType) ? value.eventType : undefined;
		if (!eventType) return undefined;
		return {
			type: "input_keyboard",
			eventType,
			...boundedText(value.key, 64, "key"),
			...boundedText(value.code, 64, "code"),
			...boundedText(value.text, 4_096, "text"),
			windowsVirtualKeyCode: boundedNumber(value.windowsVirtualKeyCode, 0, 255, 0),
			modifiers: boundedNumber(value.modifiers, 0, 15, 0),
		};
	}
	return undefined;
}

function sanitizeFrameMetadata(value: unknown): Record<string, number> {
	const metadata = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
	return {
		deviceWidth: boundedNumber(metadata.deviceWidth, 1, 10_000, 1280),
		deviceHeight: boundedNumber(metadata.deviceHeight, 1, 10_000, 720),
		timestamp: boundedNumber(metadata.timestamp, 0, Number.MAX_SAFE_INTEGER, Date.now()),
	};
}

function sanitizeTab(value: unknown): Array<Record<string, unknown>> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return [];
	const tab = value as Record<string, unknown>;
	if (typeof tab.tabId !== "string" || typeof tab.url !== "string") return [];
	return [{
		tabId: tab.tabId.slice(0, 80),
		title: typeof tab.title === "string" ? tab.title.slice(0, 300) : "",
		url: sanitizeUrl(tab.url),
		active: tab.active === true,
	}];
}

function sanitizeUrl(value: string): string {
	try {
		const url = new URL(value);
		if (url.protocol === "http:" || url.protocol === "https:") return `${url.origin}${url.pathname}`;
		if (url.protocol === "about:") return `${url.protocol}${url.pathname}`;
		return url.protocol;
	} catch {
		return "";
	}
}

function boundedText(value: unknown, max: number, key: string): Record<string, string> {
	return typeof value === "string" && value.length <= max ? { [key]: value } : {};
}

function boundedNumber(value: unknown, min: number, max: number, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}

function parseObject(data: RawData): Record<string, unknown> | undefined {
	try {
		const value = JSON.parse(data.toString()) as unknown;
		return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
	} catch {
		return undefined;
	}
}

export function rejectUpgrade(socket: Duplex, status: number, message: string): void {
	socket.end(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}
