import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

import express from "express";

import type { GoalService } from "../../server/goals/service.js";
import { createWikiRouter } from "../../server/wiki/api.js";

const workspaceDir = mkdtempSync(join(tmpdir(), "telomi-wiki-api-"));
const goalId = "goal-wiki-api";
const emptyGoalId = "goal-empty-wiki";
const corruptGoalId = "goal-corrupt-wiki";
mkdirSync(join(workspaceDir, emptyGoalId));
const corruptRoot = join(workspaceDir, corruptGoalId, "wiki", "knowledge");
mkdirSync(corruptRoot, { recursive: true });
writeFileSync(join(corruptRoot, ".topic-plan.json"), "{");
const knowledgeRoot = join(workspaceDir, goalId, "wiki", "knowledge");
const runsRoot = join(workspaceDir, goalId, "wiki", "runs");
mkdirSync(join(knowledgeRoot, "topics"), { recursive: true });
mkdirSync(runsRoot, { recursive: true });
writeFileSync(join(knowledgeRoot, ".topic-plan.json"), `${JSON.stringify({
	schema_version: 1,
	goal_id: goalId,
	revision: "topic-wiki-api",
	status: "active",
	topics: [{ id: "topic-runtime", title: "Runtime", intent: "Runtime boundaries", questions: [], include: [], exclude: [] }],
}, null, 2)}\n`);
writeFileSync(join(knowledgeRoot, ".note-registry.json"), JSON.stringify({
	schema_version: 2,
	entries: [{
		id: "entry:example",
		revisionSha256: "a".repeat(64),
		sourceRunId: "2026-08-20T00-00-00.000Z",
		sourceId: "source:logical-example",
		members: [{ source_id: "source:example" }],
	}],
}));
const sourceRoot = join(runsRoot, "2026-08-20T00-00-00.000Z", "artifacts", "source-bundles", "job-1-arxiv", "attempt-1", "sources", "0001");
mkdirSync(join(sourceRoot, "assets"), { recursive: true });
writeFileSync(join(sourceRoot, "assets", "figure.png"), Buffer.from([137, 80, 78, 71]));
writeFileSync(join(sourceRoot, "document.md"), "# Source\n\n![Figure](assets/figure.png)\n");
writeFileSync(join(sourceRoot, "..", "..", "source-index.json"), JSON.stringify({
	sources: [{ source_id: "source:example", path: "sources/0001" }],
}));

writeFileSync(join(knowledgeRoot, "quickstart.md"), `---
type: Section
title: Wiki Home
description: Start here
---
# Wiki Home

Read [Runtime](topics/runtime.md).
`);
writeFileSync(join(knowledgeRoot, "topics", "runtime.md"), `---
type: Reference
title: Runtime
description: Runtime boundaries
---
# Runtime

Only deterministic checks live here.
`);
writeFileSync(join(runsRoot, "secret.md"), "# Must not be exposed\n");

const goals = {
	getGoal: (id: string) => [goalId, emptyGoalId, corruptGoalId].includes(id) ? { id, title: "Wiki API" } : undefined,
} as unknown as GoalService;
const app = express();
app.use(createWikiRouter(workspaceDir, goals));
const server = app.listen(0);
await new Promise<void>((resolve, reject) => {
	server.once("listening", resolve);
	server.once("error", reject);
});
const port = (server.address() as AddressInfo).port;
const api = (path: string) => fetch(`http://127.0.0.1:${port}${path}`);

try {
	const emptyTree = await api(`/api/goals/${emptyGoalId}/wiki`);
	assert.equal(emptyTree.status, 200);
	assert.deepEqual(await emptyTree.json(), { pages: [], topics: [], edition: null });
	const emptyGraph = await api(`/api/goals/${emptyGoalId}/wiki/graph`);
	assert.equal(emptyGraph.status, 200);
	const { generatedAt, ...emptyNavigation } = await emptyGraph.json() as { generatedAt: string };
	assert.equal(generatedAt, "", "an unpublished Wiki has no publication timestamp");
	assert.deepEqual(emptyNavigation, { types: [], nodes: [], edges: [], communities: [], relations: [] });
	const emptySearch = await api(`/api/goals/${emptyGoalId}/wiki/search?q=runtime`);
	assert.equal(emptySearch.status, 200);
	assert.deepEqual(await emptySearch.json(), {
		mode: "keyword_graph", tokenHits: 0, vectorHits: 0, graphHits: 0, elapsedMs: 0,
		index: { status: "unavailable", indexedPages: 0, totalPages: 0, refreshing: false }, results: [],
	});
	assert.equal(existsSync(join(workspaceDir, emptyGoalId, "wiki")), false,
		"reading an unpublished Wiki must not create a fabricated Edition or index");
	assert.equal((await api(`/api/goals/${emptyGoalId}/wiki/page?path=missing.md`)).status, 404);
	assert.equal((await api(`/api/goals/${emptyGoalId}/wiki/source?path=source:test&run=missing-run`)).status, 404);
	for (const suffix of ["", "/graph", "/search?q=runtime"]) {
		const separator = suffix.includes("?") ? "&" : "?";
		assert.equal((await api(`/api/goals/${emptyGoalId}/wiki${suffix}${separator}revision=missing`)).status, 404,
			"an explicit missing Edition must not become an empty current Wiki");
		assert.equal((await api(`/api/goals/unknown/wiki${suffix}`)).status, 404);
		assert.equal((await api(`/api/goals/${corruptGoalId}/wiki${suffix}`)).status, 500,
			"damaged Edition metadata must not become an empty current Wiki");
	}
	writeFileSync(join(corruptRoot, ".topic-plan.json"), JSON.stringify({ revision: "" }));
	assert.equal((await api(`/api/goals/${corruptGoalId}/wiki`)).status, 500,
		"invalid Edition revision metadata must not be silently ignored");

	const treeResponse = await api(`/api/goals/${goalId}/wiki`);
	assert.equal(treeResponse.status, 200);
	const tree = await treeResponse.json() as { pages: Array<{ path: string }> };
	assert.deepEqual(tree.pages.map((page) => page.path), ["quickstart.md", "topics/runtime.md"]);
	assert.ok(tree.pages.every((page) => !page.path.includes("runs")));

	const pageResponse = await api(`/api/goals/${goalId}/wiki/page?path=${encodeURIComponent("topics/runtime.md")}`);
	assert.equal(pageResponse.status, 200);
	const page = await pageResponse.json() as { title: string; content: string; frontmatter: Record<string, unknown>; backlinks: string[] };
	assert.equal(page.title, "Runtime");
	assert.match(page.content, /deterministic checks/);
	assert.deepEqual(page.frontmatter, {
		type: "Reference",
		title: "Runtime",
		description: "Runtime boundaries",
	});
	assert.deepEqual(page.backlinks, ["quickstart"]);

	const graphResponse = await api(`/api/goals/${goalId}/wiki/graph`);
	assert.equal(graphResponse.status, 200);
	const graph = await graphResponse.json() as { nodes: Array<{ id: string }>; edges: Array<{
		source: string;
		target: string;
		weight: number;
		signals: { direct: number; sourceOverlap: number; adamicAdar: number; typeAffinity: number };
	}> };
	assert.deepEqual(graph.nodes.map((node) => node.id), ["quickstart", "topics/runtime"]);
	assert.ok(graph.nodes.every((node) => !("body" in node)), "graph payload must not carry page bodies");
	assert.deepEqual(graph.edges, [{
		source: "quickstart",
		target: "topics/runtime",
		weight: 3.5,
		signals: { direct: 3, sourceOverlap: 0, adamicAdar: 0, typeAffinity: 0.5 },
	}]);

	assert.equal((await api("/api/goals/unknown/wiki")).status, 404);
	assert.equal((await api(`/api/goals/${goalId}/wiki/page`)).status, 400);
	assert.equal((await api(`/api/goals/${goalId}/wiki/page?path=${encodeURIComponent("../../runs/secret.md")}`)).status, 400);
	assert.equal((await api(`/api/goals/${goalId}/wiki/page?path=missing.md`)).status, 404);
	const assetResponse = await api(`/api/goals/${goalId}/wiki/source-asset?source=${encodeURIComponent("source:example")}&path=${encodeURIComponent("assets/figure.png")}`);
	assert.equal(assetResponse.status, 200);
	assert.deepEqual([...new Uint8Array(await assetResponse.arrayBuffer())], [137, 80, 78, 71]);
	assert.equal((await api(`/api/goals/${goalId}/wiki/source-asset?source=${encodeURIComponent("source:example")}&path=${encodeURIComponent("../secret.png")}`)).status, 400);
} finally {
	await new Promise<void>((resolve) => server.close(() => resolve()));
	rmSync(workspaceDir, { recursive: true, force: true });
}

console.log("wiki API tests passed");
