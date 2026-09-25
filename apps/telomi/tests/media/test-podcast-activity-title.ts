import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { mainAgentProjection } from "../../server/main-agent/activity-projection.js";
import { cardIdFromArtifactName } from "../../server/media/product-artifacts.js";
import { createPodcastGenerator } from "../../server/media/products-api.js";
import type { GoalActivityItem } from "../../shared/types.js";
import i18n from "../../web/src/app/i18n.js";
import { activityText } from "../../web/src/shared/lib/activity-text.js";

// A running Podcast job names itself with the title of its source report, in every locale, whether the
// report is an ordinary artifact or a workspace run report addressed by an encoded path cardId.
const goalId = "goal_podcast_title";
const CHINESE = /[一-鿿]/u;
// A cardId, an artifact path and an upstream diagnostic all carry one of these; a report title does not.
const INTERNAL = /path_|wiki|runs|final|\.md|[/\\]|Error|products-api/u;
const ORDINARY_TITLE = "2026 年 TTS 模型清单";
const PATH_TITLE = "Weekly TTS model landscape";
const FAILURE = "Preference resolution failed: /Users/host/telomi/server/media/products-api.ts:120";

const en = () => i18n.changeLanguage("en");
const zh = () => i18n.changeLanguage("zh-CN");
const root = mkdtempSync(join(tmpdir(), "telomi-podcast-activity-title-"));

function writeArtifact(relativeName: string, body: string): string {
	// `wiki/runs/<runId>/report/<name>.md` resolves under the Goal root; everything else under artifacts/.
	const abs = relativeName.startsWith("wiki/runs/")
		? join(root, goalId, relativeName)
		: join(root, goalId, "artifacts", relativeName);
	mkdirSync(dirname(abs), { recursive: true });
	writeFileSync(abs, body, "utf-8");
	const cardId = cardIdFromArtifactName(relativeName);
	assert.ok(cardId, `no cardId for ${relativeName}`);
	return cardId;
}

/** Drive the real generator and collect the Activity records it emits, stopping before any model call. */
async function generationRecords(cardId: string): Promise<GoalActivityItem[]> {
	const records: GoalActivityItem[] = [];
	const generator = createPodcastGenerator(root, {
		resolveGenerationBrief: async () => { throw new Error(FAILURE); },
	}, { onActivity: (item) => records.push({ ...item, updatedAt: item.updatedAt ?? Date.now() }) });
	generator.start({ goalId, cardId });
	for (let attempt = 0; !records.some((item) => item.status === "error") && attempt < 300; attempt++) {
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	assert.equal(generator.status(goalId, cardId).status, "failed");
	// Initialization, at least one progress step, and the failure.
	assert.ok(records.filter((item) => item.status === "running").length >= 2, `too few running records: ${records.length}`);
	assert.ok(records.some((item) => item.action.includes("整理播客偏好")), "no progress record observed");
	return records;
}

const projected = (item: GoalActivityItem) => mainAgentProjection(() => [item])(goalId)[0]!.items[0]!;
const summaryOf = (item: GoalActivityItem) => activityText(projected(item).summary);

try {
	const ordinaryCardId = writeArtifact("report.md", `# ${ORDINARY_TITLE}\n\n正文段落。\n`);
	assert.equal(ordinaryCardId, "report");
	const ordinary = await generationRecords(ordinaryCardId);

	const pathCardId = writeArtifact(
		"wiki/runs/2026-09-18T18-14-51.653Z/report/final.md",
		`# ${PATH_TITLE}\n\nBody paragraph.\n`,
	);
	assert.match(pathCardId, /^path_/u, "the workspace run report must use an encoded path cardId");
	const pathCard = await generationRecords(pathCardId);

	const fallbackCardId = writeArtifact(
		"wiki/runs/2026-09-18T19-02-03.900Z/report/final.md",
		"正文没有一级标题。\n",
	);
	const fallback = await generationRecords(fallbackCardId);

	// The report title is recorded as content of its own; no record passes an identifier off as a name.
	for (const [records, title] of [[ordinary, ORDINARY_TITLE], [pathCard, PATH_TITLE]] as const) {
		for (const item of records) {
			assert.equal(item.sourceTitle, title, `record ${item.action} lost the report title`);
			assert.doesNotMatch(item.sourceTitle!, INTERNAL, "the title must not carry internal addressing");
		}
	}
	for (const item of [...ordinary, ...pathCard, ...fallback]) {
		// `detail` carries diagnostics only: it is neither the title nor the cardId.
		assert.ok(!item.detail?.includes("path_"), `a record detail leaked a cardId: ${item.detail}`);
		if (item.sourceTitle) assert.notEqual(item.detail, item.sourceTitle);
	}

	const running = (records: GoalActivityItem[]) => records.find((item) => item.status === "running")!;
	await en();
	assert.equal(summaryOf(running(ordinary)), `Generating the Podcast · ${ORDINARY_TITLE}`);
	assert.equal(summaryOf(running(pathCard)), `Generating the Podcast · ${PATH_TITLE}`);
	assert.doesNotMatch(summaryOf(running(pathCard)), CHINESE, "English UI must not keep Runtime Chinese");
	// A report without a heading keeps the localized chrome alone: the encoded cardId is not a fallback title.
	assert.equal(summaryOf(running(fallback)), "Generating the Podcast");
	assert.equal(running(fallback).sourceTitle, undefined);
	await zh();
	assert.equal(summaryOf(running(ordinary)), `正在生成 Podcast · ${ORDINARY_TITLE}`);
	assert.equal(summaryOf(running(pathCard)), `正在生成 Podcast · ${PATH_TITLE}`);
	assert.equal(summaryOf(running(fallback)), "正在生成 Podcast");

	// The upstream diagnostic stays in the detail view; the home surfaces keep chrome and title only.
	await en();
	for (const [records, expected] of [
		[ordinary, `Podcast generation failed · ${ORDINARY_TITLE}`],
		[pathCard, `Podcast generation failed · ${PATH_TITLE}`],
		[fallback, "Podcast generation failed"],
	] as const) {
		const failed = records.find((item) => item.status === "error")!;
		assert.equal(failed.detail, FAILURE);
		const item = projected(failed);
		assert.equal(activityText(item.summary), expected);
		assert.equal(activityText(item.attention!.summary), expected);
		assert.doesNotMatch(activityText(item.summary).replace(ORDINARY_TITLE, ""), INTERNAL);
		assert.ok(activityText(item.steps[0]!.summary).includes(FAILURE), "the detail view keeps the diagnostic");
	}

	// Once a later attempt for the same report exists, the earlier failure stays in history without attention.
	const earlierFailure = ordinary.find((item) => item.status === "error")!;
	assert.equal(earlierFailure.cardId, ordinaryCardId, "every attempt records the card it belongs to");
	// Retry starts the same report's generation directly, without an instruction, so a finished script resumes.
	const [retry] = projected(earlierFailure).attention!.actions;
	assert.equal(retry!.kind, "retry");
	assert.equal(retry!.href, `/api/goals/${goalId}/media-products/${ordinaryCardId}/generate`);
	assert.equal(retry!.requestBody, undefined);
	assert.deepEqual(projected({ ...earlierFailure, cardId: undefined }).attention!.actions, [],
		"a record that cannot name its report offers no retry");
	const later: GoalActivityItem = { ...earlierFailure, id: `${goalId}:podcast:later`, status: "done", startedAt: (earlierFailure.startedAt ?? 0) + 1 };
	const otherReport: GoalActivityItem = { ...later, id: `${goalId}:podcast:other`, cardId: pathCardId };
	const [superseded] = mainAgentProjection(() => [earlierFailure, later])(goalId)[0]!.items;
	assert.equal(superseded!.outcome, "failed");
	assert.equal(superseded!.attention, undefined);
	assert.ok(mainAgentProjection(() => [earlierFailure, otherReport])(goalId)[0]!.items[0]!.attention,
		"another report's attempt does not answer this failure");

	console.log("podcast activity title test passed");
} finally {
	await zh();
	rmSync(root, { recursive: true, force: true });
}
