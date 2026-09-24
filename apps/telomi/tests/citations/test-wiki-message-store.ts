import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readWikiMessageCitations, writeWikiMessageCitations } from "../../server/citations/wiki-message-store.js";
import { sha256 } from "../../server/lib/hash.js";

const root = mkdtempSync(join(tmpdir(), "telomi-wiki-message-store-"));
try {
	const record = {
		schemaVersion: 1 as const, goalId: "goal", messageId: "message/with:punctuation",
		wikiRevision: "revision", knowledgeSha256: "a".repeat(64), citations: [],
	};
	assert.equal(readWikiMessageCitations(root, record.messageId), null);
	writeWikiMessageCitations(root, record);
	assert.deepEqual(readWikiMessageCitations(root, record.messageId), record);
	const path = join(root, ".citations", "wiki", `${sha256(record.messageId)}.json`);
	assert.equal(readFileSync(path, "utf-8"), `${JSON.stringify(record, null, 2)}\n`);
	for (const field of Object.keys(record)) {
		const invalid: Record<string, unknown> = { ...record };
		delete invalid[field];
		writeFileSync(path, JSON.stringify(invalid));
		assert.equal(readWikiMessageCitations(root, record.messageId), null, `missing ${field}`);
	}
	for (const raw of ["{", "null", JSON.stringify({ ...record, messageId: "another" }), JSON.stringify({ ...record, citations: {} })]) {
		writeFileSync(path, raw);
		assert.equal(readWikiMessageCitations(root, record.messageId), null);
	}
	writeWikiMessageCitations(root, record);
	assert.deepEqual(readWikiMessageCitations(root, record.messageId), record);
} finally {
	rmSync(root, { recursive: true, force: true });
}
console.log("Wiki message citation store passed");
