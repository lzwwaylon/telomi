import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import WebSocket, { WebSocketServer } from "ws";

import { attachBrowserLoginServer, BROWSER_LOGIN_STREAM_PATH } from "../../server/providers/browser/login-stream.js";

// The settings page logs the user in to the browser-backed sources inside Telomi's browser: one
// tab is screencast to the page, its input goes back, the tab can be sent to each source's login
// page, and which sources are logged in follows their login cookies. Exercised against a CDP
// fixture: no browser, no Google, nothing typed is kept.
const cdp = createServer((_req, res) => {
	res.setHeader("Content-Type", "application/json");
	res.end(JSON.stringify({ webSocketDebuggerUrl: `ws://127.0.0.1:${(cdp.address() as AddressInfo).port}/devtools/browser/fixture` }));
});
const cdpSockets = new WebSocketServer({ server: cdp });
const commands: Array<{ method: string; params: Record<string, unknown>; sessionId?: string }> = [];
let cookies: Array<{ domain: string; name: string; path?: string }> = [{ domain: ".example.com", name: "session" }, { domain: ".youtube.com", name: "LOGIN_INFO", path: "/" }, { domain: ".google.com", name: "SID", path: "/" }];
let closedTargets = 0;
cdpSockets.on("connection", (socket) => socket.on("message", (data) => {
	const message = JSON.parse(data.toString()) as { id: number; method: string; params: Record<string, unknown>; sessionId?: string };
	commands.push({ method: message.method, params: message.params, sessionId: message.sessionId });
	const result = message.method === "Target.createTarget" ? { targetId: "t1" }
		: message.method === "Target.attachToTarget" ? { sessionId: "s1" }
		: message.method === "Storage.getCookies" ? { cookies }
		: {};
	if (message.method === "Target.closeTarget") closedTargets += 1;
	if (message.method === "Network.deleteCookies") cookies = cookies.filter((cookie) => !(cookie.name === message.params.name && cookie.domain === message.params.domain));
	socket.send(JSON.stringify({ id: message.id, result }));
	if (message.method === "Page.startScreencast") {
		socket.send(JSON.stringify({ method: "Page.screencastFrame", sessionId: "s1", params: { data: "AAAA", sessionId: 7, metadata: { deviceWidth: 1024, deviceHeight: 720 } } }));
	}
	if (message.method === "Page.navigate") {
		socket.send(JSON.stringify({ method: "Page.frameNavigated", sessionId: "s1", params: { frame: { url: message.params.url } } }));
	}
}));

const app = createServer((_req, res) => res.writeHead(404).end());
let verified = new Set<string>(["example"]);
const login = attachBrowserLoginServer(app, {
	cdpUrl: () => `http://127.0.0.1:${(cdp.address() as AddressInfo).port}`,
	sourceVerified: (sourceId) => verified.has(sourceId),
	// YouTube as shipped plus a second login, so the move from one source to the next is exercised.
	logins: [
		{ id: "example", url: "https://example.com/login", cookie: { domain: "example.com", name: "session" } },
		{ id: "youtube", url: "https://accounts.google.com/ServiceLogin", cookie: { domain: "youtube.com", name: "LOGIN_INFO" } },
	],
});

try {
	cdp.listen(0, "127.0.0.1");
	app.listen(0, "127.0.0.1");
	await Promise.all([once(cdp, "listening"), once(app, "listening")]);
	const base = `ws://127.0.0.1:${(app.address() as AddressInfo).port}`;
	const rejected = (path: string) => new Promise<number>((resolve) => {
		const socket = new WebSocket(`${base}${path}`);
		socket.once("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0));
		socket.once("error", () => undefined);
	});
	const client = new WebSocket(`${base}${BROWSER_LOGIN_STREAM_PATH}`);
	const received: Array<Record<string, unknown>> = [];
	const waitFor = (predicate: (message: Record<string, unknown>) => boolean) => new Promise<Record<string, unknown>>((resolve) => {
		const existing = received.find(predicate);
		if (existing) return resolve(existing);
		client.on("message", function listener(data) {
			const message = JSON.parse(data.toString()) as Record<string, unknown>;
			if (predicate(message)) { client.off("message", listener); resolve(message); }
		});
	});
	client.on("message", (data) => received.push(JSON.parse(data.toString()) as Record<string, unknown>));
	await once(client, "open");
	assert.equal(await rejected(BROWSER_LOGIN_STREAM_PATH), 409, "one login window at a time");
	assert.equal(login.isOpen(), true, "an open login window is reported to the idle verdict");

	const status = await waitFor((message) => message.type === "status");
	assert.deepEqual(status, { type: "status", connected: true, screencasting: true, viewportWidth: 880, viewportHeight: 640 });
	const frame = await waitFor((message) => message.type === "frame");
	assert.equal(frame.data, "AAAA");
	assert.equal(frame.source, "stream");
	// YouTube holds a login cookie its last verification rejected: the stale session is cleared
	// first, so the login page appears and only a fresh login counts.
	assert.deepEqual((await waitFor((message) => message.type === "login")), { type: "login", sourceId: "youtube" }, "starts with the first source still to log in");
	assert.deepEqual(commands.filter((command) => command.method === "Network.deleteCookies").map((command) => command.params.name), ["LOGIN_INFO"], "only the unverified source's cookies are cleared");
	assert.ok(cookies.some((cookie) => cookie.domain === ".google.com"), "cookies on other domains stay");
	assert.match(String((await waitFor((message) => message.type === "url")).url), /^https:\/\/accounts\.google\.com\//u);
	const first = await waitFor((message) => message.type === "logins");
	assert.deepEqual(first.states, { example: true, youtube: false });
	const order = commands.map((command) => command.method);
	assert.ok(order.indexOf("Page.startScreencast") < order.indexOf("Page.navigate"), "screencast starts before the first navigation");
	assert.equal(commands.find((command) => command.method === "Page.navigate")?.sessionId, "s1", "page commands go to the login tab");

	client.send(JSON.stringify({ type: "input_mouse", eventType: "mousePressed", x: 10, y: 20, button: "left", clickCount: 1, modifiers: 0 }));
	client.send(JSON.stringify({ type: "input_keyboard", eventType: "keyDown", key: "a", code: "KeyA", text: "a", windowsVirtualKeyCode: 65, modifiers: 0 }));
	client.send(JSON.stringify({ type: "input_keyboard", eventType: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, modifiers: 0 }));
	client.send(JSON.stringify({ type: "control", control: "user" }));
	client.send("not json");
	await new Promise((resolve) => setTimeout(resolve, 100));
	assert.equal(commands.filter((command) => command.method === "Page.navigate").length, 1, "a source already logged in is never shown");
	assert.ok(commands.some((command) => command.method === "Page.screencastFrameAck" && command.params.sessionId === 7));
	const mouse = commands.find((command) => command.method === "Input.dispatchMouseEvent");
	assert.equal(mouse?.sessionId, "s1");
	assert.deepEqual(mouse?.params, { type: "mousePressed", x: 10, y: 20, button: "left", clickCount: 1, deltaX: 0, deltaY: 0, modifiers: 0 });
	const keys = commands.filter((command) => command.method === "Input.dispatchKeyEvent").map((command) => command.params);
	assert.equal(keys.length, 2, "only sanitized input reaches the browser");
	assert.equal(keys[0]?.text, "a");
	assert.equal(keys[1]?.text, "\r", "Enter submits the form");

	// The other login vanishing moves the tab there; once every login exists the stream ends by itself.
	cookies = [{ domain: ".google.com", name: "SID" }, { domain: ".youtube.com", name: "LOGIN_INFO" }];
	verified = new Set(["youtube"]);
	assert.deepEqual((await waitFor((message) => message.type === "login" && message.sourceId === "example")), { type: "login", sourceId: "example" });
	assert.match(String((await waitFor((message) => message.type === "url" && /example\.com/u.test(String(message.url)))).url), /^https:\/\/example\.com\//u);
	cookies = [...cookies, { domain: ".example.com", name: "session" }];
	const closeEvent = once(client, "close");
	await waitFor((message) => message.type === "done");
	assert.deepEqual(received.filter((message) => message.type === "logins").at(-1)?.states, { example: true, youtube: true });
	assert.equal((await closeEvent)[0], 1000);
	await new Promise((resolve) => setTimeout(resolve, 50));
	assert.equal(login.isOpen(), false, "the login window closing ends it");
	assert.ok(commands.some((command) => command.method === "Page.stopScreencast"));
	assert.equal(closedTargets, 1, "the login tab is closed once");
	assert.ok(!JSON.stringify(received).includes("KeyA"), "nothing typed comes back to the page");

	// Nothing left to log in: the stream reports so and ends at once, without showing a page.
	verified = new Set(["youtube", "example"]);
	const navigations = commands.filter((command) => command.method === "Page.navigate").length;
	const second = new WebSocket(`${base}${BROWSER_LOGIN_STREAM_PATH}`);
	const secondReceived: Array<Record<string, unknown>> = [];
	second.on("message", (data) => secondReceived.push(JSON.parse(data.toString()) as Record<string, unknown>));
	const secondClosed = once(second, "close");
	await once(second, "open");
	assert.equal((await secondClosed)[0], 1000);
	assert.ok(secondReceived.some((message) => message.type === "done"));
	assert.equal(commands.filter((command) => command.method === "Page.navigate").length, navigations, "no login page is opened");
	assert.equal(closedTargets, 2);

	// Closing the window early closes the tab.
	cookies = [];
	const third = new WebSocket(`${base}${BROWSER_LOGIN_STREAM_PATH}`);
	await once(third, "open");
	await new Promise((resolve) => setTimeout(resolve, 300));
	third.close();
	await once(third, "close");
	await new Promise((resolve) => setTimeout(resolve, 1_300));
	assert.equal(closedTargets, 3);
	console.log("browser login stream: ok");
} finally {
	login.close();
	for (const socket of cdpSockets.clients) socket.terminate();
	cdpSockets.close();
	cdp.closeAllConnections();
	app.closeAllConnections();
	await Promise.all([new Promise((resolve) => cdp.close(resolve)), new Promise((resolve) => app.close(resolve))]);
}
