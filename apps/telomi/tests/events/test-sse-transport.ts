import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import express from "express";
import type { Request, Response } from "express";

import { openSse } from "../../server/events/sse.js";

const app = express();
app.get("/events", (req, res) => {
	const stream = openSse(req, res, { heartbeatMs: 60_000 });
	stream.send({ type: "ready" }, 7);
	stream.close();
});

const server = app.listen(0, "127.0.0.1");
await new Promise<void>((resolve) => server.once("listening", resolve));
const address = server.address();
assert(address && typeof address === "object");
try {
	const response = await fetch(`http://127.0.0.1:${address.port}/events`);
	assert.equal(response.headers.get("content-type"), "text/event-stream; charset=utf-8");
	assert.equal(response.headers.get("x-accel-buffering"), "no");
	assert.equal(await response.text(), 'id: 7\ndata: {"type":"ready"}\n\n');
} finally {
	await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

const request = new EventEmitter() as Request;
const writes: string[] = [];
let backpressured = true;
const response = Object.assign(new EventEmitter(), {
	writableEnded: false,
	set: () => response,
	flushHeaders: () => undefined,
	write: (frame: string) => {
		writes.push(frame);
		if (!backpressured) return true;
		backpressured = false;
		return false;
	},
	end: () => { response.writableEnded = true; return response; },
}) as unknown as Response;
const blocked = openSse(request, response, { heartbeatMs: 60_000 });
let closed = 0;
blocked.onClose(() => { closed += 1; });
assert.equal(blocked.send({ sequence: 1 }), true);
assert.equal(blocked.send({ sequence: 2 }), true);
assert.equal(response.writableEnded, false, "backpressure must not disconnect an SSE client");
assert.equal(closed, 0);
assert.equal(writes.length, 1, "later frames must wait until the response drains");
response.emit("drain");
assert.equal(writes.length, 2);
assert.match(writes[1]!, /"sequence":2/u);
blocked.close();
assert.equal(closed, 1);

console.log("SSE transport test passed");
