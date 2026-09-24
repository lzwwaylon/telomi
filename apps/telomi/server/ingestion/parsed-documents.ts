import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import { writeFileAtomic } from "../lib/fs.js";
import { isFileNameSegment } from "../lib/paths.js";
import { fileIngestCacheEntryDir, parsedDocumentsEntryDir } from "../workspaces/goal-runtime-paths.js";
import type { FileIngestResult } from "./types.js";

/** Cache keys name both the cache entry and its mirrored directory. */
const CACHE_KEY = /^[a-f0-9]{64}$/u;

/**
 * 解析产物在镜像目录里的文件名。写入方和 Agent notice 的 guest 路径共用这一处定义，
 * 改名时两侧一起变。
 */
export const PARSED_DOCUMENT_FILES = {
	markdown: "document.md",
	canonical: "document.canonical.json",
	metadata: "parser.metadata.json",
} as const;

/**
 * 除 Markdown 外的解析产物是解析器内部文件：照常挂给 Agent，也仍能按路径读取，
 * 但不作为用户文件列出。
 */
export const PARSED_DOCUMENT_INTERNAL_FILES: readonly string[] = [
	PARSED_DOCUMENT_FILES.canonical,
	PARSED_DOCUMENT_FILES.metadata,
];

/**
 * 一个解析条目背后的来源文件名，取自解析当时写下的 Ingestion 记录。
 * 记录缺失或不是一个文件名时返回 undefined，由调用方决定降级显示。
 */
export function parsedDocumentSourceName(goalDir: string, cacheKey: string): string | undefined {
	if (!CACHE_KEY.test(cacheKey)) return undefined;
	let title: unknown;
	try {
		const record = JSON.parse(readFileSync(join(fileIngestCacheEntryDir(goalDir, cacheKey), "metadata.json"), "utf-8")) as { title?: unknown };
		title = record.title;
	} catch {
		return undefined;
	}
	// 文件夹成员的 title 是文件夹内相对路径，只有其中的文件名是标签。
	const name = typeof title === "string" ? basename(title.trim()) : "";
	return isFileNameSegment(name) ? name : undefined;
}

/**
 * Job 到达终态（含缓存命中）时把解析产物镜像到只含产物的目录树。
 * Ingestion 缓存本身保持原布局，`raw/` 原件留在缓存里：镜像是挂进沙箱的那一份，
 * 每轮逻辑工作区快照都会复制它，所以原始字节不能出现在这里。
 */
export function publishParsedDocuments(goalDir: string, result: FileIngestResult): void {
	const sourceDir = dirname(result.parsedPath);
	const targetDir = parsedDocumentsEntryDir(goalDir, result.cacheKey);
	mkdirSync(targetDir, { recursive: true });
	for (const fileName of Object.values(PARSED_DOCUMENT_FILES)) {
		const source = join(sourceDir, fileName);
		if (!existsSync(source)) continue;
		writeFileAtomic(join(targetDir, fileName), readFileSync(source));
	}
}
