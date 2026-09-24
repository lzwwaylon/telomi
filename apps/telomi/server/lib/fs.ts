import { randomUUID } from "node:crypto";
import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import { toErrorMessage } from "./values.js";

/** Write `content` to `path` via a sibling temp file + rename. Creates parent directories. */
export function writeFileAtomic(path: string, content: string | Uint8Array, options: { mode?: number } = {}): void {
	mkdirSync(dirname(path), { recursive: true });
	const temporary = `${path}.${randomUUID()}.tmp`;
	try {
		writeFileSync(temporary, content, { flag: "wx", mode: options.mode });
		renameSync(temporary, path);
	} finally {
		if (existsSync(temporary)) unlinkSync(temporary);
	}
}

/** Pretty-printed JSON with a trailing newline, written atomically. */
export function writeJsonAtomic(path: string, value: unknown, options: { mode?: number } = {}): void {
	writeFileAtomic(path, `${JSON.stringify(value, null, 2)}\n`, options);
}

export function readJson<T = unknown>(path: string): T {
	let raw: string;
	try {
		raw = readFileSync(path, "utf-8");
	} catch (error) {
		throw new Error(`Cannot read JSON ${path}: ${toErrorMessage(error)}`);
	}
	try {
		return JSON.parse(raw) as T;
	} catch (error) {
		throw new Error(`Invalid JSON ${path}: ${toErrorMessage(error)}`);
	}
}

/**
 * Parse every `*.json` file directly under `directory`, sorted by filename.
 * Unreadable files are skipped unless `strict`. A missing directory yields `[]`.
 */
export function listJsonDir<T = unknown>(
	directory: string,
	options: { strict?: boolean } = {},
): Array<{ file: string; path: string; value: T }> {
	if (!existsSync(directory)) return [];
	const entries: Array<{ file: string; path: string; value: T }> = [];
	for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
		if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
		const path = join(directory, entry.name);
		try {
			entries.push({ file: entry.name, path, value: readJson<T>(path) });
		} catch (error) {
			if (options.strict) throw error;
		}
	}
	return entries;
}

export function appendJsonl(path: string, value: unknown): void {
	mkdirSync(dirname(path), { recursive: true });
	appendFileSync(path, `${JSON.stringify(value)}\n`);
}

/** Parse one JSON value per non-empty line. A missing file yields `[]`. */
export function readJsonl<T = unknown>(path: string): T[] {
	if (!existsSync(path)) return [];
	const values: T[] = [];
	readFileSync(path, "utf-8").split(/\r?\n/u).forEach((line, index) => {
		if (!line.trim()) return;
		try {
			values.push(JSON.parse(line) as T);
		} catch (error) {
			throw new Error(`Invalid JSONL at ${path}:${index + 1}: ${toErrorMessage(error)}`);
		}
	});
	return values;
}

/** Relative posix paths of files under `root`, sorted by default. `rejectNonRegular` rejects links and special files. */
export function listFilesRecursive(
	root: string,
	options: { absolute?: boolean; sort?: boolean; strict?: boolean; includeNonRegular?: boolean; rejectNonRegular?: boolean } = {},
): string[] {
	if (!options.strict && !existsSync(root)) return [];
	const walk = (directory: string): string[] => readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) return walk(path);
		if (options.rejectNonRegular && !entry.isFile()) throw new Error(`Directory contains non-file: ${path}`);
		return entry.isFile() || options.includeNonRegular ? [path] : [];
	});
	const files = walk(root).map((path) => options.absolute ? path : path.slice(root.length + 1).split("\\").join("/"));
	return options.sort === false ? files : files.sort();
}

/** JSONL paths in directory traversal order; also accepts a single JSONL path. */
export function listJsonl(root: string, options: { regularFilesOnly?: boolean } = {}): string[] {
	if (!existsSync(root)) return [];
	if (root.endsWith(".jsonl")) return [root];
	return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
		const path = join(root, entry.name);
		return entry.isDirectory() ? listJsonl(path, options)
			: path.endsWith(".jsonl") && (!options.regularFilesOnly || entry.isFile()) ? [path] : [];
	});
}
