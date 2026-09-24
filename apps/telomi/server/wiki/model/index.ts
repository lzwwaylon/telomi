import path from "node:path";
import { readFile } from "node:fs/promises";

import { ensureWikiRoot, readWikiText, resolveExistingPage, toWikiPath } from "./files.js";
import { splitFrontmatter } from "./frontmatter.js";
import { buildWikiGraph, type WikiGraph } from "./graph.js";
import {
	projectWikiBodyEvidenceLinks,
	readWikiPageEvidence,
	type WikiEvidenceEntry,
} from "../../wiki/evidence.js";
import { validateGoalTopicPlan } from "../../goals/topic-plan/index.js";

export type { WikiEdge, WikiGraph, WikiNode } from "./graph.js";

export interface WikiPageSummary {
	path: string;
	title: string;
	type: string;
	description: string;
	primaryTopicRef: string;
	topicRefs: string[];
}

export interface WikiTree {
	pages: WikiPageSummary[];
	topics: Array<{ id: string; title: string; description: string }>;
}

export interface WikiPage extends WikiPageSummary {
	content: string;
	frontmatter: Record<string, unknown>;
	evidence: WikiEvidenceEntry[];
	links: string[];
	backlinks: string[];
	missingLinks: string[];
}

export interface WikiRuntime {
	readTree(): Promise<WikiTree>;
	readPage(pagePath: string): Promise<WikiPage>;
	buildGraph(): Promise<WikiGraph>;
}

export function createWikiRuntime(rootDir: string, options: { goalDir?: string } = {}): WikiRuntime {
	const configuredRoot = path.resolve(rootDir);
	const root = () => ensureWikiRoot(configuredRoot);
	// ponytail: one graph build per runtime instance, so a request or a tool session reads one consistent snapshot; recreate the runtime to see new publications.
	let graphPromise: Promise<WikiGraph> | undefined;
	const graph = () => graphPromise ??= root().then(buildWikiGraph);

	return {
		async readTree() {
			const wikiRoot = await root();
			const [wikiGraph, topics] = await Promise.all([graph(), readTopics(wikiRoot)]);
			return {
				topics,
				pages: wikiGraph.nodes.map(({ id, title, type, description, primaryTopicRef, topicRefs }) => ({
					path: `${id}.md`,
					title,
					type,
					description,
					primaryTopicRef,
					topicRefs,
				})),
			};
		},
		async readPage(pagePath) {
			const wikiRoot = await root();
			const file = await resolveExistingPage(wikiRoot, pagePath);
			const id = toWikiPath(wikiRoot, file).replace(/\.md$/iu, "");
			const [wikiGraph, rawContent] = await Promise.all([graph(), readWikiText(file)]);
			const node = wikiGraph.nodes.find((candidate) => candidate.id === id);
			if (!node) throw new Error(`Wiki page is not part of the readable wiki: ${pagePath}`);
			const frontmatter = splitFrontmatter(rawContent).fields ?? {};
			const evidence = ["concept", "entity"].includes(node.type.toLocaleLowerCase())
				? readWikiPageEvidence(wikiRoot, frontmatter, options.goalDir)
				: [];
			return {
				path: `${node.id}.md`,
				title: node.title,
				type: node.type,
				description: node.description,
				primaryTopicRef: node.primaryTopicRef,
				topicRefs: node.topicRefs,
				content: projectWikiBodyEvidenceLinks(node.body, evidence.length),
				frontmatter,
				evidence,
				links: node.links,
				backlinks: node.backlinks,
				missingLinks: node.missingLinks,
			};
		},
		buildGraph: graph,
	};
}

async function readTopics(root: string): Promise<Array<{ id: string; title: string; description: string }>> {
	try {
		return validateGoalTopicPlan(
			JSON.parse(await readFile(path.join(root, ".topic-plan.json"), "utf-8")),
		).topics.map((topic) => ({ id: topic.id, title: topic.title, description: topic.intent }));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		return [];
	}
}
