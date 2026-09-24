import type { HindsightRuntimeManager } from "../goals/memory/hindsight-runtime.js";
import type { MemoryEmbeddingMigrator } from "./configuration.js";

/** Drives `services/hindsight/telomi_embedding_migration.py` through the managed service so its drain and restart stay native. */
export function hindsightEmbeddingMigrator(manager: HindsightRuntimeManager): MemoryEmbeddingMigrator {
	return {
		estimate: async (target) => {
			const result = await manager.runEmbeddingMigration("estimate", target);
			return { units: result.units ?? 0, characters: result.characters ?? 0 };
		},
		prepare: async (target, onProgress, signal) => { await manager.runEmbeddingMigration("prepare", target, onProgress, signal); },
		cutover: (target, commit) => manager.replaceEmbedding(async () => { await manager.runEmbeddingMigration("cutover", target); }, commit),
		abort: async (target) => { await manager.runEmbeddingMigration("abort", target); },
	};
}
