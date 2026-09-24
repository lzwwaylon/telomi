import { basename, isAbsolute, relative, resolve, sep } from "node:path";

/**
 * True when `candidate` (absolute, or relative to `root`) resolves to `root` itself or a descendant.
 * Escapes are `..`, a leading `..` + separator, or a resolved path outside `root` (including sibling
 * directories that merely share a prefix). `rejectDotPrefix` retains the stricter sandbox policy
 * that also rejects descendant names starting with two dots. `allowRoot: false` requires a descendant.
 */
export function isInsideRoot(root: string, candidate: string, options: PathGuardOptions = {}): boolean {
	const rel = relative(resolve(root), resolve(root, candidate));
	if (rel === "") return options.allowRoot !== false;
	return rel !== ".." && !(options.rejectDotPrefix ? rel.startsWith("..") : rel.startsWith(`..${sep}`)) && !isAbsolute(rel);
}

export interface PathGuardOptions {
	rejectDotPrefix?: boolean;
	allowRoot?: boolean;
}

export function assertInsideRoot(root: string, candidate: string, label = "Path", options: PathGuardOptions = {}): string {
	if (!isInsideRoot(root, candidate, options)) throw new Error(`${label} escapes ${root}: ${candidate}`);
	return resolve(root, candidate);
}

export function basenameNoExt(name: string): string {
	const base = basename(name);
	const dot = base.lastIndexOf(".");
	return dot > 0 ? base.slice(0, dot) : base;
}

/** Strict file-path guard preserving the workspace and artifact route policy: descendants only, no dot-prefixed names. */
export function ensureWithinRoot(root: string, candidate: string, label = "workspace root"): string {
	if (!isInsideRoot(root, candidate, { rejectDotPrefix: true, allowRoot: false })) {
		throw new Error(`Path '${candidate}' escapes the ${label}.`);
	}
	return resolve(root, candidate);
}

/** True when `value` can name one directory entry: no separators, NUL, `.` or `..`. */
export function isFileNameSegment(value: unknown): value is string {
	return typeof value === "string" && value !== "" && value !== "." && value !== ".." && !/[/\\\0]/u.test(value);
}

export function assertFileNameSegment(value: unknown, label = "Path segment"): string {
	if (!isFileNameSegment(value)) throw new Error(`${label} must be one filename stem: ${String(value)}`);
	return value;
}

/** Preserve attachment names while removing directories and unsupported characters. */
export function sanitizeFileName(fileName: string): string {
	const cleaned = basename(fileName).replace(/[^\w.-]+/g, "_");
	return cleaned.length > 0 ? cleaned : "attachment";
}

/** Normalize an observability identity into a bounded file-name segment. */
export function safeSegment(value: string, label: string): string {
	const safe = value
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9._-]+/gu, "-")
		.replace(/^-+|-+$/gu, "")
		.slice(0, 160);
	if (!safe) throw new Error(`${label} identity is empty`);
	return safe;
}

/** Normalize a session/file name using the existing Browser naming convention. */
export function safeName(value: string, options: { maxLength?: number; fallback?: string } = {}): string {
	return value.replace(/[^A-Za-z0-9._-]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, options.maxLength ?? 120) || (options.fallback ?? "");
}

/** Guard for a stored relative path: no root, no traversal, no NUL. */
export function assertSafeRelativePath(value: string, label: string): void {
	if (
		!value
		|| value === "."
		|| value.startsWith("/")
		|| value.startsWith("\\")
		|| value.split(/[\\/]/u).includes("..")
		|| value.includes("\0")
	) {
		throw new Error(`${label} must be a safe relative path`);
	}
}

/**
 * Locale-independent path order for everything that hashes a file list. `localeCompare` follows
 * the process locale, so two instances (zh_CN production, en_US eval instance) digested the same
 * directory differently once a CJK file name appeared. Pinned to "en", which is what every
 * digest recorded so far used for ASCII names.
 */
export const comparePaths: (left: string, right: string) => number = new Intl.Collator("en").compare;
