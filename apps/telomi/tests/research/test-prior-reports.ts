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
	console.log("prior reports tests passed");
} finally {
	rmSync(root, { recursive: true, force: true });
}
