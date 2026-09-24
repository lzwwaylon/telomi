import { existsSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { access, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
	type BashOperations,
	DEFAULT_MAX_BYTES,
	type EditOperations,
	type FindOperations,
	formatSize,
	type GrepToolDetails,
	type GrepToolInput,
	type LsOperations,
	type ReadOperations,
	truncateHead,
	truncateLine,
	type WriteOperations,
} from "@earendil-works/pi-coding-agent";

import {
	assertGuestWriteAllowed,
	canonicalGuestPath,
	type SandboxExecutionSpec,
} from "./sandbox-spec.js";
import { execSrt, isInside, policyFromSpec, type SrtPolicy } from "./runtime.js";
import { runtimeTools } from "./runtime-tools.js";

const DEFAULT_GREP_LIMIT = 100;

type TextToolResult<TDetails> = {
	content: Array<{ type: "text"; text: string }>;
	details: TDetails | undefined;
};

export class SrtWorkspace {
	readonly aliasesRoot = realpathSync(mkdtempSync(path.join(tmpdir(), "pi-srt-paths-")));
	readonly policy: SrtPolicy;
	private readonly aliases = new Map<string, string>();

	constructor(readonly spec: SandboxExecutionSpec) {
		for (const [index, mount] of [...spec.mounts]
			.sort((left, right) => right.guestPath.length - left.guestPath.length)
			.entries()) {
			const alias = path.join(this.aliasesRoot, `m${index}`);
			symlinkSync(realpathSync(mount.hostPath), alias, "dir");
			this.aliases.set(mount.guestPath, alias);
		}
		const home = path.join(this.aliasesRoot, "home");
		const temp = path.join(this.aliasesRoot, "tmp");
		mkdirSync(home);
		mkdirSync(temp);
		const base = policyFromSpec(spec);
		this.policy = {
			...base,
			filesystem: {
				...base.filesystem,
				allowRead: [...base.filesystem.allowRead, this.aliasesRoot],
				allowWrite: [...base.filesystem.allowWrite, this.aliasesRoot],
			},
		};
	}

	guestPath(value: string): string {
		const trimmed = value.trim().replace(/^@/u, "");
		return canonicalGuestPath(this.spec, trimmed
			? path.posix.resolve(this.spec.guestCwd, trimmed.split(path.sep).join("/"))
			: this.spec.guestCwd);
	}

	hostPath(value: string, operation: "read" | "write" = "read"): string {
		const guest = this.guestPath(value);
		const mount = [...this.spec.mounts]
			.sort((left, right) => right.guestPath.length - left.guestPath.length)
			.find((candidate) => guest === candidate.guestPath || guest.startsWith(`${candidate.guestPath}/`));
		if (!mount) throw new Error(`Path is outside the Agent workspace: ${guest}`);
		const suffix = path.posix.relative(mount.guestPath, guest);
		if ((mount.shadowPaths ?? []).some((shadow) => containsGuestPath(`/${suffix}`, shadow))) {
			throw new Error(`Path is hidden by sandbox policy: ${guest}`);
		}
		if (operation === "write") {
			if (mount.access !== "read-write") throw new Error(`Sandbox mount is read-only: ${guest}`);
			assertGuestWriteAllowed(this.spec, guest);
		}
		const root = realpathSync(mount.hostPath);
		const candidate = path.resolve(root, ...suffix.split("/").filter(Boolean));
		const existing = nearestExisting(candidate);
		if (!isInside(root, realpathSync(existing))) throw new Error(`Path escapes its sandbox mount: ${guest}`);
		if (operation === "read" && existsSync(candidate) && !isInside(root, realpathSync(candidate))) {
			throw new Error(`Path escapes its sandbox mount: ${guest}`);
		}
		return candidate;
	}

	command(value: string): string {
		let result = value;
		for (const [guest, alias] of [...this.aliases.entries()].sort((left, right) => right[0].length - left[0].length)) {
			result = result.replace(new RegExp(`${escapeRegExp(guest)}(?=$|[/\\s'\";|&)])`, "gu"), alias);
		}
		return result;
	}

	env(): Record<string, string> {
		const searchPath = (this.spec.env.PATH ?? "/usr/bin:/bin").split(path.delimiter);
		const translate = (value: string): string => {
			for (const [guest, alias] of this.aliases) {
				if (value === guest || value.startsWith(`${guest}/`)) return `${alias}${value.slice(guest.length)}`;
			}
			return value;
		};
		return {
			...this.spec.env,
			HOME: path.join(this.aliasesRoot, "home"),
			TMPDIR: path.join(this.aliasesRoot, "tmp"),
			PWD: this.hostPath(this.spec.guestCwd),
			...Object.fromEntries(Object.entries(this.spec.env).map(([key, value]) => [key, translate(value)])),
			PATH: [searchPath[0], ...runtimeTools().binPaths, ...searchPath.slice(1)].join(path.delimiter),
		};
	}

	close(): void {
		rmSync(this.aliasesRoot, { recursive: true, force: true });
	}
}

export function createSrtReadOps(workspace: SrtWorkspace): ReadOperations {
	return {
		readFile: (filePath) => readFile(workspace.hostPath(filePath)),
		access: (filePath) => access(workspace.hostPath(filePath)),
		detectImageMimeType: async (filePath) => {
			const ext = path.extname(workspace.hostPath(filePath)).toLowerCase();
			if (ext === ".png") return "image/png";
			if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
			if (ext === ".gif") return "image/gif";
			if (ext === ".webp") return "image/webp";
			return null;
		},
	};
}

export function createSrtWriteOps(workspace: SrtWorkspace): WriteOperations {
	return {
		writeFile: async (filePath, content) => {
			const target = workspace.hostPath(filePath, "write");
			mkdirSync(path.dirname(target), { recursive: true });
			writeFileSync(target, content, "utf8");
		},
		mkdir: async (dirPath) => {
			mkdirSync(workspace.hostPath(dirPath, "write"), { recursive: true });
		},
	};
}

export function createSrtEditOps(workspace: SrtWorkspace): EditOperations {
	const readOps = createSrtReadOps(workspace);
	const writeOps = createSrtWriteOps(workspace);
	return { readFile: readOps.readFile, writeFile: writeOps.writeFile, access: readOps.access };
}

export function createSrtLsOps(workspace: SrtWorkspace): LsOperations {
	return {
		exists: async (filePath) => existsSync(workspace.hostPath(filePath)),
		stat: (filePath) => stat(workspace.hostPath(filePath)),
		readdir: async (dirPath) => readdirSync(workspace.hostPath(dirPath)),
	};
}

export function createSrtFindOps(workspace: SrtWorkspace): FindOperations {
	return {
		exists: async (filePath) => existsSync(workspace.hostPath(filePath)),
		glob: async (pattern, cwd, options) => {
			const root = workspace.hostPath(cwd);
			const results: string[] = [];
			walkFiles(root, (_hostPath, relativePath) => {
				if (matchesToolGlob(relativePath, pattern)) results.push(workspace.guestPath(path.posix.join(cwd, relativePath)));
				return results.length < options.limit;
			});
			return results;
		},
	};
}

export async function executeSrtGrep(
	workspace: SrtWorkspace,
	params: GrepToolInput,
	signal?: AbortSignal,
): Promise<TextToolResult<GrepToolDetails>> {
	const root = workspace.hostPath(params.path ?? ".");
	const rootIsDirectory = statSync(root).isDirectory();
	const matcher = params.literal
		? (line: string) => (params.ignoreCase ? line.toLowerCase() : line)
			.includes(params.ignoreCase ? params.pattern.toLowerCase() : params.pattern)
		: (line: string) => new RegExp(params.pattern, params.ignoreCase ? "i" : undefined).test(line);
	const contextLines = Math.max(0, params.context ?? 0);
	const limit = Math.max(1, params.limit ?? DEFAULT_GREP_LIMIT);
	const outputLines: string[] = [];
	let matches = 0;
	let linesTruncated = false;
	walkFiles(root, (hostPath, relativePath) => {
		if (signal?.aborted) throw new Error("Operation aborted");
		if (params.glob && !matchesToolGlob(relativePath, params.glob)) return true;
		let content: string;
		try { content = readFileSync(hostPath, "utf8"); } catch { return true; }
		const lines = content.replace(/\r\n?/gu, "\n").split("\n");
		const display = rootIsDirectory ? relativePath : path.basename(hostPath);
		for (let index = 0; index < lines.length; index += 1) {
			if (!matcher(lines[index] ?? "")) continue;
			matches += 1;
			const start = Math.max(0, index - contextLines);
			const end = Math.min(lines.length - 1, index + contextLines);
			for (let lineIndex = start; lineIndex <= end; lineIndex += 1) {
				const truncated = truncateLine((lines[lineIndex] ?? "").replace(/\r/gu, ""));
				linesTruncated ||= truncated.wasTruncated;
				outputLines.push(`${display}${lineIndex === index ? ":" : "-"}${lineIndex + 1}-${truncated.text}`);
			}
			if (matches >= limit) return false;
		}
		return true;
	});
	if (matches === 0) return { content: [{ type: "text", text: "No matches found" }], details: undefined };
	const truncation = truncateHead(outputLines.join("\n"), { maxLines: Number.MAX_SAFE_INTEGER });
	const details: GrepToolDetails = {};
	const notices: string[] = [];
	if (matches >= limit) { details.matchLimitReached = limit; notices.push(`${limit} matches limit reached`); }
	if (linesTruncated) { details.linesTruncated = true; notices.push("long lines truncated"); }
	if (truncation.truncated) { details.truncation = truncation; notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`); }
	return {
		content: [{ type: "text", text: `${truncation.content}${notices.length ? `\n\n[${notices.join(". ")}]` : ""}` }],
		details: Object.keys(details).length ? details : undefined,
	};
}

export function createSrtBashOps(workspace: SrtWorkspace): BashOperations {
	return {
		exec: async (command, cwd, { onData, signal, timeout }) => execSrt({
			command: workspace.command(command),
			cwd: workspace.hostPath(cwd),
			env: workspace.env(),
			policy: workspace.policy,
			signal,
			timeoutSeconds: timeout,
			onData,
		}),
	};
}

function walkFiles(root: string, visit: (hostPath: string, relativePath: string) => boolean): boolean {
	const rootStat = lstatSync(root);
	if (!rootStat.isDirectory()) return visit(root, path.basename(root));
	const walk = (directory: string, relativeDirectory: string): boolean => {
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			if (entry.name === ".git" || entry.name === "node_modules" || entry.isSymbolicLink()) continue;
			const hostPath = path.join(directory, entry.name);
			const relativePath = relativeDirectory ? path.posix.join(relativeDirectory, entry.name) : entry.name;
			if (entry.isDirectory()) { if (!walk(hostPath, relativePath)) return false; }
			else if (entry.isFile() && !visit(hostPath, relativePath)) return false;
		}
		return true;
	};
	return walk(root, "");
}

function matchesToolGlob(relativePath: string, pattern: string): boolean {
	const normalized = pattern.split(path.sep).join("/");
	return normalized.includes("/")
		? path.posix.matchesGlob(relativePath, normalized) || path.posix.matchesGlob(relativePath, `**/${normalized}`)
		: path.posix.matchesGlob(path.posix.basename(relativePath), normalized);
}

function containsGuestPath(value: string, pattern: string): boolean {
	const actual = value.split("/").filter(Boolean);
	const expected = pattern.split("/").filter(Boolean);
	return actual.some((_part, start) => expected.every((part, offset) => actual[start + offset] === part));
}

function nearestExisting(value: string): string {
	let current = value;
	while (!existsSync(current)) {
		const parent = path.dirname(current);
		if (parent === current) throw new Error(`No existing ancestor for path: ${value}`);
		current = parent;
	}
	return current;
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
