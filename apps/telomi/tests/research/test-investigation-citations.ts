import assert from "node:assert/strict";

import { createInvestigationCitationScope } from "../../server/research/investigation-citations.js";

const refs = createInvestigationCitationScope();
const cue = {
	ref: "deep-search:abc123:cue-1", section_title: "Loss", cue: "Loss normalization",
	note: "Ignored labels are excluded from the mean.",
	evidence: [{ source_path: "src/loss.py", start_line: 7, end_line: 12,
		source_id: "source:long-internal-id", content_sha256: "a".repeat(64), excerpt: "ignore_index=-100" }],
};
const [first] = refs.projectCues([cue]);
assert.equal(first?.ref, "N1");
assert.equal(refs.projectCues([cue])[0]?.ref, "N1");
assert.equal(refs.projectCues([{ ...cue, ref: "cornell:run:other-long-id" }])[0]?.ref, "N2");
assert.equal(first?.evidence[0]?.excerpt, "ignore_index=-100");
assert.ok(!JSON.stringify(first).includes("content_sha256"));
assert.ok(!JSON.stringify(first).includes("source:long-internal-id"));
refs.allowWikiRef("C1");
assert.equal(refs.resolve("C1"), "C1");
assert.equal(refs.resolve("N1"), cue.ref);
assert.deepEqual(refs.restore({ answer: "Evidence <cite>N1</cite> and context <cite>C1</cite>.",
	citation_refs: ["N1", "C1"] }), {
	answer: `Evidence <cite>${cue.ref}</cite> and context <cite>C1</cite>.`,
	citation_refs: [cue.ref, "C1"],
});
assert.throws(() => refs.resolve(cue.ref), /unknown evidence/u);
assert.throws(() => refs.resolve("N3"), /unknown evidence/u);
assert.throws(() => refs.allowWikiRef("C0"), /Invalid Wiki citation/u);

console.log("Prime investigation short citation scope passed");
