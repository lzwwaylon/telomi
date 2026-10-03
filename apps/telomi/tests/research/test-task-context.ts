import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { writeInvestigationAnswerInput, readInvestigationAnswerRequest,
	type InvestigationAnswerRequest } from "../../server/research/investigation-answer.js";
import { copyTaskContext, writeTaskContext } from "../../server/research/task-context.js";

const root = mkdtempSync(join(tmpdir(), "telomi-task-context-"));
try {
	const context = "  Explain tensor dimensions.\r\n重点核查训练公式。\n\n";
	const source = writeTaskContext(join(root, "root-inputs"), context);
	assert.deepEqual(readFileSync(source), Buffer.from(context, "utf8"), "task context retains exact bytes and whitespace");
	assert.equal(writeTaskContext(join(root, "root-inputs"), context), source, "identical publication is idempotent");
	assert.throws(() => writeTaskContext(join(root, "root-inputs"), "A different brief"), /changed within the same execution/u);
	assert.equal(readFileSync(source, "utf8"), context, "a rejected rewrite preserves the original snapshot");
	const child = copyTaskContext(join(root, "child-inputs"), source);
	assert.equal(child, join(root, "child-inputs", "context.md"));
	assert.deepEqual(readFileSync(child), readFileSync(source), "delegated context is an exact independent snapshot");
	writeFileSync(source, "Later external changes", "utf8");
	assert.equal(readFileSync(child, "utf8"), context, "source changes cannot mutate a prepared child input");
	assert.throws(() => copyTaskContext(join(root, "child-inputs"), source), /changed within the same execution/u);
	assert.equal(readFileSync(child, "utf8"), context);
	assert.equal(readFileSync(writeTaskContext(join(root, "empty-inputs")), "utf8"), "");
	assert.equal(readFileSync(copyTaskContext(join(root, "empty-child")), "utf8"), "", "legacy calls still receive an empty context file");
	const limit = "x".repeat(40_000);
	assert.equal(readFileSync(writeTaskContext(join(root, "bounded"), limit), "utf8"), limit);
	assert.equal(readFileSync(writeTaskContext(join(root, "legacy-note-focus"), `${limit}x`), "utf8"), `${limit}x`,
		"generic file transport preserves legacy noteFocus; investigation validates its own input bound");

	const writerInput = join(root, "writer-inputs");
	const request: InvestigationAnswerRequest = { schema_version: 1, question: "Explain the training algorithm.",
		context, language: "en", requirements: [{ id: "Q1", question: "Explain the training algorithm." }], evidence_refs: [] };
	writeInvestigationAnswerInput({ inputRoot: writerInput, request, evidence: [] });
	assert.deepEqual(readFileSync(join(writerInput, "context.md")), Buffer.from(context, "utf8"), "Writer receives the same complete task context");
	assert.deepEqual(readInvestigationAnswerRequest(writerInput), request, "legacy Writer request.context remains available");
	assert.throws(() => writeInvestigationAnswerInput({ inputRoot: writerInput, request: { ...request, context: "Changed preferences" },
		evidence: [] }), /changed within the same execution/u);
	assert.deepEqual(readInvestigationAnswerRequest(writerInput), request, "a rejected context rewrite cannot replace the Writer request");
	console.log("Task context snapshots, bounds and Writer compatibility tests passed");
} finally {
	rmSync(root, { recursive: true, force: true });
}
