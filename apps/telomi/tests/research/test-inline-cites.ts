import assert from "node:assert/strict";
import { parseInlineCitations, replaceInlineCitations } from "../../server/citations/inline-cites.js";

const text = "Claim <cite> N1, C2,N1, note:run:cue </cite>. Then <cite>N3</cite>.";
const citations = parseInlineCitations(text);
assert.deepEqual(citations.map(citation => citation.refs), [["N1", "C2", "note:run:cue"], ["N3"]]);
for (const citation of citations) assert.equal(text.slice(citation.start, citation.end), citation.raw);
assert.equal(replaceInlineCitations(text, refs => `[${refs.join(";")}]`), "Claim [N1;C2;note:run:cue]. Then [N3].");
assert.deepEqual(parseInlineCitations("No references."), []);
const legacyUrl = "https://example.org/path/a,b?values=1,2";
assert.deepEqual(parseInlineCitations(`<cite>${legacyUrl}</cite>`)[0]?.refs, [legacyUrl]);
for (const malformed of ["<cite></cite>", "<cite> </cite>", "<cite>N1,</cite>", "<cite>,N1</cite>",
	"<cite>N1,,N2</cite>", "<cite>N1 N2</cite>", '<cite ref="N1">N1</cite>', "<cite>N1", "</cite>",
	"<CITE>N1</CITE>", "<cite>N1<cite>N2</cite></cite>", "<cite>N1</cite >"]) {
	assert.throws(() => parseInlineCitations(malformed), /Malformed inline citation/u, malformed);
}
let rendered = false;
assert.throws(() => replaceInlineCitations("<cite>N1</cite> then <cite>N2", () => { rendered = true; return ""; }), /citation/u);
assert.equal(rendered, false, "parse the entire input before compilation has side effects");
console.log("Grouped inline citations: complete refs, legacy URLs, positions and malformed input passed");
