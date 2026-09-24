import assert from "node:assert/strict";

import { codeInputFields } from "../../web/src/app/overlays/GenericOverlay.js";
import {
	formatToolOutput,
	isScalarList,
	looksLikeMarkdown,
	looksLikeTraceback,
	outputStructures,
	outputTable,
} from "../../web/src/app/overlays/tool-output.js";

assert.deepEqual(
	codeInputFields("ipython", { code: "import os\nprint(os.getcwd())", timeout: 30 }),
	[{ key: "code", content: "import os\nprint(os.getcwd())", language: "python" }],
	"ipython code renders as a Python block and other fields stay as JSON",
);
assert.deepEqual(
	codeInputFields("bash", { command: "ls -la", description: "List files" }),
	[{ key: "command", content: "ls -la", language: "bash" }],
);
assert.deepEqual(
	codeInputFields("write", { path: "notes.md", content: "line 1\nline 2" }).map((field) => [field.key, field.language]),
	[["content", "text"]],
	"any multi-line string reads better as a block than as an escaped JSON string",
);
assert.deepEqual(codeInputFields("search_general_web", { query: "open source tts" }), []);
assert.deepEqual(codeInputFields("ipython", undefined), []);

assert.deepEqual(formatToolOutput('{"groups":[],"ungrouped":["S001"]}'), {
	code: '{\n  "groups": [],\n  "ungrouped": [\n    "S001"\n  ]\n}',
	language: "json",
});
assert.deepEqual(formatToolOutput(" [1, 2] \n"), { code: "[\n  1,\n  2\n]", language: "json" });
assert.deepEqual(formatToolOutput("[{'id': 'general_web_tavily'}]"), { code: "[{'id': 'general_web_tavily'}]", language: "text" }, "a Python repr is not JSON");
assert.deepEqual(formatToolOutput("Decision validated and submitted."), { code: "Decision validated and submitted.", language: "text" });

// The text leads; details add a secondary view only when they are not a wrapper around that text.
const wikiSearch = {
	mode: "hybrid",
	tokenHits: 3,
	results: [
		{ title: "Pocket TTS", type: "entity", snippet: "A 100M CPU TTS model." },
		{ title: "Low-step distillation", type: "concept", snippet: "Distil the decoder\nto one step.", score: 0.8 },
	],
};
assert.deepEqual(outputStructures(JSON.stringify(wikiSearch), wikiSearch), { primary: wikiSearch }, "JSON text is the structure");
assert.deepEqual(outputStructures('[{"id":1}]', { stdout: '[{"id":1}]' }), { primary: [{ id: 1 }] });
assert.deepEqual(outputStructures("Created Research Schedule 'Weekly TTS'.", { schedule: { id: "s1", title: "Weekly TTS" } }),
	{ secondary: { schedule: { id: "s1", title: "Weekly TTS" } } }, "readable text stays first; reported structure is one view away");
assert.deepEqual(outputStructures("hello\n", { durationMs: 4, status: "ok", stdout: "hello\n", stderr: "" }), {},
	"an execution envelope repeating the text adds nothing");
assert.deepEqual(outputStructures("# Page\nBody", { truncation: { truncated: false } }), { secondary: { truncation: { truncated: false } } });
assert.deepEqual(outputStructures("", { schedule: { id: "s1" } }), { primary: { schedule: { id: "s1" } } }, "without text the details lead");
assert.deepEqual(outputStructures("[{'id': 1}]", undefined), {}, "a Python repr is not structure");
assert.deepEqual(outputStructures("{}", {}), {}, "empty structure is not worth a view");

assert.deepEqual(outputTable(wikiSearch), {
	label: "results",
	columns: [
		{ key: "title", label: "title" },
		{ key: "type", label: "type" },
		{ key: "snippet", label: "snippet" },
		{ key: "score", label: "score" },
	],
	rows: [
		{ title: "Pocket TTS", type: "entity", snippet: "A 100M CPU TTS model.", score: "" },
		{ title: "Low-step distillation", type: "concept", snippet: "Distil the decoder to one step.", score: "0.8" },
	],
}, "the rows inside an object become a table, with multi-line cells flattened");
assert.deepEqual(
	outputTable([{ id: 1, rare: true }, { id: 2 }, { id: 3 }])?.columns.map((column) => column.key),
	["id"],
	"a key fewer than half of the rows share is left to the field tree",
);
const wide = outputTable([{ note: "x".repeat(400), nested: { a: 1 } }]);
assert.equal(wide?.rows[0]?.note.length, 161, "long cells are shortened with an ellipsis");
assert.equal(wide?.rows[0]?.nested, '{"a":1}');
assert.deepEqual(outputTable([{ score: 0.032266458495966696, rank: 3 }])?.rows, [{ score: "0.03227", rank: "3" }],
	"long fractions are rounded in the table only");
assert.equal(outputTable({ title: "Page", content: "Body" }), undefined, "a single object is a field tree, not a table");
assert.equal(outputTable([1, 2, 3]), undefined);
assert.equal(isScalarList(["S001", "S002"]), true);
assert.equal(isScalarList([{ id: 1 }]), false);

assert.equal(looksLikeTraceback('Traceback (most recent call last):\n  File "<stdin>", line 1'), true);
assert.equal(looksLikeTraceback("no error here"), false);
assert.equal(looksLikeMarkdown("# Results\n\n| Model | Size |\n| --- | --- |\n| Pocket TTS | 100M |"), true);

console.log("Tool call details format code inputs and show outputs by their shape");
