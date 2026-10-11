import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { providerCallsPath, readProviderCallRecords, recordProviderCall } from "../../server/providers/provider-call-record.js";

const root = mkdtempSync(join(tmpdir(), "provider-call-dates-"));
try {
	const record = recordProviderCall({ runDir: root, nodeId: "search", attemptId: "1" }, {
		provider: "huggingface", startedAt: 0,
		request: { query: "speech", maxResults: 2, criterionIds: [], purpose: "dates", workspaceDir: root,
			signal: new AbortController().signal },
		outcome: { results: [
			{ id: "model", title: "Repository", url: "https://huggingface.co/example/model", snippet: "",
				metadata: { created_at: "2026-01-21", updated_at: "2026-01-29" } },
			{ id: "paper", title: "Paper", url: "https://huggingface.co/papers/2601.01234", snippet: "",
				publishedAt: "2026-01-22", metadata: { created_at: "2026-01-20" } },
		], cache: { status: "miss", ageMs: 0 }, execution: { upstreamCalled: true, attempts: 1,
			queueWaitMs: 0, intervalWaitMs: 0, rateLimitWaitMs: 0 } },
	});
	assert.deepEqual(record.response.docs, [
		{ id: "model", title: "Repository", url: "https://huggingface.co/example/model", created_at: "2026-01-21", updated_at: "2026-01-29" },
		{ id: "paper", title: "Paper", url: "https://huggingface.co/papers/2601.01234", published_at: "2026-01-22", created_at: "2026-01-20" },
	], "Trace preserves original creation dates without promoting them to publication dates");
	const legacy = { ...record, seq: 2, response: { ...record.response,
		docs: [{ id: "old", url: "https://example.invalid/old", title: "Old record", published_at: "2025-01-01" }] } };
	appendFileSync(providerCallsPath(root), `${JSON.stringify(legacy)}\n`);
	assert.deepEqual(readProviderCallRecords(root), [record, legacy], "historical date records remain readable without migration or reinterpretation");
} finally {
	rmSync(root, { recursive: true, force: true });
}
