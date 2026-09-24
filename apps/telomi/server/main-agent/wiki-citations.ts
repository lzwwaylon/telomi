import { createSha256 } from "../lib/hash.js";

import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { writeWikiMessageCitations } from "../citations/wiki-message-store.js";
import { resolveWikiEdition } from "../wiki/editions.js";
import { hashWikiDirectory } from "../wiki/files.js";
import { createGoalLlmWikiTools } from "../wiki/tools.js";
import {
	compileStandaloneCitationMarkdown,
	type KnowledgeCitationRegistry,
} from "../research/pipeline/citation-compiler.js";
import {
	createWikiReferenceAdapterFromRoot,
	type WikiReportReferenceAdapter,
} from "../research/pipeline/wiki-report-references.js";

const WIKI_CITE = /<cite>(C[1-9][0-9]*)<\/cite>/gu;
const HAS_WIKI_CITE = /<cite>C[1-9][0-9]*<\/cite>/u;

/** Compile before AgentSession persists the finalized assistant message. */
export function registerMainWikiCitationCompiler(
	pi: ExtensionAPI,
	session: MainWikiCitationSession,
): void {
	pi.on("message_end", async (event) => {
		if (event.message.role !== "assistant") return;
		return await session.compileMessage(event.message) ? { message: event.message } : undefined;
	});
}

export class MainWikiCitationSession {
	readonly tools: AgentTool[];
	private adapter?: WikiReportReferenceAdapter;
	private revision?: string;
	private knowledgeSha256?: string;

	constructor(private readonly options: {
		goalDir: string;
		goalId: string;
		workspaceDir: string;
	}) {
		this.tools = this.rawTools().map((template): AgentTool => ({
			...template,
			execute: async (...args) => {
				const tool = this.currentAdapter().tools.find((candidate) => candidate.name === template.name)!;
				return tool.execute(...args);
			},
		}));
	}

	beginTurn(): void {
		this.adapter = undefined;
		this.revision = undefined;
		this.knowledgeSha256 = undefined;
	}

	async compileMessage(message: any): Promise<boolean> {
		const blocks: Array<{ text: string; write(text: string): void }> = typeof message?.content === "string"
			? [{ text: message.content, write: (text: string) => { message.content = text; } }]
			: Array.isArray(message?.content)
				? message.content.flatMap((block: any, index: number) => block?.type === "text" && typeof block.text === "string"
					? [{ text: block.text, write: (text: string) => { message.content[index] = { ...block, text }; } }]
					: [])
				: [];
		const cited = blocks.filter((block) => HAS_WIKI_CITE.test(block.text));
		if (cited.length === 0) return false;
		const adapter = this.currentAdapter();
		const refs = [...new Set<string>(cited.flatMap((block) => [...block.text.matchAll(WIKI_CITE)].map((match) => match[1]!)))];
		await adapter.hydrateCitationRefs(refs);
		const registry: KnowledgeCitationRegistry = {
			schemaVersion: 1,
			knowledgeSha256: this.knowledgeSha256!,
			entries: refs.map((ref) => {
				const citation = adapter.resolveCitationRef(ref);
				return {
					ref,
					url: citation.entry.source.url,
					title: citation.entry.source.title,
					provenance: citation.entry.source.id,
					fileRefs: [citation.page.path],
					evidenceId: citation.entry.source.id,
					wiki: citation,
				};
			}),
		};
		const citations: ReturnType<typeof compileStandaloneCitationMarkdown>["citations"] = [];
		for (const block of cited) {
			const compiled = compileStandaloneCitationMarkdown({ markdown: block.text, citationRegistry: registry });
			block.write(compiled.markdown);
			citations.push(...compiled.citations);
		}
		const messageId = `wiki_${createSha256()
			.update(this.options.goalId).update("\0").update(String(message.timestamp ?? Date.now())).update("\0")
			.update(cited.map((block) => block.text).join("\0")).digest("hex").slice(0, 20)}`;
		message.citationMessageId = messageId;
		writeWikiMessageCitations(this.options.goalDir, {
			schemaVersion: 1,
			goalId: this.options.goalId,
			messageId,
			wikiRevision: this.revision!,
			knowledgeSha256: this.knowledgeSha256!,
			citations,
		});
		return true;
	}

	private currentAdapter(): WikiReportReferenceAdapter {
		if (this.adapter) return this.adapter;
		const edition = resolveWikiEdition(this.options.workspaceDir, this.options.goalId);
		const rawTools = this.rawTools(edition.root);
		this.revision = edition.revision;
		this.knowledgeSha256 = hashWikiDirectory(edition.root);
		this.adapter = createWikiReferenceAdapterFromRoot(edition.root, rawTools);
		return this.adapter;
	}

	private rawTools(knowledgeRoot?: string): AgentTool[] {
		return createGoalLlmWikiTools({
			goalDir: this.options.goalDir,
			...(knowledgeRoot ? { knowledgeRoot } : {}),
		});
	}
}
