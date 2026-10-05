import { type InvestigationResult } from "../../server/citations/contracts.js";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Value } from "@sinclair/typebox/value";

import { sha256 } from "../../server/lib/hash.js";
import { publishInvestigationHandoff } from "../../server/main-agent/investigation-handoff.js";
import { createGeneratePodcastTool } from "../../server/main-agent/tools/generate-podcast.js";
import { createMainAgentTools } from "../../server/main-agent/tools/index.js";
import { parseMainTerminalDetails } from "../../server/main-agent/tools/terminal-action.js";
import { scanGoalProductArtifacts } from "../../server/media/product-artifacts.js";
import { listPublishedReports, publishedInvestigationReportMetadata, publishedReportGuestPath } from "../../server/media/report-view.js";

import { publishInvestigationReport } from "../../server/research/investigation-report.js";
import { reportPublishedResponse, reportReference } from "../../server/research/reports/delivery.js";
import { serverRuntimeDirForGoalDir } from "../../server/workspaces/server-runtime-paths.js";

const workspace = mkdtempSync(join(tmpdir(), "telomi-investigation-report-"));
const goalId = "goal_publication";
const goalDir = join(workspace, goalId);
const deepRef = "deep-search:reader-1:cue-1";
const noteRef = `note:source-run:${"a".repeat(24)}:${"b".repeat(12)}`;
const anchor = { source_run_id: "source-run", source_id: "source:paper", source_revision_sha256: sha256("source"),
	source_path: "paper/content.md", start_line: 1, end_line: 1, content_sha256: sha256("Original evidence.\n"),
	excerpt: "Original evidence." };
const citations = [
	{ ref: "C1", wiki: { ref: "C1", page: { ref: "P1", path: "wiki/implementation.md", title: "Frozen Wiki",
		type: "entity", content: "Frozen Wiki text" }, entry: { id: "entry:wiki", index: 1, section: "Implementation",
			cue: "Frozen Wiki cue", note: "Frozen Wiki finding", source: { id: "source:wiki", title: "Wiki source", url: "https://example.com/wiki" },
			anchors: [{ path: "wiki-source/content.md", startLine: 1, endLine: 1, format: "markdown", content: "Frozen Wiki evidence", assets: [] }] },
		evidence: [] } },
	{ ref: deepRef, cue: { ref: deepRef, section_title: "New reading", cue: "New detail", note: "Newly read finding",
		evidence: [{ ...anchor, title: "New source", url: "https://example.com/new" }] } },
	{ ref: noteRef, cue: { ref: noteRef, cue: "Saved detail", note: "Saved finding", source_id: "source:paper",
		source_revision_sha256: anchor.source_revision_sha256, source_title: "Saved source", canonical_locator: "file:///local/paper.md",
		evidence: [anchor] } },
];
const seed = (id: string, answer = `Frozen Wiki <cite>C1</cite>. New detail <cite>${deepRef}</cite>. Saved detail <cite>${noteRef}</cite>.`,
	refs = ["C1", deepRef, noteRef], frozen: unknown[] = citations) => {
	const result: InvestigationResult = { id, question: "Write a report using all verified evidence", answer,
		citation_refs: refs, gaps: ["An unverified limitation remains"], wiki_sha256: sha256("frozen Wiki") };
	const runDir = join(serverRuntimeDirForGoalDir(goalDir), "research", "investigations", id);
	mkdirSync(runDir, { recursive: true });
	writeFileSync(join(runDir, "request.json"), JSON.stringify({ id, question: result.question }));
	writeFileSync(join(runDir, "result.json"), JSON.stringify(result));
	writeFileSync(join(runDir, "citations.json"), JSON.stringify({ schema_version: 1, citations: frozen }));
	return result;
};

try {
	const id = "1".repeat(24);
	const result = seed(id);
	const original = readFileSync(join(serverRuntimeDirForGoalDir(goalDir), "research", "investigations", id, "result.json"));
	const published = publishInvestigationReport(goalDir, id, "Evidence report");
	assert.deepEqual(published, { runId: `investigation-${id}`, reportTitle: "Evidence report",
		stableFinalReportPath: `/workspace/wiki/runs/investigation-${id}/report/final.md` });
	assert.deepEqual(reportReference(published.runId, published.stableFinalReportPath, published.reportTitle),
		{ runId: published.runId, title: published.reportTitle }, "the existing terminal contract can stamp a report card");
	const reportRoot = join(goalDir, "wiki", "runs", published.runId, "report");
	const markdown = readFileSync(join(reportRoot, "final.md"), "utf-8");
	const structured = JSON.parse(readFileSync(join(reportRoot, "final.json"), "utf-8"));
	assert.equal(new Date(structured.publishedAt).toISOString(), structured.publishedAt);
	assert.deepEqual(publishedInvestigationReportMetadata(goalDir, published.runId), { publishedAt: structured.publishedAt, question: result.question });
	assert.equal(structured.markdown, markdown);
	assert.deepEqual(structured.investigation, result, "preserve original answer bytes, citation identities and gaps");
	assert.deepEqual(structured.citations[0].wiki, [citations[0]!.wiki]);
	assert.deepEqual(structured.citations[1].cue, citations[1]!.cue);
	assert.deepEqual(structured.citations[2].cue, citations[2]!.cue);
	assert.match(markdown, /Frozen Wiki \[\[1\]\]\(https:\/\/example.com\/wiki\)/u);
	assert.match(markdown, /New detail \[\[2\]\]\(https:\/\/example.com\/new\)/u);
	assert.match(markdown, /Saved detail \[\[3\]\]/u);
	assert.equal(markdown.includes("file:///"), false, "local locators are not external citation links");
	assert.equal(markdown.includes("<cite>"), false);
	assert.deepEqual(readFileSync(join(serverRuntimeDirForGoalDir(goalDir), "research", "investigations", id, "result.json")), original);
	assert.equal(listPublishedReports(goalDir).length, 1);
	assert.ok(scanGoalProductArtifacts(workspace, goalId).some((entry) => entry.name === `wiki/runs/${published.runId}/report/final.md`));
	const guestPath = publishedReportGuestPath(goalDir, published.runId);
	assert.equal(readFileSync(join(goalDir, guestPath.slice(1)), "utf-8"), markdown);
	const dispatched: unknown[] = [];
	const podcast = createGeneratePodcastTool(goalId, goalDir, (request) => { dispatched.push(request); return { jobId: "job-1" }; });
	await podcast.execute("podcast-request", { report: guestPath }, new AbortController().signal, () => undefined);
	assert.deepEqual(dispatched, [{ goalId, cardId: listPublishedReports(goalDir)[0]!.cardId }],
		"the existing Podcast tool accepts the new Canonical Report");
	assert.deepEqual(publishInvestigationReport(goalDir, id, "Evidence report"), published);
	assert.equal(JSON.parse(readFileSync(join(reportRoot, "final.json"), "utf-8")).publishedAt, structured.publishedAt,
		"retries preserve the original publication timestamp");
	assert.equal(listPublishedReports(goalDir).length, 1, "retry does not create another report");
	assert.throws(() => publishInvestigationReport(goalDir, id, "Different title"), /differs/u);
	assert.equal(readFileSync(join(reportRoot, "final.md"), "utf-8"), markdown);
	// Recover a crash between the companion JSON and the visibility marker.
	rmSync(join(reportRoot, "final.md"));
	assert.equal(publishedInvestigationReportMetadata(goalDir, published.runId), undefined, "partial publication is not prior-report metadata");
	assert.deepEqual(publishInvestigationReport(goalDir, id, "Evidence report"), published);
	assert.equal(readFileSync(join(reportRoot, "final.md"), "utf-8"), markdown);
	assert.equal(JSON.parse(readFileSync(join(reportRoot, "final.json"), "utf-8")).publishedAt, structured.publishedAt,
		"recovery from the published companion JSON keeps the original timestamp");
	assert.equal(existsSync(join(serverRuntimeDirForGoalDir(goalDir), "runs", published.runId, "state.json")), false,
		"publication does not impersonate a full Research Run or Schedule baseline");

	const cancelledId = "2".repeat(24);
	seed(cancelledId);
	const controller = new AbortController();
	controller.abort();
	assert.throws(() => publishInvestigationReport(goalDir, cancelledId, "Cancelled", controller.signal));
	assert.equal(existsSync(join(goalDir, "wiki", "runs", `investigation-${cancelledId}`, "report", "final.md")), false);
	const missingId = "3".repeat(24);
	seed(missingId, result.answer, result.citation_refs, citations.slice(0, 2));
	assert.throws(() => publishInvestigationReport(goalDir, missingId, "Missing evidence"), /missing frozen citation/u);
	const emptyId = "4".repeat(24);
	seed(emptyId, "No supported finding is available.", [], []);
	assert.throws(() => publishInvestigationReport(goalDir, emptyId, "Empty evidence"), /Evidence Reference/u);
	const extraId = "5".repeat(24);
	seed(extraId, "A finding <cite>C1</cite>.", ["C1"], citations);
	assert.throws(() => publishInvestigationReport(goalDir, extraId, "Unassigned citation"), /identities disagree/u);
	assert.equal(listPublishedReports(goalDir).length, 1, "cancelled and rejected publications have no report cards");
	assert.deepEqual(readdirSync(join(goalDir, "wiki", "runs")), [published.runId]);
	assert.throws(() => publishInvestigationReport(goalDir, id, "Injected\nheading"), /single-line/u);
	for (const [index, corrupted] of [
		{ ...anchor, source_revision_sha256: "invalid" }, { ...anchor, content_sha256: "invalid" },
		{ ...anchor, source_id: "" }, { ...anchor, source_run_id: "../outside" },
		{ ...anchor, start_line: 0 }, { ...anchor, end_line: 0 }, { ...anchor, source_path: "../outside" },
	].entries()) {
		const badId = (index + 6).toString(16).repeat(24);
		seed(badId, `A finding <cite>${deepRef}</cite>.`, [deepRef], [{ ref: deepRef,
			cue: { ref: deepRef, section_title: "Corrupt", cue: "Corrupt anchor", note: "Unsupported",
				evidence: [{ ...corrupted, title: "Source", url: "https://example.com/new" }] } }]);
		assert.throws(() => publishInvestigationReport(goalDir, badId, "Invalid anchor"), /Source (?:anchor|path)/u);
		assert.equal(existsSync(join(goalDir, "wiki", "runs", `investigation-${badId}`, "report", "final.md")), false);
	}
	publishInvestigationHandoff(goalDir, result);
	rmSync(join(serverRuntimeDirForGoalDir(goalDir), "research", "investigations", id), { recursive: true });
	assert.deepEqual(publishInvestigationReport(goalDir, id, "Evidence report"), published,
		"a Case-restored Goal result and evidence can publish without server control files");
	const delivery = createMainAgentTools(goalDir, { goalId, workspaceDir: workspace }).find((tool) => tool.name === "deliver_investigation")!;
	assert.equal(Value.Check(delivery.parameters, { investigation_id: id, report_title: "Evidence report" }), true);
	for (const report_title of ["", "Injected\nheading", "x".repeat(121)]) {
		assert.equal(Value.Check(delivery.parameters, { investigation_id: id, report_title }), false);
	}
	const delivered = await delivery.execute("publish-report", { investigation_id: id, report_title: "Evidence report" }, new AbortController().signal);
	const terminal = parseMainTerminalDetails(delivered.details);
	assert.ok(terminal);
	assert.equal(terminal.terminal, true);
	assert.equal(terminal.action, "deliver_investigation");
	assert.equal(terminal.trace.selectedRunId, published.runId);
	assert.equal(terminal.userResponse, reportPublishedResponse("en"));
	assert.deepEqual(reportReference(terminal.trace.selectedRunId, terminal.stableFinalReportPath, terminal.reportTitle),
		{ runId: published.runId, title: "Evidence report" });
	const ordinary = await delivery.execute("ordinary-answer", { investigation_id: id }, new AbortController().signal);
	const ordinaryTerminal = parseMainTerminalDetails(ordinary.details);
	assert.ok(ordinaryTerminal);
	assert.equal(ordinaryTerminal.userResponse, result.answer);
	assert.deepEqual(ordinary.content, [{ type: "text", text: result.answer }]);
	assert.equal(ordinaryTerminal.runId, undefined, "ordinary answer delivery does not announce a report card");

	const titledId = "d".repeat(24);
	const titled = seed(titledId, `# Writer's old title\n\nA supported paragraph <cite>C1</cite>.`, ["C1"], citations.slice(0, 1));
	const titledReport = publishInvestigationReport(goalDir, titledId, "User report title");
	const titledJson = JSON.parse(readFileSync(join(goalDir, "wiki", "runs", titledReport.runId, "report", "final.json"), "utf-8"));
	assert.deepEqual(titledJson.markdown.match(/^# .+$/gmu), ["# User report title"]);
	assert.match(titledJson.markdown, /A supported paragraph \[\[1\]\]/u);
	assert.equal(titledJson.investigation.answer, titled.answer, "compiling the presentation title leaves the Writer artifact unchanged");
	const headerCitationId = "e".repeat(24);
	seed(headerCitationId, "# Writer title <cite>C1</cite>\n\nThe remaining paragraph is unchanged.", ["C1"], citations.slice(0, 1));
	const headerCitation = publishInvestigationReport(goalDir, headerCitationId, "Replacement title");
	const headerMarkdown = readFileSync(join(goalDir, "wiki", "runs", headerCitation.runId, "report", "final.md"), "utf-8");
	assert.deepEqual(headerMarkdown.match(/^# .+$/gmu), ["# Replacement title"]);
	assert.match(headerMarkdown, /## Writer title \[\[1\]\]/u,
		"a cited original heading keeps its wording and evidence as a subsection");
	const checklistId = sha256("checklist-title-fixture").slice(0, 24);
	const checklist = seed(checklistId, "## Saved checklist\n\nA supported paragraph <cite>C1</cite>.", ["C1"], citations.slice(0, 1));
	const checklistReport = publishInvestigationReport(goalDir, checklistId, "Saved checklist");
	const checklistJson = JSON.parse(readFileSync(join(goalDir, "wiki", "runs", checklistReport.runId, "report", "final.json"), "utf-8"));
	assert.deepEqual(checklistJson.markdown.match(/^#{1,6} Saved checklist$/gmu), ["# Saved checklist"],
		"an existing answer title must not become a duplicate heading in the report or its table of contents");
	assert.equal(checklistJson.investigation.answer, checklist.answer);
	assert.match(headerMarkdown, /The remaining paragraph is unchanged\./u);
	assert.ok(publishedInvestigationReportMetadata(goalDir, headerCitation.runId));

	const originalNow = Date.now;
	try {
		const firstId = "f".repeat(24);
		const secondId = "0".repeat(24);
		seed(firstId);
		seed(secondId);
		Date.now = () => Date.parse(titledJson.publishedAt) + 1000;
		const firstReport = publishInvestigationReport(goalDir, firstId, "Repeated title");
		const firstPath = publishedReportGuestPath(goalDir, firstReport.runId);
		const firstTime = publishedInvestigationReportMetadata(goalDir, firstReport.runId)!.publishedAt;
		const secondReport = publishInvestigationReport(goalDir, secondId, "Repeated title");
		assert.equal(publishedReportGuestPath(goalDir, firstReport.runId), firstPath,
			"a later lower-hash report with the same title never renames the earlier directory");
		assert.ok(Date.parse(publishedInvestigationReportMetadata(goalDir, secondReport.runId)!.publishedAt) > Date.parse(firstTime),
			"publication order survives two reports in the same millisecond");
		assert.ok(listPublishedReports(goalDir).findIndex((report) => report.runId === firstReport.runId)
			< listPublishedReports(goalDir).findIndex((report) => report.runId === secondReport.runId));
		const day = new Date(firstTime);
		const localDate = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`;
		assert.equal(firstPath, `/reports/${localDate} Repeated title/report.md`);
	} finally { Date.now = originalNow; }
	console.log("investigation report publication test passed");
} finally {
	rmSync(workspace, { recursive: true, force: true });
}
