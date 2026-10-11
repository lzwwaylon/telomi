import { createSha256 } from "../lib/hash.js";

import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { writeWikiMessageCitations } from "../citations/wiki-message-store.js";
import { citationSourceUrl, cueCitationEntries } from "../citations/cue-sources.js";
import { parseInlineCitations } from "../citations/inline-cites.js";
import { resolveNoteReadingCue } from "../research/note-reading.js";
import { resolveSavedNoteCue } from "../research/note-retrieval.js";
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
	private adapter?: WikiReportReferenceAdapter;
	private revision?: string;
	private knowledgeSha256?: string;

	constructor(private readonly options: {
		goalDir: string;
		goalId: string;
		workspaceDir: string;
	}) {}

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
		const cited = blocks.map(block => ({ ...block, citations: parseInlineCitations(block.text) }))
			.filter(block => block.citations.length > 0);
		if (cited.length === 0) return false;
		const refs = [...new Set(cited.flatMap(block => block.citations.flatMap(citation => citation.refs)))];
		const wikiRefs = refs.filter((ref) => /^C[1-9][0-9]*$/u.test(ref));
		const adapter = wikiRefs.length > 0 ? this.currentAdapter() : undefined;
		if (adapter) await adapter.hydrateCitationRefs(wikiRefs);
		const registry: KnowledgeCitationRegistry = {
			schemaVersion: 1,
			knowledgeSha256: this.knowledgeSha256 ?? "",
			entries: refs.flatMap((ref) => {
				if (adapter && /^C[1-9][0-9]*$/u.test(ref)) {
					const citation = adapter.resolveCitationRef(ref);
					const url = citationSourceUrl(citation.entry.source.url);
					return {
						ref,
						url,
						...(!url ? { numberKey: citation.entry.source.id } : {}),
						title: citation.entry.source.title,
						provenance: citation.entry.source.id,
						fileRefs: [citation.page.path],
						evidenceId: citation.entry.source.id,
						wiki: citation,
					};
				}
				const cue = ref.startsWith("note:")
					? resolveSavedNoteCue(this.options.goalDir, ref)
					: resolveNoteReadingCue(this.options.goalDir, ref);
				if (!cue) throw new Error(`Unknown saved Cue citation '${ref}'`);
				return cueCitationEntries(cue);
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
			wikiRevision: this.revision ?? "",
			knowledgeSha256: this.knowledgeSha256 ?? "",
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
