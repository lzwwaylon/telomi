import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	findOutSelfDirectedWriterUserPrompt,
	listPriorReports,
	StageInputView,
	stagePriorReports,
	wikiSelfDirectedWriterUserPrompt,
} from "../../server/research/pipeline/index.js";

const root = mkdtempSync(join(tmpdir(), "telomi-prior-reports-"));
try {
	const goal = join(root, "goal");
	const control = join(root, "control", "runs");
	const publish = (runId: string, state: Record<string, unknown>, markdown?: string): void => {
		mkdirSync(join(control, runId), { recursive: true });
		writeFileSync(join(control, runId, "run-state.json"), JSON.stringify(state));
		if (markdown !== undefined) {
			mkdirSync(join(goal, "wiki", "runs", runId, "report"), { recursive: true });
			writeFileSync(join(goal, "wiki", "runs", runId, "report", "final.md"), markdown);
		}
	};
	publish("2026-09-01T00-00-00.000Z", { status: "published", question: "TTS landscape\nsecond line", finished_at: "2026-09-01T02:00:00.000Z" },
		"# TTS: a/b | c\n\nbody");
	publish("2026-09-08T00-00-00.000Z", { status: "published", question: "TTS landscape", finished_at: "2026-09-08T02:00:00.000Z" },
		"# TTS landscape update\n\nbody");
	publish("2026-09-08T03-00-00.000Z", { status: "published", question: "TTS landscape", finished_at: "2026-09-08T04:00:00.000Z" },
		"# TTS landscape update\n\nbody 2");
	publish("2026-09-09T00-00-00.000Z", { status: "skipped", question: "TTS landscape" }, "# should not appear");
	publish("2026-09-10T00-00-00.000Z", { status: "published", question: "no report yet" });
	publish("2026-09-11T00-00-00.000Z", { status: "published", question: "current run" }, "# current");

	const reports = listPriorReports({ goalWorkspaceDirectory: goal, controlRunsRoot: control, currentRunId: "2026-09-11T00-00-00.000Z" });
	assert.deepEqual(reports.map((report) => report.fileName), [
		"2026-09-08-TTS-landscape-update.md",
		"2026-09-08-TTS-landscape-update-2.md",
		"2026-09-01-TTS-a-b-c.md",
	]);
	assert.equal(reports[2]!.question, "TTS landscape");

	const view = new StageInputView(join(root, "view"));
	const index = stagePriorReports(view, reports);
	assert.match(index, /\| 2026-09-01 \| TTS: a\/b \\\| c \| TTS landscape \| prior-reports\/2026-09-01-TTS-a-b-c\.md \|/u);
	assert.equal(readFileSync(join(view.root, "prior-reports", "index.md"), "utf-8"), index);
	assert.equal(readFileSync(join(view.root, "prior-reports", "2026-09-08-TTS-landscape-update-2.md"), "utf-8"), "# TTS landscape update\n\nbody");

	const args = { language: "zh-CN", currentDate: "2026-09-11", timeZone: "Asia/Shanghai" };
	for (const render of [wikiSelfDirectedWriterUserPrompt, findOutSelfDirectedWriterUserPrompt]) {
		assert.doesNotMatch(render(args), /prior-reports/u);
		const withIndex = render({ ...args, priorReports: index });
		assert.match(withIndex, /inputs\/prior-reports\//u);
		assert.ok(withIndex.includes(index.trim()));
	}

	assert.deepEqual(listPriorReports({ goalWorkspaceDirectory: join(root, "missing"), controlRunsRoot: control, currentRunId: "x" }), []);
	const empty = new StageInputView(join(root, "empty-view"));
	assert.equal(stagePriorReports(empty, []), "");
	assert.ok(!existsSync(join(empty.root, "prior-reports")));

	const publishInvestigation = (id: string, publishedAt: string, patch: Record<string, unknown> = {}) => {
		const runId = `investigation-${id}`;
		const reportDir = join(goal, "wiki", "runs", runId, "report");
		mkdirSync(reportDir, { recursive: true });
		const markdown = "# Investigation report\n\nFrozen finding [[1]](https://example.com/paper).\n\n## References\n1. [Paper](https://example.com/paper)\n";
		writeFileSync(join(reportDir, "final.md"), markdown);
		writeFileSync(join(reportDir, "final.json"), JSON.stringify({ markdown, publishedAt,
			citations: [{ number: 1, title: "Paper", url: "https://example.com/paper", refs: ["C1"] }],
			investigation: { id, question: "Investigation question\nsecond line", answer: "Frozen finding <cite>C1</cite>.",
				citation_refs: ["C1"], gaps: [], wiki_sha256: "a".repeat(64) },
			...patch,
		}));
		return runId;
	};
	publish("2026-09-06T00-00-00.000Z", { status: "published", question: "Older Research without explicit timestamp" }, "# Older fallback\n\nbody");
	const olderInvestigation = publishInvestigation("f".repeat(24), "2026-09-07T03:00:00.000Z");
	const newerInvestigation = publishInvestigation("0".repeat(24), "2026-09-12T03:00:00.000Z");
	const badTimestamp = publishInvestigation("1".repeat(24), "not-a-timestamp");
	const changedMarkdown = publishInvestigation("2".repeat(24), "2026-09-13T03:00:00.000Z", { markdown: "different" });
	const wrongIdentity = publishInvestigation("3".repeat(24), "2026-09-13T03:00:00.000Z", {
		investigation: { id: "4".repeat(24), question: "Mismatched identity" },
	});
	const mismatchedRefs = publishInvestigation("5".repeat(24), "2026-09-13T03:00:00.000Z", {
		citations: [{ number: 1, refs: ["C9"] }],
	});
	const incomplete = publishInvestigation("6".repeat(24), "2026-09-13T03:00:00.000Z");
	rmSync(join(goal, "wiki", "runs", incomplete, "report", "final.md"));
	const invalidResult = publishInvestigation("7".repeat(24), "2026-09-13T03:00:00.000Z", {
		investigation: { id: "7".repeat(24), question: "Invalid result", answer: "Missing required metadata" },
	});
	publish("2026-09-13T00-00-00.000Z", { status: "failed", question: "Failed Research" }, "# Must not appear");
	publish("2026-09-14T00-00-00.000Z", { status: "writing", question: "In-flight Research" }, "# Must not appear");
	const mixed = listPriorReports({ goalWorkspaceDirectory: goal, controlRunsRoot: control,
		currentRunId: "2026-09-11T00-00-00.000Z" });
	assert.deepEqual(mixed.map((report) => report.runId), [
		newerInvestigation, "2026-09-08T03-00-00.000Z", "2026-09-08T00-00-00.000Z",
		olderInvestigation, "2026-09-06T00-00-00.000Z", "2026-09-01T00-00-00.000Z",
	], "publication timestamps interleave investigation and Research reports, independent of their id prefixes");
	assert.equal(mixed[0]!.publishedOn, "2026-09-12");
	assert.equal(mixed[0]!.question, "Investigation question");
	for (const runId of [badTimestamp, changedMarkdown, wrongIdentity, mismatchedRefs, incomplete, invalidResult]) {
		assert.equal(mixed.some((report) => report.runId === runId), false, "invalid or incomplete publication is not prior-report context");
	}
	assert.equal(existsSync(join(control, newerInvestigation, "run-state.json")), false,
		"including an investigation publication never fabricates a full Research Run control state");
	assert.equal(listPriorReports({ goalWorkspaceDirectory: goal, controlRunsRoot: control,
		currentRunId: newerInvestigation }).some((report) => report.runId === newerInvestigation), false);
	console.log("prior reports tests passed");
} finally {
	rmSync(root, { recursive: true, force: true });
}
