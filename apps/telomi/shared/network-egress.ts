/** Installation-level network exits; discovery never grants permission to use a peer. */
export interface NetworkEgressNodeConfiguration {
	nodeId: string;
	sshUser: string;
	sshPort: number;
}

export interface NetworkEgressConfiguration {
	schemaVersion: 1;
	enabled: boolean;
	nodes: NetworkEgressNodeConfiguration[];
}

export type NetworkEgressNodeState =
	| "disabled" | "unsupported" | "offline" | "needs_configuration"
	| "connecting" | "ready" | "error";

export type NetworkEgressErrorCode =
	| "ssh_unavailable" | "ssh_connection_failed" | "ssh_authentication_failed"
	| "ssh_host_untrusted" | "forwarding_unavailable" | "source_service_unavailable";

export type NetworkEgressRequestErrorCode =
	| "invalid_configuration" | "tailscale_unavailable"
	| "tailscale_login_failed" | "apply_failed" | "request_not_allowed";

export interface NetworkEgressNode {
	id: string;
	name: string;
	os: string;
	online: boolean;
	supported: boolean;
	enabled: boolean;
	sshUser?: string;
	sshPort?: number;
	state: NetworkEgressNodeState;
	errorCode?: NetworkEgressErrorCode;
}

export interface NetworkEgressSnapshot {
	schemaVersion: 1;
	tailscale: {
		state: "not_installed" | "needs_login" | "running" | "unavailable";
		/** A verified HTTPS login URL supplied by the local Tailscale client. */
		authUrl?: string;
	};
	configuration: NetworkEgressConfiguration;
	nodes: NetworkEgressNode[];
	sourceServiceState: "disabled" | "ready" | "unavailable";
}
