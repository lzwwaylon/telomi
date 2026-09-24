import path from "node:path";

import { UndirectedGraph } from "graphology";
import louvain from "graphology-communities-louvain";

import { splitFrontmatter } from "./frontmatter.js";
import { listWikiMarkdown, readWikiText, toWikiPath } from "./files.js";

export interface WikiNode {
	id: string;
	title: string;
	type: string;
	description: string;
	primaryTopicRef: string;
	topicRefs: string[];
	body: string;
	size: number;
	links: string[];
	backlinks: string[];
	missingLinks: string[];
	sources: string[];
	linkCount: number;
	community: number;
}

export interface WikiEdgeSignals { direct: number; sourceOverlap: number; adamicAdar: number; typeAffinity: number }
export interface WikiEdge { source: string; target: string; weight: number; signals: WikiEdgeSignals }
export interface WikiCommunity { id: number; nodeCount: number; cohesion: number; topNodes: string[] }
export interface WikiGraph {
	generatedAt: string;
	types: string[];
	nodes: WikiNode[];
	edges: WikiEdge[];
	communities: WikiCommunity[];
}

const MARKDOWN_LINK = /\]\(([^)\s]+\.md)(?:#[^)]*)?\)/gu;

export async function buildWikiGraph(root: string): Promise<WikiGraph> {
	const files = await listWikiMarkdown(root, { includeIndexes: true });
	const nodes = await Promise.all(files.map(async (file): Promise<WikiNode> => {
		const { fields, body } = splitFrontmatter(await readWikiText(file));
		const wikiPath = toWikiPath(root, file);
		const id = wikiPath.replace(/\.md$/iu, "");
		const isIndex = path.basename(file) === "index.md";
		const title = scalar(fields?.title)
			?? (isIndex ? sectionTitle(file, root) : /^#\s+(.+)$/mu.exec(body)?.[1]?.trim())
			?? path.basename(file, ".md");
		return {
			id,
			title,
			type: scalar(fields?.type) ?? (isIndex ? "Section" : "Reference"),
			description: scalar(fields?.description) ?? "",
			primaryTopicRef: scalar(fields?.primary_topic_ref) ?? "",
			topicRefs: strings(fields?.topic_refs),
			body,
			size: body.length,
			links: [],
			backlinks: [],
			missingLinks: [],
			sources: strings(fields?.sources),
			linkCount: 0,
			community: 0,
		};
	}));
	const edges = linkNodes(nodes, root);
	const communities = analyzeGraph(nodes, edges);
	return {
		generatedAt: new Date().toISOString(),
		types: [...new Set(nodes.map((node) => node.type))].sort(),
		nodes,
		edges,
		communities,
	};
}

function linkNodes(nodes: WikiNode[], root: string): WikiEdge[] {
	const byId = new Map(nodes.map((node) => [node.id, node]));
	const aliases = buildAliases(nodes);
	const directedLinks = new Set<string>();
	const connectedPairs = new Set<string>();
	for (const node of nodes) {
		const sourceDirectory = path.dirname(path.join(root, `${node.id}.md`));
		const markdownTargets = [...node.body.matchAll(MARKDOWN_LINK)].map((match) => ({
			value: safeDecode(match[1]),
			relative: true,
		}));
		for (const link of markdownTargets) {
			const target = resolveLinkTarget(root, sourceDirectory, link.value, link.relative, aliases);
			if (!target) {
				node.missingLinks.push(link.value);
				continue;
			}
			const targetNode = byId.get(target);
			const directedKey = `${node.id}\n${target}`;
			if (!targetNode || target === node.id || directedLinks.has(directedKey)) continue;
			directedLinks.add(directedKey);
			connectedPairs.add([node.id, target].sort().join("\n"));
			node.links.push(target);
			targetNode.backlinks.push(node.id);
		}
	}
	for (const node of nodes) {
		node.links.sort();
		node.backlinks.sort();
		node.missingLinks = [...new Set(node.missingLinks)].sort();
		node.linkCount = new Set([...node.links, ...node.backlinks]).size;
	}
	return [...connectedPairs].sort().map((pair) => {
		const [source, target] = pair.split("\n") as [string, string];
		const signals = relevanceSignals(byId.get(source)!, byId.get(target)!, byId);
		return { source, target, weight: Object.values(signals).reduce((sum, value) => sum + value, 0), signals };
	});
}

const TYPE_AFFINITY: Record<string, Record<string, number>> = {
	entity: { concept: 1.2, entity: 0.8, source: 1, synthesis: 1, query: 0.8 },
	concept: { entity: 1.2, concept: 0.8, source: 1, synthesis: 1.2, query: 1 },
	source: { entity: 1, concept: 1, source: 0.5, query: 0.8, synthesis: 1 },
	query: { concept: 1, entity: 0.8, synthesis: 1, source: 0.8, query: 0.5 },
	synthesis: { concept: 1.2, entity: 1, source: 1, query: 1, synthesis: 0.8 },
};

function relevanceSignals(left: WikiNode, right: WikiNode, nodes: ReadonlyMap<string, WikiNode>): WikiEdgeSignals {
	const direct = (left.links.includes(right.id) ? 3 : 0) + (right.links.includes(left.id) ? 3 : 0);
	const leftSources = new Set(left.sources);
	const sourceOverlap = right.sources.filter((source) => leftSources.has(source)).length * 4;
	const leftNeighbors = new Set([...left.links, ...left.backlinks]);
	const rightNeighbors = new Set([...right.links, ...right.backlinks]);
	let adamicAdar = 0;
	for (const id of leftNeighbors) {
		if (!rightNeighbors.has(id)) continue;
		adamicAdar += 1 / Math.log(Math.max(nodes.get(id)?.linkCount ?? 0, 2));
	}
	const typeAffinity = TYPE_AFFINITY[left.type.toLowerCase()]?.[right.type.toLowerCase()] ?? 0.5;
	return { direct, sourceOverlap, adamicAdar: adamicAdar * 1.5, typeAffinity };
}

function analyzeGraph(nodes: WikiNode[], edges: WikiEdge[]): WikiCommunity[] {
	if (nodes.length === 0) return [];
	const graph = new UndirectedGraph();
	for (const node of nodes) graph.addNode(node.id);
	for (const edge of edges) {
		if (graph.hasEdge(edge.source, edge.target)) continue;
		graph.addEdge(edge.source, edge.target, { weight: edge.weight });
	}
	const assignments = louvain(graph, { resolution: 1, randomWalk: false });
	const groups = new Map<number, WikiNode[]>();
	for (const node of nodes) {
		const id = assignments[node.id] ?? 0;
		const group = groups.get(id) ?? [];
		group.push(node);
		groups.set(id, group);
	}
	const internalEdges = new Map<number, number>();
	for (const edge of edges) {
		const sourceCommunity = assignments[edge.source];
		if (sourceCommunity === assignments[edge.target]) {
			internalEdges.set(sourceCommunity, (internalEdges.get(sourceCommunity) ?? 0) + 1);
		}
	}
	const communities = [...groups].map(([id, members]) => ({
		id,
		nodeCount: members.length,
		cohesion: (internalEdges.get(id) ?? 0) / Math.max(1, members.length * (members.length - 1) / 2),
		topNodes: [...members].sort((left, right) => right.linkCount - left.linkCount).slice(0, 5).map((node) => node.title),
	})).sort((left, right) => right.nodeCount - left.nodeCount);
	const remap = new Map(communities.map((community, index) => [community.id, index]));
	for (const [index, community] of communities.entries()) community.id = index;
	for (const node of nodes) node.community = remap.get(assignments[node.id] ?? 0) ?? 0;
	return communities;
}

function buildAliases(nodes: readonly WikiNode[]): Map<string, string> {
	const candidates = new Map<string, Set<string>>();
	for (const node of nodes) {
		for (const value of [
			node.id,
			`${node.id}.md`,
			`wiki/${node.id}`,
			`wiki/${node.id}.md`,
			path.posix.basename(node.id),
			node.title,
		]) {
			const key = normalizeAlias(value);
			if (!key) continue;
			const matches = candidates.get(key) ?? new Set<string>();
			matches.add(node.id);
			candidates.set(key, matches);
		}
	}
	return new Map([...candidates]
		.filter(([, matches]) => matches.size === 1)
		.map(([key, matches]) => [key, [...matches][0]!]));
}

function resolveLinkTarget(
	root: string,
	sourceDirectory: string,
	value: string,
	relative: boolean,
	aliases: ReadonlyMap<string, string>,
): string | undefined {
	const withoutFragment = value.split("#", 1)[0]?.trim();
	if (!withoutFragment) return undefined;
	if (relative) {
		const absolute = path.resolve(sourceDirectory, withoutFragment);
		const target = toWikiPath(root, absolute).replace(/\.md$/iu, "");
		return aliases.get(normalizeAlias(target));
	}
	return aliases.get(normalizeAlias(withoutFragment));
}

function normalizeAlias(value: string): string {
	return value
		.trim()
		.replaceAll("\\", "/")
		.replace(/^\/+|\/+$/gu, "")
		.replace(/^wiki\//iu, "")
		.replace(/\.md$/iu, "")
		.toLocaleLowerCase()
		.replace(/\s+/gu, "-");
}

function sectionTitle(file: string, root: string): string {
	const directory = path.dirname(file);
	const name = directory === root ? "Home" : path.basename(directory);
	return name.charAt(0).toUpperCase() + name.slice(1);
}

function scalar(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value : undefined;
}

function strings(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && Boolean(item.trim())) : [];
}

function safeDecode(value: string): string {
	try { return decodeURIComponent(value); } catch { return value; }
}
