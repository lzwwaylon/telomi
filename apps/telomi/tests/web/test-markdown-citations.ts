import assert from "node:assert/strict";
import type { Root } from "mdast";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import { unified } from "unified";
import { preprocessLinks } from "../../web/src/shared/markdown/markdown-linkify.js";

import {
	citeKey,
	decodeCiteData,
	decodeCiteDataList,
	remarkIndexedCitations,
	transformIndexedCitations,
} from "../../web/src/shared/markdown/markdown-cite.js";
import { sourceKind } from "../../web/src/shared/markdown/source-kind.js";

const firstUrl = "https://example.com/first";
const secondUrl = "https://example.com/second";
const tree: Root = {
	type: "root",
	children: [
		{
			type: "paragraph",
			children: [
				{ type: "text", value: "Claim " },
				{ type: "link", url: firstUrl, children: [{ type: "text", value: "[1]" }] },
				{ type: "link", url: secondUrl, children: [{ type: "text", value: "[2]" }] },
				{ type: "text", value: " [CITE:Example source:url:https://example.com]" },
				{ type: "link", url: "javascript:alert(1)", children: [{ type: "text", value: "[3]" }] },
			],
		},
		{ type: "heading", depth: 2, children: [{ type: "text", value: "References" }] },
		{
			type: "list",
			ordered: true,
			start: 1,
			spread: false,
			children: [
				{
					type: "listItem",
					spread: false,
					children: [{
						type: "paragraph",
						children: [
							{ type: "link", url: firstUrl, children: [{ type: "text", value: "First source" }] },
						],
					}],
				},
				{
					type: "listItem",
					spread: false,
					children: [{
						type: "paragraph",
						children: [
							{ type: "link", url: secondUrl, children: [{ type: "text", value: "Second source" }] },
						],
					}],
				},
			],
		},
	],
};

transformIndexedCitations(tree);

const paragraph = tree.children[0];
assert.equal(paragraph.type, "paragraph");
assert.equal(paragraph.children[1]?.type, "html");
const encoded = /data-pi-cites="([^"]+)"/u.exec(
	paragraph.children[1].type === "html" ? paragraph.children[1].value : "",
)?.[1];
assert.ok(encoded);
assert.deepEqual(decodeCiteDataList(encoded)?.map(({ kind, target, label, index }) => ({
	kind,
	target,
	label,
	index,
})), [
	{ kind: "url", target: firstUrl, label: "First source", index: 1 },
	{ kind: "url", target: secondUrl, label: "Second source", index: 2 },
]);
assert.match(paragraph.children[2]?.type === "text" ? paragraph.children[2].value : "", /\[CITE:/u);
assert.ok(paragraph.children.some((node) => node.type === "link" && node.url.startsWith("javascript:")));
assert.equal(tree.children[2].type, "list");
assert.deepEqual(tree.children[2].type === "list" ? tree.children[2].children.map((item) => {
	const paragraph = item.children[0];
	return paragraph?.type === "paragraph" && paragraph.children[0]?.type === "html" ? paragraph.children[0].value : null;
}) : [], ['<span data-pi-source="web"></span>', '<span data-pi-source="web"></span>'],
"each References entry opens with a site icon placeholder");
assert.notEqual(
	citeKey({ kind: "url", target: firstUrl, index: 1 }),
	citeKey({ kind: "url", target: firstUrl, index: 2 }),
	"two Runtime citations sharing one URL must retain distinct Evidence identities",
);

const isolated: Root = {
	type: "root",
	children: [{
		type: "paragraph",
		children: [
			{ type: "text", value: "Claim " },
			{ type: "link", url: firstUrl, children: [{ type: "text", value: "[1]" }] },
		],
	}],
};
transformIndexedCitations(isolated);
assert.equal(isolated.children[0]?.type === "paragraph" ? isolated.children[0].children[1]?.type : undefined, "html",
	"chat block splitting must not require the References block to render an indexed citation chip");

const parser = unified().use(remarkParse).use(remarkGfm).use(remarkIndexedCitations);
const runtimeMarkdown = `Claim [[1]](${firstUrl})`;
assert.equal(preprocessLinks(runtimeMarkdown), runtimeMarkdown,
	"chat linkification must preserve Runtime-owned indexed citations");
const parsed = parser.runSync(parser.parse(runtimeMarkdown)) as Root;
assert.ok(parsed.children[0]?.type === "paragraph" && parsed.children[0].children.some((node) => node.type === "html"),
	"the Runtime's real [[n]](url) Markdown must parse into a citation chip");

const referencesBlock = parser.runSync(parser.parse("1. [Repo](https://github.com/a/b)\n2. Unlinked title\n\n- [Talk](https://youtu.be/x)")) as Root;
const [ordered, unordered] = referencesBlock.children;
assert.ok(ordered?.type === "list" && ordered.children[0]?.children[0]?.type === "paragraph"
	&& ordered.children[0].children[0].children[0]?.type === "html"
	&& ordered.children[0].children[0].children[0].value === '<span data-pi-source="github"></span>',
"a References block split from its heading still marks its linked Sources");
assert.ok(ordered?.type === "list" && ordered.children[1]?.children[0]?.type === "paragraph"
	&& ordered.children[1].children[0].children[0]?.type === "text", "unlinked entries get no icon");
assert.ok(unordered?.type === "list" && unordered.children[0]?.children[0]?.type === "paragraph"
	&& unordered.children[0].children[0].children[0]?.type === "link", "only ordered Source lists get icons");

assert.equal(sourceKind("https://github.com/a/b"), "github");
assert.equal(sourceKind("https://raw.githubusercontent.com/a/b/main/README.md"), "github");
assert.equal(sourceKind("https://www.youtube.com/watch?v=x"), "youtube");
assert.equal(sourceKind("https://en.wikipedia.org/wiki/Test"), "wikipedia");
assert.equal(sourceKind("https://twitter.com/user/status/1"), "x");
assert.equal(sourceKind("https://notgithub.com/a"), "web", "a lookalike host is a generic web page");
assert.equal(sourceKind("javascript:alert(1)"), null);


// Linkless [[n]] citations for unavailable Sources are split out of text and grouped into chips,
// labelled from the plain-text References entry.
{
	const md = [
		"Claim [[1]] and [[2]][[2]], [[1]] end.",
		"",
		"## References",
		"",
		"1. [Live source](https://example.com/first)",
		"2. Dead source",
		"",
	].join("\n");
	const tree = unified().use(remarkParse).use(remarkGfm).use(remarkIndexedCitations).runSync(unified().use(remarkParse).use(remarkGfm).parse(md)) as Root;
	const paragraph = tree.children[0];
	assert.equal(paragraph.type, "paragraph");
	const htmlNodes = paragraph.children.filter((node) => node.type === "html");
	assert.equal(htmlNodes.length, 2);
	const single = /data-pi-cite="([^"]+)"/u.exec(htmlNodes[0]!.type === "html" ? htmlNodes[0]!.value : "")?.[1];
	assert.ok(single);
	const singleData = decodeCiteData(single);
	assert.deepEqual(
		{ kind: singleData?.kind, target: singleData?.target, label: singleData?.label, index: singleData?.index },
		{ kind: "ref", target: "", label: "Live source", index: 1 },
	);
	const group = /data-pi-cites="([^"]+)"/u.exec(htmlNodes[1]!.type === "html" ? htmlNodes[1]!.value : "")?.[1];
	assert.ok(group);
	assert.deepEqual(decodeCiteDataList(group)?.map(({ kind, label, index }) => ({ kind, label, index })), [
		{ kind: "ref", label: "Dead source", index: 2 },
		{ kind: "ref", label: "Dead source", index: 2 },
		{ kind: "ref", label: "Live source", index: 1 },
	]);
	assert.equal(citeKey({ kind: "ref", target: "", index: 2 }), "ref:2");
	assert.ok(!paragraph.children.some((node) => node.type === "text" && node.value.includes("[[")));
}

console.log("Indexed Markdown citation rendering contract passed");
