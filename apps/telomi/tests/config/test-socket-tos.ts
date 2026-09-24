import assert from "node:assert/strict";
import net from "node:net";
import test from "node:test";

type Settable = net.Socket & { _handle: unknown; setTypeOfService(tos: number): net.Socket };

// A connection the peer reset before the request was written: setsockopt fails with EINVAL (-22).
function resetSocket(): Settable {
	const socket = new net.Socket() as Settable;
	socket._handle = { setTypeOfService: () => -22 };
	return socket;
}

test("a failed setTypeOfService no longer escapes as an exception; invalid arguments still do", { skip: process.platform === "win32" }, async () => {
	// Node's own behavior, which undici's fetch cannot catch because it happens in an I/O callback.
	assert.throws(() => resetSocket().setTypeOfService(0), { code: "EINVAL", syscall: "setTypeOfService" });

	await import("../../server/config/socket-tos.js");
	const socket = resetSocket();
	assert.equal(socket.setTypeOfService(0), socket);
	assert.throws(() => resetSocket().setTypeOfService(256), { code: "ERR_OUT_OF_RANGE" });
});
