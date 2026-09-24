import { join, resolve } from "node:path";

import { resolveDataDir } from "./data-dir.js";

export function resolveAgentDir(dataDir?: string): string {
	// A caller-supplied data root requests its own isolated directory. Otherwise
	// honor the same explicit Agent directory as start.sh and the native SDK.
	const configured = process.env.PI_CODING_AGENT_DIR?.trim();
	if (!dataDir?.trim() && configured) return resolve(configured);
	return join(resolve(dataDir?.trim() || resolveDataDir()), ".pi", "agent");
}

export function resolveAgentPath(...segments: string[]): string {
	return join(resolveAgentDir(), ...segments);
}
