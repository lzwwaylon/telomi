import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { createConnection, createServer } from "node:net";
import type { NetworkEgressErrorCode, NetworkEgressNodeConfiguration } from "../../shared/network-egress.js";
import { systemExecutable, type TailscalePeer } from "./tailscale.js";

export class TunnelError extends Error {
	constructor(readonly code: NetworkEgressErrorCode) { super(code); }
}
export interface EgressTunnel {
	url: string;
	alive(): boolean;
	check(): Promise<boolean>;
	stop(): Promise<void>;
}
export type StartTunnel = (peer: TailscalePeer, configuration: NetworkEgressNodeConfiguration, signal: AbortSignal) => Promise<EgressTunnel>;

export function sshTunnelArguments(ip: string, configuration: NetworkEgressNodeConfiguration, port: number): string[] {
	return ["-N", "-T", "-D", `127.0.0.1:${port}`, "-p", String(configuration.sshPort), "-l", configuration.sshUser,
		"-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", "ExitOnForwardFailure=yes",
		"-o", "ConnectTimeout=7", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=2",
		"-o", "ControlMaster=no", "-o", "ControlPath=none", "-o", "ControlPersist=no", "-o", "ForkAfterAuthentication=no",
		"-o", "ProxyCommand=none", "-o", "ProxyJump=none", "-o", "PermitLocalCommand=no", ip];
}

/** SOCKS negotiation confirms the authenticated SSH listener, without probing an upstream Provider. */
export function checkSocksListener(port: number): Promise<boolean> {
	return new Promise((resolve) => {
		const socket = createConnection({ host: "127.0.0.1", port });
		let response = Buffer.alloc(0);
		let done = false;
		const finish = (ready: boolean) => { if (done) return; done = true; socket.destroy(); resolve(ready); };
		socket.setTimeout(700, () => finish(false));
		socket.once("error", () => finish(false));
		socket.once("close", () => finish(false));
		socket.once("connect", () => socket.write(Buffer.from([5, 1, 0])));
		socket.on("data", (chunk) => { response = Buffer.concat([response, chunk]); if (response.length >= 2) finish(response[0] === 5 && response[1] === 0); });
	});
}

async function loopbackPort(): Promise<number> {
	const server = createServer();
	await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
	const address = server.address();
	if (!address || typeof address === "string") throw new TunnelError("forwarding_unavailable");
	await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
	return address.port;
}

function failureCode(stderr: string): NetworkEgressErrorCode {
	if (/host key verification failed|remote host identification has changed/iu.test(stderr)) return "ssh_host_untrusted";
	if (/permission denied|authentication failed|no supported authentication/iu.test(stderr)) return "ssh_authentication_failed";
	if (/cannot listen|address already in use|forwarding failed/iu.test(stderr)) return "forwarding_unavailable";
	return "ssh_connection_failed";
}

export function createSshTunnelStarter(options: {
	executable?: () => string | undefined;
	spawn?: (command: string, args: string[], options: SpawnOptions) => ChildProcess;
	port?: () => Promise<number>;
	check?: (port: number) => Promise<boolean>;
} = {}): StartTunnel {
	return async (peer, configuration, signal) => {
		const executable = (options.executable ?? (() => systemExecutable("ssh")))();
		if (!executable) throw new TunnelError("ssh_unavailable");
		if (!peer.ip || signal.aborted) throw new TunnelError("ssh_connection_failed");
		// ponytail: port allocation has a short release/bind race; SSH fails closed if another owner takes it.
		const port = await (options.port ?? loopbackPort)();
		const child: ChildProcess = (options.spawn ?? spawn)(executable, sshTunnelArguments(peer.ip, configuration, port), { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
		let stderr = "";
		let failed = false;
		let stopped = false;
		child.stderr?.on("data", (data) => { stderr = `${stderr}${String(data)}`.slice(-4096); });
		child.once("error", () => { failed = true; });
		const alive = () => !!child.pid && !failed && !stopped && child.exitCode === null && child.signalCode === null;
		const cleanup = () => { if (alive()) child.kill("SIGTERM"); };
		process.once("exit", cleanup);
		child.once("close", () => process.removeListener("exit", cleanup));
		const stop = async () => {
			process.removeListener("exit", cleanup);
			if (stopped) return;
			const running = alive();
			stopped = true;
			if (!running) return;
			await new Promise<void>((resolve) => {
				const timer = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); resolve(); }, 2_000);
				child.once("close", () => { clearTimeout(timer); resolve(); });
				child.kill("SIGTERM");
			});
		};
		const check = () => (options.check ?? checkSocksListener)(port);
		const deadline = Date.now() + 9_000;
		while (alive() && !signal.aborted && Date.now() < deadline) {
			if (await check() && alive() && !signal.aborted) return { url: `socks5h://127.0.0.1:${port}`, alive, check, stop };
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
		await stop();
		throw new TunnelError(failureCode(stderr));
	};
}
