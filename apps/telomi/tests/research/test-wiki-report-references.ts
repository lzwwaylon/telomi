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
	resolveUnavailableCitationUrls,
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
	const tools: AgentTool[] = [{
		name: "wiki_search", label: "wiki_search", description: "search", parameters: Query,
		execute: async () => result({ results: [{
			path: "wiki/entities/beta.md", title: "Beta", type: "entity",
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
			});
		},
	}, {
		name: "wiki_graph_search", label: "wiki_graph_search", description: "graph", parameters: Query,
		execute: async () => result({
			nodes: [{ path: "wiki/concepts/alpha.md", id: "concepts/alpha", type: "concept" }],
			edges: [{ source: "concepts/alpha", target: "entities/beta", weight: 1 }],
		}),
	}];

	const adapter = createWikiReportReferenceAdapter(knowledge, tools);
	assert.deepEqual(adapter.pageRefs, ["P1", "P2"]);
	assert.equal(adapter.resolvePageRef("P1"), "wiki/concepts/alpha.md");

	const search = adapter.tools.find((tool) => tool.name === "wiki_search")!;
	const searchDetails = (await search.execute("search", { query: "Beta" })).details as {
		results: Array<Record<string, unknown>>;
	};
	assert.equal(searchDetails.results[0]?.page_ref, "P2");
	assert.equal("path" in searchDetails.results[0]!, false, "Agent-facing search results must not expose hash paths");
	assert.doesNotMatch(JSON.stringify(searchDetails), /wiki\/(?:concepts|entities)\//u);

	const graph = adapter.tools.find((tool) => tool.name === "wiki_graph_search")!;
	const graphDetails = (await graph.execute("graph", { query: "Beta" })).details as Record<string, unknown>;
	assert.deepEqual(graphDetails.edges, [{ source: "P1", target: "P2", weight: 1 }]);
	assert.doesNotMatch(JSON.stringify(graphDetails), /concepts\/alpha|entities\/beta/u);

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
		cornellNotes: {
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
		cornellNotes: {
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
		cornellNotes: {
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
	let validatedMarkdown = "";
	await resolveUnavailableCitationUrls(
		[{ sectionId: "section-001", markdown: "## Finding\n\n<cite>C2</cite>" }],
		new AbortController().signal,
		async (markdown) => { validatedMarkdown = markdown; return new Set(); },
		citationRegistry,
	);
	assert.match(validatedMarkdown, /<cite>https:\/\/example\.test\/beta<\/cite>/u);
	assert.doesNotMatch(validatedMarkdown, /C2/u);
	let validationFailure = "";
	assert.deepEqual(
		await resolveUnavailableCitationUrls(
			[{ sectionId: "section-001", markdown: "## Finding\n\n<cite>C2</cite>" }],
			new AbortController().signal,
			async () => { throw new Error("validator unavailable"); },
			citationRegistry,
			(error) => { validationFailure = error instanceof Error ? error.message : String(error); },
		),
		new Set(),
		"a validator infrastructure failure must not strip valid citation links",
	);
	assert.equal(validationFailure, "validator unavailable");
	await assert.rejects(read.execute("unknown", { path: "P99" }), /unknown Wiki Page ref 'P99'/u);
	console.log("Wiki Report short reference adapter passed");
} finally {
	rmSync(root, { recursive: true, force: true });
}

function page(type: "concept" | "entity", title: string, entryId: string): string {
	return `---\ntype: ${type}\ntitle: ${title}\nentry_ids:\n  - ${entryId}\n---\n# ${title}\n`;
}
