import { isAbsolute } from "node:path";

import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@sinclair/typebox";
import { bridgePositiveInteger, bridgeString } from "../agent-runtime/agent-tool-bridge.js";

import { GoalWikiSearch } from "./local-search.js";

const SearchSchema = Type.Object({
	query: Type.String({ minLength: 1 }),
	top_k: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
	topic_ref: Type.Optional(Type.String({ pattern: "^T[1-9][0-9]*$", description: "A Topic reference returned by wiki_list_topics in this execution. Omit to search all Wiki pages." })),
}, { additionalProperties: false });

const ListTopicsSchema = Type.Object({}, { additionalProperties: false });

const ReadPageSchema = Type.Object({
	path: Type.String({ minLength: 1 }),
}, { additionalProperties: false });

export function createGoalLlmWikiTools(options: {
	goalDir: string;
	knowledgeRoot?: string;
	/** Only frozen historical consumers may request the retired graph tool. */
	legacyGraphSearch?: boolean;
}): AgentTool[] {
	const local = new GoalWikiSearch(options.knowledgeRoot ?? `${options.goalDir}/wiki/knowledge`, { goalDir: options.goalDir });
	const topics = async () => (await local.listTopics()).topics.map((topic, index) => ({ ...topic, topic_ref: `T${index + 1}` }));
	const wikiListTopics: AgentTool<typeof ListTopicsSchema> = {
		name: "wiki_list_topics",
		label: "wiki_list_topics",
		description: "List this Wiki Edition's Topics, their scope and directly assigned page counts. Use the returned T-number topic_ref to filter wiki_search. References belong only to this execution; a Topic with zero pages is still listed.",
		parameters: ListTopicsSchema,
		executionMode: "sequential",
		execute: async (_id, _input, signal) => {
			signal?.throwIfAborted();
			const catalog = (await topics()).map(({ id: _id, ...topic }) => topic);
			signal?.throwIfAborted();
			return toolResult({ topics: catalog });
		},
	};
	const wikiSearch: AgentTool<typeof SearchSchema> = {
		name: "wiki_search",
		label: "wiki_search",
		description: "Search this Goal's Wiki by keyword and semantic similarity. Optionally filter by a topic_ref returned by wiki_list_topics; the full body of each matching page is searched. Omit topic_ref to include pages without a Topic.",
		parameters: SearchSchema,
		executionMode: "sequential",
		execute: async (_id, input, signal) => {
			signal?.throwIfAborted();
			const topic = input.topic_ref === undefined ? undefined : (await topics()).find(topic => topic.topic_ref === input.topic_ref);
			if (input.topic_ref !== undefined && !topic) throw new Error(`Unknown Wiki Topic ref '${input.topic_ref}'; call wiki_list_topics for this execution`);
			signal?.throwIfAborted();
			return toolResult(await local.search(input.query, input.top_k ?? 10, signal, topic?.id));
		},
	};
	const wikiReadPage: AgentTool<typeof ReadPageSchema> = {
		name: "wiki_read_page",
		label: "wiki_read_page",
		description: "Read one Markdown page from this Goal's Wiki using a path returned by a Wiki search tool.",
		parameters: ReadPageSchema,
		executionMode: "sequential",
		execute: async (_id, input, signal) => {
			signal?.throwIfAborted();
			const path = normalizeWikiPagePath(input.path);
			const page = await local.readPage(path);
			signal?.throwIfAborted();
			// Historical citation-only Editions do not need a Topic catalog to remain readable.
			if (!page.topicRefs.length && !page.primaryTopicRef && page.sections.every(section => !section.topicRefs.length)) return toolResult(page);
			const aliases = new Map((await topics()).map(topic => [topic.id, topic.topic_ref]));
			const refs = (ids: string[]) => ids.flatMap(id => aliases.get(id) ?? []);
			signal?.throwIfAborted();
			return toolResult({ ...page,
				primaryTopicRef: aliases.get(page.primaryTopicRef) ?? "",
				topicRefs: refs(page.topicRefs),
				sections: page.sections.map(section => ({ ...section, topicRefs: refs(section.topicRefs) })),
				frontmatter: { ...page.frontmatter,
					...(page.frontmatter.topic_refs ? { topic_refs: refs(page.topicRefs) } : {}),
					...(page.frontmatter.primary_topic_ref ? { primary_topic_ref: aliases.get(page.primaryTopicRef) ?? "" } : {}),
				},
			});
		},
	};
	const GraphSearchSchema = Type.Omit(SearchSchema, ["topic_ref"]);
	const wikiGraphSearch: AgentTool<typeof GraphSearchSchema> = {
		name: "wiki_graph_search",
		label: "wiki_graph_search",
		description: "Find matching Wiki graph nodes and their direct neighbors for this Goal.",
		parameters: GraphSearchSchema,
		executionMode: "sequential",
		execute: async (_id, input, signal) => {
			signal?.throwIfAborted();
			return toolResult(await local.graphSearch(input.query, input.top_k ?? 10));
		},
	};
	return [wikiListTopics, wikiSearch, wikiReadPage, ...(options.legacyGraphSearch ? [wikiGraphSearch] : [])];
}

export function normalizeWikiPagePath(value: string): string {
	const path = value.trim().replace(/^\/+/, "");
	if (
		!path
		|| path.includes("\0")
		|| path.includes("\\")
		|| path.includes("%")
		|| isAbsolute(path)
		|| /^[A-Za-z]:/u.test(path)
	) {
		throw new Error("Wiki page path is invalid");
	}
	const normalized = path.startsWith("wiki/") ? path : `wiki/${path}`;
	if (normalized.split("/").some((part) => !part || part === "." || part === "..")) {
		throw new Error("Wiki page path must stay inside the Wiki root");
	}
	if (!normalized.endsWith(".md")) throw new Error("Wiki page path must reference a Markdown file");
	return normalized;
}

/** Shared argument contract for the native and Python Wiki bridges. */
export function wikiToolArguments(name: string, input: Record<string, unknown>): Record<string, unknown> {
	if (name === "wiki_list_topics") return {};
	if (name === "wiki_read_page") return { path: bridgeString(input.path, "Wiki Page ref") };
	if (name !== "wiki_search" && name !== "wiki_graph_search") throw new Error(`Unsupported Wiki operation '${name}'`);
	const topicRef = input.topic_ref === undefined ? undefined : bridgeString(input.topic_ref, "Wiki Topic ref");
	if (topicRef !== undefined && !/^T[1-9][0-9]*$/u.test(topicRef)) throw new Error("Wiki topic_ref must be a T-number returned by wiki_list_topics");
	if (topicRef !== undefined && name !== "wiki_search") throw new Error("Topic filters apply only to wiki_search");
	return { query: bridgeString(input.query, "Wiki query"),
		top_k: bridgePositiveInteger(input.top_k ?? 10, "top_k", 20),
		...(topicRef === undefined ? {} : { topic_ref: topicRef }) };
}

function toolResult(value: unknown) {
	return {
		content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
		details: value,
	};
}
