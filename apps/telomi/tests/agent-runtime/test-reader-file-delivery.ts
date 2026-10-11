import assert from "node:assert/strict";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acceptReaderFile } from "../../server/research/pipeline/reader-delivery.js";
import { sha256 } from "../../server/lib/hash.js";

const fixture = mkdtempSync(join(tmpdir(), "reader-file-delivery-"));
try {
	const root = join(fixture, "work"), runtimeRoot = join(fixture, "runtime"), workspace = join(fixture, "child");
	for (const path of [join(root, "source/S1"), runtimeRoot, workspace]) mkdirSync(path, { recursive: true });
	writeFileSync(join(root, "source/S1/paper.txt"), "Exact original evidence.\n");
	writeFileSync(join(root, "source/catalog.json"), JSON.stringify({ schema_version: 1, sources: [{ ref: "S1", source_id: "one",
		source_run_id: "original", source_revision_sha256: sha256("revision"), title: "Paper", url: "https://example.test/paper" }] }));
	const draft = { status: "found", summary: "Verified answer", gaps: [], sections: [{ section_title: "Evidence", cue_notes: [{
		cue: "Verified claim", note: "Exact original evidence.", evidence: [{ source_ref: "S1", source_path: "paper.txt", start_line: 1, end_line: 1 }],
	}] }] };
	const path = join(workspace, "note.json"), bytes = `${JSON.stringify(draft, null, 2)}\n`;
	writeFileSync(path, bytes);
	const options = { root, runtimeRoot, workspace, identity: { child_id: "sub-one", session_id: "session-one", revision: 1, task: "Read this evidence." },
		submission: 1, language: "en" as const };
	const receipt = await acceptReaderFile(options);
	assert.equal(receipt.note_sha256, sha256(bytes));
	assert.equal(receipt.language, "en");
	assert.equal(readFileSync(join(root, receipt.note_path), "utf8"), bytes);
	assert.equal(JSON.parse(readFileSync(join(root, receipt.validated_path), "utf8")).cues[0].evidence[0].excerpt, "Exact original evidence.");
	await assert.rejects(acceptReaderFile(options), /ENOTEMPTY|EEXIST/);
	assert.equal(readFileSync(join(root, receipt.note_path), "utf8"), bytes, "accepted revision cannot be overwritten");
	for (const revision of [0, -1, 1.5]) await assert.rejects(acceptReaderFile({ ...options, identity: { ...options.identity, revision } }), /revision/);
	for (const submission of [0, 4, 1.5]) await assert.rejects(acceptReaderFile({ ...options, submission }), /submission/);
	await assert.rejects(acceptReaderFile({ ...options, identity: { ...options.identity, child_id: "sub-../escape" } }), /identity/);
	await assert.rejects(acceptReaderFile({ ...options, language: "zh-CN" }), /output language/);
	const invalid = structuredClone(draft); invalid.sections[0]!.cue_notes[0]!.evidence[0]!.end_line = 99;
	writeFileSync(path, JSON.stringify(invalid));
	await assert.rejects(acceptReaderFile(options), /line range/);
	writeFileSync(path, " ".repeat(16 * 1024 * 1024 + 1));
	await assert.rejects(acceptReaderFile(options), /under 16 MB/);
	const target = join(workspace, "target.json"); writeFileSync(target, bytes);
	for (const link of [symlinkSync, linkSync]) {
		rmSync(path); link(target, path);
		await assert.rejects(acceptReaderFile(options), /ELOOP|private regular/);
	}
	rmSync(path); writeFileSync(path, bytes);
	const cancelled = new AbortController();
	const pending = acceptReaderFile({ ...options, identity: { ...options.identity, child_id: "sub-cancelled" }, signal: cancelled.signal });
	cancelled.abort(new Error("cancel publication"));
	await assert.rejects(pending, /cancel publication/);
	assert.equal(existsSync(join(root, "inputs/reader-results/sub-cancelled")), false);
	writeFileSync(join(root, "inputs/reader-results/sub-blocked"), "blocked");
	await assert.rejects(acceptReaderFile({ ...options, identity: { ...options.identity, child_id: "sub-blocked" } }), /EEXIST|ENOTDIR/);
	assert.equal(readFileSync(join(root, "inputs/reader-results/sub-blocked"), "utf8"), "blocked");
	assert.equal(readdirSync(runtimeRoot).some(name => name.includes("-delivery-")), false, "failed publication removes staging files");
	console.log("Reader file delivery: exact immutable bytes, structural citations, explicit language, link safety, cancellation and failed publication cleanup passed");
} finally { rmSync(fixture, { recursive: true, force: true }); }
