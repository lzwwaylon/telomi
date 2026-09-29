import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { primeExecutionToken } from "../../../extensions/telomi-srt/prime-workspace.js";
import { startPrimeSourceBridge } from "../../server/research/pipeline/prime-search-batch.js";
import { ResearchSourceRegistry } from "../../server/research/sources/registry.js";

const root = mkdtempSync(join(tmpdir(), "prime-investigation-bridge-"));
mkdirSync(join(root, "work"));
const seen: string[] = [];
const bridge = await startPrimeSourceBridge(new ResearchSourceRegistry(), new Set(), {
	workspaceDirectory: root,
	temporalContext: { schemaVersion: 1, currentDate: "2026-09-29", timeZone: "UTC" },
	signal: new AbortController().signal,
}, root, { runDir: root, nodeId: "prime-investigation", attemptId: "1" }, {
	investigation: {
		knowledgeSearch: async (query, limit) => { seen.push(`knowledge:${query}:${limit}`); return { results: [] }; },
		deepSearch: async (question) => { seen.push(`deep:${question}`); return { status: "not_found", cues: [], gaps: [] }; },
		githubRead: async (question, repository, ref, paths) => {
			seen.push(`github:${question}:${repository}:${ref}:${paths.join(",")}`);
			return { provider: "github", reading: { status: "found", cues: [] } };
		},
	},
});

async function call(route: string, payload: Record<string, unknown>, identity = "root") {
	const response = await fetch(`${bridge.baseUrl}${route}`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			authorization: `Bearer ${primeExecutionToken(bridge.token, identity)}`,
		},
		body: JSON.stringify({ agent_session_id: identity, ...payload }),
	});
	return { status: response.status, body: await response.json() as Record<string, unknown> };
}

try {
	assert.deepEqual(await call("/v1/knowledge-search", { query: "loss", limit: 5 }),
		{ status: 200, body: { results: [] } });
	assert.deepEqual(await call("/v1/deep-search", { question: "Which loss?" }),
		{ status: 200, body: { status: "not_found", cues: [], gaps: [] } });
	assert.deepEqual(await call("/v1/github-read", { question: "Which loss?", repository: "owner/repo", ref: "v1", paths: ["loss.py"] }),
		{ status: 200, body: { provider: "github", reading: { status: "found", cues: [] } } });
	assert.equal((await call("/v1/github-read", { question: "Which loss?", repository: "owner/repo", ref: "v1", paths: ["loss.py"] }, "sub-123")).status, 422);
	assert.equal((await call("/v1/deep-search", { question: "Which loss?" }, "sub-123")).status, 422);
	assert.equal((await call("/v1/root-search", { query: "outside" })).status, 422);
	assert.equal((await call("/v1/search", { source_id: "general_web", query: "outside" })).status, 422);
	assert.deepEqual(seen, ["knowledge:loss:5", "deep:Which loss?", "github:Which loss?:owner/repo:v1:loss.py"]);
	console.log("Prime local investigation bridge passed");
} finally {
	await bridge.close();
	rmSync(root, { recursive: true, force: true });
}
