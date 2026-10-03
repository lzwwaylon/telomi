import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashWikiDirectory } from "../../server/wiki/files.js";
import { wikiPageSections, type WikiPageContent, type WikiPagesResult } from "../../server/wiki/wiki-page-contract.js";
import { readPreviousWikiEdition, writeWikiEdition, type WikiNoteEntry } from "../../server/wiki/wiki-edition.js";

const root = mkdtempSync(join(tmpdir(), "wiki-edition-contract-"));
const id = `entry:${"a".repeat(24)}`;
const entry: WikiNoteEntry = { id, revisionSha256: "b".repeat(64), sourceRunId: "source-run", sourceId: "source:method",
	sourceTitle: "Method", canonicalLocator: "https://example.test/method", members: [], section: "Conditions", sectionSummary: "Conditional result",
	cue: "Tradeoff", detail: "The method has a conditional tradeoff.", anchors: [] };
const object: WikiPageContent = { id: "entity:stable", kind: "entity", title: "Concrete method", description: "A conditional mechanism", body: `## Conditions\nThe method has a conditional tradeoff [[${id}]].` };
const concept: WikiPageContent = { ...object, id: "concept:original", kind: "concept", title: "Reusable conditions" };
const relation = { from: object.id, to: concept.id, label: "illustrates" };
const result: WikiPagesResult = { pages: [], retained_refs: [], discarded_refs: [], deferred_entries: [], relations: [relation] };
try {
	const sections = wikiPageSections([{ ...object, body: `## Real\nFact [[${id}]].\n\n\`\`\`text\n## Hidden\n\`\`\`\n\n## Real\nSecond.` }]);
	assert.deepEqual(sections.map(section => section.heading), ["Real", "Real"], "headings inside fences are not navigation sections");
	assert.notEqual(sections[0]!.anchor, sections[1]!.anchor, "repeated titles need distinct anchors");
	assert.notEqual(wikiPageSections([object])[0]!.ref, wikiPageSections([{ ...object, body: object.body + " Changed condition." }])[0]!.ref,
		"changed content cannot reuse a stale section reference");

	const initialRoot = join(root, "initial");
	writeWikiEdition(initialRoot, [object, concept], [entry], result, { pages: [], entries: [], files: new Map(), relations: [] });
	const initialHash = hashWikiDirectory(initialRoot);
	const previous = await readPreviousWikiEdition(initialRoot);
	const original = readFileSync(join(initialRoot, "entities/stable.md"), "utf8");
	const renamed = { ...concept, id: "concept:renamed" };
	const nextRoot = join(root, "next");
	writeWikiEdition(nextRoot, [object, renamed], [entry], { ...result, relations: [{ ...relation, to: renamed.id }] }, previous);
	const retained = readFileSync(join(nextRoot, "entities/stable.md"), "utf8");
	assert.match(retained, /\(\.\.\/concepts\/renamed\.md\)/u);
	assert.doesNotMatch(retained, /\(\.\.\/concepts\/original\.md\)/u);
	assert.equal(retained.split("\n## Related\n")[0], original.split("\n## Related\n")[0], "retained prose stays byte-identical while related links change");
	assert.equal(retained.split("\n## Evidence\n")[1], original.split("\n## Evidence\n")[1], "retained evidence definitions stay byte-identical");
	assert.equal(hashWikiDirectory(initialRoot), initialHash, "writing the next Edition does not mutate history");
	assert.equal((await readPreviousWikiEdition(nextRoot)).relations[0]!.to, renamed.id);
	console.log("Wiki Edition contracts: fenced headings, duplicate anchors, stale refs and retained-page relationship rewriting passed");
} finally { rmSync(root, { recursive: true, force: true }); }
