import assert from "node:assert/strict";

import { agentFacingRows } from "../../server/research/pipeline/prime-search-batch.js";

const CURSOR = "eyIkb3IiOlt7Imxhc3RNb2RpZmllZCI6IjIwMjYtMDctMjhUMjI6NTU6MTUuMDAwWiJ9XX0=";

function huggingFaceRow(index: number) {
	return {
		id: `huggingface-${index}`,
		title: `owner/model-${index}`,
		url: `https://huggingface.co/owner/model-${index}`,
		snippet: "Hugging Face model repository.",
		publishedAt: "2026-04-17T16:56:31.000Z",
		authors: ["owner"],
		metadata: {
			resource_type: "model",
			repo_id: `owner/model-${index}`,
			sha: "7d4940564fb5dca463d5f815bf57c73743e77c8d",
			document_url: `https://huggingface.co/owner/model-${index}/raw/main/README.md`,
			downloads: index,
			material_cache_hit: false,
			provider_implementation: "huggingface_hub_http_v4",
			reliability_tier: "platform_primary",
			huggingface_page: { operation: "models_list", cursor: null, next_cursor: CURSOR, limit: 100 },
		},
	};
}

const page = agentFacingRows(Array.from({ length: 100 }, (_, index) => huggingFaceRow(index)));
const metadata = page.map((row) => (row as { metadata: Record<string, unknown> }).metadata);

// A paging cursor describes the page, so exactly one row carries it. The SDK's cursor lookup walks
// rows and returns the first hit, so paging still resolves the same value it did before.
const carrying = metadata.filter((item) => item.huggingface_page !== undefined);
assert.equal(carrying.length, 1);
assert.deepEqual(carrying[0]!.huggingface_page, { next_cursor: CURSOR });
assert.equal(metadata[0]!.huggingface_page !== undefined, true, "the first row must carry the cursor");

// The request echo beside the cursor is dropped: the Agent supplied it.
assert.equal(JSON.stringify(page).includes("models_list"), false);
assert.equal(JSON.stringify(page).includes('"limit"'), false);

// Runtime bookkeeping no Provider contract promises the Agent is gone.
for (const item of metadata) {
	assert.equal(item.provider_implementation, undefined);
	assert.equal(item.reliability_tier, undefined);
}

// Everything the Provider contract does promise survives on every row, including the cache flag the
// SDK reads from all rows to decide whether a batch was fully served from cache.
for (const [index, item] of metadata.entries()) {
	assert.equal(item.repo_id, `owner/model-${index}`);
	assert.equal(item.sha, "7d4940564fb5dca463d5f815bf57c73743e77c8d");
	assert.equal(item.document_url, `https://huggingface.co/owner/model-${index}/raw/main/README.md`);
	assert.equal(item.downloads, index);
	assert.equal(item.material_cache_hit, false);
	assert.equal(item.resource_type, "model");
}
for (const [index, row] of page.entries()) {
	assert.equal(row.id, `huggingface-${index}`);
	assert.equal(row.title, `owner/model-${index}`);
	assert.equal(row.url, `https://huggingface.co/owner/model-${index}`);
	assert.equal(row.published_at, "2026-04-17T16:56:31.000Z");
	assert.deepEqual(row.authors, ["owner"]);
}

// A terminal page has no cursor to carry, and must not invent an empty one.
const terminal = agentFacingRows([{
	...huggingFaceRow(0),
	metadata: { ...huggingFaceRow(0).metadata, huggingface_page: { operation: "models_list", next_cursor: null } },
}]);
assert.equal((terminal[0] as { metadata: Record<string, unknown> }).metadata.huggingface_page, undefined);

// Rows without metadata pass through untouched.
const bare = agentFacingRows([{ id: "a", title: "t", url: "https://example.test/a", snippet: "s" }]);
assert.deepEqual(bare, [{ id: "a", title: "t", url: "https://example.test/a", snippet: "s" }]);

const before = JSON.stringify(Array.from({ length: 100 }, (_, index) => huggingFaceRow(index))).length;
const after = JSON.stringify(page).length;
assert.ok(after < before * 0.7, `projection must cut a cursor-heavy page hard, got ${after}/${before}`);

console.log(`Provider row projection tests passed (100 行 ${before} -> ${after} 字符)`);
