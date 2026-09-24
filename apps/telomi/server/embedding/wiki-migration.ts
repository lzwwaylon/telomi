import { existsSync } from "node:fs";
import { join } from "node:path";
import type { EmbeddingEstimate, EmbeddingProgress } from "../../shared/embedding-configuration.js";
import { GoalWikiSearch } from "../wiki/local-search.js";

export interface WikiEmbeddingRuntime {
	identity: string;
	connection?: string;
	model: string;
	dimensions?: number;
	baseUrl: string;
	apiKey: string;
	fetchImpl?: typeof fetch;
}

/** The published Wiki of every Goal: the only Wiki that owns an index; snapshots and older Editions read it. */
function searches(goalDirs: readonly string[], runtime: WikiEmbeddingRuntime): GoalWikiSearch[] {
	return goalDirs.filter((dir) => existsSync(join(dir, "wiki", "knowledge")))
		.map((dir) => new GoalWikiSearch(join(dir, "wiki", "knowledge"), { goalDir: dir, embedding: async () => runtime }));
}

export async function estimateWikiWork(goalDirs: readonly string[], runtime: WikiEmbeddingRuntime): Promise<EmbeddingEstimate> {
	const total = { units: 0, characters: 0 };
	for (const search of searches(goalDirs, runtime)) {
		const estimate = await search.estimateEmbeddingWork();
		total.units += estimate.units; total.characters += estimate.characters;
	}
	return total;
}

export async function rebuildWikiIndexes(goalDirs: readonly string[], runtime: WikiEmbeddingRuntime, onProgress: (progress: EmbeddingProgress) => void, signal?: AbortSignal): Promise<void> {
	const total = (await estimateWikiWork(goalDirs, runtime)).units;
	let done = 0;
	onProgress({ done, total });
	for (const search of searches(goalDirs, runtime)) {
		await search.refreshEmbeddings(signal, (added) => { done += added; onProgress({ done, total }); });
	}
}

export async function pruneWikiIndexes(goalDirs: readonly string[], retain: string[]): Promise<void> {
	for (const dir of goalDirs.filter((goalDir) => existsSync(join(goalDir, "wiki", "knowledge")))) {
		await new GoalWikiSearch(join(dir, "wiki", "knowledge"), { goalDir: dir }).pruneIndexTables(retain);
	}
}
