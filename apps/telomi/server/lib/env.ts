/** True for `1`, `true`, `yes`, `on` (case-insensitive, trimmed); `fallback` when unset. */
export function envBoolean(name: string, fallback = false): boolean {
	const raw = process.env[name];
	if (raw === undefined) return fallback;
	return ["1", "true", "yes", "on"].includes(raw.trim().toLowerCase());
}

/**
 * The first name in `names` that carries a value, so a canonical variable outranks its older
 * aliases. Takes the environment rather than reading `process.env`, because callers resolve one
 * captured snapshot.
 */
export function firstEnvValue(
	env: Record<string, string | undefined>,
	names: readonly string[],
): string | undefined {
	for (const name of names) {
		const value = env[name]?.trim();
		if (value) return value;
	}
	return undefined;
}

/** Finite number from the environment, else `fallback`. Callers clamp or floor as they need. */
export function envNumber(name: string, fallback: number): number {
	const raw = process.env[name]?.trim();
	if (!raw) return fallback;
	const value = Number(raw);
	return Number.isFinite(value) ? value : fallback;
}
