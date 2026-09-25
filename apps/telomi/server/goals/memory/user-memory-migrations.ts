// Data-format migrations whose work lives in User Memory. Hindsight is not running while the data
// directory is migrated, so each data-format step only leaves a marker; the server finishes the work
// once User Memory answers (at startup, or before the first Memory page request if memory came up
// later), before anything the user curates can be touched by it. A failed run keeps its marker and
// is retried; every step is safe to repeat.

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { GLOBAL_MEMORY_TAG, type HindsightClient } from "pi-user-memory";

import type { DataMigration } from "../../config/data-format.js";

interface DeferredMemoryMigration extends DataMigration {
	marker: string;
	complete: (client: HindsightClient) => Promise<void>;
}

function deferred(marker: string, name: string, complete: DeferredMemoryMigration["complete"]): DeferredMemoryMigration {
	return {
		name,
		marker,
		complete,
		run(dataDir) {
			mkdirSync(join(dataDir, "user-memory"), { recursive: true });
			writeFileSync(markerPath(dataDir, marker), "");
		},
	};
}

function markerPath(dataDir: string, marker: string): string {
	return join(dataDir, "user-memory", marker);
}

/**
 * Telomi 0.0.1 tagged every user message `scope:global`, so anything said in one Goal was recalled
 * in every Goal. Episodes are now recalled in their own Goal, and only the user makes one global.
 */
export const scopeUserMemoryToGoals = deferred(
	"goal-scope-pending",
	"recall User Memory in its own Goal unless the user made it global",
	async (client) => {
		for (const document of await client.listDocuments([GLOBAL_MEMORY_TAG])) {
			// Only user messages were tagged automatically; one without a Goal came from a plain Pi session.
			if (!/^pi-(?:task|turn)-/u.test(document.id) || !document.tags.some((tag) => tag.startsWith("goal:"))) continue;
			await client.setDocumentTags(document.id, document.tags.filter((tag) => tag !== GLOBAL_MEMORY_TAG));
		}
	},
);

/**
 * Confirmed Topic Plans used to be copied into User Memory, and earlier revisions were never removed.
 * The Main Agent and the Research Schedule Reviewer now read the Topic Plan itself.
 */
export const removeTopicPlanCopiesFromUserMemory = deferred(
	"topic-plan-copies-pending",
	"stop copying Topic Plans into User Memory",
	async (client) => {
		for (const document of await client.listDocumentsById("pi-topic-plan-")) {
			// The ID filter is a substring match; only the prefix names a Topic Plan copy.
			if (document.id.startsWith("pi-topic-plan-")) await client.deleteDocument(document.id);
		}
	},
);

/** In data-format order. */
const DEFERRED = [scopeUserMemoryToGoals, removeTopicPlanCopiesFromUserMemory];

let running: Promise<void> | undefined;

/** Finishes every deferred User Memory migration the data-format steps asked for. */
export function completeUserMemoryMigrations(client: HindsightClient, dataDir: string): Promise<void> {
	if (!DEFERRED.some(({ marker }) => existsSync(markerPath(dataDir, marker)))) return Promise.resolve();
	running ??= (async () => {
		for (const migration of DEFERRED) {
			if (!existsSync(markerPath(dataDir, migration.marker))) continue;
			await migration.complete(client);
			rmSync(markerPath(dataDir, migration.marker), { force: true });
		}
	})().finally(() => {
		running = undefined;
	});
	return running;
}
