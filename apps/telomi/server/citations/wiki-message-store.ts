import { join } from "node:path";

import { citationRoot } from "../workspaces/goal-runtime-paths.js";
import { sha256 } from "../lib/hash.js";
import { JsonDocumentStore } from "../lib/json-document-store.js";

import type { CompiledCitationReport } from "../research/pipeline/citation-compiler.js";

export interface WikiMessageCitationRecord {
	schemaVersion: 1;
	goalId: string;
	messageId: string;
	wikiRevision: string;
	knowledgeSha256: string;
	citations: CompiledCitationReport["citations"];
}

export function writeWikiMessageCitations(goalDir: string, record: WikiMessageCitationRecord): void {
	wikiMessageCitationStore(goalDir).put(sha256(record.messageId), record);
}

export function readWikiMessageCitations(goalDir: string, messageId: string): WikiMessageCitationRecord | null {
	try {
		const value = wikiMessageCitationStore(goalDir).get(sha256(messageId));
		return value?.messageId === messageId ? value : null;
	} catch {
		return null;
	}
}

function wikiMessageCitationStore(goalDir: string): JsonDocumentStore<WikiMessageCitationRecord> {
	return new JsonDocumentStore(join(citationRoot(goalDir), "wiki"), (value) => {
		const record = value as Partial<WikiMessageCitationRecord> | null;
		if (!record || record.schemaVersion !== 1
			|| typeof record.goalId !== "string" || typeof record.messageId !== "string"
			|| typeof record.wikiRevision !== "string" || typeof record.knowledgeSha256 !== "string"
			|| !Array.isArray(record.citations)) throw new Error("Wiki message citation record is invalid");
		return record as WikiMessageCitationRecord;
	});
}
