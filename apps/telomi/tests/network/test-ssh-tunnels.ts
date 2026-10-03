import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import { createSshTunnelStarter, sshTunnelArguments, checkSocksListener, TunnelError } from "../../server/network/tunnels.js";

const root = mkdtempSync(join(tmpdir(), "telomi-owned-ssh-"));
const config = { nodeId: "trusted", sshUser: "lzw", sshPort: 22 };
const peer = { id: "trusted", name: "Trusted", os: "linux", online: true, supported: true, ip: "100.100.0.8" };
const args = sshTunnelArguments(peer.ip, config, 45678);
for (const option of ["BatchMode=yes", "StrictHostKeyChecking=yes", "ExitOnForwardFailure=yes", "ConnectTimeout=7",
	"ServerAliveInterval=15", "ServerAliveCountMax=2", "ControlMaster=no", "ControlPath=none", "ControlPersist=no",
	"ForkAfterAuthentication=no", "ProxyCommand=none", "ProxyJump=none", "PermitLocalCommand=no"]) assert.ok(args.includes(option));
assert.equal(args.at(-1), "100.100.0.8");
assert.ok(!args.includes("-f") && !args.some((arg) => arg.includes("accept-new")), "owned SSH neither detaches nor accepts unknown keys");

const proxy = join(root, "proxy.mjs");
writeFileSync(proxy, `
import { createServer } from 'node:net';
const port = Number(process.argv[process.argv.indexOf('-D')+1].split(':').at(-1));
const server = createServer(socket => socket.once('data', data => {
 if (data.equals(Buffer.from([5,1,0]))) { socket.write(Buffer.from([5])); setTimeout(() => socket.write(Buffer.from([0])), 5); }
 else socket.destroy();
}));
server.listen(port, '127.0.0.1');
process.on('SIGTERM', () => server.close(() => process.exit(0)));
`);
let launches = 0;
const start = createSshTunnelStarter({ executable: () => "/fake/ssh", spawn(command, args, options) {
	assert.equal(command, "/fake/ssh"); assert.deepEqual(args.slice(0, 3), ["-N", "-T", "-D"]);
	assert.deepEqual(options.stdio, ["ignore", "ignore", "pipe"]); assert.equal(options.shell, undefined);
	launches += 1; return spawn(process.execPath, [proxy, ...args], options);
} });
try {
	const tunnel = await start(peer, config, new AbortController().signal);
	assert.equal(launches, 1);
	assert.ok(tunnel.alive()); assert.equal(await tunnel.check(), true);
	const port = Number(new URL(tunnel.url).port);
	assert.equal(new URL(tunnel.url).hostname, "127.0.0.1");
	assert.equal(await checkSocksListener(port), true, "fragmented SOCKS replies are supported");
	await tunnel.stop();
	assert.equal(tunnel.alive(), false); assert.equal(await checkSocksListener(port), false, "owned process cleanup closes its listener");
	await tunnel.stop();
	const fail = join(root, "fail.mjs");
	writeFileSync(fail, "process.stderr.write('Permission denied (publickey): /private/SECRET/key');process.exit(1);\n");
	const failed = createSshTunnelStarter({ executable: () => "/fake/ssh", spawn(_command, _args, options) { return spawn(process.execPath, [fail], options); } });
	await assert.rejects(failed(peer, config, new AbortController().signal), (error: unknown) => error instanceof TunnelError && error.code === "ssh_authentication_failed" && !error.message.includes("SECRET"));
	const missing = createSshTunnelStarter({ executable: () => undefined });
	await assert.rejects(missing(peer, config, new AbortController().signal), /ssh_unavailable/u);
	const helper = join(root, "owner.mjs");
	writeFileSync(helper, `
import { spawn } from 'node:child_process';
import { createSshTunnelStarter } from ${JSON.stringify(new URL("../../server/network/tunnels.ts", import.meta.url).href)};
const start = createSshTunnelStarter({ executable: () => '/fake/ssh', spawn(command,args,options) {
 return spawn(process.execPath, [${JSON.stringify(proxy)}, ...args], options);
} });
const tunnel = await start(${JSON.stringify(peer)}, ${JSON.stringify(config)}, new AbortController().signal);
process.stdout.write(JSON.stringify({url:tunnel.url})+'\\n', () => process.exit(0));
`);
	const owner = spawn(process.execPath, ["--import", fileURLToPath(new URL(import.meta.resolve("tsx"))), helper], { stdio: ["ignore", "pipe", "pipe"] });
	let output = ""; let error = "";
	owner.stdout!.on("data", (data) => { output += String(data); });
	owner.stderr!.on("data", (data) => { error += String(data); });
	const [exit] = await once(owner, "close"); assert.equal(exit, 0, error);
	const ownedPort = Number(new URL(JSON.parse(output).url).port);
	for (let attempt = 0; attempt < 20 && await checkSocksListener(ownedPort); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 50));
	assert.equal(await checkSocksListener(ownedPort), false, "normal owner exit terminates only its SSH child and closes its listener");
	console.log("Owned SSH arguments, SOCKS readiness and process cleanup preserve authentication boundaries");
} finally { rmSync(root, { recursive: true, force: true }); }
