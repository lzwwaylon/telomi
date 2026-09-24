import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import express from "express";
import WebSocket, { WebSocketServer } from "ws";

import { attachBrowserObservationServer, createBrowserObservationRouter } from "../../server/providers/browser/observation-server.js";
import { BrowserSessionRegistry } from "../../server/providers/browser/session-registry.js";

const root = mkdtempSync(join(tmpdir(), "telomi-browser-observe-"));
const BLACK_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAADElEQVR4nGNgIB0AAAA0AAF2Xq7DAAAAAElFTkSuQmCC";
const WHITE_JPEG = "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAAEAAQDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD3+iiigD//2Q==";
// Also the CDP endpoint, so the test never reaches a real browser on this machine.
const upstreamHttp = createServer((request, response) => {
	if (request.url !== "/json/list") return void response.writeHead(404).end();
	response.setHeader("content-type", "application/json");
	response.end(JSON.stringify([{ id: "target-a", title: "Private page" }]));
});
const upstreamServer = new WebSocketServer({ server: upstreamHttp });
const upstreamMessages: Array<Record<string, unknown>> = [];
let upstream: WebSocket | undefined;
let upstreamRequestUrl: string | undefined;
upstreamServer.on("connection", (socket, request) => {
	upstream = socket;
	upstreamRequestUrl = request.url;
	socket.on("message", (data) => upstreamMessages.push(JSON.parse(data.toString()) as Record<string, unknown>));
	socket.send(JSON.stringify({ type: "status", connected: true, screencasting: true, viewportWidth: 1280, viewportHeight: 720 }));
	socket.send(JSON.stringify({ type: "url", url: "https://example.com/private?token=secret#fragment" }));
	socket.send(JSON.stringify({ type: "console", level: "log", text: "secret console" }));
	socket.send(JSON.stringify({ type: "command", id: "c0", action: "launch", params: { cdpUrl: "http://127.0.0.1:9222" }, timestamp: 9 }));
	socket.send(JSON.stringify({ type: "result", id: "c0", action: "launch", success: false, data: { launched: true }, duration_ms: 0, timestamp: 9 }));
	socket.send(JSON.stringify({ type: "command", id: "c1", action: "fill", params: { value: "password" }, timestamp: 10 }));
	socket.send(JSON.stringify({ type: "result", id: "c1", action: "fill", success: true, data: { value: "password" }, duration_ms: 20, timestamp: 30 }));
	// agent-browser 0.34 streams `success: false` for every result; null data marks the real failure.
	socket.send(JSON.stringify({ type: "result", id: "c2", action: "wait", success: false, data: { waited: "timeout" }, duration_ms: 300, timestamp: 31 }));
	socket.send(JSON.stringify({ type: "result", id: "c3", action: "click", success: false, data: null, duration_ms: 1, timestamp: 32 }));
	socket.send(JSON.stringify({ type: "frame", seq: 1, data: WHITE_JPEG, metadata: { deviceWidth: 4, deviceHeight: 4, timestamp: 40 } }));
});

await listen(upstreamHttp);
const upstreamPort = addressPort(upstreamHttp);
const registry = new BrowserSessionRegistry({
	namespace: "observe-test",
	daemonHome: join(root, "daemon"),
	cdpUrl: `http://127.0.0.1:${upstreamPort}`,
	isProcessAlive: () => true,
});
const env = registry.beginRun("goal-a", "run-a");
// This is a proxy protocol test. Real screenshot subprocesses and pixels are
// covered by browser-monitor-harness.ts; do not make this test depend on spawn latency.
registry.screenshotSession = async (goalId, sessionId) => {
	assert.equal(goalId, "goal-a");
	assert.equal(sessionId, env.AGENT_BROWSER_SESSION);
	return Buffer.from(BLACK_PNG, "base64");
};
mkdirSync(registry.config.runDir, { recursive: true });
writeFileSync(join(registry.config.runDir, `${env.AGENT_BROWSER_SESSION}.pid`), `${process.pid}\n`);
writeFileSync(join(registry.config.runDir, `${env.AGENT_BROWSER_SESSION}.stream`), `${upstreamPort}\n`);
writeFileSync(join(registry.config.runDir, `${env.AGENT_BROWSER_SESSION}.target`), JSON.stringify({ targetId: "target-a", url: "https://example.com/private?token=secret", pinned: true }));

const app = express();
app.use(express.json());
app.use(createBrowserObservationRouter(registry, (goalId) => goalId === "goal-a"));
const http = createServer(app);
const observation = attachBrowserObservationServer(http, registry, (goalId) => goalId === "goal-a");
await listen(http);
const port = addressPort(http);

const sessionResponse = await fetch(`http://127.0.0.1:${port}/api/goals/goal-a/browser-sessions`);
assert.equal(sessionResponse.status, 200);
const sessionBody = await sessionResponse.json() as { sessions: Array<{ sessionId: string; control: string; state: string; title?: string }> };
assert.deepEqual(sessionBody.sessions.map(({ sessionId, control, state, title }) => ({ sessionId, control, state, title })), [{
	sessionId: env.AGENT_BROWSER_SESSION,
	control: "agent",
	state: "live",
	title: "Private page",
}]);
const globalBody = await (await fetch(`http://127.0.0.1:${port}/api/browser-sessions`)).json() as {
	sessions: Array<{ goalId: string; sessionId: string }>;
};
assert.deepEqual(globalBody.sessions.map(({ goalId, sessionId }) => ({ goalId, sessionId })), [{
	goalId: "goal-a",
	sessionId: env.AGENT_BROWSER_SESSION,
}]);

const client = new WebSocket(`ws://127.0.0.1:${port}/api/goals/goal-a/browser-sessions/${env.AGENT_BROWSER_SESSION}/stream`);
const received: Array<Record<string, unknown>> = [];
client.on("message", (data) => received.push(JSON.parse(data.toString()) as Record<string, unknown>));
await onceOpen(client);
await waitFor(() => received.some((message) => message.type === "frame" && message.source === "snapshot"));
assert.equal(upstreamRequestUrl, "/?pacing=ack&maxFps=30");
assert.equal(received.find((message) => message.type === "frame" && message.source === "snapshot")?.data, BLACK_PNG,
	"Runtime seeds the current page screenshot after an upstream blank first frame");

assert.equal(received.some((message) => message.type === "console"), false, "console data is not exposed");
assert.equal(received.find((message) => message.type === "url")?.url, "https://example.com/private");
assert.deepEqual(received.find((message) => message.type === "command"), {
	type: "command", action: "fill", id: "c1", timestamp: 10,
});
assert.deepEqual(received.find((message) => message.type === "result"), {
	type: "result", action: "fill", id: "c1", success: true, durationMs: 20, timestamp: 30,
});
assert.deepEqual(received.filter((message) => message.type === "result").map((message) => [message.id, message.success]), [
	["c1", true], ["c2", true], ["c3", false],
], "a streamed result succeeds when it carries data, whatever the upstream success flag says; CLI launches are not actions");
assert.ok(!received.some((message) => message.type === "command" && message.action === "launch"));

client.send(JSON.stringify({ type: "config", maxFps: 100, pacing: "push" }));
client.send(JSON.stringify({ type: "ack", seq: 1 }));
client.send(JSON.stringify({ type: "input_mouse", eventType: "mousePressed", x: 7, y: 8, button: "left" }));
await waitFor(() => upstreamMessages.some((message) => message.type === "ack"));
assert.equal(upstreamMessages.some((message) => message.type === "input_mouse"), false, "Agent-owned Session rejects UI input");
assert.deepEqual(upstreamMessages.find((message) => message.type === "config"), { type: "config", pacing: "ack", maxFps: 30 });

client.send(JSON.stringify({ type: "control", control: "user" }));
await waitFor(() => received.some((message) => message.type === "control" && message.control === "user"));
client.send(JSON.stringify({ type: "input_keyboard", eventType: "char", text: "hello", windowsVirtualKeyCode: 0 }));
await waitFor(() => upstreamMessages.some((message) => message.type === "input_keyboard"));
assert.equal(upstreamMessages.find((message) => message.type === "input_keyboard")?.text, "hello");

client.send(JSON.stringify({ type: "control", control: "agent" }));
await waitFor(() => received.some((message) => message.type === "control" && message.control === "agent"));
client.send(JSON.stringify({ type: "control", control: "user" }));
await waitFor(() => received.filter((message) => message.type === "control" && message.control === "user").length === 2);

client.close();
await waitFor(() => registry.observe("goal-a")?.control === "agent");
upstream?.close();
observation.close();
await closeServer(http);
await closeWebSocketServer(upstreamServer);
await closeServer(upstreamHttp);
rmSync(root, { recursive: true, force: true });

console.log("browser observation proxy: all assertions passed");

function listen(server: ReturnType<typeof createServer>): Promise<void> {
	return new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
}

function addressPort(server: ReturnType<typeof createServer>): number {
	const address = server.address();
	assert.ok(address && typeof address === "object");
	return address.port;
}

function onceOpen(socket: WebSocket): Promise<void> {
	return new Promise((resolve, reject) => {
		socket.once("open", resolve);
		socket.once("error", reject);
	});
}

async function waitFor(predicate: () => boolean): Promise<void> {
	const deadline = Date.now() + 2_000;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error("Timed out waiting for Browser observation event");
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
	return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

function closeWebSocketServer(server: WebSocketServer): Promise<void> {
	return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
