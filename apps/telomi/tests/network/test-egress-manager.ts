import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import express from "express";
import { NetworkEgressManager, NetworkRequestError, validateEgressConfiguration } from "../../server/network/manager.js";
import { createNetworkEgressRouter } from "../../server/network/api.js";
import { TunnelError, type EgressTunnel } from "../../server/network/tunnels.js";
import type { TailscaleDiscovery } from "../../server/network/tailscale.js";
import { sha256 } from "../../server/lib/hash.js";

const root = mkdtempSync(join(tmpdir(), "telomi-network-egress-"));
const discovery: TailscaleDiscovery = { tailscale: { state: "running" }, peers: [
	{ id: "linux", name: "Linux", os: "linux", supported: true, online: true, ip: "100.64.0.5" },
	{ id: "mac", name: "Mac", os: "macos", supported: true, online: true, ip: "100.64.0.6" },
	{ id: "phone", name: "Phone", os: "ios", supported: false, online: true, ip: "100.64.0.7" },
] };
const configuration = { schemaVersion: 1, enabled: true, nodes: [{ nodeId: "linux", sshUser: "lzw", sshPort: 22 }] };
const publications: Record<string, string>[] = [];
const tunnels: Array<EgressTunnel & { stops: number }> = [];
let publishFailure = false;
let acknowledge: (() => void) | undefined;
let publicationStarted: (() => void) | undefined;
let loginCalls = 0;
const sourceService = { async setManagedArxivEgressRoutes(routes: Record<string, string>) {
	publications.push({ ...routes }); publicationStarted?.();
	if (publishFailure) throw new Error("private-key-path: /home/SECRET/.ssh, password: DO-NOT-EXPOSE");
	if (acknowledge) await new Promise<void>((resolve) => { acknowledge = resolve; });
} };
const manager = new NetworkEgressManager({ dataDir: root, sourceService,
	tailscale: { discover: async () => structuredClone(discovery), login: async () => { loginCalls += 1; return discovery; } },
	startTunnel: async (peer, config) => {
		assert.equal(peer.id, "linux"); assert.equal(config.sshUser, "lzw");
		const tunnel = { url: `socks5h://127.0.0.1:${40000 + tunnels.length}`, stops: 0,
			alive: () => tunnel.stops === 0, check: async () => tunnel.stops === 0, stop: async () => { tunnel.stops += 1; } };
		tunnels.push(tunnel); return tunnel;
	},
});
let server: ReturnType<express.Express["listen"]> | undefined;
try {
	await manager.start();
	assert.equal(tunnels.length, 0, "discovery never enables peers implicitly");
	assert.equal(manager.snapshot().nodes.find((node) => node.id === "phone")?.state, "unsupported");
	await manager.login(); assert.equal(loginCalls, 0, "Running login is a no-op");
	const first = await manager.configure(configuration);
	assert.equal(tunnels.length, 1);
	assert.equal(first.nodes.find((node) => node.id === "linux")?.state, "ready");
	assert.equal(first.nodes.find((node) => node.id === "mac")?.state, "disabled");
	assert.deepEqual(publications.at(-1), { [`ts_${sha256("linux").slice(0, 20)}`]: tunnels[0]!.url });
	const path = join(root, ".pi/runtime/network/egress.json");
	assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), configuration);
	if (process.platform !== "win32") assert.equal(statSync(path).mode & 0o777, 0o600);
	assert.doesNotMatch(JSON.stringify(first), /100\.64|socks5|40000|private-key/iu, "settings never exposes peer IPs, listener addresses, paths or keys");
	first.configuration.nodes[0]!.sshUser = "mutated";
	assert.equal(manager.snapshot().configuration.nodes[0]?.sshUser, "lzw");
	await manager.refresh();
	assert.equal(tunnels.length, 1, "refresh and Source restarts republish healthy routes without another SSH process");
	assert.equal(publications.length, 2);
	await assert.rejects(manager.configure({ ...configuration, nodes: [{ nodeId: "untrusted-host", sshUser: "lzw", sshPort: 22 }] }), (error: unknown) => error instanceof NetworkRequestError && error.code === "invalid_configuration");
	for (const value of [
		{ ...configuration, proxyUrl: "socks5://attacker" },
		{ ...configuration, nodes: [{ ...configuration.nodes[0], host: "attacker" }] },
		{ ...configuration, nodes: [{ ...configuration.nodes[0], sshUser: "-oStrictHostKeyChecking=no" }] },
		{ ...configuration, nodes: [{ ...configuration.nodes[0], sshPort: 0 }] },
	]) assert.throws(() => validateEgressConfiguration(value), /invalid_configuration/u);
	publishFailure = true;
	const failed = await manager.refresh();
	assert.equal(failed.sourceServiceState, "unavailable");
	assert.equal(failed.nodes.find((node) => node.id === "linux")?.errorCode, "source_service_unavailable");
	assert.doesNotMatch(JSON.stringify(failed), /SECRET|DO-NOT-EXPOSE|\.ssh/u);
	assert.equal(tunnels[0]!.stops, 0, "a failed Source publication does not tear down an acknowledged live route");
	publishFailure = false; await manager.refresh();
	assert.equal(manager.snapshot().sourceServiceState, "ready");
	const entered = new Promise<void>((resolve) => { publicationStarted = resolve; });
	acknowledge = () => undefined;
	const disabling = manager.configure({ ...configuration, enabled: false });
	await entered;
	assert.equal(tunnels[0]!.stops, 0, "old SSH stays alive while the Source drains its retired in-flight requests");
	acknowledge!(); acknowledge = undefined; publicationStarted = undefined;
	assert.equal((await disabling).sourceServiceState, "disabled");
	assert.equal(tunnels[0]!.stops, 1);
	await manager.configure(configuration);
	const reload = new NetworkEgressManager({ dataDir: root, sourceService, tailscale: { discover: async () => discovery, login: async () => discovery },
		startTunnel: async () => { throw new TunnelError("ssh_host_untrusted"); },
	});
	await reload.start();
	assert.equal(reload.snapshot().configuration.enabled, true, "installation selection survives server restart");
	assert.equal(reload.snapshot().nodes.find((node) => node.id === "linux")?.errorCode, "ssh_host_untrusted");
	await reload.refresh();
	await reload.close();
	const app = express(); app.use(express.json()); app.use(createNetworkEgressRouter(manager));
	server = app.listen(0, "127.0.0.1"); await once(server, "listening");
	const address = server.address(); assert.ok(address && typeof address === "object");
	const url = `http://127.0.0.1:${address.port}/api/network/egress`;
	assert.equal((await fetch(url)).status, 200);
	const rejected = await fetch(url, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...configuration, arbitraryHost: "ssh://attacker" }) });
	assert.equal(rejected.status, 400); assert.deepEqual(await rejected.json(), { errorCode: "invalid_configuration" });
	assert.equal((await fetch(`${url}/refresh`, { method: "POST" })).status, 200);
	assert.equal((await fetch(`${url}/login`, { method: "POST" })).status, 200);
	const blockedLogin = await fetch(`${url}/login`, { method: "POST", headers: { origin: "https://unrelated.example" } });
	assert.equal(blockedLogin.status, 403); assert.deepEqual(await blockedLogin.json(), { errorCode: "request_not_allowed" });
	const crossSite = await fetch(`${url}/login`, { method: "POST", headers: { "sec-fetch-site": "cross-site" } });
	assert.equal(crossSite.status, 403, "simple POST cannot bypass CORS to trigger a native login");
	for (const origin of [`http://127.0.0.1:${address.port}`, "http://127.0.0.1:5174"]) {
		assert.equal((await fetch(`${url}/login`, { method: "POST", headers: { origin } })).status, 200);
	}
	let onboardingState: TailscaleDiscovery = { tailscale: { state: "needs_login", authUrl: "https://login.tailscale.com/a/trusted" }, peers: [] };
	let onboardingCommands = 0;
	const onboarding = new NetworkEgressManager({ dataDir: join(root, "onboarding"), sourceService: {
		setManagedArxivEgressRoutes: async () => { throw new Error("disabled discovery must not publish Source routes"); },
	}, refreshIntervalMs: 10, tailscale: {
		discover: async () => { onboardingCommands += 1; return onboardingState; }, login: async () => onboardingState,
	}, startTunnel: async () => { throw new Error("onboarding discovery must not enable SSH"); } });
	try {
		await onboarding.start();
		onboardingState = { tailscale: { state: "running" }, peers: discovery.peers };
		for (let attempt = 0; attempt < 100 && onboarding.snapshot().tailscale.state !== "running"; attempt += 1) {
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		assert.equal(onboarding.snapshot().tailscale.state, "running", "native browser login completion is discovered while forwarding stays disabled");
		assert.ok(onboardingCommands >= 2);
		assert.equal(onboarding.snapshot().sourceServiceState, "disabled");
	} finally { await onboarding.close(); }
	publishFailure = true;
	assert.equal(await manager.close(), false, "remote Source revocation failures are reported and preserve owned SSH");
	assert.equal(tunnels.at(-1)!.stops, 0);
	let localSourceStopped = false;
	assert.equal(await manager.close(async () => { localSourceStopped = true; return true; }), true);
	assert.ok(localSourceStopped); assert.equal(tunnels.at(-1)!.stops, 1, "local Source shutdown precedes failed-revocation SSH cleanup");
	console.log("Managed exits preserve explicit selection, publication ordering, recovery and safe settings errors");
} finally {
	publishFailure = false; acknowledge?.(); acknowledge = undefined;
	await manager.close();
	if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
	rmSync(root, { recursive: true, force: true });
}
