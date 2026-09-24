import { randomUUID } from "node:crypto";
import { cpSync, existsSync, readFileSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";

import { sha256 } from "../lib/hash.js";
import { hashWikiDirectory, scheduleWikiIndexRefresh, type WikiCompilationResult } from "./index.js";
import { GoalWorkspacePublicationLock } from "../workspaces/publication-lock.js";
import { listFilesRecursive } from "../lib/fs.js";

export interface WikiPublicationResult {
	status: "promoted" | "no_change";
	compilationId: string;
	baseContentHash: string;
	publishedContentHash: string;
	changedPaths: string[];
}

export async function publishCompilation(input: {
	goalId: string;
	goalDir: string;
	workspaceDir: string;
	compilation: WikiCompilationResult;
	env?: Record<string, string | undefined>;
	signal?: AbortSignal;
}): Promise<WikiPublicationResult> {
	const publication = await new GoalWorkspacePublicationLock(input.goalId, input.workspaceDir).withLock("wiki", async (): Promise<WikiPublicationResult> => {
		validateCompilationArtifact(input.compilation);
		const target = join(input.goalDir, "wiki", "knowledge");
		const baseContentHash = hashWikiDirectory(target);
		const publishedContentHash = hashWikiDirectory(input.compilation.knowledge.absolutePath);
		if (baseContentHash === publishedContentHash) {
			return { status: "no_change", compilationId: input.compilation.compilationId,
				baseContentHash, publishedContentHash, changedPaths: [] };
		}
		if (baseContentHash !== input.compilation.baseKnowledgeSha256) {
			throw new Error("wiki_publication_base_drift: Goal Knowledge changed after compilation");
		}
		const changedPaths = changedWikiPaths(target, input.compilation.knowledge.absolutePath);
		const staging = join(dirname(target), `.knowledge-${randomUUID()}.tmp`);
		const backup = join(dirname(target), `.knowledge-${randomUUID()}.bak`);
		try {
			cpSync(input.compilation.knowledge.absolutePath, staging, { recursive: true, errorOnExist: true });
			if (hashWikiDirectory(staging) !== publishedContentHash) throw new Error("Wiki publication staging hash mismatch");
			if (existsSync(target)) renameSync(target, backup);
			renameSync(staging, target);
			rmSync(backup, { recursive: true, force: true });
		} catch (error) {
			if (!existsSync(target) && existsSync(backup)) renameSync(backup, target);
			throw error;
		} finally {
			rmSync(staging, { recursive: true, force: true });
			rmSync(backup, { recursive: true, force: true });
		}
		return {
			status: "promoted",
			compilationId: input.compilation.compilationId,
			baseContentHash,
			publishedContentHash,
			changedPaths,
		};
	});
	// The index follows each finished publication, never the Curator's intermediate drafts; search keeps
	// serving unchanged pages while it refreshes.
	void scheduleWikiIndexRefresh(input.goalDir, { immediate: true });
	return publication;
}

function validateCompilationArtifact(compilation: WikiCompilationResult): void {
	const current = new Map(fileDigests(compilation.knowledge.absolutePath).map((file) => [file.relativePath, file]));
	if (current.size !== compilation.knowledge.files.length) throw new Error("Wiki compilation Artifact file count changed");
	for (const expected of compilation.knowledge.files) {
		const file = current.get(expected.relativePath);
		if (!file || file.sha256 !== expected.sha256 || file.byteLength !== expected.byteLength) {
			throw new Error(`Wiki compilation Artifact changed: ${expected.relativePath}`);
		}
	}
}

/** Wiki paths added, deleted, or changed between two knowledge roots. */
function changedWikiPaths(before: string, after: string): string[] {
	const digests = (root: string) => new Map(fileDigests(root).map((file) => [file.relativePath, file.sha256]));
	const [previous, next] = [digests(before), digests(after)];
	return [...new Set([...previous.keys(), ...next.keys()])].sort()
		.filter((path) => previous.get(path) !== next.get(path))
		.map((path) => `wiki/${path}`);
}

function fileDigests(root: string): Array<{ relativePath: string; sha256: string; byteLength: number }> {
	return listFilesRecursive(root, { rejectNonRegular: true }).map((relativePath) => {
		const content = readFileSync(join(root, relativePath));
		return { relativePath, sha256: sha256(content), byteLength: content.byteLength };
	});
}

