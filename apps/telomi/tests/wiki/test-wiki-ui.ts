import assert from "node:assert/strict";
import test from "node:test";
import {
	colorsForWikiTypes,
	defaultWikiPage,
	filterWikiPages,
	groupWikiPagesByType,
	normalizeWikiFrontmatter,
	normalizeWikiPath,
	plainWikiSnippet,
	wikiSearchSnippetParts,
	resolveWikiLink,
	splitSearchHighlights,
	stripDuplicateLeadingHeading,
	stripWikiFrontmatter,
	type WikiPageSummary,
	wikiStatusFromActivities,
} from "../../web/src/features/wiki/wiki-model.js";

const pages: WikiPageSummary[] = [
	{ path: "index.md", title: "Home", type: "Section", description: "入口" },
	{ path: "themes/agents.md", title: "Agents", type: "Reference", description: "Agent 运行方式" },
	{ path: "themes/index.md", title: "Themes", type: "Section", description: "主题索引" },
];

test("Wiki paths resolve relative links without escaping the knowledge root", () => {
	assert.equal(resolveWikiLink("themes/agents.md", "../index.md#top"), "index.md");
	assert.equal(resolveWikiLink("themes/agents.md", "related/runtime"), "themes/related/runtime.md");
	assert.equal(resolveWikiLink("index.md", "themes/"), "themes/index.md");
	assert.equal(resolveWikiLink("index.md", "https://example.com/a.md"), null);
	assert.equal(normalizeWikiPath("../../wiki/runs/private.md"), null);
});

test("Wiki navigation searches metadata and defaults to a page the sidebar lists", () => {
	assert.deepEqual(filterWikiPages(pages, "运行方式").map((page) => page.path), ["themes/agents.md"]);
	assert.equal(defaultWikiPage(pages), null, "Section and Reference pages are not listed in the sidebar");
	const listed: WikiPageSummary[] = [
		...pages,
		{ path: "entities/model.md", title: "Model", type: "entity", description: "" },
		{ path: "concepts/flow.md", title: "Flow", type: "concept", description: "" },
	];
	assert.equal(defaultWikiPage(listed), "concepts/flow.md");
});

test("Wiki navigation keeps Concepts and Entities separate inside a Topic", () => {
	const pages = [
		{ path: "concepts/flow.md", type: "concept", title: "Flow Matching", description: "Method" },
		{ path: "entities/model.md", type: "entity", title: "Model", description: "Model" },
	];
	assert.deepEqual(groupWikiPagesByType(pages).map((group) => [group.type, group.pages.map((page) => page.title)]), [
		["concept", ["Flow Matching"]],
		["entity", ["Model"]],
	]);
});

test("Wiki reader separates frontmatter from the Markdown body", () => {
	assert.equal(stripWikiFrontmatter("---\ntype: Reference\ntitle: A\n---\n# A\nBody"), "# A\nBody");
	assert.equal(stripWikiFrontmatter("# Plain"), "# Plain");
	assert.equal(stripDuplicateLeadingHeading("# A\n\nBody", "A"), "Body");
	assert.equal(stripDuplicateLeadingHeading("\n# A\n\nBody", "A"), "Body");
	assert.equal(stripDuplicateLeadingHeading("# Other\n\nBody", "A"), "# Other\n\nBody");
});

test("Wiki search presents plain prose instead of maintenance Markdown", () => {
	assert.equal(
		plainWikiSnippet("# Luna-TTS ## 概述 [[entities/luna-tts|Luna-TTS]] 是模型。 <!-- pi-wiki:graph-relations:end --> - `document.md`"),
		"Luna-TTS 概述 Luna-TTS 是模型。 document.md",
	);
});

test("Wiki reader renders every frontmatter field", () => {
	assert.deepEqual(normalizeWikiFrontmatter({
		type: "concept",
		title: "Agent Runtime",
		tags: ["agent", "wiki"],
		provenance: { provider: "arxiv" },
	}), [
		{ key: "type", value: "concept" },
		{ key: "title", value: "Agent Runtime" },
		{ key: "tags", value: "agent, wiki" },
		{ key: "provenance", value: '{"provider":"arxiv"}' },
	]);
	assert.deepEqual(normalizeWikiFrontmatter(null), []);
});

test("Wiki graph uses the type palette and node sizing", () => {
	assert.deepEqual(colorsForWikiTypes(["Section", "Reference"]), {
		Section: "#4FA8F0",
		Reference: "#B6DE3E",
	});
});

test("Wiki search highlights every query term without changing its case", () => {
	assert.deepEqual(splitSearchHighlights("Speech recognition improves speech tools", "speech recognition"), [
		{ text: "Speech", match: true },
		{ text: " ", match: false },
		{ text: "recognition", match: true },
		{ text: " improves ", match: false },
		{ text: "speech", match: true },
		{ text: " tools", match: false },
	]);
});

test("Search citations retain their page-local evidence identity", () => {
	assert.deepEqual(wikiSearchSnippetParts("正文 [E2](#evidence-2) 与 [来源](https://example.com)"), [
		{ text: "正文" }, { text: "E2", evidenceIndex: 2 }, { text: "与 来源" },
	]);
	assert.equal(wikiSearchSnippetParts("[E2](#evidence-3)")[0]?.evidenceIndex, undefined);
});

test("Wiki status pill only reflects queued or running Wiki updates and Topic Plan reframes", () => {
	assert.equal(wikiStatusFromActivities([]), null);
	assert.equal(wikiStatusFromActivities([{ kind: "wiki-update", lifecycle: "finished" }, { kind: "research", lifecycle: "running" }]), null);
	assert.equal(wikiStatusFromActivities([{ kind: "wiki-update", lifecycle: "queued" }]), "updating");
	assert.equal(wikiStatusFromActivities([{ kind: "topic-plan", lifecycle: "running" }]), "rebuilding");
	assert.equal(wikiStatusFromActivities([{ kind: "topic-plan", lifecycle: "waiting" }]), null);
	assert.equal(wikiStatusFromActivities([{ kind: "topic-plan", lifecycle: "running" }, { kind: "wiki-update", lifecycle: "running" }]), "updating");
});
