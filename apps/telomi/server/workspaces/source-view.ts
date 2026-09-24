import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, extname, join, relative, resolve, sep } from "node:path";

import { sha256 } from "../lib/hash.js";
import { isInsideRoot } from "../lib/paths.js";
import { readJson } from "../lib/fs.js";

export interface SourceEvidenceAnchorRef {
	path: string;
	startLine: number;
	endLine: number;
	sha256?: string;
}

export interface SourceEvidenceAsset {
	sourceId: string;
	path: string;
	/** Pixel size when the format is PNG or JPEG. Other display formats are accepted unmeasured. */
	width?: number;
	height?: number;
}

export interface SourceEvidenceExcerpt {
	path: string;
	startLine: number;
	endLine: number;
	format: "markdown" | "text";
	content: string;
	assets: SourceEvidenceAsset[];
}

export interface LogicalSourceMemberView {
	source_id?: unknown;
	title?: unknown;
	canonical_locator?: unknown;
	path?: unknown;
	summary?: unknown;
}

export interface LogicalSourceView {
	source_id?: unknown;
	title?: unknown;
	path?: unknown;
	members?: LogicalSourceMemberView[];
}

export interface ResolvedLogicalSource {
	source: LogicalSourceView;
	sourceRoot: string;
	runRoot: string;
}

export function findLogicalSourceInRun(runRoot: string, sourceId: string): ResolvedLogicalSource | null {
	const root = join(runRoot, "artifacts", "find-out-sources");
	for (const sequence of sequenceDirectories(root)) {
		const manifestPath = join(root, sequence, "manifest.json");
		if (!existsSync(manifestPath)) continue;
		const manifest = readJson<{ sources?: LogicalSourceView[] }>(manifestPath);
		const source = manifest.sources?.find((item) => item.source_id === sourceId);
		if (source && typeof source.path === "string") {
			const sourceRoot = safeResolve(join(root, sequence), source.path);
			if (sourceRoot) return { source, sourceRoot, runRoot };
		}
	}
	return null;
}

export function readSourceEvidenceAnchors(
	resolved: ResolvedLogicalSource,
	anchors: readonly SourceEvidenceAnchorRef[],
): SourceEvidenceExcerpt[] {
	return anchors.map((anchor) => {
		const sourceFile = safeResolve(resolved.sourceRoot, anchor.path);
		if (!sourceFile || !existsSync(sourceFile)) throw new Error(`Evidence Source file is missing: ${anchor.path}`);
		const lines = readFileSync(sourceFile, "utf-8").replace(/\r\n?/gu, "\n").split("\n");
		if (anchor.startLine < 1 || anchor.endLine < anchor.startLine || anchor.endLine > lines.length) {
			throw new Error(`Evidence Source range is invalid: ${anchor.path}:${anchor.startLine}-${anchor.endLine}`);
		}
		const raw = lines.slice(anchor.startLine - 1, anchor.endLine).join("\n");
		if (anchor.sha256 && sha256(`${raw}\n`) !== anchor.sha256) {
			throw new Error(`Evidence Source range changed: ${anchor.path}:${anchor.startLine}-${anchor.endLine}`);
		}
		const member = matchingMember(resolved.source, anchor.path);
		return {
			path: anchor.path,
			startLine: anchor.startLine,
			endLine: anchor.endLine,
			format: isMarkdown(sourceFile) ? "markdown" : "text",
			content: raw.replace(/<!--\s*image\s*-->/giu, "").replace(/!\[[^\]]*\]\([^)]+\)/gu, "").trim(),
			assets: member ? assetsInRange(resolved, member, sourceFile, lines, anchor.startLine, anchor.endLine) : [],
		};
	});
}

function matchingMember(source: LogicalSourceView, anchorPath: string): LogicalSourceMemberView | null {
	return [...(source.members ?? [])]
		.filter((member) => typeof member.path === "string"
			&& (anchorPath === member.path || anchorPath.startsWith(`${member.path}/`)))
		.sort((left, right) => String(right.path).length - String(left.path).length)[0] ?? null;
}

function assetsInRange(
	resolved: ResolvedLogicalSource,
	member: LogicalSourceMemberView,
	sourceFile: string,
	lines: readonly string[],
	startLine: number,
	endLine: number,
): SourceEvidenceAsset[] {
	if (typeof member.path !== "string" || typeof member.source_id !== "string") return [];
	const memberRoot = safeResolve(resolved.sourceRoot, member.path);
	if (!memberRoot) return [];
	// The Agent view under find-out-sources only carries text plus assets a parser manifest declared.
	// The immutable Source Bundle in the same Run always keeps the full material, so fall back to it.
	const roots = [memberRoot, findSourceBundleDirectory(resolved.runRoot, member.source_id)].filter((root): root is string => Boolean(root));
	const assets = new Map<string, SourceEvidenceAsset>();
	const add = (relativePath: string): void => {
		for (const root of roots) {
			const target = safeResolve(root, relativePath);
			if (!target || !isInsideRoot(root, target) || !existsSync(target)) continue;
			const size = displayAssetSize(target);
			if (!size) return;
			const path = relative(root, target).split(sep).join("/");
			assets.set(path, { sourceId: member.source_id as string, path, ...size });
			return;
		}
	};
	const sourceDir = relative(memberRoot, dirname(sourceFile));
	for (const line of lines.slice(startLine - 1, endLine)) {
		for (const match of line.matchAll(/!\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/gu)) {
			add(join(sourceDir, match[1]!));
		}
	}
	const markers = lines.flatMap((line, index) => /<!--\s*image\s*-->/iu.test(line) ? [index + 1] : []);
	if (markers.length === 0) return [...assets.values()];
	const figures = markerFigures(roots, sourceDir, markers.length);
	for (const [index, line] of markers.entries()) {
		const figure = figures[index];
		if (figure && line >= startLine && line <= endLine) add(figure);
	}
	return [...assets.values()];
}

/** Ordered figure paths for `<!-- image -->` markers: the parser manifest when present, else the sorted `assets/` listing. */
function markerFigures(roots: readonly string[], sourceDir: string, markerCount: number): string[] {
	for (const root of roots) {
		const recordPath = join(root, sourceDir, "record.json");
		if (!existsSync(recordPath)) continue;
		const declared = readJson<{ metadata?: { parser_manifest?: { assets?: Array<{
			figure_index?: unknown; markdown_path?: unknown; media_type?: unknown;
		}> } } }>(recordPath).metadata?.parser_manifest?.assets;
		if (Array.isArray(declared) && declared.length === markerCount
			&& declared.every((asset, index) => asset.figure_index === index
				&& typeof asset.markdown_path === "string" && asset.media_type === "image/png")) {
			return declared.map((asset) => join(sourceDir, asset.markdown_path as string));
		}
	}
	for (const root of roots) {
		const assetsDir = join(root, sourceDir, "assets");
		if (!existsSync(assetsDir)) continue;
		const files = readdirSync(assetsDir).filter((name) => /\.(?:png|jpe?g|webp|gif)$/iu.test(name)).sort();
		if (files.length === markerCount) return files.map((name) => join(sourceDir, "assets", name));
	}
	return [];
}

/** Source Bundle directory holding the full material for a Source in this Run, if any. */
export function findSourceBundleDirectory(runRoot: string, sourceId: string): string | null {
	const bundlesRoot = join(runRoot, "artifacts", "source-bundles");
	for (const job of safeDirectories(bundlesRoot).sort()) {
		for (const attempt of safeDirectories(join(bundlesRoot, job)).sort().reverse()) {
			const indexPath = join(bundlesRoot, job, attempt, "source-index.json");
			if (!existsSync(indexPath)) continue;
			const source = readJson<{ sources?: Array<{ path?: unknown; source_id?: unknown }> }>(indexPath).sources
				?.find((item) => item.source_id === sourceId);
			if (typeof source?.path !== "string") continue;
			const directory = safeResolve(join(bundlesRoot, job, attempt), source.path);
			if (directory && existsSync(directory)) return directory;
		}
	}
	return null;
}

/** `null` when the file is not a display asset; `{}` when it is one we cannot measure. */
function displayAssetSize(path: string): { width?: number; height?: number } | null {
	const extension = extname(path).toLowerCase();
	if (![".png", ".jpg", ".jpeg", ".gif", ".webp"].includes(extension)) return null;
	if (extension === ".gif" || extension === ".webp") return {};
	const content = readFileSync(path);
	const size = extension === ".png" ? pngSize(content) : jpegSize(content);
	if (!size) return null;
	return size.width >= 80 && size.height >= 80 && size.width * size.height >= 20_000 ? size : null;
}

function pngSize(content: Buffer): { width: number; height: number } | null {
	if (content.byteLength < 24 || !content.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return null;
	return { width: content.readUInt32BE(16), height: content.readUInt32BE(20) };
}

export function jpegSize(content: Buffer): { width: number; height: number } | null {
	if (content.byteLength < 4 || content[0] !== 0xff || content[1] !== 0xd8) return null;
	let offset = 2;
	while (offset + 9 < content.byteLength) {
		if (content[offset] !== 0xff) return null;
		const marker = content[offset + 1]!;
		if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01 || marker === 0xff) { offset += marker === 0xff ? 1 : 2; continue; }
		const length = content.readUInt16BE(offset + 2);
		if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
			return { height: content.readUInt16BE(offset + 5), width: content.readUInt16BE(offset + 7) };
		}
		if (marker === 0xda) return null;
		offset += 2 + length;
	}
	return null;
}

function sequenceDirectories(root: string): string[] {
	return safeDirectories(root)
		.filter((name) => /^sequence-\d+$/u.test(name))
		.sort((left, right) => Number(right.slice(9)) - Number(left.slice(9)));
}

function safeDirectories(path: string): string[] {
	try {
		return readdirSync(path, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
	} catch {
		return [];
	}
}

function safeResolve(root: string, path: string): string | null {
	if (!path || path.includes("\0")) return null;
	const target = resolve(root, path);
	return isInsideRoot(root, target) ? target : null;
}

function isMarkdown(path: string): boolean {
	return [".md", ".markdown", ".mdx"].includes(extname(path).toLowerCase());
}
