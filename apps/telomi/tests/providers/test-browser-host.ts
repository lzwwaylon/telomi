import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";

import { BrowserHost } from "../../server/providers/browser/startup.js";

// A CDP endpoint that answers only while the fake browser "runs".
async function fakeBrowser(context: { after(fn: () => void): void }) {
	let running = false;
	const server = createServer((_req, res) => {
		if (!running) { res.writeHead(503).end(); return; }
		res.setHeader("Content-Type", "application/json");
		res.end(JSON.stringify({ webSocketDebuggerUrl: "ws://127.0.0.1/devtools/browser/x" }));
	}).listen(0, "127.0.0.1");
	await once(server, "listening");
	context.after(() => server.close());
	const address = server.address();
	assert(address && typeof address !== "string");
	const calls: string[] = [];
	return {
		env: { TELOMI_BROWSER_HOST_CDP_URL: `http://127.0.0.1:${address.port}` } as NodeJS.ProcessEnv,
		calls,
		get running() { return running; },
		set running(value: boolean) { running = value; },
		start: async () => { calls.push("start"); await new Promise((resolve) => setTimeout(resolve, 20)); running = true; },
		stop: async () => { calls.push("stop"); running = false; },
	};
}

const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("concurrent first uses share one start and the browser stops only after the last release and the idle time", async (context) => {
	const browser = await fakeBrowser(context);
	const host = new BrowserHost({ env: browser.env, idleStopMs: 60, start: browser.start, stop: browser.stop,
		afterStart: async () => { browser.calls.push("afterStart"); }, beforeStop: async () => { browser.calls.push("beforeStop"); } });
	context.after(() => void host.shutdown());
	const [first, second] = await Promise.all([host.acquire(), host.acquire()]);
	assert.deepEqual(browser.calls, ["start", "afterStart"]);
	first();
	first(); // releasing twice counts once
	await settle(120);
	assert.equal(browser.running, true, "a held lease keeps the browser");
	second();
	await settle(30);
	assert.equal(browser.running, true, "stopped only after the idle time");
	await settle(100);
	assert.deepEqual(browser.calls, ["start", "afterStart", "beforeStop", "stop"]);
	assert.equal(browser.running, false);
});

test("a use during the idle time keeps the browser, and a use after the stop starts it again", async (context) => {
	const browser = await fakeBrowser(context);
	const host = new BrowserHost({ env: browser.env, idleStopMs: 60, start: browser.start, stop: browser.stop });
	context.after(() => void host.shutdown());
	(await host.acquire())();
	await settle(30);
	(await host.acquire())();
	await settle(40);
	assert.equal(browser.running, true, "the idle time restarts with each release");
	await settle(80);
	assert.equal(browser.running, false);
	await host.withLease(async () => assert.equal(browser.running, true));
	assert.deepEqual(browser.calls, ["start", "stop", "start"]);
});

test("a browser already running at server start gets the idle time, and shutdown stops it", async (context) => {
	const idle = await fakeBrowser(context);
	idle.running = true;
	const host = new BrowserHost({ env: idle.env, idleStopMs: 40, start: idle.start, stop: idle.stop });
	await settle(100);
	assert.deepEqual(idle.calls, ["stop"]);
	host.shutdown();

	const running = await fakeBrowser(context);
	const other = new BrowserHost({ env: running.env, idleStopMs: 60_000, start: running.start, stop: running.stop });
	(await other.acquire())();
	await other.shutdown();
	assert.deepEqual(running.calls, ["start", "stop"]);
});

test("a remote host is never started or stopped here", async (context) => {
	const browser = await fakeBrowser(context);
	const env = { TELOMI_BROWSER_HOST_CDP_URL: `${browser.env.TELOMI_BROWSER_HOST_CDP_URL}/remote` };
	const host = new BrowserHost({ env, idleStopMs: 20, stop: browser.stop });
	assert.equal(host.managed, false);
	await assert.rejects(host.acquire(), /unavailable/u);
	browser.running = true;
	(await host.acquire())();
	await host.shutdown();
	await settle(60);
	assert.deepEqual(browser.calls, []);
});

test("a mistyped headed setting fails when the host is created", () => {
	assert.throws(() => new BrowserHost({ env: { TELOMI_BROWSER_HEADED: "yes" } }), /must be true or false/u);
});
