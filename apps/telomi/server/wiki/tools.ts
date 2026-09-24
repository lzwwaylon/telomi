import { isAbsolute } from "node:path";

import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@sinclair/typebox";

import { GoalWikiSearch } from "./local-search.js";

const SearchSchema = Type.Object({
	query: Type.String({ minLength: 1 }),
	top_k: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
}, { additionalProperties: false });

const ReadPageSchema = Type.Object({
	path: Type.String({ minLength: 1 }),
}, { additionalProperties: false });

export function createGoalLlmWikiTools(options: {
	goalDir: string;
	knowledgeRoot?: string;
}): AgentTool[] {
	const local = new GoalWikiSearch(options.knowledgeRoot ?? `${options.goalDir}/wiki/knowledge`, { goalDir: options.goalDir });
	const wikiSearch: AgentTool<typeof SearchSchema> = {
		name: "wiki_search",
		label: "wiki_search",
		description: "Search this Goal's Wiki with hybrid keyword, embedding, and graph retrieval.",
		parameters: SearchSchema,
		executionMode: "sequential",
		execute: async (_id, input, signal) => {
			signal?.throwIfAborted();
			return toolResult(await local.search(input.query, input.top_k ?? 10, signal));
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
			return toolResult(await local.readPage(path));
		},
	};
	const wikiGraphSearch: AgentTool<typeof SearchSchema> = {
		name: "wiki_graph_search",
		label: "wiki_graph_search",
		description: "Find matching Wiki graph nodes and their direct neighbors for this Goal.",
		parameters: SearchSchema,
		executionMode: "sequential",
		execute: async (_id, input, signal) => {
			signal?.throwIfAborted();
			return toolResult(await local.graphSearch(input.query, input.top_k ?? 10));
		},
	};
	return [wikiSearch, wikiReadPage, wikiGraphSearch];
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

function toolResult(value: unknown) {
	return {
		content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
		details: value,
	};
}
