import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acceptReaderFile } from "../../server/research/pipeline/reader-delivery.js";
import { assembleReaderNote } from "../../server/research/pipeline/reader-assembly.js";
import { validateNoteReadingDraftFromCorpus } from "../../server/research/note-reading.js";
import { sha256 } from "../../server/lib/hash.js";

const fixture = mkdtempSync(join(tmpdir(), "reader-assembly-"));
const work = join(fixture, "work"), runtimeRoot = join(fixture, "runtime");
const signal = new AbortController().signal;
const file = join(work, "reader-plan.json"), output = join(work, "note.json");
const json = (path: string) => JSON.parse(readFileSync(path, "utf8"));
const draft = (name: string) => ({ status: "found", summary: name, gaps: [], sections: [{ section_title: name,
	cue_notes: [1, 2].map(line => ({ cue: `${name} claim ${line}`, note: `Exact ${name} evidence, with its limitation.`,
		evidence: [{ source_ref: "S1", source_path: "paper.txt", start_line: line, end_line: line }] })) }] });
try {
	mkdirSync(join(work, "source/S1"), { recursive: true }); mkdirSync(runtimeRoot);
	writeFileSync(join(work, "source/S1/paper.txt"), "Evidence alpha.\nEvidence beta.\n");
	writeFileSync(join(work, "source/catalog.json"), JSON.stringify({ schema_version: 1, sources: [{ ref: "S1", source_id: "one",
		source_run_id: "original", source_revision_sha256: sha256("revision"), title: "Paper", url: "https://example.test/paper" }] }));
	const receipts = [];
	for (const name of ["alpha", "beta"]) {
		const workspace = join(fixture, name); mkdirSync(workspace); writeFileSync(join(workspace, "note.json"), JSON.stringify(draft(name)));
		const receipt = await acceptReaderFile({ root: work, runtimeRoot, workspace, identity: { child_id: `sub-${name}`,
			session_id: name, revision: 1, task: `Read ${name}` }, submission: 1, language: "en", signal });
		receipts.push(receipt); appendFileSync(join(runtimeRoot, "reader-delivery.jsonl"), `${JSON.stringify({ type: "reader_delivery_accepted", ...receipt })}\n`);
	}
	const [alpha, beta] = receipts.map(r => r.note_path);
	const plan = { status: "found", summary: "Combined evidence", gaps: [], notes: [beta, alpha], excluded: [] };
	const assemble = async (value: unknown) => { writeFileSync(file, JSON.stringify(value)); await assembleReaderNote({ work, runtimeRoot, signal }); };
	await assemble(plan);
	assert.deepEqual(json(output), { status: plan.status, summary: plan.summary, gaps: [], sections: [...draft("beta").sections, ...draft("alpha").sections] });
	const evidence = json(join(runtimeRoot, "reader-assembly.json"));
	assert.equal(evidence.assembled_note_sha256, sha256(readFileSync(output)));
	assert.deepEqual(evidence.plan, plan);
	assert.equal(validateNoteReadingDraftFromCorpus(json(output), "Question", "root", join(work, "source")).cues.length, 4);
	const original = readFileSync(output, "utf8");
	for (const [bad, error] of [
		[{ ...plan, notes: [beta] }, /unaccounted/],
		[{ ...plan, notes: [beta, beta, alpha] }, /Duplicate/],
		[{ ...plan, excluded: [{ note_path: alpha, reason: "Duplicate", gaps: [] }] }, /Duplicate/],
		[{ ...plan, notes: [beta], excluded: [{ note_path: alpha, reason: " ", gaps: [] }] }, /nonempty reason/],
		[{ ...plan, notes: [beta], excluded: [{ note_path: alpha, reason: "Outside the question" }] }, /explicit array/],
		[{ ...plan, notes: ["../outside.json", alpha] }, /Unknown accepted/],
		[{ ...plan, notes: [beta, "inputs/reader-results/sub-alpha/2/note.json"] }, /Unknown accepted/],
		[{ ...plan, sections: draft("rewritten").sections }, /Cue text belongs/],
		[{ ...plan, include_root_note: "yes" }, /boolean/],
	] as const) { await assert.rejects(assemble(bad), error); assert.equal(readFileSync(output, "utf8"), original); }
	await assemble({ ...plan, notes: [beta], excluded: [{ note_path: alpha, reason: "Superseded by this selected result", gaps: [] }] });
	assert.deepEqual(json(output).sections, draft("beta").sections);
	assert.equal(json(join(runtimeRoot, "reader-assembly.json")).sources.find((s: { note_path: string }) => s.note_path === alpha).included, false);
	writeFileSync(join(work, "root-note.json"), JSON.stringify(draft("supplement")));
	await assemble({ ...plan, include_root_note: true });
	assert.deepEqual(json(output).sections, [...draft("beta").sections, ...draft("alpha").sections, ...draft("supplement").sections]);
	const invalid = draft("supplement"); invalid.sections[0]!.cue_notes[0]!.evidence[0]!.end_line = 99;
	writeFileSync(join(work, "root-note.json"), JSON.stringify(invalid));
	await assert.rejects(assemble({ ...plan, include_root_note: true }), /line range/);
	const acceptedPath = join(work, alpha!); const acceptedBytes = readFileSync(acceptedPath, "utf8");
	writeFileSync(acceptedPath, JSON.stringify(draft("tampered")));
	await assert.rejects(assemble(plan), /integrity mismatch/); writeFileSync(acceptedPath, acceptedBytes);
	const target = join(work, "target.json"); writeFileSync(target, JSON.stringify(plan));
	for (const link of [symlinkSync, linkSync]) {
		rmSync(file); link(target, file);
		await assert.rejects(assembleReaderNote({ work, runtimeRoot, signal }), /ELOOP|private regular/);
		rmSync(file); writeFileSync(file, JSON.stringify(plan));
	}
	rmSync(file);
	await assert.rejects(assembleReaderNote({ work, runtimeRoot, signal }), /ENOENT/);
	assert.ok(existsSync(output), "a previous note.json never bypasses the required plan");
	writeFileSync(file, JSON.stringify(plan));
	const beforeAbort = readFileSync(output, "utf8");
	await assert.rejects(assembleReaderNote({ work, runtimeRoot, signal: AbortSignal.abort(new Error("cancelled")) }), /cancelled/);
	assert.equal(readFileSync(output, "utf8"), beforeAbort);
	// A newer accepted revision replaces the earlier file without changing history.
	const replacement = await acceptReaderFile({ root: work, runtimeRoot, workspace: join(fixture, "alpha"), identity: {
		child_id: "sub-alpha", session_id: "alpha", revision: 2, task: "Read alpha", follow_up: "Clarify" }, submission: 1, language: "en", signal });
	appendFileSync(join(runtimeRoot, "reader-delivery.jsonl"), `${JSON.stringify({ type: "reader_delivery_accepted", ...replacement })}\n`);
	await assert.rejects(assemble(plan), /Superseded/);
	await assemble({ ...plan, notes: [beta, replacement.note_path] });
	assert.deepEqual(json(join(runtimeRoot, "reader-assembly.json")).superseded, [alpha]);
	assert.deepEqual(json(output).sections, [...draft("beta").sections, ...draft("alpha").sections]);
	assert.equal(readFileSync(acceptedPath, "utf8"), acceptedBytes);
	// A selected child's supported Cues survive an unresolved condition; only accepted
	// Root supplements contribute gaps, while the plan owns the full-question handoff.
	const partial = { ...draft("gamma"), status: "partial", gaps: ["The release date is not disclosed."] };
	const gammaWork = join(fixture, "gamma"); mkdirSync(gammaWork);
	writeFileSync(join(gammaWork, "note.json"), JSON.stringify(partial));
	const gamma = await acceptReaderFile({ root: work, runtimeRoot, workspace: gammaWork, identity: {
		child_id: "sub-gamma", session_id: "gamma", revision: 1, task: "Read gamma" }, submission: 1, language: "en", signal });
	appendFileSync(join(runtimeRoot, "reader-delivery.jsonl"), `${JSON.stringify({ type: "reader_delivery_accepted", ...gamma })}\n`);
	writeFileSync(join(work, "root-note.json"), JSON.stringify({ ...draft("supplement"), status: "partial",
		gaps: ["An additional Source could not be inspected."] }));
	const partialPlan = { ...plan, status: "partial", notes: [beta, replacement.note_path, gamma.note_path], include_root_note: false };
	await assemble(partialPlan);
	assert.deepEqual(json(output).gaps, partial.gaps);
	assert.deepEqual(json(output).sections, [...draft("beta").sections, ...draft("alpha").sections, ...partial.sections]);
	await assemble({ ...partialPlan, include_root_note: true, gaps: partial.gaps });
	assert.deepEqual(json(output).gaps, [...partial.gaps, "An additional Source could not be inspected."]);
	const beforeInvalidStatus = readFileSync(output, "utf8");
	await assert.rejects(assemble({ ...partialPlan, status: "found" }), /found requires Cues and no gaps/);
	assert.equal(readFileSync(output, "utf8"), beforeInvalidStatus, "status conflicts are repaired before replacing a valid output");
	const excludedGaps = ["The release date still needs verification."];
	await assemble({ ...partialPlan, notes: [beta, replacement.note_path], excluded: [{ note_path: gamma.note_path,
		reason: "The requested release condition is unresolved", gaps: excludedGaps }] });
	assert.deepEqual(json(output).gaps, excludedGaps);
	assert.deepEqual(json(output).sections, [...draft("beta").sections, ...draft("alpha").sections], "Root retains the choice to exclude Cues");
	const excludedIndex = json(join(runtimeRoot, "reader-assembly.json")).sources.find((item: { note_path: string }) => item.note_path === gamma.note_path);
	assert.deepEqual(excludedIndex, { note_path: gamma.note_path, note_sha256: gamma.note_sha256, included: false,
		status: partial.status, summary: partial.summary, gaps: partial.gaps,
		exclusion: { reason: "The requested release condition is unresolved", gaps: excludedGaps } });
	assert.equal(readFileSync(join(work, gamma.note_path), "utf8"), JSON.stringify(partial), "excluded accepted private Notes remain intact");
	writeFileSync(join(work, "root-note.json"), "unfinished Root file");
	await assemble({ ...partialPlan, gaps: ["Root records its unresolved question here."] });
	assert.deepEqual(json(output).gaps, ["Root records its unresolved question here.", ...partial.gaps], "include_root_note=false ignores an unaccepted draft");
	// A model-created FIFO must not block the host event loop before it can reject the file.
	rmSync(file); execFileSync("mkfifo", [file]);
	const helper = new URL("../../server/research/pipeline/reader-delivery.ts", import.meta.url).href;
	const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e",
		`import {readReaderFile} from ${JSON.stringify(helper)}; try { readReaderFile(process.argv[1]); process.exitCode=1; } catch(e) { if (!String(e).includes('private regular')) throw e; }`, file],
		{ encoding: "utf8", timeout: 5000, killSignal: "SIGKILL" });
	assert.equal(child.error, undefined, "FIFO must be rejected without waiting for a writer");
	assert.equal(child.status, 0, child.stderr);
	console.log("Reader assembly preserves ordered child Cues, explicit exclusions and valid supplements; rejects omissions, forged/duplicate refs, tampering, unsafe files and cancellation");
} finally { rmSync(fixture, { recursive: true, force: true }); }
