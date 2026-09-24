import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { FastApiDocumentParser } from "../../server/research/documents/fastapi-parser.js";
import { materializeBrowserSource } from "../../server/research/pipeline/browser-materialize.js";
import { canonicalDocumentResponse } from "../ingestion/canonical-document-stub.js";

const root = mkdtempSync(join(tmpdir(), "telomi-browser-materialize-"));
const goalId = "goal-browser";
const goalDir = join(root, goalId);
const artifactRoot = join(goalDir, "run", "provider-executions", "sub-1");
mkdirSync(artifactRoot, { recursive: true });

const site = createServer((_request, response) => {
	response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
	response.end("<html><head><title>Release</title></head><body>Model card body</body></html>");
});
await new Promise<void>((resolve) => site.listen(0, "127.0.0.1", resolve));
const { port } = site.address() as AddressInfo;

let parseCalls = 0;
const documentParser: FastApiDocumentParser = {
	async parse(request) {
		parseCalls += 1;
		if (parseCalls === 1) throw new Error("transient parser failure");
		return canonicalDocumentResponse(request, "Model card body", "doc-browser");
	},
};

try {
	const result = await materializeBrowserSource(
		// Never reached for a URL source: the product listener is no longer part of conversion.
		{ baseUrl: "http://127.0.0.1:9", token: "unused", scopeId: "scope", goalId, runId: "run" },
		{ artifactRoot, converters: { documentParser } },
		"sub-1",
		{ source: { kind: "url", url: `http://127.0.0.1:${port}/release` }, title: "Release notes" },
	);

	assert.equal(result.status, "ready");
	assert.equal(result.parser, "test-parser");
	assert.equal(parseCalls, 2, "a failed conversion is retried once");
	const material = join(artifactRoot, String(result.material_path));
	assert.deepEqual(readdirSync(material).sort(), ["document.canonical.json", "document.md", "provenance.json", "raw"]);
	assert.match(readFileSync(join(material, "document.md"), "utf-8"), /Model card body/u);

	// Browser material is candidate evidence of one Provider execution. Nothing may land in the Goal's
	// ingestion state, its Activity, or the parsed documents the Main Agent mounts at /documents.
	assert.deepEqual(readdirSync(goalDir), ["run"], "conversion writes nothing outside the Provider execution workspace");
	console.log("Browser material converts inside its Provider workspace without Goal file ingestion");
} finally {
	site.close();
	rmSync(root, { recursive: true, force: true });
}
