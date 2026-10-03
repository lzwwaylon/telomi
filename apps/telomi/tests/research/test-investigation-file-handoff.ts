import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { primeExecutionToken } from "../../../extensions/telomi-srt/prime-workspace.js";
import { publishInvestigationHandoff, readInvestigationHandoff, readLatestInvestigationWriter } from "../../server/research/investigation-handoff.js";
import { startPrimeSourceBridge } from "../../server/research/pipeline/prime-search-batch.js";
import { ResearchSourceRegistry } from "../../server/research/sources/registry.js";

const workspace = mkdtempSync(join(tmpdir(), "investigation-file-handoff-"));
const evidence = { ref: "N1", note: "已核查的结论", evidence: [{ source_path: "model.py", start_line: 1, end_line: 2,
	excerpt: "original evidence\n".repeat(3000) }] };
const knowledge = { pages: [], cues: [evidence] };
const reading = { status: "partial", summary: "Verified implementation", cues: [evidence], gaps: ["Missing configuration"] };
const answer = { answer: "Implementation verified. <cite>N1</cite>", citation_refs: ["N1"], gaps: [],
	coverage: [{ requirement_id: "Q1", citation_refs: ["N1"], gap: "" }] };
const bridge = await startPrimeSourceBridge(new ResearchSourceRegistry(), new Set(), {
	workspaceDirectory: workspace, temporalContext: { schemaVersion: 1, currentDate: "2026-01-01", timeZone: "UTC" },
	signal: new AbortController().signal,
}, workspace, { runDir: workspace, nodeId: "prime-investigation", attemptId: "1" }, {
	investigation: { knowledgeSearch: async () => knowledge, readSources: async () => reading,
		externalSearch: async () => ({ ...reading, sources: [{ title: "Source", url: "https://example.org" }] }),
		writeAnswer: async () => answer },
});

try {
	for (const [operation, route, request, expected] of [
		["knowledge_search", "knowledge-search", { query: "implementation", limit: 5 }, knowledge],
		["deep_search", "deep-search", { question: "Read implementation" }, reading],
		["external_search", "external-search", { question: "Find configuration" },
			{ ...reading, sources: [{ title: "Source", url: "https://example.org" }] }],
		["write_answer", "write-answer", { evidence_refs: ["N1"], requirements: ["Explain implementation"] }, answer],
	] as const) {
		const response = await fetch(`${bridge.baseUrl}/v1/${route}`, { method: "POST",
			headers: { "content-type": "application/json", authorization: `Bearer ${primeExecutionToken(bridge.token, "root")}` },
			body: JSON.stringify({ agent_session_id: "root", ...request }) });
		assert.equal(response.status, 200);
		const receipt = await response.json();
		assert.deepEqual(Object.keys(receipt).sort(), ["byte_length", "operation", "result_ref", "schema_version", "sha256"]);
		assert.equal(receipt.operation, operation);
		assert.deepEqual(readInvestigationHandoff(workspace, receipt, operation), expected,
			"file transport retains every Note, original excerpt and gap");
		if (operation === "deep_search") assert.ok(Buffer.byteLength(JSON.stringify(receipt)) < 500,
			"a long original excerpt is not automatically returned to the Root");
	}
	const receipt = publishInvestigationHandoff(workspace, "deep_search", reading);
	const sdkPath = fileURLToPath(new URL("../../server/research/python-tools/research_runtime.py", import.meta.url));
	const python = `import importlib.util, json, os, sys
spec = importlib.util.spec_from_file_location("research_runtime", sys.argv[1])
sdk = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sdk)
os.environ["PRIME_AGENT_ARTIFACT_WORKSPACE"] = sys.argv[2]
receipt = json.loads(sys.argv[3])
result = sdk.read_handoff(receipt)
assert result["cues"][0]["note"] == "已核查的结论"
assert len(result["cues"][0]["evidence"][0]["excerpt"]) == 54000
assert result["gaps"] == ["Missing configuration"]
for field, value in [("result_ref", "inputs/handoff/../../private.json"), ("operation", "write_answer"), ("byte_length", True), ("sha256", "0" * 64)]:
    try:
        sdk.read_handoff({**receipt, field: value})
    except (sdk.ResearchRuntimeError, OSError):
        pass
    else:
        raise AssertionError(field)
print("Python verified the complete file and rejected invalid receipts")
`;
	const result = await promisify(execFile)("python3", ["-c", python, sdkPath, workspace, JSON.stringify(receipt)],
		{ env: process.env });
	assert.match(result.stdout, /Python verified/u);
	assert.throws(() => readInvestigationHandoff(workspace, { ...receipt, result_ref: "../private.json" }), /Invalid/u);
	assert.throws(() => readInvestigationHandoff(workspace, receipt, "write_answer"), /Invalid/u);
	assert.throws(() => readInvestigationHandoff(workspace, { ...receipt, operation: "write_answer" }), /Invalid/u);
	const file = join(workspace, receipt.result_ref);
	const bytes = readFileSync(file);
	writeFileSync(file, "{}\n");
	assert.throws(() => readInvestigationHandoff(workspace, receipt), /hash|byte/u);
	rmSync(file);
	assert.throws(() => readInvestigationHandoff(workspace, receipt));
	const outside = join(workspace, "outside.json");
	writeFileSync(outside, bytes);
	symlinkSync(outside, file);
	assert.throws(() => readInvestigationHandoff(workspace, receipt), /symbolic|symlink|regular/u);
	const empty = { status: "not_found", cues: [], gaps: ["No evidence in accessible materials"] };
	assert.deepEqual(readInvestigationHandoff(workspace, publishInvestigationHandoff(workspace, "deep_search", empty)), empty);
	const earlier = publishInvestigationHandoff(workspace, "write_answer", answer);
	const latest = publishInvestigationHandoff(workspace, "write_answer", { ...answer, coverage: [] });
	assert.throws(() => readLatestInvestigationWriter(workspace, earlier), /latest Writer/u,
		"identical public prose does not make an old Writer receipt the latest delegation");
	assert.deepEqual(readLatestInvestigationWriter(workspace, latest), { ...answer, coverage: [] });
	assert.deepEqual(readLatestInvestigationWriter(workspace, latest.result_ref), { ...answer, coverage: [] },
		"a path resolves through Runtime's registered integrity receipt");
	assert.throws(() => readLatestInvestigationWriter(workspace, earlier.result_ref), /latest Writer/u);
	assert.throws(() => readLatestInvestigationWriter(workspace, "../private.json"), /Invalid/u);
} finally {
	await bridge.close();
	rmSync(workspace, { recursive: true, force: true });
}
