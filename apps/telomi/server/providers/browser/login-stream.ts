/**
 * Log in to the browser-backed sources inside Telomi's own browser, from the settings page.
 *
 * The browser host is headless, so its page is streamed: one tab is opened, its screencast goes to
 * the settings page and the user's mouse and keyboard come back, over the same message shapes the
 * Browser Session observation stream uses. The tab is sent to the login page of each source that
 * is not logged in yet, one after another, and the stream ends by itself once every source's login
 * cookie exists; the settings page then asks for a verification, which re-reads the browser
 * session. The user sees a login form and nothing else. Nothing typed is stored or logged here.
 */
import type { IncomingMessage, Server as HttpServer } from "node:http";
import type { Duplex } from "node:stream";

import WebSocket, { WebSocketServer } from "ws";

import { toErrorMessage } from "../../lib/values.js";
import { SOURCE_DESCRIPTORS, type SourceDescriptor } from "../source-descriptors.js";
import { rejectUpgrade, sanitizeClientMessage } from "./observation-server.js";

export const BROWSER_LOGIN_STREAM_PATH = "/api/sources/browser/login/stream";
const VIEWPORT = { width: 880, height: 640 };
const LOGIN_POLL_MS = 1_000;
const MAX_MESSAGE_BYTES = 64 * 1024;

export interface BrowserLoginDependencies {
	cdpUrl: () => string;
	/** Whether the source's last verification passed. A login cookie the source rejects is stale. */
	sourceVerified: (sourceId: string) => boolean;
	/** The sources to log in to; every descriptor with a `login` unless given. */
	logins?: BrowserLogin[];
}

type BrowserLogin = { id: string } & NonNullable<SourceDescriptor["login"]>;

/** The sources the user can log in to in the browser, with the page to send it to for each. */
function browserLogins(): BrowserLogin[] {
	return SOURCE_DESCRIPTORS.flatMap((source) => source.login ? [{ id: source.id, ...source.login }] : []);
}

export function attachBrowserLoginServer(httpServer: HttpServer, deps: BrowserLoginDependencies): { close(): void } {
	const webSocketServer = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES, perMessageDeflate: false });
	let open = false;
	const onUpgrade = (request: IncomingMessage, socket: Duplex, head: Buffer) => {
		const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
		if (url.pathname !== BROWSER_LOGIN_STREAM_PATH) return;
		if (open) return rejectUpgrade(socket, 409, "The browser login is already open in another window");
		webSocketServer.handleUpgrade(request, socket, head, (client) => {
			open = true;
			client.once("close", () => { open = false; });
			void runLogin(client, deps).catch((error) => {
				if (client.readyState === WebSocket.OPEN) client.close(1011, toErrorMessage(error).slice(0, 120));
			});
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

async function runLogin(client: WebSocket, deps: BrowserLoginDependencies): Promise<void> {
	const logins = deps.logins ?? browserLogins();
	const send = (message: Record<string, unknown>) => {
		if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(message));
	};
	const cdp = await connectCdp(deps.cdpUrl());
	let targetId: string | undefined;
	try {
		targetId = (await cdp.call("Target.createTarget", { url: "about:blank" }) as { targetId: string }).targetId;
		const sessionId = (await cdp.call("Target.attachToTarget", { targetId, flatten: true }) as { sessionId: string }).sessionId;
		const page = (method: string, params?: Record<string, unknown>) => cdp.call(method, params, sessionId);
		let seq = 0;
		cdp.onEvent((method, params, session) => {
			if (session !== sessionId) return;
			if (method === "Page.screencastFrame") {
				const frame = params as { data: string; sessionId: number; metadata: { deviceWidth: number; deviceHeight: number } };
				seq += 1;
				send({
					type: "frame", seq, data: frame.data, mimeType: "image/jpeg", source: "stream",
					metadata: { deviceWidth: frame.metadata.deviceWidth, deviceHeight: frame.metadata.deviceHeight, timestamp: Date.now() },
				});
				void page("Page.screencastFrameAck", { sessionId: frame.sessionId }).catch(() => undefined);
			} else if (method === "Page.frameNavigated") {
				const frame = (params as { frame: { url: string; parentId?: string } }).frame;
				if (!frame.parentId) send({ type: "url", url: frame.url });
			}
		});
		client.on("message", (data, isBinary) => {
			if (isBinary) return;
			const message = sanitizeClientMessage(data, true);
			if (message?.type === "input_mouse") {
				const { type: _type, eventType, ...rest } = message;
				void page("Input.dispatchMouseEvent", { type: eventType, ...rest }).catch(() => undefined);
			} else if (message?.type === "input_keyboard") {
				const { type: _type, eventType, ...rest } = message;
				// Enter only submits a form when it also arrives as text, which the page never sends.
				const text = rest.text ?? (eventType === "keyDown" && rest.key === "Enter" ? "\r" : undefined);
				void page("Input.dispatchKeyEvent", { type: eventType, ...rest, ...(text === undefined ? {} : { text }) }).catch(() => undefined);
			}
		});
		await page("Emulation.setDeviceMetricsOverride", { ...VIEWPORT, deviceScaleFactor: 1, mobile: false });
		await page("Page.enable");
		// Started on the blank tab: while a cross-site navigation swaps the page's renderer, Chrome
		// rejects a screencast start ("Not attached to an active page"); one already running carries on.
		await page("Page.startScreencast", { format: "jpeg", quality: 75, maxWidth: VIEWPORT.width, maxHeight: VIEWPORT.height, everyNthFrame: 1 });
		type Cookie = { domain: string; name: string; path: string };
		const allCookies = async () => (await cdp.call("Storage.getCookies") as { cookies: Cookie[] }).cookies;
		// Polled every second while the user types: ask only for the login sites' cookies. The whole
		// jar of a profile synced from the user's browser is thousands of cookies, about 1 MB a call.
		const loginUrls = logins.map((login) => `https://${login.cookie.domain}/`);
		const loginStates = async () => {
			const cookies = (await page("Network.getCookies", { urls: loginUrls }) as { cookies: Cookie[] }).cookies;
			return Object.fromEntries(logins.map((login) => [
				login.id,
				cookies.some((cookie) => cookie.name === login.cookie.name && cookieOnDomain(cookie.domain, login.cookie.domain)),
			]));
		};
		// A source that failed verification while holding its login cookie has a stale session (one
		// copied from the user's browser, or expired). Its cookies go, so the site shows its login
		// page and the cookie's return means a fresh login rather than the old one still sitting there.
		const stale = logins.filter((login) => !deps.sourceVerified(login.id));
		if (stale.length > 0) {
			for (const cookie of await allCookies()) {
				if (stale.some((login) => cookieOnDomain(cookie.domain, login.cookie.domain))) {
					await page("Network.deleteCookies", { name: cookie.name, domain: cookie.domain, path: cookie.path });
				}
			}
		}
		send({ type: "status", connected: true, screencasting: true, viewportWidth: VIEWPORT.width, viewportHeight: VIEWPORT.height });

		// The tab shows the login page of one source at a time: the first still to log in. Once that
		// login exists, it moves to the next; once none is left, the login is over and the tab closes.
		let current: string | undefined;
		let previous = "";
		while (client.readyState === WebSocket.OPEN) {
			const states = await loginStates();
			const serialized = JSON.stringify(states);
			if (serialized !== previous) {
				previous = serialized;
				send({ type: "logins", states });
			}
			const pending = logins.find((login) => !states[login.id]);
			if (!pending) break;
			if (pending.id !== current) {
				current = pending.id;
				send({ type: "login", sourceId: current });
				await page("Page.navigate", { url: pending.url });
			}
			await new Promise((resolve) => setTimeout(resolve, LOGIN_POLL_MS));
		}
		if (client.readyState !== WebSocket.OPEN) return;
		await page("Page.stopScreencast").catch(() => undefined);
		send({ type: "done" });
		client.close(1000, "logged in");
	} finally {
		if (targetId) await cdp.call("Target.closeTarget", { targetId }).catch(() => undefined);
		cdp.close();
	}
}

function cookieOnDomain(cookieDomain: string, domain: string): boolean {
	const host = cookieDomain.toLowerCase().replace(/^\./u, "");
	return host === domain || host.endsWith(`.${domain}`);
}

interface Cdp {
	call(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<unknown>;
	onEvent(listener: (method: string, params: unknown, sessionId?: string) => void): void;
	close(): void;
}

async function connectCdp(cdpUrl: string): Promise<Cdp> {
	const version = await (await fetch(new URL("/json/version", cdpUrl), { signal: AbortSignal.timeout(2_000) })).json() as { webSocketDebuggerUrl?: unknown };
	if (typeof version.webSocketDebuggerUrl !== "string") throw new Error("Browser CDP host did not answer with a debugger endpoint");
	const socket = new WebSocket(version.webSocketDebuggerUrl, { maxPayload: 16 * 1024 * 1024, perMessageDeflate: false });
	await new Promise<void>((resolve, reject) => {
		socket.once("open", resolve);
		socket.once("error", reject);
	});
	const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
	const listeners: Array<(method: string, params: unknown, sessionId?: string) => void> = [];
	let nextId = 0;
	socket.on("message", (data) => {
		let message: { id?: number; result?: unknown; error?: { message?: string }; method?: string; params?: unknown; sessionId?: string };
		try { message = JSON.parse(data.toString()); } catch { return; }
		if (typeof message.id === "number") {
			const entry = pending.get(message.id);
			pending.delete(message.id);
			if (!entry) return;
			if (message.error) entry.reject(new Error(message.error.message ?? "CDP command failed"));
			else entry.resolve(message.result);
		} else if (typeof message.method === "string") {
			for (const listener of listeners) listener(message.method, message.params, message.sessionId);
		}
	});
	socket.once("close", () => {
		for (const entry of pending.values()) entry.reject(new Error("Browser CDP connection closed"));
		pending.clear();
	});
	return {
		call: (method, params, sessionId) => new Promise((resolve, reject) => {
			if (socket.readyState !== WebSocket.OPEN) return reject(new Error("Browser CDP connection closed"));
			nextId += 1;
			pending.set(nextId, { resolve, reject });
			socket.send(JSON.stringify({ id: nextId, method, params: params ?? {}, ...(sessionId ? { sessionId } : {}) }));
		}),
		onEvent: (listener) => { listeners.push(listener); },
		close: () => { try { socket.close(); } catch { /* already closed */ } },
	};
}
