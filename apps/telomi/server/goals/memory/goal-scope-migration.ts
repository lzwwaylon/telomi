// Telomi 0.0.1 tagged every user message `scope:global`, so anything said in one Goal was recalled
// in every Goal. Episodes are now recalled in their own Goal, and only the user makes one global.
//
// The automatic tags live in Hindsight, which is not running while the data directory is migrated.
// The data-format step therefore only records that they must go; the server removes them once User
// Memory answers, before anything can make an Episode global on purpose.

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { GLOBAL_MEMORY_TAG, type HindsightClient } from "pi-user-memory";

import type { DataMigration } from "../../config/data-format.js";

function markerPath(dataDir: string): string {
	return join(dataDir, "user-memory", "goal-scope-pending");
}

export const scopeUserMemoryToGoals: DataMigration = {
	name: "recall User Memory in its own Goal unless the user made it global",
	run(dataDir) {
		mkdirSync(join(dataDir, "user-memory"), { recursive: true });
		writeFileSync(markerPath(dataDir), "");
	},
};

let running: Promise<void> | undefined;

/** Drops the automatic global tags if the data-format step asked for it. Safe to repeat after a failure. */
export function completeGoalScopedUserMemory(client: HindsightClient, dataDir: string): Promise<void> {
	if (!existsSync(markerPath(dataDir))) return Promise.resolve();
	running ??= (async () => {
		for (const document of await client.listDocuments([GLOBAL_MEMORY_TAG])) {
			// Only user messages were tagged automatically; one without a Goal came from a plain Pi session.
			if (!/^pi-(?:task|turn)-/u.test(document.id) || !document.tags.some((tag) => tag.startsWith("goal:"))) continue;
			await client.setDocumentTags(document.id, document.tags.filter((tag) => tag !== GLOBAL_MEMORY_TAG));
		}
		rmSync(markerPath(dataDir), { force: true });
	})().finally(() => {
		running = undefined;
	});
	return running;
}
