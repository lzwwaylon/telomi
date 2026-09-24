import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ResearchNodeError } from "../../server/agent-runtime/retry-policy.js";
import { generalWebWithFallback } from "../../server/research/sources/general-web-fallback.js";
import { ProviderRuntime } from "../../server/research/sources/provider-runtime.js";
import type { ResearchSearchProvider, ResearchSearchRequest } from "../../server/providers/search-types.js";

// general_web prefers the policy's backend and falls back, in order, only when a backend is
// unavailable; a rejected query stops at the first backend.
const root = mkdtempSync(join(tmpdir(), "telomi-general-web-fallback-"));
const runtime = new ProviderRuntime({ databasePath: join(root, "runtime.sqlite") });
const request: ResearchSearchRequest = {
	query: "tts official blog", maxResults: 5, criterionIds: [], purpose: "test", workspaceDir: root, signal: new AbortController().signal,
};
const calls: string[] = [];
const backend = (id: string, behaviour: () => never | Array<{ id: string }>): ResearchSearchProvider => ({
	id: `general_web_${id}`,
	async search() {
		calls.push(id);
		const rows = behaviour();
		return rows.map((row) => ({ ...row, title: row.id, url: `https://example.com/${row.id}`, metadata: { general_web_backend: id } })) as never;
	},
});
// Non-retryable so the Runtime's own retry loop stays out of the way; the fallback keys on the code.
const unavailable = (code: string) => () => { throw new ResearchNodeError(`${code} on this backend`, "provider", false, { code }); };
const rejected = () => { throw new ResearchNodeError("query rejected", "validation", false, { code: "provider_rejected_request" }); };

try {
	const ok = generalWebWithFallback("firecrawl", {
		firecrawl: backend("firecrawl", unavailable("provider_credentials")),
		tavily: backend("tavily", () => [{ id: "t1" }]),
		exa: backend("exa", () => [{ id: "e1" }]),
	}, runtime);
	const rows = await ok.search(request);
	assert.deepEqual(calls, ["firecrawl", "tavily"], "exhausted credits move on to the next backend in order, and no further");
	assert.equal(rows[0]?.metadata?.general_web_backend, "tavily", "the row names the backend that answered");
	assert.deepEqual(rows[0]?.metadata?.general_web_fallback_from, ["firecrawl"], "and which ones were skipped");

	calls.length = 0;
	const preferExa = generalWebWithFallback("exa", {
		firecrawl: backend("firecrawl", () => [{ id: "f1" }]),
		tavily: backend("tavily", () => [{ id: "t1" }]),
		exa: backend("exa", () => [{ id: "e1" }]),
	}, runtime);
	const direct = await preferExa.search(request);
	assert.deepEqual(calls, ["exa"], "the preferred backend answers alone when it works");
	assert.equal(direct[0]?.metadata?.general_web_fallback_from, undefined);

	calls.length = 0;
	const stopsOnRejection = generalWebWithFallback("firecrawl", {
		firecrawl: backend("firecrawl", rejected),
		tavily: backend("tavily", () => [{ id: "t1" }]),
		exa: backend("exa", () => [{ id: "e1" }]),
	}, runtime);
	await assert.rejects(stopsOnRejection.search(request), /query rejected/u);
	assert.deepEqual(calls, ["firecrawl"], "a rejected query is not retried on another backend");

	calls.length = 0;
	const allDown = generalWebWithFallback("firecrawl", {
		firecrawl: backend("firecrawl", unavailable("provider_credentials")),
		tavily: backend("tavily", unavailable("provider_rate_limit")),
		exa: backend("exa", unavailable("provider_timeout")),
	}, runtime);
	await assert.rejects(allDown.search(request), (error: unknown) => {
		assert.ok(error instanceof ResearchNodeError);
		assert.equal(error.code, "general_web_unavailable");
		assert.equal(error.retryable, true);
		assert.match(error.message, /firecrawl: provider_credentials.*tavily: provider_rate_limit.*exa: provider_timeout/u);
		return true;
	});
	assert.deepEqual(calls, ["firecrawl", "tavily", "exa"]);
	console.log("General Web backend fallback order tests passed");
} finally {
	rmSync(root, { recursive: true, force: true });
}
