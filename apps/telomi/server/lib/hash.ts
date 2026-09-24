import { createHash, type BinaryToTextEncoding } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { comparePaths } from "./paths.js";

// Preserve the serialization conventions used by existing persisted hashes.
export function stableJson(value: unknown, format: "locale" | "lexical" | "native" = "locale"): string {
	if (format === "native") return JSON.stringify(sortJson(value));
	if (Array.isArray(value)) return `[${value.map((item) => stableJson(item, format)).join(",")}]`;
	if (value && typeof value === "object") {
		return `{${Object.entries(value as Record<string, unknown>)
			.sort(([left], [right]) => format === "locale" ? left.localeCompare(right) : left < right ? -1 : left > right ? 1 : 0)
			.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item, format)}`)
			.join(",")}}`;
	}
	return JSON.stringify(value);
}

function sortJson(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(sortJson);
	if (!value || typeof value !== "object") return value;
	const record = value as Record<string, unknown>;
	return Object.fromEntries(Object.keys(record).sort().map((key) => [key, sortJson(record[key])]));
}

export function createSha256() {
	return createHash("sha256");
}

export function sha256(value: string | Uint8Array, encoding: BinaryToTextEncoding = "hex"): string {
	return createSha256().update(value).digest(encoding);
}

export function hashJson(value: unknown): string {
	return sha256(stableJson(value));
}

export function hashDirectory(root: string, include?: (relativePath: string) => boolean): string {
	return hashJson(directoryFileHashes(root, include).sort((left, right) => comparePaths(left.path, right.path)));
}

function directoryFileHashes(root: string, include?: (relativePath: string) => boolean): Array<{ path: string; sha256: string }> {
	const files: Array<{ path: string; sha256: string }> = [];
	const walk = (directory: string, prefix: string): void => {
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
			if (include && !include(relative)) continue;
			const path = join(directory, entry.name);
			if (entry.isDirectory()) walk(path, relative);
			else if (entry.isFile()) files.push({ path: relative, sha256: sha256(readFileSync(path)) });
		}
	};
	if (existsSync(root)) walk(root, "");
	return files;
}
