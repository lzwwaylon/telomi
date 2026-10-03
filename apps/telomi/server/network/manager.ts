import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { NetworkEgressConfiguration, NetworkEgressNode, NetworkEgressSnapshot, NetworkEgressRequestErrorCode } from "../../shared/network-egress.js";
import { writeJsonAtomic } from "../lib/fs.js";
import { sha256 } from "../lib/hash.js";
import { runtimeControlRoot } from "../workspaces/server-runtime-paths.js";
import { TailscaleClient, type TailscaleDiscovery } from "./tailscale.js";
import { createSshTunnelStarter, TunnelError, type EgressTunnel, type StartTunnel } from "./tunnels.js";

const emptyConfiguration = (): NetworkEgressConfiguration => ({ schemaVersion: 1, enabled: false, nodes: [] });
export class NetworkRequestError extends Error {
	constructor(readonly code: NetworkEgressRequestErrorCode) { super(code); }
}

export function validateEgressConfiguration(value: unknown): NetworkEgressConfiguration {
	const invalid = () => new NetworkRequestError("invalid_configuration");
	if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid();
	const body = value as Record<string, unknown>;
	if (Object.keys(body).some((key) => !["schemaVersion", "enabled", "nodes"].includes(key))
		|| body.schemaVersion !== 1 || typeof body.enabled !== "boolean" || !Array.isArray(body.nodes) || body.nodes.length > 16) throw invalid();
	const ids = new Set<string>();
	const nodes = body.nodes.map((value) => {
		if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid();
		const node = value as Record<string, unknown>;
		if (Object.keys(node).some((key) => !["nodeId", "sshUser", "sshPort"].includes(key))
			|| typeof node.nodeId !== "string" || !/^[A-Za-z0-9:_-]{1,200}$/u.test(node.nodeId) || ids.has(node.nodeId)
			|| typeof node.sshUser !== "string" || !/^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/u.test(node.sshUser)
			|| typeof node.sshPort !== "number" || !Number.isInteger(node.sshPort) || node.sshPort < 1 || node.sshPort > 65535) throw invalid();
		ids.add(node.nodeId);
		return { nodeId: node.nodeId, sshUser: node.sshUser, sshPort: node.sshPort };
	});
	return { schemaVersion: 1, enabled: body.enabled, nodes };
}

export interface ManagedEgressPublisher {
	setManagedArxivEgressRoutes(routes: Record<string, string>, signal?: AbortSignal): Promise<void>;
}
interface Connection { key: string; tunnel: EgressTunnel }

/** Owns only selected per-process tunnels. Tailscale profiles and host network routes remain untouched. */
export class NetworkEgressManager {
	private readonly path: string;
	private readonly tailscale: Pick<TailscaleClient, "discover" | "login">;
	private readonly startTunnel: StartTunnel;
	private configuration = emptyConfiguration();
	private discovery: TailscaleDiscovery = { tailscale: { state: "not_installed" }, peers: [] };
	private readonly connections = new Map<string, Connection>();
	private readonly retired = new Set<EgressTunnel>();
	private readonly failures = new Map<string, { count: number; nextAttempt: number; code: NetworkEgressNode["errorCode"] }>();
	private readonly states = new Map<string, NetworkEgressNode["state"]>();
	private sourceState: NetworkEgressSnapshot["sourceServiceState"] = "disabled";
	private queue: Promise<void> = Promise.resolve();
	private timer?: ReturnType<typeof setInterval>;
	private readonly lifetime = new AbortController();
	private closing = false;
	private published = false;
	private refreshing?: Promise<NetworkEgressSnapshot>;

	constructor(private readonly options: {
		dataDir?: string;
		sourceService: ManagedEgressPublisher;
		tailscale?: Pick<TailscaleClient, "discover" | "login">;
		startTunnel?: StartTunnel;
		refreshIntervalMs?: number;
	}) {
		this.path = join(runtimeControlRoot(options.dataDir), "network", "egress.json");
		this.tailscale = options.tailscale ?? new TailscaleClient();
		this.startTunnel = options.startTunnel ?? createSshTunnelStarter();
		if (existsSync(this.path)) {
			try { this.configuration = validateEgressConfiguration(JSON.parse(readFileSync(this.path, "utf-8"))); }
			catch { console.warn("[network] Stored egress configuration is unavailable; managed exits remain disabled"); }
		}
	}

	async start(): Promise<void> {
		if (this.timer || this.closing) return;
		this.timer = setInterval(() => { void this.refresh().catch(() => undefined); }, this.options.refreshIntervalMs ?? 30_000);
		this.timer.unref();
		await this.refresh(existsSync(this.path));
	}

	snapshot(): NetworkEgressSnapshot {
		const selected = new Map(this.configuration.nodes.map((node) => [node.nodeId, node]));
		const peers = [...this.discovery.peers];
		for (const node of selected.values()) if (!peers.some((peer) => peer.id === node.nodeId)) {
			peers.push({ id: node.nodeId, name: node.nodeId, os: "unknown", supported: true, online: false });
		}
		return {
			schemaVersion: 1, tailscale: { ...this.discovery.tailscale }, configuration: structuredClone(this.configuration),
			sourceServiceState: this.sourceState,
			nodes: peers.map((peer) => {
				const configuration = selected.get(peer.id);
				const enabled = this.configuration.enabled && !!configuration;
				const state = !peer.supported ? "unsupported" : !enabled ? "disabled"
					: !peer.online || this.discovery.tailscale.state !== "running" ? "offline"
						: !peer.ip ? "needs_configuration" : this.states.get(peer.id) ?? "connecting";
				const errorCode = this.failures.get(peer.id)?.code;
				return {
					id: peer.id, name: peer.name, os: peer.os, online: peer.online, supported: peer.supported, enabled, state,
					...(configuration ? { sshUser: configuration.sshUser, sshPort: configuration.sshPort } : {}),
					...(state === "error" && errorCode ? { errorCode } : {}),
				};
			}),
		};
	}

	refresh(forcePublication = false): Promise<NetworkEgressSnapshot> {
		if (this.refreshing) return this.refreshing;
		const pending = this.serialize(async () => {
			if (!this.closing) await this.refreshLocked(forcePublication);
			return this.snapshot();
		});
		this.refreshing = pending;
		void pending.finally(() => { if (this.refreshing === pending) this.refreshing = undefined; }).catch(() => undefined);
		return pending;
	}

	configure(value: unknown): Promise<NetworkEgressSnapshot> {
		return this.serialize(async () => {
			if (this.closing) throw new NetworkRequestError("apply_failed");
			const configuration = validateEgressConfiguration(value);
			this.discovery = await this.tailscale.discover();
			const known = new Set([...this.discovery.peers.map((peer) => peer.id), ...this.configuration.nodes.map((node) => node.nodeId)]);
			if (configuration.nodes.some((node) => !known.has(node.nodeId))) throw new NetworkRequestError("invalid_configuration");
			try { writeJsonAtomic(this.path, configuration, { mode: 0o600 }); }
			catch { throw new NetworkRequestError("apply_failed"); }
			this.configuration = configuration;
			this.failures.clear();
			await this.refreshLocked(true);
			return this.snapshot();
		});
	}

	login(): Promise<NetworkEgressSnapshot> {
		return this.serialize(async () => {
			if (this.closing) throw new NetworkRequestError("tailscale_unavailable");
			this.discovery = await this.tailscale.discover();
			if (this.discovery.tailscale.state === "running") return this.snapshot();
			if (this.discovery.tailscale.state !== "needs_login") throw new NetworkRequestError("tailscale_unavailable");
			try { this.discovery = await this.tailscale.login(); }
			catch { throw new NetworkRequestError("tailscale_login_failed"); }
			return this.snapshot();
		});
	}

	/** A failed revocation keeps old tunnels until locally owned Source shutdown or a later retry. */
	async close(stopLocalSource?: () => Promise<boolean>): Promise<boolean> {
		this.closing = true;
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
		this.lifetime.abort();
		return this.serialize(async () => {
			if (this.published || this.connections.size || this.retired.size) {
				try { await this.options.sourceService.setManagedArxivEgressRoutes({}, AbortSignal.timeout(65_000)); }
				catch {
					if (!stopLocalSource || !await stopLocalSource()) return false;
				}
			}
			await Promise.all([...this.connections.values()].map(({ tunnel }) => tunnel.stop()).concat([...this.retired].map((tunnel) => tunnel.stop())));
			this.connections.clear(); this.retired.clear(); this.published = false; this.sourceState = "disabled";
			return true;
		});
	}

	private serialize<T>(operation: () => Promise<T>): Promise<T> {
		const result = this.queue.then(operation);
		this.queue = result.then(() => undefined, () => undefined);
		return result;
	}

	private async refreshLocked(forcePublication: boolean): Promise<void> {
		this.discovery = await this.tailscale.discover();
		const peers = new Map(this.discovery.peers.map((peer) => [peer.id, peer]));
		const desired = new Map(this.configuration.enabled && this.discovery.tailscale.state === "running"
			? this.configuration.nodes.filter((node) => { const peer = peers.get(node.nodeId); return peer?.supported && peer.online && peer.ip; }).map((node) => [node.nodeId, node]) : []);
		for (const [id, connection] of this.connections) {
			const configuration = desired.get(id);
			const key = configuration ? JSON.stringify([peers.get(id)!.ip, configuration.sshUser, configuration.sshPort]) : undefined;
			if (connection.key !== key || !connection.tunnel.alive() || !await connection.tunnel.check()) {
				this.connections.delete(id); this.retired.add(connection.tunnel);
			}
		}
		await Promise.all([...desired].map(async ([id, configuration]) => {
			if (this.connections.has(id) || this.closing) return;
			const failure = this.failures.get(id);
			if (failure && failure.nextAttempt > Date.now()) { this.states.set(id, "error"); return; }
			this.states.set(id, "connecting");
			try {
				const peer = peers.get(id)!;
				const tunnel = await this.startTunnel(peer, configuration, this.lifetime.signal);
				if (this.closing) { await tunnel.stop(); return; }
				this.connections.set(id, { key: JSON.stringify([peer.ip, configuration.sshUser, configuration.sshPort]), tunnel });
				this.failures.delete(id);
			} catch (error) {
				const count = (failure?.count ?? 0) + 1;
				this.failures.set(id, { count, nextAttempt: Date.now() + Math.min(300_000, 30_000 * 2 ** Math.min(count - 1, 4)),
					code: error instanceof TunnelError ? error.code : "ssh_connection_failed" });
				this.states.set(id, "error");
			}
		}));
		if (this.closing) return;
		const routes = Object.fromEntries([...this.connections].map(([id, { tunnel }]) => [`ts_${sha256(id).slice(0, 20)}`, tunnel.url]));
		if (!forcePublication && !this.configuration.enabled && !this.published && !this.retired.size) { this.sourceState = "disabled"; return; }
		try {
			await this.options.sourceService.setManagedArxivEgressRoutes(routes, AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(65_000)]));
			this.published = Object.keys(routes).length > 0;
			this.sourceState = this.published ? "ready" : "disabled";
			for (const id of this.connections.keys()) { this.states.set(id, "ready"); this.failures.delete(id); }
			await Promise.all([...this.retired].map((tunnel) => tunnel.stop()));
			this.retired.clear();
		} catch {
			this.sourceState = "unavailable";
			for (const id of this.connections.keys()) {
				this.states.set(id, "error");
				this.failures.set(id, { count: 0, nextAttempt: 0, code: "source_service_unavailable" });
			}
		}
	}
}
