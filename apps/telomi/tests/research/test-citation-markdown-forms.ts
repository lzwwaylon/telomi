import assert from "node:assert/strict";

import { compileCanonicalMarkdown, compileStandaloneCitationMarkdown, normalizeCitationSource, validateChapterCandidate } from "../../server/research/pipeline/citation-compiler.js";
import { normalizeGfmTables } from "../../server/research/pipeline/gfm-tables.js";

const registry = {
	schemaVersion: 1 as const,
	knowledgeSha256: "a".repeat(64),
	entries: [
		{ ref: "C1", url: "https://example.test/live", title: "Live source", provenance: "source:live", fileRefs: [], evidenceId: "source:live" },
		{ ref: "C2", url: "https://example.test/dead", title: "Dead source", provenance: "source:dead", fileRefs: [], evidenceId: "source:dead" },
	],
};

// Each grouped ref contributes independently to resolution, numbering and the evidence count.
const grouped = compileStandaloneCitationMarkdown({ markdown: "Both. <cite> C1, C2, C1 </cite>", citationRegistry: registry });
assert.equal(grouped.citationCount, 2, "citation count measures distinct refs per group, not tag count");
assert.deepEqual(grouped.citations.map(item => item.refs), [["C1"], ["C2"]]);
assert.match(grouped.markdown, /Both\. \[\[1\]\].*\[\[2\]\]/u);
assert.throws(() => compileStandaloneCitationMarkdown({ markdown: "Unknown. <cite>C1,C3</cite>", citationRegistry: registry }), /C3.*not present/u);
const sameUrl = compileStandaloneCitationMarkdown({ markdown: "Both. <cite>C1,C2</cite>",
	citationRegistry: { ...registry, entries: registry.entries.map(entry => ({ ...entry, url: registry.entries[0]!.url })) } });
assert.equal(sameUrl.citations.length, 1);
assert.deepEqual(sameUrl.citations[0]?.refs, ["C1", "C2"], "URL deduplication must retain every grouped evidence identity");
assert.equal(sameUrl.markdown.match(/Both\. \[\[1\]\]/gu)?.length, 1);
const commaUrl = "https://example.test/model,a?items=one,two";
const legacyUrlRegistry = { ...registry, entries: [{ ...registry.entries[0]!, ref: undefined, url: commaUrl }] };
assert.equal(compileStandaloneCitationMarkdown({ markdown: `<cite>${commaUrl}</cite>`, citationRegistry: legacyUrlRegistry }).citations[0]?.url, commaUrl);
const sourceNotes = { schema_version: 1 as const, snapshot_id: "fixture", run_id: "fixture",
	pipeline: { id: "pipeline", version: "1", sha256: "a".repeat(64) }, source_bundle_refs: [], notes: [] };
const section = { section_id: "section-001", title: "Findings", claims: [] };
const chapter = "## Findings\n\nBoth. <cite> C1, C2, C1 </cite>";
const canonical = compileCanonicalMarkdown({ plan: { title: "Grouped evidence", sections: [section] }, sourceNotes,
	citationRegistry: registry, chapters: [{ sectionId: section.section_id, markdown: chapter }],
	outlineEvidenceIds: new Set(["source:live", "source:dead"]) });
assert.equal(canonical.citationCount, 2);
assert.deepEqual(canonical.citations.map(item => item.refs), [["C1"], ["C2"]]);
assert.throws(() => validateChapterCandidate(section, chapter, sourceNotes, registry, new Set(["source:live"])), /C2.*not claimed/u,
	"the second member of a group must pass Outline ownership validation");
assert.throws(() => validateChapterCandidate(section, chapter.replace("C2, C1", "C3"), sourceNotes, registry), /malformed inline Evidence citation/u,
	"an unregistered second group member cannot be silently dropped");
assert.throws(() => validateChapterCandidate(section, '## Findings\n\n<cite refs="C1">C1</cite>', sourceNotes, registry),
	(error: unknown) => error instanceof Error && /malformed inline Evidence citation/u.test(error.message) && error.message.includes("refs="),
	"Chapter validation preserves the shared parser's precise malformed tag feedback");

// Stored Source URLs remain linked; adjacent repeated citations collapse.
const compiled = compileStandaloneCitationMarkdown({
	markdown: "Live claim. <cite>C1</cite> Dead claim. <cite>C2</cite><cite>C2</cite> <cite>C2</cite>",
	citationRegistry: registry,
});
assert.equal(compiled.markdown, [
	"Live claim. [[1]](https://example.test/live) Dead claim. [[2]](https://example.test/dead)",
	"",
	"## References",
	"",
	"1. [Live source](https://example.test/live)",
	"2. [Dead source](https://example.test/dead)",
	"",
].join("\n"));
assert.equal(compiled.citations[1]?.url, "https://example.test/dead");
const ipv6Url = "https://[2001:db8::1]/paper_(2026)";
const ipv6Target = "https://[2001:db8::1]/paper_%282026%29";
assert.equal(normalizeCitationSource(ipv6Url), ipv6Target, "Markdown escaping preserves valid IPv6 host syntax");
assert.equal(new URL(normalizeCitationSource(ipv6Url)).hostname, "[2001:db8::1]");
const ipv6 = compileStandaloneCitationMarkdown({ markdown: "IPv6. <cite>C1</cite>",
	citationRegistry: { ...registry, entries: [{ ...registry.entries[0]!, url: normalizeCitationSource(ipv6Url) }] } });
assert.equal(ipv6.citations[0]?.url, ipv6Target, "an IPv6 HTTP Source remains linked after target serialization");
const unsafeUrl = "https://example.test/)[external](https://evil.test/a)";
const safeUrl = "https://example.test/%29[external]%28https://evil.test/a%29";
const escaped = compileStandaloneCitationMarkdown({ markdown: "Claim. <cite>C1</cite>",
	citationRegistry: { ...registry, entries: [{ ...registry.entries[0]!, url: unsafeUrl }] } });
assert.equal(escaped.markdown, `Claim. [[1]](${safeUrl})\n\n## References\n\n1. [Live source](${safeUrl})\n`,
	"a Source URL cannot break out of its Markdown target and create another link");
assert.equal(escaped.citations[0]?.url, safeUrl);
const parens = compileStandaloneCitationMarkdown({ markdown: "Normal. <cite>C1</cite>",
	citationRegistry: { ...registry, entries: [{ ...registry.entries[0]!, url: "https://example.test/paper_(2026)#part" }] } });
assert.equal(parens.citations[0]?.url, "https://example.test/paper_%282026%29#part", "ordinary parenthesized URLs remain valid linked targets");

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
