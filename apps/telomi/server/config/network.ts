export function resolveServerHost(env: NodeJS.ProcessEnv = process.env): string {
	return env.TELOMI_HOST?.trim() || "127.0.0.1";
}

export function isAllowedBrowserOrigin(
	origin: string | undefined,
	port: number,
	publicUrl = process.env.TELOMI_URL,
): boolean {
	if (!origin) return true;
	const allowed = new Set([
		`http://127.0.0.1:${port}`,
		`http://localhost:${port}`,
		"http://127.0.0.1:5174",
		"http://localhost:5174",
	]);
	if (allowed.has(origin)) return true;
	if (publicUrl?.trim()) {
		try {
			return origin === new URL(publicUrl).origin;
		} catch {
			return false;
		}
	}
	return false;
}

/**
 * Evaluation role of this instance. Read once at startup; changing it requires a restart.
 *
 * off      Default. Captures only the Cases Browser Skill Evolution consumes; no Operations Listener.
 * capture  `TELOMI_EVAL_CAPTURE=1`: full Case capture and a read-only Operations Listener.
 * eval     `TELOMI_EVAL_INSTANCE=1`: full Case capture and the full Replay Operations Listener.
 *
 * Product capabilities, Evolution included, are the same in every role.
 */
export type OperationsMode = "off" | "capture" | "eval";

export function resolveOperationsMode(env: NodeJS.ProcessEnv = process.env): OperationsMode {
	if (env.TELOMI_EVAL_INSTANCE === "1") return "eval";
	return env.TELOMI_EVAL_CAPTURE === "1" ? "capture" : "off";
}

/** The Operations Listener never reads TELOMI_HOST; it is loopback-only by construction. */
export const OPERATIONS_HOST = "127.0.0.1";

export function resolveOperationsPort(productPort: number, env: NodeJS.ProcessEnv = process.env): number {
	const configured = Number(env.TELOMI_OPERATIONS_PORT);
	return Number.isInteger(configured) && configured > 0 && configured < 65536 ? configured : productPort + 1;
}
