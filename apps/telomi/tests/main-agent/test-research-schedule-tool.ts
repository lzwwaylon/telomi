import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createResearchScheduleTool } from "../../server/main-agent/tools/research-schedule.js";
import { ResearchScheduleStore } from "../../server/research/schedules/store.js";

const workspaceDir = mkdtempSync(join(tmpdir(), "research-schedule-tool-"));
const goalId = "goal_schedule_tool";
const createdAt = new Date("2026-09-18T18:20:00.000Z");
const readSource = { sourceIdentity: "source:read", contentSha256: "a".repeat(64) };
const gapSource = { sourceIdentity: "source:91b319038d79efcf852fe5f8", contentSha256: "b".repeat(64) };

try {
	const store = new ResearchScheduleStore(goalId, workspaceDir);
	const partial = store.create({
		title: "Weekly open TTS models",
		question: "What changed?",
		monitoringScope: "Monitor newly published open source TTS models.",
		reportContext: "Write for the launch review board.",
		cron: "0 9 * * 1",
		timeZone: "Asia/Singapore",
		initializedFromRunId: "2026-09-18T18-14-51.653Z",
		coveredThrough: "2026-09-18T18:14:51.653Z",
		sources: [readSource],
		sourceGaps: [gapSource],
		now: createdAt,
	});
	const complete = store.create({
		title: "Fully read baseline",
		question: "What changed?",
		monitoringScope: "Monitor the project.",
		reportContext: "Write for the launch review board.",
		cron: "0 9 * * 1",
		timeZone: "Asia/Singapore",
		initializedFromRunId: "run-complete",
		coveredThrough: "2026-09-18T18:14:51.653Z",
		sources: [readSource],
		now: createdAt,
	});
	store.close();

	const tool = createResearchScheduleTool({ goalId, workspaceDir });
	const textOf = async (args: Parameters<typeof tool.execute>[1]) => {
		const value = await tool.execute("call-1", args);
		return value.content[0]?.type === "text" ? value.content[0].text : "";
	};

	// The Main Agent only ever sees the Tool's text: a Cornell Note gap the user asks about has to
	// be stated here, because `details` never reaches the model.
	assert.equal(await textOf({ action: "get", scheduleId: partial.id }), [
		`${partial.id} | active | Weekly open TTS models`,
		"Cadence: 0 9 * * 1 (Asia/Singapore); next occurrence 2026-09-21T01:00:00.000Z",
		"Baseline: Research Run 2026-09-18T18-14-51.653Z, covered through 2026-09-18T18:14:51.653Z",
		"Source gaps: 1 Source gap, published without a Cornell Note and not read since."
		+ " An occurrence may read one again if it rediscovers it; none of them is retried on its own.",
		`  ${gapSource.sourceIdentity} revision ${gapSource.contentSha256}`
		+ " (Research Run 2026-09-18T18-14-51.653Z)",
	].join("\n"));

	assert.equal(await textOf({ action: "get", scheduleId: complete.id }), [
		`${complete.id} | active | Fully read baseline`,
		"Cadence: 0 9 * * 1 (Asia/Singapore); next occurrence 2026-09-21T01:00:00.000Z",
		"Baseline: Research Run run-complete, covered through 2026-09-18T18:14:51.653Z",
		"Source gaps: none; every Source of this Schedule has a Cornell Note.",
	].join("\n"),
	"a Schedule whose baseline was read in full must say so, not stay silent about gaps");

	const listed = (await textOf({ action: "list" })).split("\n");
	assert.equal(listed.length, 2);
	assert.ok(listed.some((line) => line.startsWith(`${partial.id} | active | Weekly open TTS models |`)
		&& line.endsWith("| next 2026-09-21T01:00:00.000Z | 1 Source gap")),
	`the listing must carry each Schedule's cadence and gap count: ${listed.join(" / ")}`);
	assert.ok(listed.some((line) => line.endsWith("| next 2026-09-21T01:00:00.000Z | 0 Source gaps")));
	assert.ok(!listed.some((line) => line.includes("Write for the launch review board")),
		"the listing must not carry every Schedule's Report Context");

	const paused = await textOf({ action: "pause", scheduleId: partial.id });
	assert.match(paused, /^Research Schedule pause completed\./u);
	assert.match(paused, /next occurrence none while it is not active/u);
	assert.match(paused, /source:91b319038d79efcf852fe5f8 revision b{64}/u,
		"a mutation must report the Schedule it leaves behind, gaps included");

	console.log("research schedule tool output tests passed");
} finally {
	rmSync(workspaceDir, { recursive: true, force: true });
}
