import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@sinclair/typebox";

import { RunArtifactStore } from "../../server/agent-runtime/artifact-store.js";
import {
	buildKnowledgeCitationRegistry,
	compileCanonicalMarkdown,
} from "../../server/research/pipeline/citation-compiler.js";
import { createWikiReportReferenceAdapter } from "../../server/research/pipeline/wiki-report-references.js";

const root = mkdtempSync(join(tmpdir(), "telomi-wiki-report-refs-"));
try {
	const knowledgeRoot = join(root, "knowledge");
	mkdirSync(join(knowledgeRoot, "wiki", "concepts"), { recursive: true });
	mkdirSync(join(knowledgeRoot, "wiki", "entities"), { recursive: true });
	writeFileSync(join(knowledgeRoot, "wiki", "concepts", "alpha.md"), page("concept", "Alpha", "entry:alpha"));
	writeFileSync(join(knowledgeRoot, "wiki", "entities", "beta.md"), page("entity", "Beta", "entry:beta"));
	const knowledge = new RunArtifactStore(root).describeDirectory("knowledge");

	const Query = Type.Object({ query: Type.String() });
	const Read = Type.Object({ path: Type.String() });
	const result = (details: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(details) }], details });
	let rawReadPath = "";
	let searchPath = "wiki/entities/beta.md";
	let pageExtras: Record<string, unknown> = {};
	let searchExtras: Record<string, unknown> = { mode: "hybrid", index: { status: "ready" } };
	const topics = { topics: [{ topic_ref: "T1", title: "Models", intent: "Track models.",
		questions: [], include: [], exclude: [], page_count: 2 }] };
	const tools: AgentTool[] = [{
		name: "wiki_list_topics", label: "wiki_list_topics", description: "list", parameters: Type.Object({}),
		execute: async () => result({ ...topics, revision: "internal-revision",
			topics: topics.topics.map(topic => ({ ...topic, id: "internal-topic" })) }),
	}, {
		name: "wiki_search", label: "wiki_search", description: "search", parameters: Query,
		execute: async () => result({ ...searchExtras, elapsedMs: 41, tokenHits: 1, vectorHits: 1, graphHits: 0, results: [{
			path: searchPath, title: "Beta", type: "entity", snippet: "Beta finding.", sources: ["embedding"],
			knowledgeContext: { outgoingLinks: ["wiki/concepts/alpha.md"], backlinks: [], linkCount: 1 },
		}] }),
	}, {
		name: "wiki_read_page", label: "wiki_read_page", description: "read", parameters: Read,
		execute: async (_id, input) => {
			rawReadPath = (input as { path: string }).path;
			return result({
				path: rawReadPath,
				title: "Beta",
				type: "entity",
				content: "Beta is grounded.",
				evidence: [{
					id: "entry:beta", index: 1, section: "Results", cue: "Grounded", note: "Beta note.",
					source: { id: "source:beta", title: "Beta source", url: "https://example.test/beta" },
					anchors: [{ path: "paper.md", startLine: 2, endLine: 3, format: "markdown", content: "Exact evidence.", assets: [] }],
				}],
				links: ["concepts/alpha"], backlinks: [], missingLinks: [],
				...pageExtras,
			});
		},
	}];

	const adapter = createWikiReportReferenceAdapter(knowledge, tools);
	assert.deepEqual(adapter.pageRefs, ["P1", "P2"]);
	assert.equal(adapter.resolvePageRef("P1"), "wiki/concepts/alpha.md");
	const list = adapter.tools.find((tool) => tool.name === "wiki_list_topics")!;
	assert.deepEqual((await list.execute("list", {})).details, topics,
		"Topic discovery passes through the Page reference adapter without resolving a Page ref");
	assert.equal(rawReadPath, "", "listing Topics never reads a Page");

	const search = adapter.tools.find((tool) => tool.name === "wiki_search")!;
	const searchDetails = (await search.execute("search", { query: "Beta" })).details as {
		results: Array<Record<string, unknown>>;
	};
	assert.equal(searchDetails.results[0]?.page_ref, "P2");
	assert.equal("path" in searchDetails.results[0]!, false, "Agent-facing search results must not expose hash paths");
	assert.doesNotMatch(JSON.stringify(searchDetails), /wiki\/(?:concepts|entities)\//u);

	assert.deepEqual(searchDetails, { results: [{ page_ref: "P2", title: "Beta", type: "entity", snippet: "Beta finding." }] });
	for (const [mode, status, warning] of [
		["keyword_graph", "unavailable", /Semantic retrieval is unavailable/u],
		["hybrid", "partial", /covers only part/u],
	] as const) {
		searchExtras = { mode, index: { status, error: "PRIVATE_DIAGNOSTIC", indexedPages: 1, totalPages: 2, refreshing: true } };
		const degraded = await search.execute("degraded", { query: "Beta" });
		assert.match(JSON.stringify(degraded.details), warning);
		assert.doesNotMatch(JSON.stringify(degraded), /PRIVATE_DIAGNOSTIC|indexedPages|elapsedMs|sources|knowledgeContext/u);
	}

	const read = adapter.tools.find((tool) => tool.name === "wiki_read_page")!;
	const pageDetails = (await read.execute("read", { path: "P2" })).details as {
		page_ref: string;
		path?: string;
		evidence: Array<{ cite_ref: string; id?: string }>;
	};
	assert.equal(rawReadPath, "wiki/entities/beta.md");
	assert.equal(pageDetails.page_ref, "P2");
	assert.equal(pageDetails.path, undefined);
	assert.deepEqual(pageDetails.evidence, [{ cite_ref: "C2", index: 1, section: "Results", cue: "Grounded", note: "Beta note.", source: { title: "Beta source" }, anchors: [{ path: "paper.md", startLine: 2, endLine: 3, format: "markdown", content: "Exact evidence.", assets: [] }] }]);
	const citation = adapter.resolveCitationRef("C2");
	assert.deepEqual(citation, {
		ref: "C2",
		page: { ref: "P2", path: "wiki/entities/beta.md", title: "Beta", type: "entity", content: "Beta is grounded." },
		entry: {
			id: "entry:beta", index: 1, section: "Results", cue: "Grounded", note: "Beta note.",
			source: { id: "source:beta", title: "Beta source", url: "https://example.test/beta" },
			anchors: [{ path: "paper.md", startLine: 2, endLine: 3, format: "markdown", content: "Exact evidence.", assets: [] }],
		},
		evidence: [{
			id: "entry:beta", index: 1, section: "Results", cue: "Grounded", note: "Beta note.",
			source: { id: "source:beta", title: "Beta source", url: "https://example.test/beta" },
			anchors: [{ path: "paper.md", startLine: 2, endLine: 3, format: "markdown", content: "Exact evidence.", assets: [] }],
		}],
	});
	const citationRegistry = buildKnowledgeCitationRegistry({
		knowledgeSnapshot: knowledge,
		sourceNotes: {
			schema_version: 1, snapshot_id: "snapshot:test", run_id: "run-test",
			pipeline: { id: "pipeline", version: "1", sha256: "a".repeat(64) }, source_bundle_refs: [], notes: [],
		},
	});
	citationRegistry.entries.push({
		ref: citation.ref,
		url: citation.entry.source.url,
		title: citation.entry.source.title,
		provenance: citation.entry.source.id,
		fileRefs: [citation.page.path],
		evidenceId: citation.entry.source.id,
		wiki: citation,
	});
	const compiled = compileCanonicalMarkdown({
		plan: { title: "Beta report", sections: [{
			section_id: "section-001", title: "Finding", claims: [],
		}] },
		sourceNotes: {
			schema_version: 1, snapshot_id: "snapshot:test", run_id: "run-test",
			pipeline: { id: "pipeline", version: "1", sha256: "a".repeat(64) }, source_bundle_refs: [], notes: [],
		},
		citationRegistry,
		chapters: [{ sectionId: "section-001", markdown: "## Finding\n\nBeta is grounded. <cite>C2</cite>" }],
	});
	assert.match(compiled.markdown, /Beta is grounded\. \[\[1\]\]\(https:\/\/example\.test\/beta\)/u);
	assert.deepEqual(compiled.citations[0]?.refs, ["C2"]);
	assert.deepEqual(compiled.citations[0]?.wiki, [citation]);
	const noteCompiled = compileCanonicalMarkdown({
		plan: { title: "Note report", sections: [{ section_id: "section-001", title: "Finding", claims: [] }] },
		sourceNotes: {
			schema_version: 1, snapshot_id: "snapshot:test", run_id: "run-test",
			pipeline: { id: "pipeline", version: "1", sha256: "a".repeat(64) }, source_bundle_refs: [], notes: [],
		},
		citationRegistry: {
			schemaVersion: 1,
			knowledgeSha256: "a".repeat(64),
			entries: ["N1", "N2"].map((ref) => ({
				ref,
				url: "https://example.test/beta",
				title: "Beta source",
				provenance: "source:beta",
				fileRefs: [],
				evidenceId: "source:beta",
			})),
		},
		chapters: [{
			sectionId: "section-001",
			markdown: "## Finding\n\nFirst claim. <cite>N1</cite> Second claim. <cite>N2</cite>",
		}],
	});
	assert.deepEqual(noteCompiled.citations.map((item) => item.refs), [["N1", "N2"]]);
	assert.match(noteCompiled.markdown, /First claim\. \[\[1\]\].*Second claim\. \[\[1\]\]/su);
	assert.match(noteCompiled.markdown, /## References\n\n1\. \[Beta source\]\(https:\/\/example\.test\/beta\)\n$/u,
		"Notes from one Source share one References entry without provenance");
	const privateAnchor = { ...citation.entry.anchors[0]!, sha256: "anchor-hash",
		source: { id: "internal-source", title: "Original source", url: "https://example.test/original", runId: "internal-run", revisionSha256: "revision-hash" },
		assets: [{ sourceId: "internal-source", path: "images/chart.png", width: 640, height: 480 }],
	};
	pageExtras = {
		pageId: "internal-page", frontmatter: { entry_ids: ["entry:beta"] }, unknownInternalField: "private",
		primaryTopicRef: "T1", topicRefs: ["T1"], description: "Beta description.",
		sections: [{ id: "internal-section", heading: "Finding", anchor: "finding", topicRefs: ["T1"] }],
		links: ["concepts/alpha", "missing/page"], backlinks: ["wiki/concepts/alpha.md"],
		knowledgeContext: { outgoingLinks: ["concepts/alpha"], backlinks: [], linkCount: 1 },
		relations: [{ from: "internal-page", to: "internal-alpha", label: "uses", direction: "outgoing",
			page: { path: "concepts/alpha.md", pageId: "internal-alpha", title: "Alpha", type: "concept", description: "Related concept." } }],
		evidence: [{ ...citation.entry, anchors: [privateAnchor] }],
	};
	const projected = await read.execute("private-metadata", { path: "P2" });
	const clean = JSON.parse(projected.content[0]!.type === "text" ? projected.content[0]!.text : "{}");
	assert.deepEqual(JSON.parse(JSON.stringify(projected.details)), clean, "both Tool delivery channels use the same projection");
	assert.deepEqual(clean.sections, [{ heading: "Finding", anchor: "finding", topicRefs: ["T1"] }]);
	assert.deepEqual(clean.links, ["P1"]);
	assert.deepEqual(clean.backlinks, ["P1"]);
	assert.deepEqual(clean.relations, [{ label: "uses", direction: "outgoing",
		page: { page_ref: "P1", title: "Alpha", type: "concept", description: "Related concept." } }]);
	assert.deepEqual(clean.evidence[0].anchors, [{ path: "paper.md", startLine: 2, endLine: 3,
		format: "markdown", content: "Exact evidence.", source: { title: "Original source" },
		assets: [{ path: "images/chart.png", width: 640, height: 480 }] }]);
	assert.doesNotMatch(JSON.stringify(clean), /internal-|sha256|revisionSha256|runId|pageId|sourceId|frontmatter|unknownInternalField|missingLinks|knowledgeContext/u);
	assert.deepEqual(adapter.resolveCitationRef("C2").entry.anchors, [privateAnchor], "Runtime retains original hashes, identities and asset provenance");
	searchPath = "wiki/outside.md";
	await assert.rejects(search.execute("outside-edition", { query: "Beta" }), /outside the pinned Edition/u);

	await assert.rejects(read.execute("unknown", { path: "P99" }), /unknown Wiki Page ref 'P99'/u);
	console.log("Wiki Report short reference adapter passed");
} finally {
	rmSync(root, { recursive: true, force: true });
}

function page(type: "concept" | "entity", title: string, entryId: string): string {
	return `---\ntype: ${type}\ntitle: ${title}\nentry_ids:\n  - ${entryId}\n---\n# ${title}\n`;
}
