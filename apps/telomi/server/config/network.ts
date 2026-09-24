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

/** Instance role controls Operations write access, never product capability availability. */
export type OperationsMode = "capture" | "eval";

export function resolveOperationsMode(env: NodeJS.ProcessEnv = process.env): OperationsMode {
	return env.TELOMI_EVAL_INSTANCE === "1" ? "eval" : "capture";
}

/** The Operations Listener never reads TELOMI_HOST; it is loopback-only by construction. */
export const OPERATIONS_HOST = "127.0.0.1";

export function resolveOperationsPort(productPort: number, env: NodeJS.ProcessEnv = process.env): number {
	const configured = Number(env.TELOMI_OPERATIONS_PORT);
	return Number.isInteger(configured) && configured > 0 && configured < 65536 ? configured : productPort + 1;
}
