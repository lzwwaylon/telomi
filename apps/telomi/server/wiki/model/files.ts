import { mkdir, readFile, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { isInsideRoot } from "../../lib/paths.js";

const MAX_WIKI_PAGE_BYTES = 2 * 1024 * 1024;

export const CONTROL_MARKDOWN = new Set([
	"README.md",
	"index.md",
	"log.md",
	"_plan.md",
	"INSTRUCTIONS.md",
]);

export async function ensureWikiRoot(rootDir: string): Promise<string> {
	const root = path.resolve(rootDir);
	await mkdir(root, { recursive: true });
	return realpath(root);
}

export function toWikiPath(root: string, file: string): string {
	return path.relative(root, file).split(path.sep).join("/");
}

export async function listWikiDirectories(root: string): Promise<string[]> {
	const directories: string[] = [];
	async function visit(directory: string): Promise<void> {
		directories.push(directory);
		const entries = await readdir(directory, { withFileTypes: true });
		for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
			if (entry.name.startsWith(".") || !entry.isDirectory()) continue;
			const child = path.resolve(directory, entry.name);
			if (isInsideRoot(root, child, { rejectDotPrefix: true })) await visit(child);
		}
	}
	await visit(root);
	return directories;
}

export async function listWikiMarkdown(
	root: string,
	options: { includeIndexes?: boolean } = {},
): Promise<string[]> {
	const files: string[] = [];
	for (const directory of await listWikiDirectories(root)) {
		for (const entry of await readdir(directory, { withFileTypes: true })) {
			if (
				entry.name.startsWith(".") ||
				!entry.isFile() ||
				path.extname(entry.name).toLowerCase() !== ".md" ||
				(CONTROL_MARKDOWN.has(entry.name) && !(options.includeIndexes && entry.name === "index.md"))
			) continue;
			files.push(path.resolve(directory, entry.name));
		}
	}
	return files.sort();
}

export async function readWikiText(file: string): Promise<string> {
	if ((await stat(file)).size > MAX_WIKI_PAGE_BYTES) throw new Error("Wiki page is too large to read");
	return readFile(file, "utf8");
}

export async function resolveExistingPage(root: string, requestedPath: string): Promise<string> {
	if (!requestedPath || path.isAbsolute(requestedPath)) {
		throw new Error("Wiki page path must be a non-empty root-relative path.");
	}
	const normalized = requestedPath.split("/").join(path.sep);
	const candidate = path.resolve(root, normalized.endsWith(".md") ? normalized : `${normalized}.md`);
	if (!isInsideRoot(root, candidate, { rejectDotPrefix: true })) throw new Error("Wiki page path escapes the wiki root.");
	const resolved = await realpath(candidate);
	if (!isInsideRoot(root, resolved, { rejectDotPrefix: true })) throw new Error("Wiki page resolves outside the wiki root.");
	return resolved;
}
