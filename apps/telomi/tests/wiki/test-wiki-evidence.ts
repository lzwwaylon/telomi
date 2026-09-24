import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { wikiSearchExcerpt, projectWikiBodyEvidenceLinks } from "../../server/wiki/evidence.js";
import { sha256 } from "../../server/lib/hash.js";
import { createWikiRuntime } from "../../server/wiki/model/index.js";

const goalRoot = mkdtempSync(join(tmpdir(), "telomi-wiki-evidence-"));
const knowledgeRoot = join(goalRoot, "wiki", "knowledge");
const sourceRoot = join(
	goalRoot,
	"wiki",
	"runs",
	"run-001",
	"artifacts",
	"find-out-sources",
	"sequence-001",
	"sources",
	"logical-source",
);
const articleRoot = join(sourceRoot, "members", "article");
mkdirSync(join(knowledgeRoot, "concepts"), { recursive: true });
mkdirSync(join(knowledgeRoot, "entities"), { recursive: true });
mkdirSync(articleRoot, { recursive: true });

const source = "# 原始标题\n![实验图](figure.png)\n完整原文，不应截断。";
writeFileSync(join(articleRoot, "content.md"), source);
const png = Buffer.alloc(24);
Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png);
png.writeUInt32BE(200, 16);
png.writeUInt32BE(120, 20);
writeFileSync(join(articleRoot, "figure.png"), png);

const sequenceRoot = join(sourceRoot, "..", "..");
writeFileSync(join(sequenceRoot, "manifest.json"), JSON.stringify({
	sources: [{
		source_id: "logical-source",
		path: "sources/logical-source",
		members: [{ source_id: "member-source", path: "members/article" }],
	}],
}));
writeFileSync(join(knowledgeRoot, ".note-registry.json"), JSON.stringify({
	entries: [{
		id: "entry:one",
		revisionSha256: "a".repeat(64),
		sourceRunId: "run-001",
		sourceId: "logical-source",
		sourceTitle: "真实来源",
		canonicalLocator: "https://example.com/source",
		members: [{ source_id: "member-source", provider_id: "article", title: "真实来源", canonical_locator: "https://example.com/source" }],
		section: "方法",
		cue: "核心线索",
		detail: "**Note** 的完整解释。",
		anchors: [{
			path: "members/article/content.md",
			startLine: 1,
			endLine: 3,
			sha256: sha256(`${source}\n`),
		}],
	}],
}));
writeFileSync(join(knowledgeRoot, "entities", "demo.md"), `---
type: entity
title: "Demo"
description: "Evidence demo"
entry_ids:
  - "entry:one"
---

# Demo

正文引用。[^1]

## Evidence

[^1]: 旧的脚注展示。
`);
writeFileSync(join(knowledgeRoot, "concepts", "demo.md"), `---
type: concept
title: "Concept Demo"
description: "Concept Evidence demo"
entry_ids:
  - "entry:one"
---

# Concept Demo

概念引用。[^1]
`);

const page = await createWikiRuntime(knowledgeRoot).readPage("entities/demo.md");
assert.equal(page.evidence.length, 1);
assert.equal(page.evidence[0]?.note, "**Note** 的完整解释。");
assert.equal(page.evidence[0]?.anchors[0]?.content, "# 原始标题\n\n完整原文，不应截断。");
assert.deepEqual(page.evidence[0]?.anchors[0]?.assets, [{
	sourceId: "member-source",
	path: "figure.png",
	width: 200,
	height: 120,
}]);
assert.match(page.content, /正文引用。\[E1\]\(#evidence-1\)/u);
assert.doesNotMatch(page.content, /旧的脚注展示/u);
const concept = await createWikiRuntime(knowledgeRoot).readPage("concepts/demo.md");
assert.equal(concept.evidence.length, 1);
assert.match(concept.content, /概念引用。\[E1\]\(#evidence-1\)/u);
const frozenRoot = join(goalRoot, "report-run", "knowledge-snapshot", "wiki");
mkdirSync(join(frozenRoot, ".."), { recursive: true });
cpSync(knowledgeRoot, frozenRoot, { recursive: true });
const frozenPage = await createWikiRuntime(frozenRoot, { goalDir: goalRoot }).readPage("entities/demo.md");
assert.equal(frozenPage.evidence.length, 1, "a frozen Wiki must resolve evidence from its source Goal");
console.log("Wiki Entity and Concept Evidence projection passed");

const excerpt = wikiSearchExcerpt(projectWikiBodyEvidenceLinks("# Test\n\n" + "x".repeat(303) + "[^1]\n\n## Evidence\n\n[^1]: internal registry", 1), "Test");
assert.match(excerpt, /\[E1\]\(#evidence-1\)/u);
assert.doesNotMatch(excerpt, /\[\^|internal registry/u);

const readableBody = [
	"# 蒸馏", "", "## 方法", "",
	`**蒸馏**使用 [teacher_model](../concepts/${"long-path-".repeat(200)}.md)，参见[E1](#evidence-1)。`, "",
	"## Related", "", "- [METADATAONLY](../concepts/other.md) - implements", "",
	"## Evidence", "", "internal registry",
].join("\n");
assert.equal(wikiSearchExcerpt(readableBody, "蒸馏"), "蒸馏使用 teacher_model，参见[E1](#evidence-1)。");
assert.equal(wikiSearchExcerpt(readableBody, "METADATAONLY", { description: "可读的页面描述。" }), "可读的页面描述。");
assert.doesNotMatch(wikiSearchExcerpt(readableBody, "METADATAONLY"), /Related|implements|concepts\/|internal registry/u);
assert.equal(wikiSearchExcerpt("# 标题\n\n" + "前文".repeat(300) + "匹配内容[E1](#evidence-1)。", "匹配内容").includes("匹配内容[E1](#evidence-1)"), true, "long paragraphs keep the matching text and evidence link visible");

// A fixed-offset window cuts words as readily as it cuts between them, and a cut Latin word can
// still read as a phrase, so each edge steps off a word and a shortened excerpt says that it is one.
{
	// The window opens 80 characters before the match, which here lands inside "Austin".
	const prose = `${"前".repeat(50)}University of Texas at Austin${"补".repeat(78)}许可证边界${"尾".repeat(400)}`;
	const excerpt = wikiSearchExcerpt(prose, "许可证");
	assert.match(excerpt, /^…/u, "an excerpt that drops a beginning says so");
	assert.match(excerpt, /…$/u, "an excerpt that drops an ending says so");
	assert.doesNotMatch(excerpt, /^…[A-Za-z]/u, "an excerpt never opens inside a word");
	assert.ok(excerpt.includes("许可证边界"), "the matched term stays inside the window");
	// Han text has no word runs to protect, so only the marks are added.
	assert.match(wikiSearchExcerpt(`${"前".repeat(200)}许可证边界${"后".repeat(400)}`, "许可证"), /^…[前]*许可证边界[后]*…$/u);
	// A whole paragraph that fits needs no marks at all.
	assert.equal(wikiSearchExcerpt("许可证边界很清楚。", "许可证"), "许可证边界很清楚。");
}
