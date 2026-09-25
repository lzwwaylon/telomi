import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Report names carry the user's local date; pin the zone so the expected names hold on any machine.
process.env.TZ = "Asia/Shanghai";

const { cardIdFromArtifactName } = await import("../../server/media/product-artifacts.js");
const { listPublishedReports, publishedReportForPath, publishedReportGuestPath, syncPublishedReportView } = await import("../../server/media/report-view.js");
const { createGeneratePodcastTool } = await import("../../server/main-agent/tools/generate-podcast.js");

const goalDir = mkdtempSync(join(tmpdir(), "telomi-report-view-"));
const publishReport = (runId: string, markdown: string) => {
	mkdirSync(join(goalDir, "wiki", "runs", runId, "report"), { recursive: true });
	writeFileSync(join(goalDir, "wiki", "runs", runId, "report", "final.md"), markdown);
};
const publishPodcast = (runId: string, transcript: string) => {
	const cardId = cardIdFromArtifactName(`wiki/runs/${runId}/report/final.md`)!;
	mkdirSync(join(goalDir, ".media-products", cardId), { recursive: true });
	writeFileSync(join(goalDir, ".media-products", cardId, "podcast-ai.meta.json"), JSON.stringify({ extra: { slug: `slug-${runId.slice(0, 10)}` } }));
	mkdirSync(join(goalDir, "podcasts", `slug-${runId.slice(0, 10)}`), { recursive: true });
	writeFileSync(join(goalDir, "podcasts", `slug-${runId.slice(0, 10)}`, "transcript.md"), transcript);
};

try {
	// 20:31 UTC is already the next day in Shanghai.
	publishReport("2026-09-24T20-31-51.639Z", "# 语音生成开源模型 / 研究报告\n\nBody\n");
	publishReport("2026-09-25T04-31-51.639Z", "# 语音生成开源模型 / 研究报告\n\nSecond body\n");
	publishReport("2026-09-26T01-00-00.000Z", "No heading\n");
	mkdirSync(join(goalDir, "wiki", "runs", "unpublished"), { recursive: true });

	const reports = listPublishedReports(goalDir);
	assert.deepEqual(reports.map((report) => report.name), [
		"2026-09-25 语音生成开源模型 研究报告",
		"2026-09-25 语音生成开源模型 研究报告 2026-09-25T04-31-51.639Z",
		"2026-09-26 研究报告",
	], "a name is the local date and title; a repeated name keeps the earlier report's and spells out the later run");
	assert.equal(reports[0]!.cardId, cardIdFromArtifactName("wiki/runs/2026-09-24T20-31-51.639Z/report/final.md"),
		"the report keeps the card id its report card and Podcast already use");

	publishPodcast("2026-09-24T20-31-51.639Z", "# 播客\n\n口语化文稿\n");
	const view = syncPublishedReportView(goalDir);
	const first = join(view, "2026-09-25 语音生成开源模型 研究报告");
	assert.deepEqual(readdirSync(first).sort(), ["podcast.md", "report.md"]);
	assert.equal(readFileSync(join(first, "report.md"), "utf-8"), "# 语音生成开源模型 / 研究报告\n\nBody\n");
	assert.equal(readFileSync(join(first, "podcast.md"), "utf-8"), "# 播客\n\n口语化文稿\n");
	assert.deepEqual(readdirSync(join(view, "2026-09-26 研究报告")), ["report.md"], "a report without a Podcast has no podcast.md");

	// The view follows its sources: an updated source is copied again, a removed Podcast disappears.
	publishPodcast("2026-09-24T20-31-51.639Z", "# 播客\n\n新的文稿，长度不同\n");
	syncPublishedReportView(goalDir);
	assert.equal(readFileSync(join(first, "podcast.md"), "utf-8"), "# 播客\n\n新的文稿，长度不同\n");
	rmSync(join(goalDir, ".media-products"), { recursive: true });
	writeFileSync(join(view, "stray.md"), "not a report");
	syncPublishedReportView(goalDir);
	assert.equal(existsSync(join(first, "podcast.md")), false);
	assert.equal(existsSync(join(view, "stray.md")), false);

	for (const path of [
		"/reports/2026-09-25 语音生成开源模型 研究报告",
		"/reports/2026-09-25 语音生成开源模型 研究报告/",
		"/reports/2026-09-25 语音生成开源模型 研究报告/report.md",
	]) {
		assert.equal(publishedReportForPath(goalDir, path)?.runId, "2026-09-24T20-31-51.639Z", path);
	}
	for (const path of ["/reports", "/reports/2026-09-24T20-31-51.639Z/final.md", "/work/report.md", "/reports/missing/report.md"]) {
		assert.equal(publishedReportForPath(goalDir, path), undefined, path);
	}
	assert.equal(publishedReportGuestPath(goalDir, "2026-09-26T01-00-00.000Z"), "/reports/2026-09-26 研究报告/report.md");

	const dispatched: unknown[] = [];
	const tool = createGeneratePodcastTool("goal_view", goalDir, (request) => {
		dispatched.push(request);
		return { jobId: "job-1" };
	});
	const started = await tool.execute("call-1", {
		report: "/reports/2026-09-25 语音生成开源模型 研究报告",
		instruction: " Keep it short. ",
	}, new AbortController().signal, () => undefined);
	assert.deepEqual(dispatched, [{ goalId: "goal_view", cardId: reports[0]!.cardId, generationInstruction: "Keep it short." }]);
	assert.match(JSON.stringify(started.content), /2026-09-25 语音生成开源模型 研究报告\/podcast\.md/u);
	// The run-id path an older receipt carried now points the Agent at the listing.
	await assert.rejects(() => tool.execute("call-2", { report: "/reports/2026-09-24T20-31-51.639Z/final.md" },
		new AbortController().signal, () => undefined), /is not a published report\. Run `ls \/reports`/u);
	assert.equal(dispatched.length, 1);
	console.log("report view test passed");
} finally {
	rmSync(goalDir, { recursive: true, force: true });
}
