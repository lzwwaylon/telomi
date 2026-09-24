import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { posix } from "node:path";
import { test } from "node:test";

// Shared frontend code carries no business ownership, so it must not reach back
// into a feature's implementation. Aliased and relative imports resolve to the
// same web/src path, so neither spelling can smuggle a dependency back in.
test("shared frontend code does not depend on feature implementations", () => {
	const shared = new URL("../../web/src/shared/", import.meta.url);
	const reverseDependencies: Record<string, string[]> = {};
	for (const path of readdirSync(shared, { recursive: true })) {
		if (typeof path !== "string" || !/\.tsx?$/.test(path)) continue;
		const source = readFileSync(new URL(path, shared), "utf8");
		const targets = [...source.matchAll(/from\s*["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']/g)]
			.map((match) => match[1] ?? match[2])
			.map((specifier) => resolveWebSrc(specifier, posix.join("shared", path)))
			.filter((target): target is string => target !== null && target.startsWith("features/"));
		if (targets.length) reverseDependencies[path] = targets;
	}
	assert.deepEqual(reverseDependencies, {});
});

/** Resolve an import specifier to its web/src-relative path, or null when it leaves web/src. */
function resolveWebSrc(specifier: string, fromPath: string): string | null {
	if (specifier.startsWith("@/")) return specifier.slice(2);
	if (!specifier.startsWith(".")) return null;
	const resolved = posix.normalize(posix.join(posix.dirname(fromPath), specifier));
	return resolved.startsWith("..") ? null : resolved;
}
