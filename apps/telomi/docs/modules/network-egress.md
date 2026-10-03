# Network egress

Network egress lets an installation explicitly approve Tailscale peers as alternate arXiv transports. It bridges local device discovery and the Research Source Service without changing Agent requests or the machine's default network route.

## Interface and ownership

Settings uses `/api/network/egress` to read and save the installation configuration. The refresh and login actions use the same API boundary. The server discovers peers through the installed Tailscale client, owns SSH dynamic forwarding processes for selected peers, and publishes ready routes through the authenticated Source Service `/v1/arxiv/egress` endpoint. Both services must run on the same host because managed forwarding listens on loopback.

Configuration belongs to the installation's Runtime Control Store under `.pi/runtime/network`, rather than Agent settings. Copying Agent configuration into a Replay must not silently grant that Replay access to an installation's network peers. Discovery, connection status and process identifiers are transient; the approved peer IDs and SSH settings survive application restarts.

## Transport lifecycle

A discovered peer is not automatically approved. Only selected, supported peers with SSH configuration may create tunnels. Stable Tailscale peer IDs identify approvals; a display name alone cannot transfer approval to another machine. SSH uses existing keys and trusted host keys, with noninteractive authentication. Telomi does not install Tailscale, accept host keys or collect SSH passwords.

Readiness verifies the local SOCKS listener without sending unsolicited arXiv traffic. Source route replacement preserves static routes and waits for retired clients' active requests to finish before acknowledging the update. The server must retain retired tunnels until that acknowledgment, including when the control request fails. Periodic reconciliation restores routes after Source Service restart and reconnects failed owned tunnels. Shutdown revokes routes before closing tunnels, or stops its locally owned Source Service first when revocation fails.

## Research boundary

The Research Source Service owns request admission, API/PDF cooldown scopes, cache behavior and route choice. Adding a peer does not increase global request throughput or reset existing cooldowns. The existing Runtime retry budget governs retries through another healthy route. API throttling does not itself block a known PDF URL; the PDF transport has its own upstream health scope.

This module does not synchronize files, expose remote Telomi installations, or make every Tailscale device a forwarding server. The current forwarding mechanism requires an SSH server on Linux or macOS. Phone peers remain visible but cannot be selected for SSH forwarding. Tailscale exit-node selection is a separate machine-level feature and is not changed by Telomi.
