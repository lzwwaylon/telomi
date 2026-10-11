import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { huggingface } from "../../server/providers/sources/huggingface.js";
import type { ResearchSearchProvider, ResearchSearchRequest } from "../../server/providers/search-types.js";
import { builtInFastApiRuntimePolicy, ProviderRuntime } from "../../server/research/index.js";

const root = mkdtempSync(join(tmpdir(), "huggingface-date-cache-"));
const runtime = new ProviderRuntime({ databasePath: join(root, "cache.sqlite3") });
try {
	const request: ResearchSearchRequest = { query: "speech models", maxResults: 5, criterionIds: [], purpose: "date semantics",
		workspaceDir: root, signal: new AbortController().signal,
		providerRequest: { operation: "models_list", parameters: { search: "speech", limit: 5 } } };
	const row = { id: "model", title: "Example model", url: "https://huggingface.co/example/model", snippet: "",
		metadata: { resource_type: "model", created_at: "2026-01-21" } };
	const provider: ResearchSearchProvider = { id: "huggingface", catalog: huggingface.provider!.catalog!,
		runtimePolicy: builtInFastApiRuntimePolicy({ sourceId: "huggingface", env: {} }),
		async search() { return [row]; } };
	const legacy = { ...provider, catalog: { ...provider.catalog!, implementationVersion: "huggingface-hub-http-v5" },
		async search() { return [{ ...row, publishedAt: "2026-01-21" }]; } };
	assert.equal((await runtime.search(legacy, request)).results[0]?.publishedAt, "2026-01-21");
	assert.equal((await runtime.search(legacy, request)).cache.status, "hit");
	const current = await runtime.search(provider, request);
	assert.equal(current.cache.status, "miss", "old Hub response cache entries cannot revive the creation/publication alias");
	assert.equal(current.results[0]?.publishedAt, undefined);
	assert.equal(current.results[0]?.metadata?.created_at, "2026-01-21");
	assert.equal((await runtime.search(provider, request)).cache.status, "hit", "corrected metadata still benefits from response caching");
} finally {
	runtime.close();
	rmSync(root, { recursive: true, force: true });
}
