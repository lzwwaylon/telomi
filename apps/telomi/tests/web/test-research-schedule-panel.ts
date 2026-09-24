import assert from "node:assert/strict";
import i18n from "../../web/src/app/i18n.js";
import {
	describeCron,
	lastFinishedRun,
	nextRunText,
} from "../../web/src/features/goals/GoalResearchSchedulePanel.js";

await i18n.changeLanguage("en");

assert.equal(describeCron("48 9 * * 1"), "Every Monday at 09:48");
assert.equal(describeCron("0 9 * * *"), "Daily at 09:00");
assert.equal(describeCron("30 8 * * 1-5"), "Weekdays at 08:30");
assert.equal(describeCron("0 7 15 * *"), "Monthly on day 15 at 07:00");
assert.equal(describeCron("*/10 * * * *"), "Every 10 minutes");
assert.equal(describeCron("5 * * * *"), "Hourly at :05");
assert.equal(describeCron("0 9 * * 1,3"), "0 9 * * 1,3", "unsupported cron stays raw");

const run = (status: string, extra: Record<string, unknown> = {}) => ({
	id: status,
	status,
	scheduledFor: "2026-09-14T01:48:00.000Z",
	discoveredSources: 0,
	incrementalSources: 0,
	retainedEvidence: 0,
	...extra,
}) as never;
const due = Date.parse("2026-09-14T01:48:00.000Z");

assert.match(nextRunText({ nextRunAt: "2026-09-14T01:48:00.000Z", runs: [] }, due - 60_000), /^Next /u);
assert.equal(
	nextRunText({ nextRunAt: "2026-09-14T01:48:00.000Z", runs: [run("running", { startedAt: "2026-09-14T01:42:54.000Z" })] }, due + 60_000),
	`Running since ${new Date("2026-09-14T01:42:54.000Z").toLocaleString("en", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })}`,
);
assert.equal(nextRunText({ nextRunAt: "2026-09-14T01:48:00.000Z", runs: [run("scheduled")] }, due), "Queued, waiting to start");
assert.equal(nextRunText({ nextRunAt: "2026-09-14T01:48:00.000Z", runs: [] }, due), "Due, waiting for the current run to finish");
assert.equal(nextRunText({ runs: [] }, due), "Next Not scheduled");

assert.equal(lastFinishedRun([run("running"), run("published"), run("failed")])?.status, "published");
assert.equal(lastFinishedRun([run("scheduled")]), undefined);

console.log("research schedule panel tests passed");
