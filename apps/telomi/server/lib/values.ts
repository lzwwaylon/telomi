export { setTimeout as delay } from "node:timers/promises";

export function toErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function clipSummary(raw: string): string {
	const cleaned = raw.replace(/\s+/g, " ").trim();
	return cleaned.length <= 80 ? cleaned : `${cleaned.slice(0, 80)}…`;
}

export function assertNoDuplicates(values: readonly string[], label: string): void {
	const seen = new Set<string>();
	for (const value of values) {
		if (seen.has(value)) throw new Error(`${label} contains duplicate '${value}'`);
		seen.add(value);
	}
}
