import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { inspectAgentSourceView } from "../../server/research/pipeline/agent-source-view.js";

const NUL = String.fromCharCode(0);
const root = mkdtempSync(join(tmpdir(), "telomi-agent-source-view-"));
try {
	// Converted Markdown with a stray NUL per dropped figure is still the Agent-readable text.
	const converted = join(root, "converted");
	mkdirSync(converted);
	writeFileSync(join(converted, "paper.md"), `# Title\n\n${"prose ".repeat(200)}\n\n${NUL}\n\n<!-- image -->\n\n${NUL}\n\nMore prose.\n`);
	writeFileSync(join(converted, "paper.pdf"), Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(64, 0)]));
	writeFileSync(join(converted, "record.json"), "{}\n");
	assert.deepEqual(inspectAgentSourceView(converted).contentFiles.map((file) => file.relativePath), ["paper.md"]);

	// Binary material without any conversion is still rejected.
	const binary = join(root, "binary");
	mkdirSync(binary);
	writeFileSync(join(binary, "blob.bin"), Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe, 0x00, 0x00, 0x03]));
	writeFileSync(join(binary, "paper.pdf"), Buffer.from("%PDF-1.7\n"));
	assert.throws(() => inspectAgentSourceView(binary), /no readable text/u);

	console.log("Agent Source view keeps converted Markdown with stray control bytes and rejects binary material");
} finally {
	rmSync(root, { recursive: true, force: true });
}
