import assert from "node:assert/strict";
import { TailscaleClient, parseTailscaleStatus, verifiedAuthUrl, type CommandResult } from "../../server/network/tailscale.js";

const status = { BackendState: "Running", Self: { ID: "self" }, Peer: {
	self: { ID: "self", OS: "linux", Online: true, TailscaleIPs: ["100.64.0.1"] },
	linux: { ID: "linux", StableID: "stable-linux", HostName: "Linux", OS: "linux", Online: true, TailscaleIPs: ["192.168.0.5", "100.100.0.5"] },
	mac: { ID: "mac", OS: "macOS", Online: false, TailscaleIPs: ["fd7a:115c:a1e0::1"] },
	phone: { ID: "phone", OS: "iOS", Online: true, TailscaleIPs: ["100.64.0.8"] },
	bad: { PublicKey: "nodekey:never-a-stable-id", OS: "linux", Online: true, TailscaleIPs: ["127.0.0.1"] },
} };
const discovery = parseTailscaleStatus(status);
assert.equal(discovery.tailscale.state, "running");
assert.equal(discovery.peers.length, 3, "self and key-only records are not selectable peers");
assert.equal(discovery.peers.find((peer) => peer.id === "stable-linux")?.ip, "100.100.0.5");
assert.equal(discovery.peers.find((peer) => peer.id === "phone")?.supported, false);
assert.equal(discovery.peers.find((peer) => peer.id === "mac")?.online, false);
for (const value of ["http://login.tailscale.com/a/test", "https://login.tailscale.com.evil/a/test", "https://secret@login.tailscale.com/a/test", "https://login.tailscale.com:444/a/test", "javascript:alert(1)"]) {
	assert.equal(verifiedAuthUrl(value), undefined);
}
assert.equal(verifiedAuthUrl("https://login.tailscale.com:443/a/test"), "https://login.tailscale.com/a/test");

const missing = new TailscaleClient(async () => { throw new Error("must not execute"); }, () => undefined);
assert.equal((await missing.discover()).tailscale.state, "not_installed");
const unavailable = new TailscaleClient(async () => ({ stdout: JSON.stringify(status), stderr: "private details", code: 1 }), () => "/fake/tailscale");
assert.equal((await unavailable.discover()).tailscale.state, "unavailable", "failed CLI status never reports ready from a plausible JSON body");

let loggedIn = false;
const calls: string[][] = [];
const client = new TailscaleClient(async (command, args): Promise<CommandResult> => {
	assert.equal(command, "/fake/tailscale"); calls.push(args);
	if (args[0] === "debug") {
		assert.deepEqual(args, ["debug", "localapi", "POST", "/localapi/v0/login-interactive"]);
		loggedIn = true;
		return { stdout: "", stderr: "", code: 0 };
	}
	assert.deepEqual(args, ["status", "--json"]);
	return { stdout: JSON.stringify({ BackendState: "NeedsLogin", ...(loggedIn ? { AuthURL: "https://login.tailscale.com/a/trusted" } : {}) }), stderr: "", code: 0 };
}, () => "/fake/tailscale");
assert.equal((await client.login()).tailscale.authUrl, "https://login.tailscale.com/a/trusted");
assert.equal(calls.filter((args) => args[0] === "debug").length, 1);
assert.ok(calls.every((args) => !args.includes("up") && !args.includes("login") && !args.some((arg) => arg.includes("exit-node"))), "login never changes network or profile preferences");
const runningCalls: string[][] = [];
const running = new TailscaleClient(async (_command, args) => {
	runningCalls.push(args); return { stdout: JSON.stringify(status), stderr: "", code: 0 };
}, () => "/fake/tailscale");
assert.equal((await running.login()).tailscale.state, "running");
assert.deepEqual(runningCalls, [["status", "--json"]], "an active login is reused");
console.log("Tailscale discovery and native login preserve trusted identities and installed preferences");
