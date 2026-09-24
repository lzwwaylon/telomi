import type { WikiCommunity, WikiGraph, WikiGraphNode } from "@/features/wiki/wiki-model";
import { uiText } from "@/app/ui-text";

export type WikiGraphColorMode = "type" | "community";

export interface WikiGraphFilters {
	hiddenTypes: ReadonlySet<string>;
	hideStructural: boolean;
	hideIsolated: boolean;
	minLinks?: number;
	maxLinks?: number;
}

export interface WikiGraphInsight {
	key: string;
	kind: "connection" | "isolated-node" | "sparse-community" | "bridge-node";
	title: string;
	description: string;
	nodeIds: string[];
	score?: number;
}

export const DEFAULT_WIKI_GRAPH_FILTERS: WikiGraphFilters = {
	hiddenTypes: new Set(["source"]),
	hideStructural: true,
	hideIsolated: false,
};

const STRUCTURAL_IDS = new Set(["index", "overview", "log", "schema", "purpose"]);

function structural(node: Pick<WikiGraphNode, "id" | "type">): boolean {
	const id = node.id.toLocaleLowerCase();
	return STRUCTURAL_IDS.has(id.split("/").at(-1) ?? id) || node.type.toLocaleLowerCase() === "overview";
}

export function filterWikiGraph(graph: WikiGraph, filters: WikiGraphFilters): WikiGraph {
	const nodes = graph.nodes.filter((node) => {
		if (filters.hiddenTypes.has(node.type)) return false;
		if (filters.hideStructural && structural(node)) return false;
		if (filters.hideIsolated && node.linkCount === 0) return false;
		if (filters.minLinks !== undefined && node.linkCount < filters.minLinks) return false;
		if (filters.maxLinks !== undefined && node.linkCount > filters.maxLinks) return false;
		return true;
	});
	const visible = new Set(nodes.map((node) => node.id));
	return {
		...graph,
		nodes,
		edges: graph.edges.filter((edge) => visible.has(edge.source) && visible.has(edge.target)),
	};
}

export function searchWikiGraph(graph: WikiGraph, query: string): WikiGraph {
	const tokens = query.toLocaleLowerCase().trim().split(/\s+/u).filter(Boolean);
	if (tokens.length === 0) return graph;
	const nodes = graph.nodes.filter((node) => {
		const haystack = [node.title, node.id, node.type].join(" ").toLocaleLowerCase();
		return tokens.every((token) => haystack.includes(token));
	});
	const visible = new Set(nodes.map((node) => node.id));
	return { ...graph, nodes, edges: graph.edges.filter((edge) => visible.has(edge.source) && visible.has(edge.target)) };
}

export function graphInsights(graph: WikiGraph): WikiGraphInsight[] {
	return [
		...surprisingConnections(graph).slice(0, 5),
		...knowledgeGaps(graph.nodes, graph.edges, graph.communities).slice(0, 8),
	];
}

function surprisingConnections(graph: WikiGraph): WikiGraphInsight[] {
	const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
	const maxDegree = Math.max(1, ...graph.nodes.map((node) => node.linkCount));
	return graph.edges.flatMap((edge) => {
		const source = nodes.get(edge.source);
		const target = nodes.get(edge.target);
		if (!source || !target || structural(source) || structural(target)) return [];
		let score = 0;
		const reasons: string[] = [];
		if (source.community !== target.community) {
			score += 3;
			reasons.push(uiText("wiki.graphWorkbench.crossesCommunityBoundaries"));
		}
		if (source.type !== target.type) {
			score += 1;
			reasons.push(uiText("wiki.graphWorkbench.connectsSourceAndTarget", { source: source.type, target: target.type }));
		}
		if (Math.min(source.linkCount, target.linkCount) <= 2 && Math.max(source.linkCount, target.linkCount) >= maxDegree * 0.5) {
			score += 2;
			reasons.push(uiText("wiki.graphWorkbench.connectsAPeripheralPageToAHubPage"));
		}
		const sourceSet = new Set(source.sources);
		const sharedSources = target.sources.filter((item) => sourceSet.has(item)).length;
		if (sharedSources > 0) {
			score += 2;
			reasons.push(uiText("wiki.graphWorkbench.sharesCountSources", { count: sharedSources }));
		}
		if (score < 3) return [];
		return [{
			key: `connection:${[source.id, target.id].sort().join("::")}`,
			kind: "connection" as const,
			title: `${source.title} ↔ ${target.title}`,
			description: reasons.join("; "),
			nodeIds: [source.id, target.id],
			score,
		}];
	}).sort((left, right) => (right.score ?? 0) - (left.score ?? 0));
}

function knowledgeGaps(
	nodes: WikiGraphNode[],
	edges: WikiGraph["edges"],
	communities: WikiCommunity[],
): WikiGraphInsight[] {
	const insights: WikiGraphInsight[] = [];
	const isolated = nodes.filter((node) => node.linkCount <= 1 && !structural(node));
	if (isolated.length > 0) {
		insights.push({
			key: "isolated-pages",
			kind: "isolated-node",
			title: uiText("wiki.graphWorkbench.countIsolatedOrWeaklyConnectedPages", { count: isolated.length }),
			description: isolated.slice(0, 5).map((node) => node.title).join(", ") + (isolated.length > 5 ? uiText("wiki.graphWorkbench.plusCountMore", { count: isolated.length - 5 }) : ""),
			nodeIds: isolated.map((node) => node.id),
		});
	}
	for (const community of communities) {
		if (community.nodeCount < 3 || community.cohesion >= 0.15) continue;
		insights.push({
			key: `sparse-community:${community.id}`,
			kind: "sparse-community",
			title: uiText("wiki.graphWorkbench.sparseCommunityName", { name: community.topNodes[0] ?? uiText("wiki.graphWorkbench.communityIndex", { index: community.id + 1 }) }),
			description: uiText("wiki.graphWorkbench.countPagesWithInternalConnectionDensityDensity", { count: community.nodeCount, density: community.cohesion.toFixed(2) }),
			nodeIds: nodes.filter((node) => node.community === community.id).map((node) => node.id),
		});
	}
	const communityNeighbors = new Map(nodes.map((node) => [node.id, new Set<number>()]));
	const nodesById = new Map(nodes.map((node) => [node.id, node]));
	for (const edge of edges) {
		const source = nodesById.get(edge.source);
		const target = nodesById.get(edge.target);
		if (!source || !target) continue;
		communityNeighbors.get(source.id)?.add(target.community);
		communityNeighbors.get(target.id)?.add(source.community);
	}
	const bridges = nodes.filter((node) => !structural(node) && (communityNeighbors.get(node.id)?.size ?? 0) >= 3)
		.sort((left, right) => (communityNeighbors.get(right.id)?.size ?? 0) - (communityNeighbors.get(left.id)?.size ?? 0))
		.slice(0, 3);
	for (const node of bridges) {
		const count = communityNeighbors.get(node.id)?.size ?? 0;
		insights.push({
			key: `bridge:${node.id}`,
			kind: "bridge-node",
			title: uiText("wiki.graphWorkbench.keyBridgeTitle", { title: node.title }),
			description: uiText("wiki.graphWorkbench.connectsCountKnowledgeCommunitiesAndIsAnImportantStructural", { count }),
			nodeIds: [node.id],
		});
	}
	return insights;
}
