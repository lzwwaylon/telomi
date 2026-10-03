# Configure Tailscale forwarding

English | [简体中文](network-egress.zh-CN.md)

Use another computer's network connection for eligible arXiv requests when the local route is unavailable. Telomi retains its shared request queue and retry limits; another node does not guarantee that an upstream request will succeed.

## Prepare the computers

1. Install [Tailscale](https://tailscale.com/download) on the computer running Telomi and on each forwarding computer. Sign them into the same tailnet, or otherwise grant the required tailnet access. Telomi reads the local Tailscale client; logging in only inside the browser is insufficient.
2. Enable an SSH server on a Linux or macOS forwarding computer. Use an SSH account with key authentication and permission for TCP forwarding. Your SSH username can differ from your Tailscale login.
3. From the Telomi computer, connect once with `ssh USER@TAILSCALE_IP` and verify the host identity before trusting its key. Ensure a subsequent connection succeeds without a password or interactive prompt. Tailnet access rules and the SSH server must allow the connection.

Telomi and its Research Source Service must run on the same computer. The forwarding computer needs Tailscale and SSH; it does not need a separate Telomi or Source Service installation. iPhone peers appear in discovery, but this forwarding method requires a computer running an SSH server.

## Configure Telomi

1. Open Settings > Network exits. If Tailscale is not installed or connected, follow the installation or login guidance. A connected client keeps its current network preferences.
2. Refresh the device list. Select the forwarding computer, enter its SSH username and port (normally `22`), and enable forwarding.
3. Save the configuration and wait for the node to become ready. Online status alone does not mean SSH forwarding is available.

Telomi manages the forwarding process and its local port. No proxy URL, fixed local port, private key or password needs to be pasted into Telomi. The selection is saved for this installation and restored when Telomi restarts.

## Check and troubleshoot

- A ready node can serve eligible retries when the current arXiv route is limited. Requests still respect the shared queue and cooldowns.
- For authentication or host-trust errors, verify the ordinary SSH connection from the same computer and account that runs Telomi. Telomi does not accept unknown host keys automatically.
- For an offline node, check Tailscale connectivity and the forwarding computer's sleep state. A failed tunnel is retried during periodic refresh.
- If Source Service is unavailable, restore the local service and refresh. A remotely hosted Source Service cannot reach Telomi's loopback forwarding ports.
- To stop using a node, clear its selection and save. Disabling forwarding removes all managed nodes while keeping separately configured static routes.

Closing or restarting Telomi closes the SSH processes it owns. Disabling a node waits for its active Source requests to finish before closing that node's tunnel.
