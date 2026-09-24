import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { basename, join, relative, resolve, sep } from "node:path";

import { findLogicalSourceInRun } from "../workspaces/source-view.js";

export interface WikiSourceDocument {
	path: string;
	title: string;
	content: string;
	runId?: string;
}

export interface WikiSourceAsset {
	absolutePath: string;
	filename: string;
}

const SOURCE_ID_REF = /^source:[a-z0-9_-]+$/iu;
const SOURCE_ASSET_PATH = /^[A-Za-z0-9._/-]+\.(?:png|jpe?g|webp|gif)$/iu;

function inside(root: string, candidate: string): boolean {
	const rel = relative(root, candidate);
	return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== "..");
}

async function textDocument(file: string, allowedRoot: string, path: string, runId?: string): Promise<WikiSourceDocument | null> {
	try {
		const [root, target] = await Promise.all([realpath(allowedRoot), realpath(file)]);
		if (!inside(root, target) || !(await stat(target)).isFile()) return null;
		const content = await readFile(target, "utf8");
		const title = content.match(/^#\s+(.+)$/mu)?.[1]?.trim() || basename(path);
		return { path, title, content, ...(runId ? { runId } : {}) };
	} catch {
		return null;
	}
}

async function directories(path: string): Promise<string[]> {
	try {
		return (await readdir(path, { withFileTypes: true }))
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name);
	} catch {
		return [];
	}
}

async function indexedAsset(
	runsRoot: string,
	runId: string,
	sourceId: string,
	assetPath: string,
): Promise<WikiSourceAsset | null> {
	const bundlesRoot = join(runsRoot, runId, "artifacts", "source-bundles");
	for (const job of await directories(bundlesRoot)) {
		for (const attempt of (await directories(join(bundlesRoot, job))).sort().reverse()) {
			const bundleRoot = join(bundlesRoot, job, attempt);
			try {
				const safeBundleRoot = await realpath(bundleRoot);
				const index = JSON.parse(await readFile(join(bundleRoot, "source-index.json"), "utf8")) as {
					sources?: Array<{ path?: unknown; source_id?: unknown }>;
				};
				const source = index.sources?.find((item) => item.source_id === sourceId);
				if (typeof source?.path !== "string") continue;
				const sourceRoot = await realpath(join(bundleRoot, source.path));
				if (!inside(safeBundleRoot, sourceRoot)) continue;
				const target = await realpath(join(sourceRoot, assetPath));
				if (!inside(sourceRoot, target) || !(await stat(target)).isFile()) continue;
				return { absolutePath: target, filename: basename(target) };
			} catch {
				// Continue through older runs and attempts until the immutable asset is found.
			}
		}
	}
	return null;
}

export async function resolveWikiSource(goalDir: string, sourceRef: string, pinnedRunId: string): Promise<WikiSourceDocument> {
	const normalized = sourceRef.trim().replace(/\\/gu, "/").replace(/^\/+/, "");
	if (!SOURCE_ID_REF.test(normalized)) throw new Error("Invalid Wiki Source ID");
	const runsRoot = resolve(goalDir, "wiki", "runs");
	const runIds = pinnedRunId === null ? (await directories(runsRoot)).sort().reverse() : [pinnedRunId];
	for (const runId of runIds) {
		if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(runId)) throw new Error("Invalid Wiki Source Run ID");
		const logical = findLogicalSourceInRun(join(runsRoot, runId), normalized);
		if (logical) {
			const files = await markdownFiles(logical.sourceRoot);
			for (const file of files) {
				const found = await textDocument(file, logical.sourceRoot, normalized, runId);
				if (found) return {
					...found,
					title: typeof logical.source.title === "string" && logical.source.title.trim()
						? logical.source.title.trim()
						: found.title,
				};
			}
		}
	}
	throw new Error(`Wiki Source not found: ${sourceRef}`);
}

async function markdownFiles(root: string): Promise<string[]> {
	const files: string[] = [];
	for (const entry of await readdir(root, { withFileTypes: true })) {
		const path = join(root, entry.name);
		if (entry.isDirectory()) files.push(...await markdownFiles(path));
		else if (entry.isFile() && /\.(?:md|markdown|mdx)$/iu.test(entry.name)) files.push(path);
	}
	const priority = (path: string) => /(?:^|\/)(?:document|paper|readme)\.md$/iu.test(path) ? 0 : 1;
	return files.sort((left, right) => priority(left) - priority(right) || left.localeCompare(right));
}

/** Source IDs are content hashes, so when no Wiki Edition pins a Run every Run in the Goal is searched, newest first. */
export async function resolveWikiSourceAsset(
	goalDir: string,
	sourceId: string,
	assetPath: string,
	pinnedRunId: string | null,
): Promise<WikiSourceAsset> {
	if (!SOURCE_ID_REF.test(sourceId)) throw new Error("Invalid Wiki Source Asset owner");
	const normalized = assetPath.trim().replace(/\\/gu, "/").replace(/^\/+/, "");
	if (!SOURCE_ASSET_PATH.test(normalized) || normalized.split("/").some((part) => !part || part === "." || part === "..")) {
		throw new Error("Invalid Wiki Source Asset path");
	}
	const runsRoot = resolve(goalDir, "wiki", "runs");
	const runIds = pinnedRunId === null ? (await directories(runsRoot)).sort().reverse() : [pinnedRunId];
	for (const runId of runIds) {
		if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(runId)) throw new Error("Invalid Wiki Source Run ID");
		const found = await indexedAsset(runsRoot, runId, sourceId, normalized);
		if (found) return found;
	}
	throw new Error(`Wiki Source Asset not found: ${sourceId}/${normalized}`);
}
