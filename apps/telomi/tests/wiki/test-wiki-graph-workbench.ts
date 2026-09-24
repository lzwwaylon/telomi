import assert from "node:assert/strict";
import test from "node:test";
import i18n from "../../web/src/app/i18n.js";

import { DEFAULT_WIKI_GRAPH_FILTERS, filterWikiGraph, graphInsights, searchWikiGraph } from "../../web/src/features/wiki/wiki-graph-workbench.ts";
import { countFilterChanges } from "../../web/src/features/wiki/WikiGraphWorkbench.tsx";
import { edgeRelevanceLabel, type WikiGraph, type WikiGraphNode } from "../../web/src/features/wiki/wiki-model.ts";

const node = (id: string, community: number, linkCount: number, sources: string[] = []): WikiGraphNode => ({
	id,
	title: id,
	type: id === "source" ? "source" : "concept",
	description: "",
	primaryTopicRef: "",
	topicRefs: [],
	size: 10,
	links: [],
	backlinks: [],
	missingLinks: [],
	sources,
	linkCount,
	community,
});

const graph: WikiGraph = {
	generatedAt: "",
	types: ["concept", "source"],
	nodes: [
		node("bridge", 0, 4, ["shared"]),
		node("alpha", 1, 2, ["shared"]),
		node("beta", 2, 2),
		node("source", 3, 2),
		node("isolated", 3, 0),
	],
	edges: [
		{ source: "bridge", target: "alpha", weight: 7 },
		{ source: "bridge", target: "beta", weight: 4 },
		{ source: "bridge", target: "source", weight: 4 },
	],
	communities: [
		{ id: 0, nodeCount: 1, cohesion: 0, topNodes: ["bridge"] },
		{ id: 1, nodeCount: 1, cohesion: 0, topNodes: ["alpha"] },
		{ id: 2, nodeCount: 1, cohesion: 0, topNodes: ["beta"] },
		{ id: 3, nodeCount: 2, cohesion: 0, topNodes: ["source"] },
	],
};

test("hides provenance-only Source pages by default", () => {
	assert.deepEqual(filterWikiGraph(graph, DEFAULT_WIKI_GRAPH_FILTERS).nodes.map((item) => item.id), ["bridge", "alpha", "beta", "isolated"]);
});

test("filters graph nodes and their incident edges", () => {
	const filtered = filterWikiGraph(graph, {
		hiddenTypes: new Set(["source"]),
		hideStructural: false,
		hideIsolated: true,
	});
	assert.deepEqual(filtered.nodes.map((item) => item.id), ["bridge", "alpha", "beta"]);
	assert.equal(filtered.edges.length, 2);
});

test("surfaces source overlap, isolated pages, and bridge nodes", async () => {
	await i18n.changeLanguage("zh-CN");
	const insights = graphInsights(graph);
	assert.ok(insights.some((item) => item.kind === "connection" && item.description.includes("共享 1 个 Source")));
	assert.ok(insights.some((item) => item.kind === "isolated-node" && item.nodeIds.includes("isolated")));
	assert.ok(insights.some((item) => item.kind === "bridge-node" && item.nodeIds[0] === "bridge"));
});

test("searches graph nodes with all query tokens", () => {
	const searched = searchWikiGraph(graph, "alpha concept");
	assert.deepEqual(searched.nodes.map((item) => item.id), ["alpha"]);
	assert.equal(searched.edges.length, 0);
});

test("explains every relevance signal", async () => {
	await i18n.changeLanguage("en");
	assert.equal(edgeRelevanceLabel({ weight: 11.25, signals: { direct: 6, sourceOverlap: 4, adamicAdar: 0.45, typeAffinity: 0.8 } }), "Relevance 11.25 · Direct 6.00 · Source overlap 4.00 · Adamic-Adar 0.45 · Type affinity 0.80");
});

test("filter badge counts only deviations from the defaults", () => {
	assert.equal(countFilterChanges(DEFAULT_WIKI_GRAPH_FILTERS), 0);
	assert.equal(countFilterChanges({ ...DEFAULT_WIKI_GRAPH_FILTERS, hiddenTypes: new Set(), hideIsolated: true, minLinks: 2 }), 3);
});
