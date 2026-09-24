import assert from "node:assert/strict";

import { compileStandaloneCitationMarkdown } from "../../server/research/pipeline/citation-compiler.js";
import { normalizeGfmTables } from "../../server/research/pipeline/gfm-tables.js";

const registry = {
	schemaVersion: 1 as const,
	knowledgeSha256: "a".repeat(64),
	entries: [
		{ ref: "C1", url: "https://example.test/live", title: "Live source", provenance: "source:live", fileRefs: [], evidenceId: "source:live" },
		{ ref: "C2", url: "https://example.test/dead", title: "Dead source", provenance: "source:dead", fileRefs: [], evidenceId: "source:dead" },
	],
};

// Unavailable Sources keep the [[n]] form without a link; adjacent repeats collapse like linked ones.
const compiled = compileStandaloneCitationMarkdown({
	markdown: "Live claim. <cite>C1</cite> Dead claim. <cite>C2</cite><cite>C2</cite> <cite>C2</cite>",
	citationRegistry: registry,
	unavailableUrls: new Set(["https://example.test/dead"]),
});
assert.equal(compiled.markdown, [
	"Live claim. [[1]](https://example.test/live) Dead claim. [[2]]",
	"",
	"## References",
	"",
	"1. [Live source](https://example.test/live)",
	"2. Dead source",
	"",
].join("\n"));
assert.equal(compiled.citations[1]?.url, undefined);

// Delimiter rows are rebuilt to the header's cell count; matching tables and code fences stay untouched.
const broken = [
	"Intro",
	"",
	"|A|B|C|",
	"|---|---|---|---|",
	"|1|2|3|",
	"",
	"| X | Y |",
	"|:--|",
	"| 1 | 2 |",
	"",
	"| ok | ok |",
	"|---|---|",
	"",
	"```",
	"|A|B|",
	"|---|---|---|",
	"```",
	"",
	"Setext heading",
	"---",
].join("\n");
assert.equal(normalizeGfmTables(broken), [
	"Intro",
	"",
	"|A|B|C|",
	"|---|---|---|",
	"|1|2|3|",
	"",
	"| X | Y |",
	"|:--|---|",
	"| 1 | 2 |",
	"",
	"| ok | ok |",
	"|---|---|",
	"",
	"```",
	"|A|B|",
	"|---|---|---|",
	"```",
	"",
	"Setext heading",
	"---",
].join("\n"));

// Table repair runs on writer Markdown before citations are numbered.
const table = compileStandaloneCitationMarkdown({
	markdown: "|Model|Note|\n|---|---|---|\n|X|Claim <cite>C1</cite>|",
	citationRegistry: registry,
});
assert.match(table.markdown, /^\|Model\|Note\|\n\|---\|---\|\n\|X\|Claim \[\[1\]\]\(https:\/\/example\.test\/live\)\|/u);

console.log("citation markdown forms ok");
