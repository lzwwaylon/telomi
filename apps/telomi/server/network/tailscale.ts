import { execFile } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";
import { isIP } from "node:net";
import type { NetworkEgressSnapshot } from "../../shared/network-egress.js";

export interface TailscalePeer {
	id: string;
	name: string;
	os: string;
	online: boolean;
	supported: boolean;
	ip?: string;
}
export interface TailscaleDiscovery {
	tailscale: NetworkEgressSnapshot["tailscale"];
	peers: TailscalePeer[];
}
export interface CommandResult { stdout: string; stderr: string; code: number }
export type ExecuteCommand = (command: string, args: string[], signal?: AbortSignal) => Promise<CommandResult>;

export const executeCommand: ExecuteCommand = (command, args, signal) => new Promise((resolve) => {
	execFile(command, args, { timeout: 8_000, maxBuffer: 1024 * 1024, signal }, (error, stdout, stderr) => {
		resolve({ stdout, stderr, code: error ? 1 : 0 });
	});
});

/** Discovery inspects existing clients; installation and host routing remain user-owned. */
export function systemExecutable(name: "tailscale" | "ssh", env = process.env): string | undefined {
	const candidates = (env.PATH ?? "").split(delimiter).filter(Boolean).map((directory) => join(directory, name));
	if (name === "tailscale") candidates.push("/Applications/Tailscale.app/Contents/MacOS/Tailscale", "/usr/local/bin/tailscale", "/opt/homebrew/bin/tailscale", "/usr/bin/tailscale");
	else candidates.push("/usr/bin/ssh");
	return candidates.find((path) => { try { accessSync(path, constants.X_OK); return true; } catch { return false; } });
}

export function verifiedAuthUrl(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	try {
		const url = new URL(value);
		return url.protocol === "https:" && url.hostname === "login.tailscale.com" && !url.port && !url.username && !url.password
			? url.href : undefined;
	} catch { return undefined; }
}

function tailnetAddress(value: unknown): value is string {
	if (typeof value !== "string") return false;
	if (isIP(value) === 4) {
		const [a, b] = value.split(".").map(Number);
		return a === 100 && b! >= 64 && b! <= 127;
	}
	return isIP(value) === 6 && value.toLowerCase().startsWith("fd7a:115c:a1e0:");
}

export function parseTailscaleStatus(value: unknown): TailscaleDiscovery {
	if (!value || typeof value !== "object") throw new Error("Invalid Tailscale status");
	const status = value as Record<string, unknown>;
	const authUrl = verifiedAuthUrl(status.AuthURL);
	const state = status.BackendState === "Running" ? "running"
		: status.BackendState === "NeedsLogin" || status.BackendState === "NeedsMachineAuth" ? "needs_login" : "unavailable";
	const self = status.Self && typeof status.Self === "object" ? status.Self as Record<string, unknown> : {};
	const peers = new Map<string, TailscalePeer>();
	if (status.Peer && typeof status.Peer === "object") for (const value of Object.values(status.Peer)) {
		if (!value || typeof value !== "object") continue;
		const peer = value as Record<string, unknown>;
		const id = peer.StableID ?? peer.ID;
		if (typeof id !== "string" || !id || id.length > 200 || id === (self.StableID ?? self.ID)) continue;
		const os = typeof peer.OS === "string" ? peer.OS.toLowerCase().slice(0, 32) : "unknown";
		const ip = Array.isArray(peer.TailscaleIPs) ? peer.TailscaleIPs.find(tailnetAddress) : undefined;
		peers.set(id, {
			id, os, supported: ["linux", "darwin", "macos"].includes(os), online: peer.Online === true,
			name: String(peer.HostName || peer.DNSName || id).replace(/[\r\n\t]/gu, " ").slice(0, 200),
			...(ip ? { ip } : {}),
		});
	}
	return { tailscale: { state, ...(state === "needs_login" && authUrl ? { authUrl } : {}) }, peers: [...peers.values()].sort((a, b) => a.name.localeCompare(b.name)) };
}

export class TailscaleClient {
	constructor(
		private readonly execute: ExecuteCommand = executeCommand,
		private readonly executable: () => string | undefined = () => systemExecutable("tailscale"),
	) {}
	async discover(): Promise<TailscaleDiscovery> {
		const cli = this.executable();
		if (!cli) return { tailscale: { state: "not_installed" }, peers: [] };
		try {
			const result = await this.execute(cli, ["status", "--json"]);
			if (result.code !== 0) throw new Error("Tailscale status unavailable");
			return parseTailscaleStatus(JSON.parse(result.stdout));
		}
		catch { return { tailscale: { state: "unavailable" }, peers: [] }; }
	}
	async login(): Promise<TailscaleDiscovery> {
		const current = await this.discover();
		if (current.tailscale.state === "running") return current;
		const cli = this.executable();
		if (!cli || current.tailscale.state !== "needs_login") throw new Error("Tailscale login unavailable");
		// Interactive LocalAPI login preserves installed client preferences, including its exit node.
		const result = await this.execute(cli, ["debug", "localapi", "POST", "/localapi/v0/login-interactive"]);
		if (result.code !== 0) throw new Error("Tailscale login unavailable");
		for (let attempt = 0; attempt < 5; attempt += 1) {
			const status = await this.discover();
			if (status.tailscale.state === "running" || status.tailscale.authUrl) return status;
			await new Promise((resolve) => setTimeout(resolve, 200));
		}
		throw new Error("Tailscale login unavailable");
	}
}
